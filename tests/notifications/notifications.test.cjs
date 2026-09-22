const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const {
    notifyProjectUpdate,
} = require('../../src/notifications/notifications.cjs');
const { managementPath } = require('../../src/management/management-route.cjs');

async function fixture(t) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-notify-test-'),
    );
    t.after(async () => {
        assert.equal(path.dirname(directory), os.tmpdir());
        await fs.rm(directory, { recursive: true, force: true });
    });
    const write = (file, data) =>
        fs.writeFile(
            path.join(directory, file),
            '\uFEFF' + JSON.stringify(data),
        );
    return { directory, write };
}

test('update notifications are opt-in and invalid or local state never sends', async (t) => {
    const { directory, write } = await fixture(t);
    let calls = 0;
    const options = {
        fetch: async () => {
            calls++;
            throw Error('must not send');
        },
    };
    await write('ngrok-state.json', { url: 'https://example.ngrok-free.dev' });
    assert.equal(
        await notifyProjectUpdate(directory, 'demo', 'upload', options),
        false,
    );
    for (const config of [
        { topic: 'topic' },
        { topic: 'topic', enabled: true },
        { topic: 'topic', enabled: false, updates: true },
        { topic: 'topic', enabled: true, updates: false },
        { topic: 'invalid/topic', updates: true },
    ]) {
        await write('ntfy.json', config);
        assert.equal(
            await notifyProjectUpdate(directory, 'demo', 'upload', options),
            false,
        );
    }
    await write('ntfy.json', { topic: 'topic', updates: true });
    for (const url of [
        undefined,
        'http://example.ngrok-free.dev',
        'https://localhost:8787',
        'https://localhost.',
        'https://127.0.0.1',
        'https://192.168.1.5',
        'https://10.1.1.1',
        'https://172.16.0.1',
        'https://[::1]',
        'https://user:password@example.ngrok-free.dev',
        'https://example.ngrok-free.dev/path',
        'https://example.ngrok-free.dev/#secret',
    ]) {
        await write('ngrok-state.json', { url });
        assert.equal(
            await notifyProjectUpdate(directory, 'demo', 'upload', options),
            false,
        );
    }
    await fs.unlink(path.join(directory, 'ngrok-state.json'));
    assert.equal(
        await notifyProjectUpdate(directory, 'demo', 'upload', options),
        false,
    );
    assert.equal(calls, 0);
});

test('enabled updates send public link and stable management action without rewriting credentials', async (t) => {
    const { directory, write } = await fixture(t),
        token = 'e'.repeat(64);
    const previous = process.env.HTML_SHARE_UPLOAD_TOKEN;
    delete process.env.HTML_SHARE_UPLOAD_TOKEN;
    t.after(() => {
        if (previous === undefined) delete process.env.HTML_SHARE_UPLOAD_TOKEN;
        else process.env.HTML_SHARE_UPLOAD_TOKEN = previous;
    });
    await write('ntfy.json', { topic: 'unit-test-topic', updates: true });
    await write('ngrok-state.json', { url: 'https://example.ngrok-free.dev' });
    await write('upload-auth.json', { token });
    const original = await fs.readFile(
            path.join(directory, 'upload-auth.json'),
            'utf8',
        ),
        sent = [];
    const options = {
        fetch: async (url, request) => {
            sent.push({ url, request });
            return { ok: true, json: async () => ({ id: 'message-123' }) };
        },
    };
    for (const reason of ['upload', 'applied', 'PWA settings'])
        assert.equal(
            await notifyProjectUpdate(
                directory,
                '한글 프로젝트',
                reason,
                options,
            ),
            true,
        );
    assert.equal(sent.length, 3);
    for (const { url, request } of sent) {
        assert.equal(url, 'https://ntfy.sh');
        assert.equal(request.method, 'POST');
        assert.ok(request.signal instanceof AbortSignal);
        const payload = JSON.parse(request.body);
        assert.equal(payload.topic, 'unit-test-topic');
        assert.equal(payload.title, 'HTML Share updated');
        assert.equal(
            payload.click,
            'https://example.ngrok-free.dev/' +
                encodeURIComponent('한글 프로젝트') +
                '/',
        );
        assert.deepEqual(payload.actions[0], {
            action: 'view',
            label: 'Open page',
            url: payload.click,
        });
        assert.equal(
            payload.actions[1].url,
            'https://example.ngrok-free.dev' +
                managementPath(token) +
                '#key=' +
                token +
                '&project=' +
                encodeURIComponent('한글 프로젝트'),
        );
    }
    assert.equal(
        await fs.readFile(path.join(directory, 'upload-auth.json'), 'utf8'),
        original,
    );
    const metadata = JSON.parse(
        await fs.readFile(
            path.join(directory, 'ntfy-last-update.json'),
            'utf8',
        ),
    );
    assert.deepEqual(Object.keys(metadata).sort(), [
        'id',
        'project',
        'reason',
        'time',
    ]);
    assert.ok(!JSON.stringify(metadata).includes(token));
    await fs.unlink(path.join(directory, 'upload-auth.json'));
    assert.equal(
        await notifyProjectUpdate(directory, 'demo', 'upload', options),
        true,
    );
    assert.equal(JSON.parse(sent.at(-1).request.body).actions.length, 1);
    await assert.rejects(fs.stat(path.join(directory, 'upload-auth.json')), {
        code: 'ENOENT',
    });
});

test('network failures and invalid acknowledgements are swallowed without metadata or logging secrets', async (t) => {
    const { directory, write } = await fixture(t);
    await write('ntfy.json', { topic: 'test', enabled: true, updates: true });
    await write('ngrok-state.json', { url: 'https://example.ngrok-free.dev' });
    for (const send of [
        async () => {
            throw Error('secret network error');
        },
        async () => ({ ok: false }),
        async () => ({
            ok: true,
            json: async () => {
                throw Error('invalid json');
            },
        }),
        async () => ({ ok: true, json: async () => ({}) }),
    ]) {
        assert.equal(
            await notifyProjectUpdate(directory, 'demo', 'upload', {
                fetch: send,
            }),
            false,
        );
        await assert.rejects(
            fs.stat(path.join(directory, 'ntfy-last-update.json')),
            { code: 'ENOENT' },
        );
    }
});

test('API enqueues successful changes only and never waits for notification completion', async (t) => {
    const { directory } = await fixture(t),
        root = path.join(directory, 'public'),
        runtime = path.join(directory, 'runtime');
    await fs.mkdir(path.join(root, 'demo'), { recursive: true });
    await fs.mkdir(runtime);
    const token = 'f'.repeat(64);
    await fs.writeFile(
        path.join(runtime, 'upload-auth.json'),
        JSON.stringify({ token }),
    );
    const notified = [],
        module = { exports: {} };
    vm.runInNewContext(
        await fs.readFile(
            path.join(repositoryRoot, 'src/management/upload.cjs'),
            'utf8',
        ),
        {
            module,
            require: (name) =>
                name === '../notifications/notifications.cjs'
                    ? {
                          notifyProjectUpdate: (_runtime, project, reason) => {
                              notified.push({ project, reason });
                              return new Promise(() => {});
                          },
                      }
                    : require('node:module').createRequire(
                          path.join(
                              repositoryRoot,
                              'src/management/upload.cjs',
                          ),
                      )(name),
            process,
            Buffer,
            URL,
        },
    );
    const pwa = {
        directory: async (name) => path.join(root, name),
        enabled: async () => false,
        managed: async () => false,
        configure: async (_name, body) => body,
    };
    const uploads = new module.exports.Uploads(root, runtime, undefined, pwa),
        server = http.createServer((req, res) => uploads.handle(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/upload/api/`,
        headers = { Authorization: 'Bearer ' + token };
    const request = (
        route,
        method = 'GET',
        body,
        contentType = 'application/json',
    ) =>
        fetch(base + route, {
            method,
            headers: { ...headers, 'Content-Type': contentType },
            body:
                body === undefined
                    ? undefined
                    : contentType === 'application/json'
                      ? JSON.stringify(body)
                      : body,
            signal: AbortSignal.timeout(2000),
        });
    assert.equal(
        (
            await request(
                'file?project=demo&filename=one.html',
                'PUT',
                'ONE',
                'application/octet-stream',
            )
        ).status,
        201,
    );
    assert.equal(
        (
            await request(
                'file?project=demo&filename=two.html',
                'PUT',
                'TWO',
                'application/octet-stream',
            )
        ).status,
        201,
    );
    let state = await (await request('files?project=demo')).json();
    assert.equal(
        (
            await request('apply?project=demo', 'POST', {
                revision: state.revision,
                filename: 'one.html',
            })
        ).status,
        200,
    );
    assert.equal(
        (
            await request('pwa?project=demo', 'POST', {
                revision: 'initial',
                enabled: false,
            })
        ).status,
        200,
    );
    state = await (await request('files?project=demo')).json();
    assert.equal(
        (
            await request('cleanup?project=demo', 'POST', {
                revision: state.revision,
            })
        ).status,
        200,
    );
    assert.equal(
        (
            await request(
                'file?project=demo&filename=bad.exe',
                'PUT',
                'BAD',
                'application/octet-stream',
            )
        ).status,
        415,
    );
    assert.deepEqual(notified, [
        { project: 'demo', reason: 'upload' },
        { project: 'demo', reason: 'upload' },
        { project: 'demo', reason: 'applied' },
        { project: 'demo', reason: 'PWA settings' },
    ]);
});
