const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const {
    managementPath,
    readManagementToken,
} = require('../../src/management/management-route.cjs');

test('opaque management routes stay private, authenticated and stable across restarts', async (t) => {
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'management-route-test-'),
    );
    const root = path.join(fixture, 'public'),
        runtime = path.join(fixture, 'runtime'),
        adminRoot = path.join(fixture, 'admin');
    for (const name of [
        'example',
        'upload',
        'admin',
        'manage',
        'api',
        '_manage',
    ])
        await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.mkdir(runtime);
    await fs.mkdir(adminRoot);
    await fs.writeFile(
        path.join(root, 'example', 'hello.html'),
        '<a href="style.css">CSS</a><script src="app.js"></script>',
    );
    await fs.writeFile(
        path.join(root, 'example', 'style.css'),
        'body {color: red}',
    );
    await fs.writeFile(
        path.join(root, 'example', 'app.js'),
        'console.log("example")',
    );
    await fs.writeFile(
        path.join(root, 'upload', 'index.html'),
        'OLD ADMIN DO NOT EXPOSE',
    );
    await fs.writeFile(
        path.join(adminRoot, 'index.html'),
        '<link rel="stylesheet" href="style.css"><script src="app.js"></script>ADMIN',
    );
    await fs.writeFile(
        path.join(adminRoot, 'app.js'),
        'fetch("./api/projects")',
    );
    await fs.writeFile(path.join(adminRoot, 'style.css'), 'body {color: blue}');
    const token = 'd'.repeat(64),
        route = managementPath(token),
        headers = { Authorization: 'Bearer ' + token };
    await fs.writeFile(
        path.join(runtime, 'upload-auth.json'),
        '\uFEFF' + JSON.stringify({ token }),
    );
    assert.equal(
        await readManagementToken(runtime),
        process.env.HTML_SHARE_UPLOAD_TOKEN || token,
    );
    assert.match(route, /^\/_manage\/[a-f0-9]{32}\/$/);
    assert.equal(managementPath(token), route);
    assert.ok(!route.includes(token));
    let child;
    async function start() {
        child = spawn(
            process.execPath,
            [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
            {
                env: {
                    ...process.env,
                    HTML_SHARE_UPLOAD_TOKEN: '',
                    HTML_SHARE_ROOT: root,
                    HTML_SHARE_RUNTIME: runtime,
                    HTML_SHARE_ADMIN_ROOT: adminRoot,
                    HTML_SHARE_PROJECTS_ROOT: path.join(fixture, 'projects'),
                    HTML_SHARE_ZIP_CACHE: path.join(runtime, 'cache'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(Error('server timeout')),
                10000,
            );
            child.stdout.on('data', (data) => {
                const match = String(data).match(/127\.0\.0\.1:(\d+)/);
                if (match) {
                    clearTimeout(timer);
                    resolve('http://127.0.0.1:' + match[1]);
                }
            });
            child.on('exit', (code) => {
                clearTimeout(timer);
                reject(Error('server exit ' + code));
            });
        });
    }
    async function stop() {
        if (child && child.exitCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
    }
    t.after(async () => {
        await stop();
        assert.equal(path.dirname(fixture), os.tmpdir());
        await fs.rm(fixture, { recursive: true, force: true });
    });
    let base = await start();
    await t.test(
        'public crawler finds projects but neither credentials nor admin links',
        async () => {
            const rootPage = await (await fetch(base + '/')).text();
            assert.match(rootPage, /example/);
            assert.doesNotMatch(rootPage, /upload|admin|_manage|manage\//);
            for (const url of [
                '/',
                '/example/',
                '/example/style.css',
                '/example/app.js',
            ]) {
                const response = await fetch(base + url);
                assert.equal(response.status, 200);
                const text = await response.text();
                assert.ok(!text.includes(token));
                assert.ok(!text.includes(route));
            }
            for (const guess of [
                '/upload',
                '/upload/',
                '/upload/index.html',
                '/upload/api/projects',
                '/admin/',
                '/manage/',
                '/api/',
                '/_manage',
                '/_manage/',
                '/_manage/' + '0'.repeat(32) + '/',
                '/robots.txt',
                '/sitemap.xml',
                '/runtime/upload-auth.json',
            ]) {
                const response = await fetch(base + guess, {
                    redirect: 'manual',
                });
                assert.equal(response.status, 404, guess);
                assert.equal(response.headers.get('location'), null);
                assert.ok(!(await response.text()).includes(route));
            }
            for (const guess of [
                '/upload/api/projects',
                '/admin/',
                '/_manage/',
            ])
                assert.equal(
                    (await fetch(base + guess, { method: 'POST' })).status,
                    404,
                );
        },
    );
    await t.test(
        'known route exposes only exact UI assets and authenticated APIs',
        async () => {
            for (const asset of ['', 'index.html', 'app.js', 'style.css']) {
                const response = await fetch(base + route + asset);
                assert.equal(response.status, 200);
                assert.match(
                    response.headers.get('content-security-policy'),
                    /worker-src 'none'/,
                );
                assert.equal(
                    response.headers.get('referrer-policy'),
                    'no-referrer',
                );
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.ok(!(await response.text()).includes(token));
            }
            assert.equal(
                (await fetch(base + route + 'api/projects')).status,
                401,
            );
            assert.equal(
                (
                    await fetch(base + route + 'api/projects', {
                        headers: { Authorization: 'Bearer wrong' },
                    })
                ).status,
                401,
            );
            assert.deepEqual(
                await (
                    await fetch(base + route + 'api/projects', { headers })
                ).json(),
                { projects: [{ name: 'example' }] },
            );
            assert.equal(
                (
                    await fetch(base + route + 'api/projects', {
                        headers: { ...headers, Origin: 'https://evil.example' },
                    })
                ).status,
                403,
            );
            assert.equal(
                (
                    await fetch(base + route + 'api/file', {
                        method: 'DELETE',
                        headers,
                    })
                ).status,
                405,
            );
            assert.equal(
                (
                    await fetch(base + route + 'app.js', {
                        headers: { 'Service-Worker': 'script' },
                    })
                ).status,
                403,
            );
            for (const suffix of [
                'upload-auth.json',
                '../upload-auth.json',
                'extra.js',
            ])
                assert.equal((await fetch(base + route + suffix)).status, 404);
            assert.equal(
                (await fetch(base + route.replace('/_manage/', '/%5fmanage/')))
                    .status,
                404,
            );
            assert.equal(
                (await fetch(base + route.slice(0, -1), { redirect: 'manual' }))
                    .status,
                404,
            );
        },
    );
    await t.test(
        'restarting keeps the same route without rewriting the token file',
        async () => {
            const before = await fs.readFile(
                path.join(runtime, 'upload-auth.json'),
                'utf8',
            );
            await stop();
            base = await start();
            assert.equal((await fetch(base + route)).status, 200);
            assert.equal(
                (await fetch(base + route + 'api/projects', { headers }))
                    .status,
                200,
            );
            assert.equal(
                await fs.readFile(
                    path.join(runtime, 'upload-auth.json'),
                    'utf8',
                ),
                before,
            );
            await fs.unlink(path.join(runtime, 'upload-auth.json'));
            assert.equal((await fetch(base + route)).status, 404);
            await assert.rejects(
                fs.stat(path.join(runtime, 'upload-auth.json')),
                { code: 'ENOENT' },
            );
        },
    );
});
