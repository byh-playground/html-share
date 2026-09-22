const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, files } = require('../../scripts/development/publication.cjs');
test('release allowlist includes dependencies and excludes all private application data', () => {
    const names = files();
    for (const required of [
        'package-lock.json',
        'scripts/sharing/share-qr.cjs',
        'src/management/ui/app.js',
        'src/management/management-route.cjs',
        'src/pwa/template/sw.template.js',
    ])
        assert.ok(names.includes(required), required);
    assert.ok(
        !names.some((name) =>
            /^(\.runtime|\.tools|node_modules|projects)\//.test(name),
        ),
    );
    assert.ok(
        names
            .filter((name) => name.startsWith('public/'))
            .every((name) => name === 'public/example/hello.html'),
    );
});
test('git ignore protects future user projects and authentication files', async (t) => {
    const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), 'html-share-release-'),
    );
    t.after(async () => {
        assert.equal(path.dirname(fixture), os.tmpdir());
        await fs.rm(fixture, { recursive: true, force: true });
    });
    await fs.copyFile(
        path.join(root, '.gitignore'),
        path.join(fixture, '.gitignore'),
    );
    const init = spawnSync('git', ['init', '--quiet', fixture], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (init.error?.code === 'ENOENT') {
        t.skip('Git is not installed');
        return;
    }
    assert.equal(init.status, 0, init.stderr);
    const ignored = [
        '.runtime/upload-auth.json',
        '.runtime/manage-qr.png',
        '.runtime/ngrok.yml',
        '.tools/ngrok.exe',
        'projects/demo/uploads/private.html',
        'public/private-site/new.zip',
        'public/upload/private.txt',
        'public/upload/app.js',
        'public/example/private.html',
        '.env',
        '.env.local',
        'ngrok.yml',
        'config/upload-auth.json',
        'config/ntfy.json',
        'upload-url.txt',
        'manage-qr.png',
        'private.key',
        'certificate.pfx',
        'download.zip',
        'source.zip',
        'notes.bak',
        'test-results/mobile.png',
        'personal.html',
        'personal.htm',
        'ngrok.exe',
    ];
    const result = spawnSync(
        'git',
        ['-C', fixture, 'check-ignore', '--stdin'],
        {
            input: ignored.join('\n') + '\n',
            encoding: 'utf8',
            windowsHide: true,
        },
    );
    assert.deepEqual(
        result.stdout.trim().split(/\r?\n/).sort(),
        ignored.sort(),
    );
    const publicFiles = spawnSync(
        'git',
        ['-C', fixture, 'check-ignore', '--stdin'],
        {
            input: 'src/management/ui/app.js\nsrc/projects/zip-projects.cjs\ntests/projects/zip-projects.test.cjs\npublic/example/hello.html\n',
            encoding: 'utf8',
            windowsHide: true,
        },
    );
    assert.equal(publicFiles.stdout, '');
});
