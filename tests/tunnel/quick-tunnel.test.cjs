const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
    urlParser,
    createSupervisor,
} = require('../../scripts/tunnel/quick-tunnel.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
    for (let n = 0; n < 100; n++) {
        if (fn()) return;
        await pause(10);
    }
    assert.fail('timed out');
}
function fixture(t, extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-tunnel-')),
        runtime = path.join(root, '.runtime');
    fs.mkdirSync(runtime);
    const write = (name, value) =>
        fs.writeFileSync(path.join(runtime, name), JSON.stringify(value));
    write('ngrok-state.json', {
        provider: 'cloudflare',
        tunnel: { id: 123 },
        server: { id: 456 },
        url: null,
    });
    write('upload-auth.json', { token: 'a'.repeat(64) });
    write('ntfy.json', { enabled: true, topic: 'test-topic' });
    const children = [];
    const supervisor = createSupervisor({
        root,
        pid: 123,
        exe: 'cloudflared',
        port: 8787,
        retryMs: 10,
        log: () => {},
        launch: (exe, args) => {
            assert.deepEqual(args, [
                'tunnel',
                '--no-autoupdate',
                '--url',
                'http://127.0.0.1:8787',
            ]);
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            children.push(child);
            return child;
        },
        send: async () => ({ ok: true, json: async () => ({ id: 'receipt' }) }),
        ...extra,
    });
    t.after(() => {
        supervisor.stop();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return {
        root,
        runtime,
        write,
        children,
        supervisor,
        read: (name) =>
            JSON.parse(fs.readFileSync(path.join(runtime, name), 'utf8')),
    };
}
test('URL parser recognizes Cloudflare URL split across chunks', () => {
    const urls = [];
    const parse = urlParser((url) => urls.push(url));
    parse('hello https://fresh-');
    parse('address.trycloud');
    assert.equal(urls.length, 0);
    parse('flare.com |\n');
    parse('ordinary connection log\n');
    assert.deepEqual(urls, ['https://fresh-address.trycloudflare.com']);
});
test('publishes URL with retained process fields, retries ntfy and deduplicates repeated logs', async (t) => {
    let calls = 0,
        payload;
    const f = fixture(t, {
        send: async (_url, options) => {
            calls++;
            payload = JSON.parse(options.body);
            return { ok: calls > 1, json: async () => ({ id: 'success' }) };
        },
    });
    await f.supervisor.start();
    f.children[0].stdout.emit(
        'data',
        'https://first.trycloudflare.com\nRegistered tunnel connection\n',
    );
    await until(() => fs.existsSync(path.join(f.runtime, 'ntfy-last.json')));
    assert.equal(calls, 2);
    assert.equal(f.read('ngrok-state.json').server.id, 456);
    assert.equal(
        f.read('ngrok-state.json').url,
        'https://first.trycloudflare.com',
    );
    assert.match(payload.actions[1].url, /#key=a{64}$/);
    assert.equal(f.read('ntfy-last.json').topic, undefined);
    f.children[0].stderr.emit('data', 'https://first.trycloudflare.com\n');
    await pause(30);
    assert.equal(calls, 2);
    f.children[0].emit('exit', 1);
    assert.equal(f.read('ngrok-state.json').url, null);
    await until(() => f.children.length === 2);
    f.children[1].stdout.emit(
        'data',
        'https://second.trycloudflare.com\nRegistered tunnel connection\n',
    );
    await until(
        () =>
            f.read('ntfy-last.json').url === 'https://second.trycloudflare.com',
    );
    assert.equal(calls, 3);
});
test('does not replace state owned by a newer process or recreate deleted state', async (t) => {
    const f = fixture(t);
    f.write('ngrok-state.json', {
        provider: 'cloudflare',
        tunnel: { id: 999 },
        url: 'https://new.trycloudflare.com',
    });
    await f.supervisor.acceptUrl('https://old.trycloudflare.com');
    assert.equal(f.read('ngrok-state.json').tunnel.id, 999);
    fs.unlinkSync(path.join(f.runtime, 'ngrok-state.json'));
    await f.supervisor.acceptUrl('https://old.trycloudflare.com');
    assert.equal(
        fs.existsSync(path.join(f.runtime, 'ngrok-state.json')),
        false,
    );
});
test('disabled ntfy cancels failed-send retries and obsolete URL is not retried', async (t) => {
    const sent = [];
    const f = fixture(t, {
        send: async (_url, options) => {
            sent.push(JSON.parse(options.body).click);
            return { ok: false };
        },
    });
    await f.supervisor.acceptUrl('https://old.trycloudflare.com');
    await until(() => sent.length === 1);
    f.write('ntfy.json', { enabled: false, topic: 'test-topic' });
    await pause(40);
    assert.equal(sent.length, 1);
    f.write('ntfy.json', { enabled: true, topic: 'test-topic' });
    await f.supervisor.acceptUrl('https://new.trycloudflare.com');
    await until(() => sent.length >= 3);
    assert.ok(
        sent.slice(1).every((url) => url === 'https://new.trycloudflare.com'),
    );
});
test('waits for registration, consumes old URLs, and stop cancels restart', async (t) => {
    const f = fixture(t);
    await f.supervisor.start();
    const child = f.children[0];
    child.stdout.emit('data', 'https://first.trycloudflare.com\n');
    await pause(20);
    assert.equal(f.read('ngrok-state.json').url, null);
    child.stderr.emit('data', 'Registered tunnel connection\n');
    await until(
        () =>
            f.read('ngrok-state.json').url ===
            'https://first.trycloudflare.com',
    );
    child.stdout.emit('data', 'https://second.trycloudflare.com\n');
    await until(
        () =>
            f.read('ngrok-state.json').url ===
            'https://second.trycloudflare.com',
    );
    child.stdout.emit('data', 'connection healthy\n');
    await pause(20);
    assert.equal(
        f.read('ngrok-state.json').url,
        'https://second.trycloudflare.com',
    );
    child.emit('exit', 1);
    f.supervisor.stop();
    await pause(40);
    assert.equal(f.children.length, 1);
});
test('parser rejects host suffix across chunk boundaries', () => {
    const urls = [];
    const parse = urlParser((url) => urls.push(url));
    parse('https://fake.trycloudflare.com');
    parse('.evil.example\n');
    assert.deepEqual(urls, []);
});

test('optional ntfy missing configuration stays silent without retrying', async (t) => {
    const logs = [];
    let sends = 0;
    const f = fixture(t, {
        log: (message) => logs.push(message),
        send: async () => {
            sends++;
            throw Error('must not send');
        },
    });
    fs.unlinkSync(path.join(f.runtime, 'ntfy.json'));
    await f.supervisor.acceptUrl('https://optional.trycloudflare.com');
    await pause(70);
    assert.equal(sends, 0);
    assert.equal(logs.filter((message) => message.includes('ntfy')).length, 0);
    assert.equal(
        f.read('ngrok-state.json').url,
        'https://optional.trycloudflare.com',
    );
});
