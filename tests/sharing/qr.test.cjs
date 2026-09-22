const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { managementPath } = require('../../src/management/management-route.cjs');
const {
    projectUrl,
    manageUrl,
    generate,
} = require('../../scripts/sharing/share-qr.cjs');
test('management QR reuses the existing key; public QR has no management capability', () => {
    const token = 'c'.repeat(64),
        base = 'https://example.test';
    assert.equal(
        manageUrl(base, token),
        base + managementPath(token) + '#key=' + token,
    );
    assert.equal(manageUrl(base, token), manageUrl(base, token));
    const shared = projectUrl(base, '프로젝트 A');
    assert.equal(
        shared,
        'https://example.test/' + encodeURIComponent('프로젝트 A') + '/',
    );
    assert.ok(
        !shared.includes(token) &&
            !shared.includes('_manage') &&
            !shared.includes('#'),
    );
    for (const project of ['../outside', 'upload', 'admin', '_manage'])
        assert.throws(() => projectUrl(base, project));
    assert.throws(() => manageUrl('http://127.0.0.1:8787', token));
});
test('QR files are generated locally outside the public project tree without changing the key', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'html-share-qr-'));
    t.after(async () => {
        assert.equal(path.dirname(root), os.tmpdir());
        await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, '.runtime'));
    await fs.mkdir(path.join(root, 'public', 'demo'), { recursive: true });
    const content = JSON.stringify({ token: 'd'.repeat(64) });
    await fs.writeFile(
        path.join(root, '.runtime', 'upload-auth.json'),
        content,
    );
    await fs.writeFile(
        path.join(root, '.runtime', 'ngrok-state.json'),
        JSON.stringify({ url: 'https://example.test' }),
    );
    const admin = await generate(root),
        publicQr = await generate(root, 'demo');
    assert.equal(admin.private, true);
    assert.equal(publicQr.private, false);
    for (const item of [admin, publicQr]) {
        const bytes = await fs.readFile(item.output);
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        assert.equal(path.dirname(item.output), path.join(root, '.runtime'));
    }
    assert.equal(
        await fs.readFile(
            path.join(root, '.runtime', 'upload-auth.json'),
            'utf8',
        ),
        content,
    );
});
