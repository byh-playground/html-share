const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { managementPath } = require('../../src/management/management-route.cjs');

test('management creates a project without replacing an existing project', async (t) => {
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-project-test-'),
    );
    const root = path.join(fixture, 'public');
    const runtime = path.join(fixture, 'runtime');
    const projectsRoot = path.join(fixture, 'projects');
    const token = 'a'.repeat(64);
    await fs.mkdir(path.join(root, 'upload'), { recursive: true });
    await fs.mkdir(path.join(root, 'existing'));
    await fs.mkdir(runtime);
    await fs.writeFile(path.join(root, 'existing', 'index.html'), 'ORIGINAL');
    await fs.writeFile(path.join(root, 'upload', 'index.html'), 'MANAGE');
    await fs.writeFile(
        path.join(runtime, 'upload-auth.json'),
        JSON.stringify({ token }),
    );
    const child = spawn(
        process.execPath,
        [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
        {
            env: {
                ...process.env,
                HTML_SHARE_ROOT: root,
                HTML_SHARE_RUNTIME: runtime,
                HTML_SHARE_PROJECTS_ROOT: projectsRoot,
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
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(Error('server start timeout')),
            10000,
        );
        child.stdout.on('data', (data) => {
            const match = String(data).match(/127\.0\.0\.1:(\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(Error('server exited ' + code));
        });
    });
    const base = `http://127.0.0.1:${port}`;
    const api = base + managementPath(token) + 'api/';
    const auth = { Authorization: `Bearer ${token}` };
    const create = (name, displayName, headers = auth) =>
        fetch(api + 'projects', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, displayName }),
        });

    assert.equal(
        (await create('bloom-rpg', '블룸 · 수관 원정', {})).status,
        401,
    );
    assert.equal(
        (
            await create('bloom-rpg', '블룸 · 수관 원정', {
                ...auth,
                Origin: 'https://untrusted.example',
            })
        ).status,
        403,
    );
    assert.equal((await create('upload', 'Reserved')).status, 400);
    assert.equal((await create('bad/name', 'Invalid')).status, 400);
    assert.equal((await create('another', 'Bad\u202elabel')).status, 400);
    await assert.rejects(fs.lstat(path.join(root, 'bloom-rpg')), {
        code: 'ENOENT',
    });
    assert.equal((await create('existing', 'Changed')).status, 409);
    assert.equal(
        await fs.readFile(path.join(root, 'existing', 'index.html'), 'utf8'),
        'ORIGINAL',
    );
    const created = await create('bloom-rpg', '블룸 · 수관 원정');
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
        name: 'bloom-rpg',
        displayName: '블룸 · 수관 원정',
    });
    assert.equal(
        (await fs.lstat(path.join(root, 'bloom-rpg'))).isDirectory(),
        true,
    );
    assert.equal((await create('bloom-rpg', 'Other')).status, 409);
    assert.deepEqual(
        (await (await fetch(api + 'projects', { headers: auth })).json())
            .projects,
        [
            { name: 'bloom-rpg', displayName: '블룸 · 수관 원정' },
            { name: 'existing', displayName: 'existing' },
        ],
    );
    const html = Buffer.from('<!doctype html><title>New project</title>');
    const upload = await fetch(
        api +
            'file?' +
            new URLSearchParams({
                project: 'bloom-rpg',
                filename: 'index.html',
            }),
        {
            method: 'PUT',
            headers: {
                ...auth,
                'Content-Type': 'application/octet-stream',
            },
            body: html,
        },
    );
    assert.equal(upload.status, 201);
    assert.deepEqual(
        await fs.readFile(path.join(root, 'bloom-rpg', 'index.html')),
        html,
    );
});
