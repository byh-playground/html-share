const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
    managementPath,
    readManagementToken,
} = require('../../src/management/management-route.cjs');

function urlParser(onUrl) {
    let pending = '';
    return (chunk) => {
        pending = (pending + chunk.toString()).slice(-16384);
        const end = pending.lastIndexOf('\n');
        if (end < 0) return;
        const complete = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        const pattern =
            /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|"'<>])/g;
        for (const match of complete.matchAll(pattern)) onUrl(match[0]);
    };
}
function createSupervisor({
    root = path.resolve(__dirname, '../..'),
    pid = process.pid,
    exe,
    port,
    send = globalThis.fetch,
    launch = spawn,
    retryMs = 2000,
    log = console.log,
} = {}) {
    const runtime = path.join(root, '.runtime');
    const stateFile = path.join(runtime, 'ngrok-state.json');
    let child = null,
        closed = false,
        generation = 0,
        lastUrl = null,
        currentUrl = null,
        notified = null;
    let retryTimer, notifyTimer, ownershipTimer, notifyAbort;
    const readJson = (file) =>
        JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    function ownedState() {
        try {
            const state = readJson(stateFile);
            return Number(state.tunnel?.id) === pid &&
                state.provider === 'cloudflare'
                ? state
                : null;
        } catch {
            return null;
        }
    }
    function write(file, value) {
        if (!ownedState()) return false;
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            fs.writeFileSync(temporary, value, { flag: 'wx' });
            if (!ownedState()) return false;
            fs.renameSync(temporary, file);
            return true;
        } finally {
            try {
                fs.unlinkSync(temporary);
            } catch {}
        }
    }
    function updateUrl(url, token) {
        const state = ownedState();
        if (!state || closed) return false;
        if (
            !write(stateFile, JSON.stringify({ ...state, url }, null, 2) + '\n')
        )
            return false;
        write(path.join(runtime, 'url.txt'), url ? url + '\n' : '');
        write(
            path.join(runtime, 'upload-url.txt'),
            url && token
                ? url + managementPath(token) + '#key=' + token + '\n'
                : '',
        );
        return true;
    }
    async function notify(url, version, attempt = 0) {
        if (
            closed ||
            generation !== version ||
            currentUrl !== url ||
            notified === version ||
            !ownedState()
        )
            return;
        try {
            let config;
            try {
                config = readJson(path.join(runtime, 'ntfy.json'));
            } catch (error) {
                if (error.code === 'ENOENT') return;
                throw error;
            }
            if (
                config.enabled === false ||
                typeof config.topic !== 'string' ||
                !/^[A-Za-z0-9_-]{1,64}$/.test(config.topic)
            )
                return;
            const token = await readManagementToken(runtime);
            if (closed || generation !== version || !ownedState()) return;
            const actions = [{ action: 'view', label: '프로젝트 열기', url }];
            if (token)
                actions.push({
                    action: 'view',
                    label: '업로드·관리',
                    url: url + managementPath(token) + '#key=' + token,
                });
            const controller = new AbortController();
            notifyAbort = controller;
            const timeout = setTimeout(() => controller.abort(), 8000);
            let receipt;
            try {
                const response = await send('https://ntfy.sh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        topic: config.topic,
                        title: 'HTML Share 접속 주소 안내',
                        message:
                            'Cloudflare 임시 주소입니다. 재시작하면 주소가 바뀔 수 있습니다.\n' +
                            url,
                        click: url,
                        actions,
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error('notification rejected');
                receipt = await response.json();
            } finally {
                clearTimeout(timeout);
                if (notifyAbort === controller) notifyAbort = null;
            }
            if (
                typeof receipt.id !== 'string' ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id)
            )
                throw new Error('invalid receipt');
            if (closed || generation !== version || !ownedState()) return;
            notified = version;
            write(
                path.join(runtime, 'ntfy-last.json'),
                JSON.stringify({
                    id: receipt.id,
                    url,
                    sentAt: new Date().toISOString(),
                }) + '\n',
            );
            log('새 터널 주소의 ntfy 알림을 전송했습니다.');
        } catch {
            if (!closed && generation === version && ownedState()) {
                log('ntfy 알림 전송 실패: 잠시 후 다시 시도합니다.');
                notifyTimer = setTimeout(
                    () => notify(url, version, attempt + 1),
                    Math.min(60000, retryMs * 2 ** Math.min(attempt, 5)),
                );
            }
        }
    }
    async function acceptUrl(url) {
        if (closed || !ownedState() || currentUrl === url) return;
        const version = generation;
        const token = await readManagementToken(runtime);
        if (
            closed ||
            generation !== version ||
            !ownedState() ||
            currentUrl === url
        )
            return;
        if (!updateUrl(url, token)) return;
        currentUrl = url;
        generation++;
        clearTimeout(notifyTimer);
        notifyAbort?.abort();
        log('공개 주소: ' + url);
        lastUrl = url;
        void notify(url, generation);
    }
    function startChild(attempt = 0) {
        if (closed || !ownedState()) return;
        const instance = launch(
            exe,
            ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child = instance;
        let ready = false,
            candidate = null;
        function streamReader() {
            const parse = urlParser((url) => {
                candidate = url;
                if (ready && child === instance) void acceptUrl(url);
            });
            let pending = '';
            return (chunk) => {
                parse(chunk);
                pending = (pending + chunk.toString()).slice(-16384);
                const end = pending.lastIndexOf('\n');
                if (end < 0) return;
                const lines = pending.slice(0, end + 1);
                pending = pending.slice(end + 1);
                if (lines.includes('Registered tunnel connection')) {
                    ready = true;
                    if (candidate && child === instance)
                        void acceptUrl(candidate);
                }
                if (/\b(?:ERR|error)\b/i.test(lines))
                    log('cloudflared 연결 오류: 자동 재연결을 기다립니다.');
            };
        }
        instance.stdout?.on('data', streamReader());
        instance.stderr?.on('data', streamReader());
        let handled = false;
        const ended = () => {
            if (handled) return;
            handled = true;
            if (child !== instance) return;
            child = null;
            const hadUrl = !!currentUrl;
            currentUrl = null;
            generation++;
            clearTimeout(notifyTimer);
            notifyAbort?.abort();
            updateUrl(null, null);
            if (!closed && ownedState()) {
                log('터널 연결이 종료되어 다시 연결합니다.');
                retryTimer = setTimeout(
                    () => startChild(hadUrl ? 0 : attempt + 1),
                    Math.min(30000, retryMs * 2 ** Math.min(attempt, 4)),
                );
            }
        };
        instance.once('error', ended);
        instance.once('exit', ended);
    }
    function stop() {
        if (closed) return;
        updateUrl(null, null);
        closed = true;
        generation++;
        clearTimeout(retryTimer);
        clearTimeout(notifyTimer);
        clearInterval(ownershipTimer);
        notifyAbort?.abort();
        child?.kill();
        child = null;
    }
    async function start() {
        const deadline = Date.now() + 30000;
        while (!ownedState()) {
            if (closed || Date.now() > deadline)
                throw new Error('터널 실행 상태가 등록되지 않았습니다.');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        let misses = 0;
        ownershipTimer = setInterval(() => {
            if (ownedState()) misses = 0;
            else if (++misses >= 3) stop();
        }, 1000);
        startChild();
    }
    return {
        start,
        stop,
        acceptUrl,
        ownedState,
        get lastUrl() {
            return lastUrl;
        },
    };
}
if (require.main === module) {
    const [exe, portText] = process.argv.slice(2);
    const port = Number(portText);
    if (!exe || !Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(
            '사용법: node quick-tunnel.cjs <cloudflared 경로> <포트>',
        );
        process.exitCode = 1;
    } else {
        const supervisor = createSupervisor({ exe, port });
        process.on('SIGINT', () => supervisor.stop());
        process.on('SIGTERM', () => supervisor.stop());
        supervisor.start().catch((error) => {
            console.error(error.message);
            supervisor.stop();
            process.exitCode = 1;
        });
    }
}
module.exports = { urlParser, createSupervisor };
