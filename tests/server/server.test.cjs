const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('static HTML projects', async (t) => {
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-share-test-'),
    );
    const root = path.join(fixture, 'public');
    await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
    await fs.mkdir(path.join(root, 'beta'));
    await fs.mkdir(path.join(root, 'empty'));
    const put = async (name, body, seconds) => {
        const file = path.join(root, name);
        await fs.writeFile(file, body);
        if (seconds !== undefined) await fs.utimes(file, seconds, seconds);
    };
    await put('alpha/index.html', 'OLD INDEX', 1000);
    await put(
        'alpha/arbitrary name.htm',
        '<link href="style.css">LATEST',
        2000,
    );
    await put('alpha/style.css', 'body{color:red}');
    await put('beta/anything.HTML', 'BETA');
    await put('.secret.html', 'PRIVATE');
    await fs.writeFile(path.join(fixture, 'outside.html'), 'OUTSIDE');
    const child = spawn(
        process.execPath,
        [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
        {
            env: { ...process.env, HTML_SHARE_ROOT: root },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
        // Only remove this test's verified, freshly created temporary fixture.
        assert.equal(path.dirname(fixture), os.tmpdir());
        assert.ok(path.basename(fixture).startsWith('html-share-test-'));
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(
            () => reject(new Error('Server did not start')),
            10000,
        );
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const match = output.match(/127\.0\.0\.1:(\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Server exited: ${code}`));
        });
    });
    const request = (url, method = 'GET') =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { hostname: '127.0.0.1', port, path: url, method },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk) => {
                        body += chunk;
                    });
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            body,
                        }),
                    );
                },
            );
            req.on('error', reject);
            req.end();
        });
    await t.test(
        'latest arbitrary filename beats index; projects stay separate',
        async () => {
            assert.match((await request('/alpha/')).body, /LATEST/);
            assert.equal((await request('/beta/')).body, 'BETA');
            assert.equal(
                (await request('/alpha/index.html')).body,
                'OLD INDEX',
            );
            assert.match((await request('/')).body, /href="\.\/alpha\/"/);
            assert.match(
                (await request('/empty/')).body,
                /HTML 파일을 기다리고/,
            );
        },
    );
    await t.test(
        'edits, additions, deletions and tied mtimes update immediately',
        async () => {
            await put('alpha/index.html', 'UPDATED', 3000);
            assert.equal((await request('/alpha/')).body, 'UPDATED');
            await put('alpha/z.html', 'NEW', 4000);
            assert.equal((await request('/alpha/')).body, 'NEW');
            await put('alpha/a.html', 'TIE WINNER', 4000);
            assert.equal((await request('/alpha/')).body, 'TIE WINNER');
            await fs.unlink(path.join(root, 'alpha/a.html'));
            assert.equal((await request('/alpha/')).body, 'NEW');
            await fs.unlink(path.join(root, 'alpha/z.html'));
            assert.equal((await request('/alpha/')).body, 'UPDATED');
        },
    );
    await t.test(
        'canonical slash, relative assets, HEAD and cache controls',
        async () => {
            const redirect = await request('/alpha?hello=1');
            assert.equal(redirect.status, 301);
            assert.equal(redirect.headers.location, '/alpha/?hello=1');
            assert.equal(
                (await request('/alpha/style.css')).body,
                'body{color:red}',
            );
            const head = await request('/alpha/', 'HEAD');
            assert.equal(head.status, 200);
            assert.equal(head.body, '');
            assert.equal(head.headers['content-length'], '7');
            assert.equal(head.headers['cache-control'], 'no-store');
        },
    );
    await t.test(
        'traversal, hidden files, ADS and backslashes are blocked',
        async () => {
            for (const url of [
                '/../outside.html',
                '/%2e%2e/outside.html',
                '/.secret.html',
                '/alpha%5cindex.html',
                '/alpha/index.html:stream',
            ]) {
                const result = await request(url);
                assert.equal(result.status, 403, url);
                assert.doesNotMatch(result.body, /OUTSIDE|PRIVATE/);
            }
            assert.equal((await request('/%xx')).status, 400);
            assert.equal((await request('/missing')).status, 404);
            assert.equal((await request('/alpha/', 'POST')).status, 405);
        },
    );
    await t.test(
        'outside directory symlinks are neither listed nor served',
        async () => {
            await fs.symlink(
                fixture,
                path.join(root, 'escape'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            assert.equal((await request('/escape/outside.html')).status, 403);
            assert.doesNotMatch((await request('/')).body, /href="\.\/escape/);
        },
    );
    await t.test(
        'untrusted project scripts cannot be registered as service workers',
        async () => {
            await put('alpha/sw.js', 'self.addEventListener("fetch",()=>{});');
            const endpoint = `http://127.0.0.1:${port}/alpha/sw.js`;
            assert.equal((await fetch(endpoint)).status, 200);
            assert.equal(
                (
                    await fetch(endpoint, {
                        headers: { 'Service-Worker': 'script' },
                    })
                ).status,
                403,
            );
        },
    );
    await t.test(
        'root only lists projects even when a root HTML file exists',
        async () => {
            await put('root page.html', 'ROOT PAGE');
            assert.doesNotMatch((await request('/')).body, /root%20page.html/);
            for (const directory of ['alpha', 'beta', 'empty', 'escape']) {
                await fs.rename(
                    path.join(root, directory),
                    path.join(fixture, directory + '-moved'),
                );
            }
            assert.match((await request('/')).body, /HTML 프로젝트/);
            assert.equal(
                (await request('/root%20page.html')).body,
                'ROOT PAGE',
            );
        },
    );
});
