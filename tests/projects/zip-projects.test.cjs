const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const AdmZip = require('adm-zip');
const { ZipProjects, LIMITS } = require('../../src/projects/zip-projects.cjs');

test('ZIP entry count is rejected before materializing entry objects', async (t) => {
    const vm = require('node:vm');
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-zip-count-test-'),
    );
    t.after(async () => {
        assert.equal(path.dirname(fixture), os.tmpdir());
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const zip = new AdmZip();
    for (let i = 0; i < 8; i++)
        zip.addFile(`page-${i}.html`, Buffer.from('test'));
    const archive = path.join(fixture, 'many.zip');
    await fs.writeFile(archive, zip.toBuffer());
    let materialized = false;
    const module = { exports: {} };
    vm.runInNewContext(
        await fs.readFile(
            path.join(repositoryRoot, 'src/projects/zip-projects.cjs'),
            'utf8',
        ),
        {
            module,
            require: (name) =>
                name === 'adm-zip'
                    ? function (data) {
                          const parsed = new AdmZip(data);
                          const original = parsed.getEntries;
                          parsed.getEntries = () => {
                              materialized = true;
                              return original.call(parsed);
                          };
                          return parsed;
                      }
                    : require(name),
        },
    );
    await assert.rejects(
        new module.exports.ZipProjects(path.join(fixture, 'cache'), {
            ...LIMITS,
            entries: 5,
        }).load(archive),
        /ZIP has too many entries/,
    );
    assert.equal(materialized, false);
});

test('ZIP projects refresh safely without changing source files', async (t) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'html-zip-test-'));
    const root = path.join(fixture, 'public');
    const cache = path.join(fixture, 'cache');
    for (const name of ['a', 'b', 'bad'])
        await fs.mkdir(path.join(root, name), { recursive: true });
    const archive = async (name, files, time = 2000) => {
        const zip = new AdmZip();
        for (const [name, body, date = 1000] of files) {
            const temporaryName = 'entry-' + zip.getEntries().length;
            zip.addFile(temporaryName, Buffer.from(body));
            const entry = zip.getEntry(temporaryName);
            entry.entryName = name;
            entry.header.time = new Date(date * 1000);
        }
        const file = path.join(root, name);
        await fs.writeFile(file, zip.toBuffer());
        await fs.utimes(file, time, time);
        return file;
    };
    await fs.writeFile(path.join(root, 'a', 'loose.html'), 'LOOSE');
    await fs.utimes(path.join(root, 'a', 'loose.html'), 1000, 1000);
    await archive('a/first.zip', [['page.html', 'FIRST']]);
    await archive(
        'a/second.zip',
        [
            ['bundle/page.html', 'SECOND'],
            ['bundle/assets/style.css', 'CSS'],
            ['__MACOSX/._page', 'ignored'],
        ],
        3000,
    );
    await archive('b/site.zip', [['other.htm', 'BETA']]);
    const child = spawn(
        process.execPath,
        [path.join(repositoryRoot, 'src/server/server.cjs'), '0'],
        {
            env: {
                ...process.env,
                HTML_SHARE_ROOT: root,
                HTML_SHARE_ZIP_CACHE: cache,
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
        assert.ok(path.basename(fixture).startsWith('html-zip-test-'));
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('server timeout')),
            10000,
        );
        child.stdout.on('data', (data) => {
            const m = String(data).match(/127\.0\.0\.1:(\d+)/);
            if (m) {
                clearTimeout(timeout);
                resolve(m[1]);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error('exit ' + code));
        });
    });
    const get = async (route) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            redirect: 'manual',
        });
        return {
            status: response.status,
            body: await response.text(),
            location: response.headers.get('location'),
        };
    };
    await t.test(
        'newest archive only, flattened wrapper, assets, isolation, and concurrency',
        async () => {
            const results = await Promise.all(
                Array.from({ length: 8 }, () => get('/a/')),
            );
            for (const result of results) assert.equal(result.body, 'SECOND');
            assert.equal((await fs.readdir(cache)).length, 1);
            assert.equal((await get('/a/assets/style.css')).body, 'CSS');
            assert.equal((await get('/b/')).body, 'BETA');
            assert.doesNotMatch((await get('/')).body, /first.zip|second.zip/);
            assert.equal((await get('/a/second.zip')).status, 404);
            assert.equal(
                await fs.readFile(path.join(root, 'a', 'loose.html'), 'utf8'),
                'LOOSE',
            );
        },
    );
    await t.test(
        'replacement, deletion fallback, and loose HTML restoration',
        async () => {
            await archive('a/second.zip', [['new.html', 'UPDATED']], 4000);
            assert.equal((await get('/a/')).body, 'UPDATED');
            await fs.unlink(path.join(root, 'a', 'second.zip'));
            assert.equal((await get('/a/')).body, 'FIRST');
            await fs.unlink(path.join(root, 'a', 'first.zip'));
            assert.equal((await get('/a/')).body, 'LOOSE');
        },
    );
    await t.test(
        'recursive latest HTML redirects into its asset directory',
        async () => {
            await archive('a/pages.zip', [
                ['old.html', 'OLD', 315532800],
                ['pages/new.html', 'NEW', 631152000],
                ['pages/style.css', 'NESTED CSS'],
            ]);
            const result = await get('/a/');
            assert.equal(result.status, 302);
            assert.equal(result.location, '/a/pages/');
            assert.equal((await get(result.location)).body, 'NEW');
            assert.equal((await get('/a/pages/style.css')).body, 'NESTED CSS');
        },
    );
    await t.test(
        'invalid newest archive errors without serving stale content, then recovers',
        async () => {
            await fs.writeFile(
                path.join(root, 'a', 'broken.zip'),
                'COPY IN PROGRESS',
            );
            assert.equal((await get('/a/')).status, 503);
            assert.equal((await get('/b/')).body, 'BETA');
            await fs.unlink(path.join(root, 'a', 'broken.zip'));
            assert.equal((await get('/a/')).status, 302);
        },
    );
    await t.test(
        'unsafe names, links, CRC corruption and size limits rejected',
        async () => {
            for (const name of [
                '../escape.html',
                '/absolute.html',
                'C:/escape.html',
                'folder/CON.txt',
                'folder/evil:ads',
                'folder/back\\slash.html',
            ]) {
                const file = await archive('bad/unsafe.zip', [[name, 'BAD']]);
                await assert.rejects(new ZipProjects(cache).load(file), {
                    code: 'ZIP_INVALID',
                });
            }
            const file = await archive('bad/unsafe.zip', [
                ['big.html', '12345'],
            ]);
            await assert.rejects(
                new ZipProjects(cache, { ...LIMITS, file: 4 }).load(file),
                { code: 'ZIP_INVALID' },
            );
            await assert.rejects(
                new ZipProjects(cache, { ...LIMITS, total: 4 }).load(file),
                { code: 'ZIP_INVALID' },
            );
            await assert.rejects(
                new ZipProjects(cache, { ...LIMITS, entries: 0 }).load(file),
                { code: 'ZIP_INVALID' },
            );
            const zip = new AdmZip();
            zip.addFile('link.html', Buffer.from('target'));
            zip.getEntry('link.html').header.attr = (0xa1ff << 16) >>> 0;
            await fs.writeFile(file, zip.toBuffer());
            await assert.rejects(new ZipProjects(cache).load(file), {
                code: 'ZIP_INVALID',
            });
            await archive('bad/unsafe.zip', [['page.html', 'CRC DATA']]);
            const corrupt = await fs.readFile(file);
            corrupt.writeUInt32LE(0, 14); // Break the local file header CRC.
            await fs.writeFile(file, corrupt);
            await assert.rejects(new ZipProjects(cache).load(file), {
                code: 'ZIP_INVALID',
            });
        },
    );
    await t.test(
        'root is only a project directory even when a root ZIP exists',
        async () => {
            await archive('root.zip', [['bundle/root.html', 'ROOT']]);
            assert.match((await get('/')).body, /HTML 프로젝트/);
            for (const name of ['a', 'b', 'bad'])
                await fs.rename(
                    path.join(root, name),
                    path.join(fixture, name),
                );
            assert.match((await get('/')).body, /HTML 프로젝트/);
            assert.doesNotMatch((await get('/')).body, />ROOT</);
        },
    );
});
