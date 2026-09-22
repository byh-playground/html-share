const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { Uploads } = require('../../src/management/upload.cjs');
const { managementPath } = require('../../src/management/management-route.cjs');
const AdmZip = require('adm-zip');

test('authenticated uploads publish complete files into selected projects', async (t) => {
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-upload-test-'),
    );
    const root = path.join(fixture, 'public'),
        runtime = path.join(fixture, 'runtime');
    for (const name of ['a', 'b', 'upload'])
        await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.mkdir(runtime);
    const token = 'a'.repeat(64);
    await fs.writeFile(
        path.join(runtime, 'upload-auth.json'),
        JSON.stringify({ token }),
    );
    await fs.writeFile(path.join(root, 'upload', 'index.html'), 'UPLOAD');
    const child = spawn(
        process.execPath,
        [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
        {
            env: {
                ...process.env,
                HTML_SHARE_ROOT: root,
                HTML_SHARE_RUNTIME: runtime,
                HTML_SHARE_ADMIN_ROOT: path.join(root, 'upload'),
                HTML_SHARE_ZIP_CACHE: path.join(runtime, 'cache'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
        assert.equal(path.dirname(fixture), os.tmpdir());
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('timeout')), 10000);
        child.stdout.on('data', (data) => {
            const match = String(data).match(/127\.0\.0\.1:(\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(Error('exit ' + code));
        });
    });
    const base = `http://127.0.0.1:${port}`;
    const admin = managementPath(token),
        api = admin + 'api/';
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
    };
    const put = (project, name, body, extra = {}) =>
        fetch(
            base +
                api +
                'file?' +
                new URLSearchParams({ project, filename: name }),
            { method: 'PUT', headers: { ...headers, ...extra }, body },
        );
    const get = async (route) => (await fetch(base + route)).text();
    await t.test(
        'assets public but APIs authenticated; key reloads without restart',
        async () => {
            assert.equal(await get(admin), 'UPLOAD');
            const asset = await fetch(base + admin);
            assert.match(
                asset.headers.get('content-security-policy'),
                /frame-ancestors 'none'/,
            );
            assert.equal((await fetch(base + api + 'projects')).status, 401);
            assert.deepEqual(
                await (
                    await fetch(base + api + 'projects', { headers })
                ).json(),
                { projects: [{ name: 'a' }, { name: 'b' }] },
            );
            await fs.writeFile(
                path.join(runtime, 'upload-auth.json'),
                JSON.stringify({ token: 'b'.repeat(64) }),
            );
            assert.equal(
                (await fetch(base + api + 'projects', { headers })).status,
                404,
            );
            await fs.writeFile(
                path.join(runtime, 'upload-auth.json'),
                JSON.stringify({ token }),
            );
        },
    );
    await t.test(
        'public share QR requires authentication and excludes management credentials',
        async () => {
            const endpoint = base + api + 'share-qr?project=a';
            assert.equal((await fetch(endpoint)).status, 401);
            assert.equal(
                (
                    await fetch(endpoint, {
                        headers: { Authorization: 'Bearer wrong' },
                    })
                ).status,
                401,
            );
            const response = await fetch(endpoint, { headers });
            assert.equal(response.status, 200);
            const value = await response.json();
            assert.equal(value.project, 'a');
            assert.equal(value.url, base + '/a/');
            assert.match(value.image, /^data:image\/png;base64,/);
            assert.ok(!value.url.includes(token));
            assert.ok(!value.url.includes(admin));
            assert.equal(new URL(value.url).hash, '');
            assert.equal(
                (
                    await fetch(base + '/upload/api/share-qr?project=a', {
                        headers,
                    })
                ).status,
                404,
            );
        },
    );
    await t.test(
        'private device QR requires the existing bearer and never replaces the key',
        async () => {
            const endpoint = base + api + 'manage-qr';
            const keyFile = path.join(runtime, 'upload-auth.json');
            const before = await fs.readFile(keyFile, 'utf8');
            assert.equal((await fetch(endpoint)).status, 401);
            assert.equal(
                (
                    await fetch(endpoint, {
                        headers: { Authorization: 'Bearer wrong' },
                    })
                ).status,
                401,
            );
            assert.equal(
                (
                    await fetch(endpoint, {
                        headers: {
                            ...headers,
                            Origin: 'https://untrusted.example',
                        },
                    })
                ).status,
                403,
            );
            const response = await fetch(endpoint, { headers });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.equal(result.url, base + admin + '#key=' + token);
            assert.match(result.image, /^data:image\/png;base64,/);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const second = await (await fetch(endpoint, { headers })).json();
            assert.equal(second.url, result.url);
            assert.equal(await fs.readFile(keyFile, 'utf8'), before);
            const publicQr = await (
                await fetch(base + api + 'share-qr?project=a', { headers })
            ).json();
            assert.ok(!publicQr.url.includes(token));
        },
    );
    await t.test(
        'duplicate names preserved, upload becomes newest even with future source',
        async () => {
            await fs.writeFile(path.join(root, 'a', 'future.html'), 'FUTURE');
            await fs.utimes(
                path.join(root, 'a', 'future.html'),
                2000000000,
                2000000000,
            );
            assert.equal((await put('a', 'page.html', 'ONE')).status, 201);
            const result = await (await put('a', 'page.html', 'TWO')).json();
            assert.equal(result.filename, 'page-1.html');
            assert.equal(
                await fs.readFile(path.join(root, 'a', 'page.html'), 'utf8'),
                'ONE',
            );
            assert.equal(await get('/a/'), 'TWO');
            assert.deepEqual(await fs.readdir(path.join(root, 'b')), []);
        },
    );
    await t.test(
        'ZIP then HTML then ZIP switches current source and serves assets',
        async () => {
            const zip = new AdmZip();
            zip.addFile('index.html', Buffer.from('ZIP'));
            zip.addFile('style.css', Buffer.from('CSS'));
            assert.equal(
                (await put('a', 'site.zip', zip.toBuffer())).status,
                201,
            );
            assert.equal(await get('/a/'), 'ZIP');
            assert.equal(await get('/a/style.css'), 'CSS');
            assert.equal((await put('a', 'new.htm', 'HTML')).status, 201);
            assert.equal(await get('/a/'), 'HTML');
            assert.equal(
                (await put('a', 'site.zip', zip.toBuffer())).status,
                201,
            );
            assert.equal(await get('/a/'), 'ZIP');
        },
    );
    await t.test(
        'invalid ZIP, unsupported files, traversal, reserved targets, origins, and oversized uploads rejected',
        async () => {
            assert.equal((await put('a', 'bad.zip', 'bad')).status, 422);
            assert.equal((await put('a', 'bad.exe', 'bad')).status, 415);
            for (const project of ['../b', 'upload', '.hidden', 'CON'])
                assert.equal(
                    (await put(project, 'page.html', 'bad')).status,
                    403,
                );
            for (const name of [
                '../page.html',
                'CON.html',
                'evil:ads.html',
                '.hidden.html',
                'x\\y.html',
            ])
                assert.equal((await put('a', name, 'bad')).status, 403);
            assert.equal(
                (await put('missing', 'page.html', 'bad')).status,
                404,
            );
            assert.equal(
                (
                    await put('a', 'page.html', 'bad', {
                        Origin: 'https://attacker.example',
                    })
                ).status,
                403,
            );
            assert.equal(
                (
                    await put('a', 'page.html', 'bad', {
                        Authorization: 'Bearer wrong',
                    })
                ).status,
                401,
            );
            const limited = new Uploads(root, runtime, 4);
            const server = http.createServer((req, res) =>
                limited.handle(req, res),
            );
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            try {
                const endpoint = `http://127.0.0.1:${server.address().port}/upload/api/file?project=a&filename=big.html`;
                assert.equal(
                    (
                        await fetch(endpoint, {
                            method: 'PUT',
                            headers,
                            body: '12345',
                        })
                    ).status,
                    413,
                );
                const status = await new Promise((resolve, reject) => {
                    const request = http.request(
                        endpoint,
                        { method: 'PUT', headers },
                        (response) => {
                            response.resume();
                            response.on('end', () =>
                                resolve(response.statusCode),
                            );
                        },
                    );
                    request.on('error', reject);
                    request.write('123');
                    request.end('456');
                });
                assert.equal(status, 413);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
            assert.ok(
                !(await fs.readdir(path.join(root, 'a'))).includes('bad.zip'),
            );
        },
    );
    await t.test(
        'interrupted upload is never published and temporary files cleaned',
        async () => {
            const request = http.request(
                base + api + 'file?project=b&filename=partial.html',
                {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Length': '100000' },
                },
            );
            request.on('error', () => {});
            request.write('partial');
            await new Promise((resolve) => setTimeout(resolve, 100));
            request.destroy();
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert.deepEqual(await fs.readdir(path.join(root, 'b')), []);
            assert.deepEqual(
                (await fs.readdir(runtime)).filter(
                    (name) =>
                        name.startsWith('upload-') &&
                        name !== 'upload-auth.json',
                ),
                [],
            );
        },
    );
    const list = async (project = 'a') =>
        (
            await fetch(
                base + api + 'files?' + new URLSearchParams({ project }),
                { headers },
            )
        ).json();
    const manage = (action, project, body, extra = {}) =>
        fetch(base + api + action + '?' + new URLSearchParams({ project }), {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                ...extra,
            },
            body: JSON.stringify(body),
        });
    await t.test(
        'original downloads preserve HTML and ZIP bytes and listing; require auth and current revision',
        async () => {
            const state = await list();
            const endpoint = (
                filename,
                revision = state.revision,
                project = 'a',
            ) =>
                base +
                api +
                'download?' +
                new URLSearchParams({ project, filename, revision });
            assert.equal((await fetch(endpoint('page.html'))).status, 401);
            assert.equal(
                (
                    await fetch(endpoint('page.html'), {
                        headers: { Authorization: 'Bearer wrong' },
                    })
                ).status,
                401,
            );
            for (const filename of ['page.html', 'site.zip']) {
                const response = await fetch(endpoint(filename), { headers });
                assert.equal(response.status, 200);
                assert.deepEqual(
                    Buffer.from(await response.arrayBuffer()),
                    await fs.readFile(path.join(root, 'a', filename)),
                );
                assert.equal(
                    response.headers.get('content-type'),
                    'application/octet-stream',
                );
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.equal(
                    response.headers.get('x-content-type-options'),
                    'nosniff',
                );
                assert.match(
                    response.headers.get('content-disposition'),
                    /^attachment;/,
                );
            }
            assert.deepEqual(await list(), state);
            for (const name of [
                '../page.html',
                'x\\y.html',
                'missing.html',
                'style.css',
            ])
                assert.equal(
                    (await fetch(endpoint(name), { headers })).status,
                    400,
                );
            assert.equal(
                (
                    await fetch(endpoint('page.html', state.revision, '../a'), {
                        headers,
                    })
                ).status,
                403,
            );
            assert.equal(
                (await fetch(endpoint('page.html', 'bad'), { headers })).status,
                400,
            );
            const unicode = '한글 버전(1).html',
                file = path.join(root, 'a', unicode);
            await fs.writeFile(file, '<!doctype html>한글 원본');
            assert.equal(
                (await fetch(endpoint('page.html'), { headers })).status,
                409,
            );
            const fresh = await list(),
                response = await fetch(endpoint(unicode, fresh.revision), {
                    headers,
                });
            assert.equal(response.status, 200);
            assert.equal(await response.text(), '<!doctype html>한글 원본');
            assert.ok(
                response.headers
                    .get('content-disposition')
                    .includes(
                        "filename*=UTF-8''" +
                            encodeURIComponent(unicode).replace(
                                /[!'()*]/g,
                                (char) =>
                                    '%' +
                                    char
                                        .charCodeAt(0)
                                        .toString(16)
                                        .toUpperCase(),
                            ),
                    ),
            );
            await fs.unlink(file);
            const alias = path.join(root, 'a', 'download-alias.html');
            let linked = false;
            try {
                await fs.symlink(path.join(root, 'a', 'page.html'), alias);
                linked = true;
            } catch (error) {
                if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code))
                    throw error;
            }
            if (linked) {
                try {
                    assert.equal(
                        (
                            await fetch(
                                endpoint(
                                    'download-alias.html',
                                    (await list()).revision,
                                ),
                                { headers },
                            )
                        ).status,
                        400,
                    );
                } finally {
                    await fs.unlink(alias);
                }
            }
        },
    );
    await t.test(
        'listing authenticates; cleanup empty and single source are no-ops; POST inputs guarded',
        async () => {
            assert.equal(
                (await fetch(base + api + 'files?project=a')).status,
                401,
            );
            assert.equal(
                (
                    await manage(
                        'cleanup',
                        'a',
                        { revision: (await list()).revision },
                        { Authorization: 'Bearer wrong' },
                    )
                ).status,
                401,
            );
            assert.equal(
                (await manage('cleanup', '../a', { revision: 'a'.repeat(64) }))
                    .status,
                403,
            );
            assert.equal((await manage('cleanup', 'a', {})).status, 400);
            assert.equal(
                (
                    await manage('apply', 'a', {
                        revision: (await list()).revision,
                        filename: '../b.html',
                    })
                ).status,
                400,
            );
            assert.equal(
                (
                    await manage('cleanup', 'a', {
                        revision: 'a'.repeat(64),
                        large: 'x'.repeat(9000),
                    })
                ).status,
                413,
            );
            let state = await list('b');
            assert.equal(state.active, null);
            assert.deepEqual(state.cleanup, { count: 0, bytes: 0 });
            assert.deepEqual(
                await (
                    await manage('cleanup', 'b', { revision: state.revision })
                ).json(),
                { project: 'b', deleted: [], kept: null, freedBytes: 0 },
            );
            await put('b', 'keep.html', 'KEEP');
            state = await list('b');
            assert.deepEqual(
                await (
                    await manage('cleanup', 'b', { revision: state.revision })
                ).json(),
                { project: 'b', deleted: [], kept: 'keep.html', freedBytes: 0 },
            );
        },
    );
    await t.test(
        'applying old HTML and ZIP switches served source; stale snapshots cannot delete',
        async () => {
            let state = await list();
            assert.equal(state.active, 'site-1.zip');
            assert.equal(state.files[0].active, true);
            assert.equal(state.files.filter((entry) => entry.active).length, 1);
            const oldRevision = state.revision;
            const applied = await manage('apply', 'a', {
                revision: state.revision,
                filename: 'page.html',
            });
            assert.equal(applied.status, 200);
            state = await applied.json();
            assert.equal(state.active, 'page.html');
            assert.equal(await get('/a/'), 'ONE');
            const namesBefore = await fs.readdir(path.join(root, 'a'));
            assert.equal(
                (await manage('cleanup', 'a', { revision: oldRevision }))
                    .status,
                409,
            );
            assert.deepEqual(
                await fs.readdir(path.join(root, 'a')),
                namesBefore,
            );
            const zipApplied = await manage('apply', 'a', {
                revision: state.revision,
                filename: 'site.zip',
            });
            assert.equal(zipApplied.status, 200);
            state = await zipApplied.json();
            assert.equal(state.active, 'site.zip');
            assert.equal(await get('/a/'), 'ZIP');
            await put('a', 'recent.html', 'RECENT');
            assert.equal(
                (await manage('cleanup', 'a', { revision: state.revision }))
                    .status,
                409,
            );
            state = await list();
            assert.equal(state.active, 'recent.html');
        },
    );
    await t.test(
        'invalid active ZIP blocks cleanup and apply without losing older files',
        async () => {
            const broken = path.join(root, 'a', 'broken.zip');
            await fs.writeFile(broken, 'BAD ZIP');
            await fs.utimes(broken, 2100000000, 2100000000);
            const state = await list();
            assert.equal(state.active, 'broken.zip');
            const names = await fs.readdir(path.join(root, 'a'));
            assert.equal(
                (await manage('cleanup', 'a', { revision: state.revision }))
                    .status,
                422,
            );
            assert.equal(
                (
                    await manage('apply', 'a', {
                        revision: state.revision,
                        filename: 'broken.zip',
                    })
                ).status,
                422,
            );
            assert.deepEqual(await fs.readdir(path.join(root, 'a')), names);
            await fs.unlink(broken);
        },
    );
    await t.test(
        'tie ordering matches server and cleanup keeps applied ZIP with assets and other projects intact',
        async () => {
            const zip = new AdmZip();
            zip.addFile('index.html', Buffer.from('TIE ZIP'));
            await fs.writeFile(
                path.join(root, 'a', 'a-tie.zip'),
                zip.toBuffer(),
            );
            await fs.writeFile(path.join(root, 'a', 'a-tie.html'), 'TIE HTML');
            await fs.utimes(
                path.join(root, 'a', 'a-tie.zip'),
                2200000000,
                2200000000,
            );
            await fs.utimes(
                path.join(root, 'a', 'a-tie.html'),
                2200000000,
                2200000000,
            );
            let state = await list();
            assert.equal(state.active, 'a-tie.zip');
            assert.equal(await get('/a/'), 'TIE ZIP');
            const applied = await manage('apply', 'a', {
                revision: state.revision,
                filename: 'site.zip',
            });
            state = await applied.json();
            assert.equal(state.active, 'site.zip');
            await fs.writeFile(path.join(root, 'a', 'style.css'), 'PRESERVE');
            await fs.mkdir(path.join(root, 'a', 'nested'));
            await fs.writeFile(
                path.join(root, 'a', 'nested', 'other.html'),
                'NESTED',
            );
            await fs.writeFile(path.join(root, 'a', '.hidden.html'), 'HIDDEN');
            const alias = path.join(root, 'a', 'alias.html');
            let linked = false;
            try {
                await fs.symlink(path.join(root, 'b', 'keep.html'), alias);
                linked = true;
            } catch (error) {
                if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
            }
            state = await list();
            assert.ok(
                !state.files.some((entry) => entry.name === '.hidden.html'),
            );
            const expected = state.files.slice(1).map((entry) => entry.name);
            assert.ok(
                !state.files.some((entry) => entry.name === 'alias.html'),
            );
            const result = await manage('cleanup', 'a', {
                revision: state.revision,
            });
            assert.equal(result.status, 200);
            const body = await result.json();
            assert.deepEqual(body.deleted, expected);
            assert.equal(body.kept, 'site.zip');
            assert.equal(body.freedBytes, state.cleanup.bytes);
            assert.equal(
                await fs.readFile(path.join(root, 'a', 'style.css'), 'utf8'),
                'PRESERVE',
            );
            assert.equal(
                await fs.readFile(
                    path.join(root, 'a', 'nested', 'other.html'),
                    'utf8',
                ),
                'NESTED',
            );
            assert.equal(
                await fs.readFile(path.join(root, 'a', '.hidden.html'), 'utf8'),
                'HIDDEN',
            );
            assert.equal(await get('/a/'), 'ZIP');
            assert.equal(await get('/b/'), 'KEEP');
            assert.equal((await list()).files.length, 1);
            if (linked)
                assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
        },
    );
    await t.test('cleanup also keeps newest HTML after ZIP', async () => {
        await put('a', 'final.html', 'FINAL');
        const state = await list();
        assert.equal(state.active, 'final.html');
        const result = await (
            await manage('cleanup', 'a', { revision: state.revision })
        ).json();
        assert.deepEqual(result.deleted, ['site.zip']);
        assert.equal(result.kept, 'final.html');
        assert.equal(await get('/a/'), 'FINAL');
    });
});

test('PWA uploads compose immutable releases from private HTML sources', async (t) => {
    const { PwaProjects } = require('../../src/pwa/pwa-projects.cjs');
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-pwa-upload-test-'),
    );
    const root = path.join(fixture, 'public'),
        runtime = path.join(fixture, 'runtime'),
        projects = path.join(fixture, 'projects');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'c'.repeat(64);
    await fs.writeFile(
        path.join(runtime, 'upload-auth.json'),
        JSON.stringify({ token }),
    );
    for (const name of ['alpha', 'beta']) {
        await fs.mkdir(path.join(root, name), { recursive: true });
        await fs.mkdir(path.join(projects, name, 'pwa-base', 'icons'), {
            recursive: true,
        });
        await fs.mkdir(path.join(projects, name, 'archives'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(projects, name, 'archives', 'original.zip'),
            'ARCHIVE',
        );
        await fs.writeFile(
            path.join(projects, name, 'pwa-base', 'manifest.json'),
            JSON.stringify({ start_url: './', scope: './', id: './' }),
        );
        await fs.writeFile(
            path.join(projects, name, 'pwa-base', 'icons', 'icon.svg'),
            '<svg/>',
        );
    }
    const pwa = new PwaProjects(root, runtime, projects),
        uploads = new Uploads(root, runtime, undefined, pwa);
    const server = http.createServer((req, res) => uploads.handle(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        assert.equal(path.dirname(fixture), os.tmpdir());
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}/upload/api/`,
        headers = { Authorization: `Bearer ${token}` };
    const html = (build) =>
        `<!doctype html><script>const PWA_BUILD_ID = '${build}';</script><main>${build}</main>`;
    const put = (project, filename, body) =>
        fetch(base + 'file?' + new URLSearchParams({ project, filename }), {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/octet-stream' },
            body,
        });
    const list = async (project = 'alpha') =>
        (
            await fetch(base + 'files?' + new URLSearchParams({ project }), {
                headers,
            })
        ).json();
    const manage = (action, body) =>
        fetch(base + action + '?project=alpha', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    await t.test(
        'generic projects advertise PWA and reject ZIP and conflicting builds before source publication',
        async () => {
            assert.deepEqual(
                await (await fetch(base + 'projects', { headers })).json(),
                {
                    projects: [
                        { name: 'alpha', pwa: true },
                        { name: 'beta', pwa: true },
                    ],
                },
            );
            assert.equal((await put('alpha', 'bad.zip', 'ZIP')).status, 415);
            assert.equal(
                (await put('alpha', 'conflict.html', html('one') + html('two')))
                    .status,
                422,
            );
            assert.deepEqual(
                await fs.readdir(await pwa.directory('alpha')),
                [],
            );
            assert.equal(await pwa.readActive('alpha'), null);
        },
    );
    await t.test(
        'uploads preserve exact original and compose matching index, version, worker and assets',
        async () => {
            const response = await put(
                'alpha',
                'download.html',
                html('alpha-v1'),
            );
            assert.equal(response.status, 201);
            const published = await response.json();
            assert.equal(published.pwa.build, 'alpha-v1');
            assert.equal(
                await fs.readFile(
                    path.join(await pwa.directory('alpha'), 'download.html'),
                    'utf8',
                ),
                html('alpha-v1'),
            );
            assert.deepEqual(await fs.readdir(path.join(root, 'alpha')), []);
            const active = await pwa.resolve('alpha');
            assert.equal(
                await fs.readFile(path.join(active.root, 'index.html'), 'utf8'),
                html('alpha-v1'),
            );
            assert.match(
                await fs.readFile(
                    path.join(active.root, 'version.json'),
                    'utf8',
                ),
                /alpha-v1/,
            );
            assert.ok(
                (
                    await fs.readFile(path.join(active.root, 'sw.js'), 'utf8')
                ).includes(active.id),
            );
            assert.equal(
                await fs.readFile(
                    path.join(active.root, 'icons', 'icon.svg'),
                    'utf8',
                ),
                '<svg/>',
            );
            const state = await list();
            assert.equal(state.pwa.build, 'alpha-v1');
            assert.equal(state.active, 'download.html');
            const downloaded = await fetch(
                base +
                    'download?' +
                    new URLSearchParams({
                        project: 'alpha',
                        filename: 'download.html',
                        revision: state.revision,
                    }),
                { headers },
            );
            assert.equal(downloaded.status, 200);
            assert.equal(await downloaded.text(), html('alpha-v1'));
            assert.deepEqual(await list(), state);
            for (const filename of ['index.html', 'version.json', 'sw.js'])
                assert.equal(
                    (
                        await fetch(
                            base +
                                'download?' +
                                new URLSearchParams({
                                    project: 'alpha',
                                    filename,
                                    revision: state.revision,
                                }),
                            { headers },
                        )
                    ).status,
                    400,
                );
            assert.equal(
                (await put('beta', 'other.htm', html('beta-v1'))).status,
                201,
            );
            assert.equal((await pwa.resolve('beta')).build, 'beta-v1');
        },
    );
    await t.test(
        'reapplying previous HTML and cleanup preserves base, archives, private ZIP and other project',
        async () => {
            assert.equal(
                (await put('alpha', 'download.html', html('alpha-v2'))).status,
                201,
            );
            const directory = await pwa.directory('alpha');
            await fs.writeFile(
                path.join(directory, 'ignored.zip'),
                'DO NOT DELETE',
            );
            let state = await list();
            assert.equal(state.active, 'download-1.html');
            assert.equal(state.files.length, 2);
            const applied = await manage('apply', {
                revision: state.revision,
                filename: 'download.html',
            });
            assert.equal(applied.status, 200);
            state = await applied.json();
            assert.equal(state.active, 'download.html');
            assert.equal(state.pwa.build, 'alpha-v1');
            const cleaned = await manage('cleanup', {
                revision: state.revision,
            });
            assert.equal(cleaned.status, 200);
            assert.deepEqual((await cleaned.json()).deleted, [
                'download-1.html',
            ]);
            assert.equal(
                await fs.readFile(path.join(directory, 'ignored.zip'), 'utf8'),
                'DO NOT DELETE',
            );
            assert.equal(
                await fs.readFile(
                    path.join(projects, 'alpha', 'archives', 'original.zip'),
                    'utf8',
                ),
                'ARCHIVE',
            );
            assert.equal(
                await fs.readFile(
                    path.join(
                        projects,
                        'alpha',
                        'pwa-base',
                        'icons',
                        'icon.svg',
                    ),
                    'utf8',
                ),
                '<svg/>',
            );
            assert.equal((await pwa.resolve('beta')).build, 'beta-v1');
        },
    );
    await t.test(
        'invalid manually added latest source reports previous release and blocks cleanup',
        async () => {
            const directory = await pwa.directory('alpha'),
                bad = path.join(directory, 'bad.html');
            await fs.writeFile(bad, html('one') + html('two'));
            await fs.utimes(bad, 2300000000, 2300000000);
            const state = await list();
            assert.equal(state.active, 'bad.html');
            assert.ok(state.pwa.error);
            assert.equal(state.pwa.build, 'alpha-v1');
            assert.equal(
                (await manage('cleanup', { revision: state.revision })).status,
                422,
            );
            assert.ok((await fs.readdir(directory)).includes('download.html'));
            assert.equal((await pwa.readActive('alpha')).build, 'alpha-v1');
            await fs.unlink(bad);
        },
    );
    const settings = async () =>
        (await fetch(base + 'pwa?project=alpha', { headers })).json();
    const save = (value) =>
        fetch(base + 'pwa?project=alpha', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
        });
    await t.test(
        'PWA settings authenticated, validated and revision checked; metadata saves rebuild immediately',
        async () => {
            assert.equal((await fetch(base + 'pwa?project=alpha')).status, 401);
            assert.equal(
                (await fetch(base + 'pwa?project=../alpha', { headers }))
                    .status,
                403,
            );
            let current = await settings();
            assert.equal(current.enabled, true);
            assert.ok(
                typeof current.revision === 'string' &&
                    current.revision.length > 0,
            );
            assert.equal(
                (await save({ ...current, revision: 'a'.repeat(64) })).status,
                409,
            );
            assert.ok(
                [400, 422].includes(
                    (await save({ ...current, themeColor: 'not-a-color' }))
                        .status,
                ),
            );
            const response = await save({
                ...current,
                name: '새 프로젝트',
                shortName: '새앱',
                description: '설명',
                themeColor: '#123456',
                backgroundColor: '#eeeeee',
            });
            assert.equal(response.status, 200);
            current = await response.json();
            const release = await pwa.resolve('alpha');
            const manifest = JSON.parse(
                await fs.readFile(
                    path.join(release.root, 'manifest.json'),
                    'utf8',
                ),
            );
            assert.equal(manifest.name, '새 프로젝트');
            assert.equal(manifest.short_name, '새앱');
            assert.equal(manifest.theme_color, '#123456');
            assert.equal((await settings()).description, '설명');
        },
    );
    await t.test(
        'generic HTML auto builds, checkbox disable preserves private file list and reenables cleanly',
        async () => {
            const response = await put(
                'alpha',
                'plain.html',
                '<!doctype html><h1>Plain HTML</h1>',
            );
            assert.equal(response.status, 201);
            assert.ok((await response.json()).pwa.build);
            const before = await list(),
                active = await pwa.resolve('alpha');
            const original = '<!doctype html><h1>Plain HTML</h1>';
            assert.notEqual(
                await fs.readFile(path.join(active.root, 'index.html'), 'utf8'),
                original,
            );
            const download = await fetch(
                base +
                    'download?' +
                    new URLSearchParams({
                        project: 'alpha',
                        filename: 'plain.html',
                        revision: before.revision,
                    }),
                { headers },
            );
            assert.equal(download.status, 200);
            assert.equal(await download.text(), original);
            assert.deepEqual(await list(), before);
            assert.equal((await pwa.resolve('alpha')).id, active.id);
            let current = await settings();
            assert.equal(
                (await save({ ...current, enabled: false })).status,
                200,
            );
            let files = await list();
            assert.equal(files.pwa.enabled, false);
            assert.equal(files.active, 'plain.html');
            assert.ok(
                files.files.some((entry) => entry.name === 'download.html'),
            );
            assert.equal(
                await pwa.directory('alpha'),
                path.join(projects, 'alpha', 'uploads'),
            );
            assert.equal(
                (
                    await put(
                        'alpha',
                        'while-disabled.html',
                        '<!doctype html><p>Disabled</p>',
                    )
                ).status,
                201,
            );
            const zip = new AdmZip();
            zip.addFile('index.html', Buffer.from('ORDINARY ZIP'));
            assert.equal(
                (await put('alpha', 'ordinary.zip', zip.toBuffer())).status,
                201,
            );
            files = await list();
            assert.equal(files.active, 'ordinary.zip');
            assert.equal(files.files[0].type, 'zip');
            current = await settings();
            assert.equal(
                (await save({ ...current, enabled: true })).status,
                200,
            );
            files = await list();
            assert.equal(files.pwa.enabled, true);
            assert.match(files.active, /^imported-[a-f0-9]+\.html$/);
            assert.ok(files.pwa.build);
            assert.match(
                await fs.readFile(
                    path.join(await pwa.directory('alpha'), files.active),
                    'utf8',
                ),
                /ORDINARY ZIP/,
            );
        },
    );
});
