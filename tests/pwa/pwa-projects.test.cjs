const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const AdmZip = require('adm-zip');
const { PwaProjects, SW_TEMPLATE } = require('../../src/pwa/pwa-projects.cjs');
async function fixture(t, name = 'game') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-pwa-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'public'),
        runtime = path.join(dir, 'runtime'),
        projects = path.join(dir, 'projects');
    await fs.mkdir(root, { recursive: true });
    const base = path.join(projects, name, 'pwa-base');
    await fs.mkdir(path.join(base, 'icons'), { recursive: true });
    const manifest = {
        id: './',
        scope: './',
        start_url: './',
        name: 'Game',
        icons: [{ src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    };
    await fs.writeFile(
        path.join(base, 'manifest.webmanifest'),
        JSON.stringify(manifest),
    );
    await fs.writeFile(path.join(base, 'icons/icon.svg'), '<svg/>');
    const pwa = new PwaProjects(root, runtime, projects),
        uploads = await pwa.directory(name);
    const source = path.join(uploads, 'a.html');
    await fs.writeFile(
        source,
        "<html><script>const PWA_BUILD_ID = 'build1';</script></html>",
    );
    return { pwa, root, runtime, projects, base, uploads, source, name };
}
test('PWA project detection and private uploads are generic', async (t) => {
    const f = await fixture(t, 'other-game');
    assert.equal(await f.pwa.enabled('other-game'), true);
    assert.equal(await f.pwa.enabled('ordinary'), false);
    assert.equal(
        await f.pwa.directory('ordinary'),
        path.join(f.root, 'ordinary'),
    );
    assert.equal(f.uploads, path.join(f.projects, 'other-game', 'uploads'));
    await assert.rejects(f.pwa.directory('../escape'), { code: 'PWA_INVALID' });
});
test('immutable release preserves HTML/assets and synchronizes version and worker', async (t) => {
    const f = await fixture(t);
    const release = await f.pwa.resolve(f.name);
    assert.deepEqual(
        await fs.readFile(path.join(release.root, 'index.html')),
        await fs.readFile(f.source),
    );
    assert.equal(
        await fs.readFile(path.join(release.root, 'icons/icon.svg'), 'utf8'),
        '<svg/>',
    );
    assert.deepEqual(
        await fs.readFile(path.join(release.root, 'manifest.webmanifest')),
        await fs.readFile(path.join(f.base, 'manifest.webmanifest')),
    );
    assert.equal(
        JSON.parse(await fs.readFile(path.join(release.root, 'version.json')))
            .build,
        'build1',
    );
    const sw = await fs.readFile(path.join(release.root, 'sw.js'), 'utf8');
    assert.ok(sw.includes(release.id));
    new vm.Script(sw);
    assert.ok(!sw.includes('__PWA_'));
    assert.ok(sw.includes('self.registration.scope'));
    assert.ok(sw.includes('key.startsWith(PREFIX)'));
    assert.equal((await f.pwa.readActive(f.name)).id, release.id);
    const restarted = new PwaProjects(f.root, f.runtime, f.projects);
    assert.equal((await restarted.resolve(f.name)).id, release.id);
});
test('same build HTML edits and base edits create distinct releases', async (t) => {
    const f = await fixture(t);
    const first = await f.pwa.resolve(f.name);
    await fs.appendFile(f.source, 'new');
    const second = await f.pwa.resolve(f.name);
    assert.notEqual(first.id, second.id);
    assert.equal(first.build, second.build);
    assert.ok(
        !(
            await fs.readFile(path.join(first.root, 'index.html'), 'utf8')
        ).endsWith('new'),
    );
    await fs.writeFile(path.join(f.base, 'icons/icon.svg'), '<svg>new</svg>');
    const third = await f.pwa.resolve(f.name);
    assert.notEqual(second.id, third.id);
});
test('invalid newest HTML leaves last good active pointer unchanged', async (t) => {
    const f = await fixture(t);
    const first = await f.pwa.resolve(f.name);
    const bad = path.join(f.uploads, 'bad.html');
    await fs.writeFile(
        bad,
        "<script>const PWA_BUILD_ID='one';</script><script>const PWA_BUILD_ID='two';</script>",
    );
    await fs.utimes(bad, new Date(), new Date(Date.now() + 5000));
    await assert.rejects(f.pwa.resolve(f.name), { code: 'PWA_INVALID' });
    assert.equal((await f.pwa.readActive(f.name)).id, first.id);
    await fs.writeFile(
        bad,
        "<script>const PWA_BUILD_ID='one';</script><script>const PWA_BUILD_ID='two';</script>",
    );
    await assert.rejects(f.pwa.resolve(f.name), { code: 'PWA_INVALID' });
});
test('prepare does not activate and concurrent resolves produce complete release', async (t) => {
    const f = await fixture(t);
    const prepared = await f.pwa.prepare(f.name, f.source);
    assert.equal(await f.pwa.readActive(f.name), null);
    const results = await Promise.all([
        f.pwa.resolve(f.name),
        f.pwa.resolve(f.name),
    ]);
    assert.equal(results[0].id, prepared.id);
    assert.equal(results[1].id, prepared.id);
});
test('manifest cannot escape project scope', async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
        path.join(f.base, 'manifest.webmanifest'),
        JSON.stringify({ scope: '/' }),
    );
    await assert.rejects(f.pwa.resolve(f.name), { code: 'PWA_INVALID' });
});
test('HTTP serves generated index, manifest, worker and icons but not private sources', async (t) => {
    const cleanups = [];
    const f = await fixture({ after: (fn) => cleanups.push(fn) });
    await fs.mkdir(path.join(f.root, f.name));
    await fs.writeFile(path.join(f.root, f.name, 'old.html'), 'OLD PUBLIC');
    const child = spawn(
        process.execPath,
        [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
        {
            env: {
                ...process.env,
                HTML_SHARE_ROOT: f.root,
                HTML_SHARE_RUNTIME: f.runtime,
                HTML_SHARE_PROJECTS_ROOT: f.projects,
                HTML_SHARE_ZIP_CACHE: path.join(f.runtime, 'zip-cache'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    t.after(async () => {
        if (child.exitCode === null) {
            const done = once(child, 'close');
            child.kill();
            await done;
        }
        for (const cleanup of cleanups) await cleanup();
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Server timeout')),
            10000,
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const match = output.match(/127\.0\.0\.1:(\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('Server exit ' + code));
        });
    });
    const base = 'http://127.0.0.1:' + port + '/game/';
    const main = await fetch(base);
    assert.equal(main.status, 200);
    assert.equal(await main.text(), await fs.readFile(f.source, 'utf8'));
    assert.equal(
        await (await fetch(base + 'index.html')).text(),
        await fs.readFile(f.source, 'utf8'),
    );
    assert.match(
        (await fetch(base + 'manifest.webmanifest')).headers.get(
            'content-type',
        ),
        /application\/manifest\+json/,
    );
    assert.equal((await fetch(base + 'icons/icon.svg')).status, 200);
    assert.equal((await fetch(base + 'sw.js')).status, 200);
    for (const file of [
        'old.html',
        'a.html',
        'active.json',
        'release.json',
        'sw.template.js',
        'uploads/a.html',
    ])
        assert.equal((await fetch(base + file)).status, 404, file);
    await f.pwa.configure('game', {
        ...(await f.pwa.settings('game')),
        enabled: false,
    });
    assert.equal(
        await (await fetch(base)).text(),
        await fs.readFile(f.source, 'utf8'),
    );
    assert.equal((await fetch(base + 'a.html')).status, 200);
    assert.equal((await fetch(base + 'old.html')).status, 404);
});
test('worker offline query fallback stays within its own cache and only documents/version', async () => {
    const listeners = {},
        scope = 'https://example.test/game/',
        seen = [];
    const stored = new Map([
        [scope + 'index.html', { kind: 'html' }],
        [scope + 'version.json', { kind: 'version' }],
        [scope + 'data.json', { kind: 'private-data' }],
    ]);
    const cache = {
        match: async (request, options) => {
            let url = typeof request === 'string' ? request : request.url;
            if (options?.ignoreSearch) {
                url = url.split('?')[0];
            }
            return stored.get(url);
        },
    };
    const script = SW_TEMPLATE.replaceAll(
        '__PWA_CACHE_NAME__',
        JSON.stringify('html-share:game:release:abc'),
    ).replaceAll('__PWA_PRECACHE__', '[]');
    vm.runInNewContext(script, {
        URL,
        Request,
        Headers,
        self: {
            registration: { scope },
            location: { origin: 'https://example.test' },
            addEventListener: (name, fn) => (listeners[name] = fn),
        },
        caches: {
            open: async (name) => {
                seen.push(name);
                return cache;
            },
        },
        fetch: async () => {
            throw new Error('offline');
        },
    });
    const request = (tail, mode = 'cors') => {
        let result;
        listeners.fetch({
            request: { method: 'GET', url: scope + tail, headers: {}, mode },
            respondWith: (promise) => (result = promise),
        });
        return result;
    };
    assert.equal((await request('version.json?t=123')).kind, 'version');
    assert.equal((await request('?v=123', 'navigate')).kind, 'html');
    await assert.rejects(request('data.json?t=123'));
    assert.ok(
        seen.every((key) =>
            key.startsWith(
                'html-share:game:' + encodeURIComponent(scope) + ':',
            ),
        ),
    );
});
test('shared metadata creates generic PWA without changing stored HTML; updates and disable preserve sources', async (t) => {
    const f = await fixture(t);
    const ordinary = path.join(f.root, 'plain');
    await fs.mkdir(ordinary);
    const raw =
        '<!doctype html><html><head><title>Hello</title></head><body>Hi</body></html>';
    await fs.writeFile(path.join(ordinary, 'hello.html'), raw);
    const original = await f.pwa.settings('plain');
    assert.equal(original.enabled, false);
    const settings = await f.pwa.configure('plain', {
        ...original,
        enabled: true,
        name: 'Phone app',
    });
    assert.equal(await f.pwa.managed('plain'), true);
    const active = await f.pwa.resolve('plain');
    assert.match(active.build, /^[a-f0-9]{16}$/);
    const generated = await fs.readFile(
        path.join(active.root, 'index.html'),
        'utf8',
    );
    assert.match(generated, /pwa-register\.js/);
    assert.match(generated, /manifest\.webmanifest/);
    assert.equal(
        await fs.readFile(
            path.join(await f.pwa.directory('plain'), 'hello.html'),
            'utf8',
        ),
        raw,
    );
    assert.equal(
        await fs.readFile(path.join(ordinary, 'hello.html'), 'utf8'),
        raw,
    );
    const manifest = JSON.parse(
        await fs.readFile(path.join(active.root, 'manifest.json')),
    );
    assert.equal(manifest.name, 'Phone app');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.id, '/plain/');
    assert.match(generated, /rel="manifest"[^>]*crossorigin="use-credentials"/);
    const changed = await f.pwa.configure('plain', {
        ...settings,
        name: 'Renamed',
    });
    assert.notEqual((await f.pwa.readActive('plain')).id, active.id);
    await assert.rejects(
        f.pwa.configure('plain', { ...settings, name: 'Stale' }),
        { code: 'PWA_CONFLICT' },
    );
    await assert.rejects(
        f.pwa.configure('plain', { ...changed, themeColor: 'javascript:bad' }),
        { code: 'PWA_INVALID' },
    );
    assert.equal((await f.pwa.settings('plain')).name, 'Renamed');
    await f.pwa.configure('plain', { ...changed, enabled: false });
    assert.equal(await f.pwa.enabled('plain'), false);
    assert.equal(await f.pwa.managed('plain'), true);
    assert.equal(
        await fs.readFile(
            path.join(await f.pwa.directory('plain'), 'hello.html'),
            'utf8',
        ),
        raw,
    );
});
test('first enable imports selected ZIP safely and failed initial config stays ordinary', async (t) => {
    const f = await fixture(t);
    const folder = path.join(f.root, 'packed');
    await fs.mkdir(folder);
    const zip = new AdmZip();
    zip.addFile('site/index.html', Buffer.from('<html>ZIP PAGE</html>'));
    zip.addFile('site/style.css', Buffer.from('body{color:red}'));
    await fs.writeFile(path.join(folder, 'new.zip'), zip.toBuffer());
    await f.pwa.configure('packed', {
        ...(await f.pwa.settings('packed')),
        enabled: true,
    });
    const active = await f.pwa.resolve('packed');
    assert.match(
        await fs.readFile(path.join(active.root, 'index.html'), 'utf8'),
        /ZIP PAGE/,
    );
    assert.equal(
        await fs.readFile(path.join(active.root, 'style.css'), 'utf8'),
        'body{color:red}',
    );
    assert.ok(await fs.stat(path.join(folder, 'new.zip')));
    const bad = path.join(f.root, 'broken');
    await fs.mkdir(bad);
    await fs.writeFile(path.join(bad, 'bad.zip'), 'not zip');
    await assert.rejects(
        f.pwa.configure('broken', {
            ...(await f.pwa.settings('broken')),
            enabled: true,
        }),
    );
    assert.equal(await f.pwa.managed('broken'), false);
    assert.equal(await f.pwa.enabled('broken'), false);
});
test('legacy conversion preserves install metadata and shared template changes rebuild', async (t) => {
    const f = await fixture(t);
    const file = path.join(f.base, 'manifest.webmanifest');
    const legacy = JSON.parse(await fs.readFile(file));
    legacy.orientation = 'portrait';
    legacy.lang = 'ko';
    await fs.writeFile(file, JSON.stringify(legacy));
    f.pwa.templateRoot = path.join(f.runtime, 'test-template');
    await fs.mkdir(f.pwa.templateRoot, { recursive: true });
    await fs.writeFile(
        path.join(f.pwa.templateRoot, 'sw.template.js'),
        SW_TEMPLATE,
    );
    await f.pwa.configure('game', {
        ...(await f.pwa.settings('game')),
        enabled: true,
    });
    const first = await f.pwa.resolve('game');
    const manifest = JSON.parse(
        await fs.readFile(path.join(first.root, 'manifest.json')),
    );
    assert.equal(manifest.orientation, 'portrait');
    assert.equal(manifest.lang, 'ko');
    assert.deepEqual(manifest.icons, legacy.icons);
    assert.equal(manifest.id, '/game/');
    await fs.appendFile(
        path.join(f.pwa.templateRoot, 'sw.template.js'),
        '\n// template v2',
    );
    const second = await f.pwa.resolve('game');
    assert.notEqual(first.id, second.id);
    assert.equal(first.build, second.build);
});
test('worker install drains fetched bodies before waiting for queued connections', async () => {
    const listeners = {},
        scope = 'https://example.test/game/';
    let calls = 0,
        releaseQueued,
        drained = 0;
    const response = {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
    };
    const script = SW_TEMPLATE.replaceAll(
        '__PWA_CACHE_NAME__',
        JSON.stringify('html-share:game:release:abc'),
    ).replaceAll(
        '__PWA_PRECACHE__',
        JSON.stringify(['icons/a.png', 'icons/b.png']),
    );
    vm.runInNewContext(script, {
        URL,
        Request,
        Headers,
        self: {
            registration: { scope },
            addEventListener: (name, fn) => (listeners[name] = fn),
        },
        caches: {
            open: async () => ({
                put: async () => {
                    drained++;
                    if (releaseQueued) releaseQueued(response);
                },
            }),
        },
        fetch: async () => {
            calls++;
            if (calls === 1) return response;
            return new Promise((resolve) => (releaseQueued = resolve));
        },
    });
    let done;
    listeners.install({ waitUntil: (promise) => (done = promise) });
    let timer;
    try {
        await Promise.race([
            done,
            new Promise(
                (_, reject) =>
                    (timer = setTimeout(
                        () =>
                            reject(
                                new Error('Precache waits for unread bodies'),
                            ),
                        1000,
                    )),
            ),
        ]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(drained, 2);
});
test('build IDs come only from executable inline JS declarations, with comments and strings ignored', async (t) => {
    const f = await fixture(t);
    const source = `<!doctype html>
    <p>const PWA_BUILD_ID='paragraph';</p>
    <!-- <script>const PWA_BUILD_ID='comment';</script> -->
    <template><script>const PWA_BUILD_ID='inert-template';</script></template>
    <script type="application/json">{"example":"const PWA_BUILD_ID='json';"}</script>
    <script src="other.js">const PWA_BUILD_ID='external-fallback';</script>
    <script type="module">
      /* const PWA_BUILD_ID='old'; */
      const sample="const PWA_BUILD_ID='string';";
      export const unused=1, PWA_BUILD_ID='actual-module';
    </script>`;
    await fs.writeFile(f.source, source);
    const result = await f.pwa.resolve(f.name);
    assert.equal(result.build, 'actual-module');
    await fs.writeFile(
        f.source,
        "<script>const PWA_BUILD_ID='one';</script><script type='module'>const PWA_BUILD_ID='two';</script>",
    );
    await assert.rejects(f.pwa.resolve(f.name), { code: 'PWA_INVALID' });
    assert.equal((await f.pwa.readActive(f.name)).id, result.id);
    await fs.writeFile(f.source, '<script>const broken = ;</script>');
    await assert.rejects(
        f.pwa.resolve(f.name),
        (error) =>
            error.code === 'PWA_INVALID' &&
            /Inline JavaScript syntax error/.test(error.message),
    );
    assert.equal((await f.pwa.readActive(f.name)).id, result.id);
});
test('disabled ZIP-only project imports its latest archive when enabled, including new off-mode ZIP uploads', async (t) => {
    const f = await fixture(t);
    const folder = path.join(f.root, 'packed-later');
    await fs.mkdir(folder);
    const putZip = async (directory, name, text, color) => {
        const zip = new AdmZip();
        zip.addFile('index.html', Buffer.from('<h1>' + text + '</h1>'));
        zip.addFile('style.css', Buffer.from(color));
        const file = path.join(directory, name);
        await fs.writeFile(file, zip.toBuffer());
        return file;
    };
    await putZip(folder, 'one.zip', 'first', 'red');
    const off = await f.pwa.configure('packed-later', {
        ...(await f.pwa.settings('packed-later')),
        enabled: false,
    });
    const enabled = await f.pwa.configure('packed-later', {
        ...off,
        enabled: true,
    });
    const first = await f.pwa.resolve('packed-later');
    assert.match(
        await fs.readFile(path.join(first.root, 'index.html'), 'utf8'),
        /first/,
    );
    assert.ok(await fs.stat(path.join(folder, 'one.zip')));
    const disabled = await f.pwa.configure('packed-later', {
        ...enabled,
        enabled: false,
    });
    const directory = await f.pwa.directory('packed-later');
    const nextZip = await putZip(directory, 'two.zip', 'second', 'blue');
    await fs.utimes(nextZip, new Date(), new Date(Date.now() + 10000));
    await f.pwa.configure('packed-later', { ...disabled, enabled: true });
    const second = await f.pwa.resolve('packed-later');
    assert.match(
        await fs.readFile(path.join(second.root, 'index.html'), 'utf8'),
        /second/,
    );
    assert.equal(
        await fs.readFile(path.join(second.root, 'style.css'), 'utf8'),
        'blue',
    );
    assert.equal(
        await fs.readFile(path.join(first.root, 'style.css'), 'utf8'),
        'red',
    );
    assert.ok(await fs.stat(nextZip));
});
test('nested ZIP conversion rejects before publishing settings or moving originals', async (t) => {
    const f = await fixture(t);
    const folder = path.join(f.root, 'nested');
    await fs.mkdir(folder);
    const zip = new AdmZip();
    zip.addFile(
        'pages/index.html',
        Buffer.from('<script src="../assets/app.js"></script>'),
    );
    zip.addFile('assets/app.js', Buffer.from('console.log("asset")'));
    const file = path.join(folder, 'nested.zip');
    await fs.writeFile(file, zip.toBuffer());
    const before = await fs.readFile(file);
    await assert.rejects(
        f.pwa.configure('nested', {
            ...(await f.pwa.settings('nested')),
            enabled: true,
        }),
        (error) =>
            error.code === 'PWA_INVALID' &&
            /Move the entry HTML/.test(error.message),
    );
    assert.equal(await f.pwa.managed('nested'), false);
    assert.deepEqual(await fs.readFile(file), before);
});
test('failed ZIP build and failed activation restore the prior settings, sources, assets and active release', async (t) => {
    const f = await fixture(t);
    const initial = await f.pwa.configure(f.name, {
        ...(await f.pwa.settings(f.name)),
        enabled: true,
    });
    const good = await f.pwa.resolve(f.name);
    const off = await f.pwa.configure(f.name, { ...initial, enabled: false });
    const makeZip = async (text) => {
        const zip = new AdmZip();
        zip.addFile('index.html', Buffer.from(text));
        zip.addFile('icons/icon.svg', Buffer.from('new-icon'));
        const file = path.join(f.uploads, 'latest.zip');
        await fs.writeFile(file, zip.toBuffer());
        await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
        return file;
    };
    const file = await makeZip('<script>const broken = ;</script>');
    const originals = await fs.readdir(f.uploads);
    await assert.rejects(f.pwa.configure(f.name, { ...off, enabled: true }), {
        code: 'PWA_INVALID',
    });
    assert.deepEqual(await fs.readdir(f.uploads), originals);
    assert.deepEqual(await f.pwa.settings(f.name), off);
    assert.equal((await f.pwa.readActive(f.name)).id, good.id);
    assert.equal(
        await fs.readFile(
            path.join(f.projects, f.name, 'pwa-assets/icons/icon.svg'),
            'utf8',
        ),
        '<svg/>',
    );
    await makeZip('<h1>valid import</h1>');
    const activate = f.pwa._activate.bind(f.pwa);
    let failure = true;
    f.pwa._activate = async (...args) => {
        if (failure) {
            failure = false;
            throw new Error('simulated pointer write failure');
        }
        return activate(...args);
    };
    await assert.rejects(
        f.pwa.configure(f.name, { ...off, enabled: true }),
        /simulated pointer/,
    );
    assert.deepEqual(await fs.readdir(f.uploads), originals);
    assert.deepEqual(await f.pwa.settings(f.name), off);
    assert.equal((await f.pwa.readActive(f.name)).id, good.id);
    assert.ok(await fs.stat(file));
    assert.equal(
        await fs.readFile(
            path.join(f.projects, f.name, 'pwa-assets/icons/icon.svg'),
            'utf8',
        ),
        '<svg/>',
    );
});
