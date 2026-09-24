const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const Zip = require('adm-zip');
const { managementPath } = require('../../src/management/management-route.cjs');
(async () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'html-share-ui-'));
    const publicRoot = path.join(fixture, 'public');
    const runtime = path.join(fixture, 'runtime');
    let browser, child;
    try {
        await fs.mkdir(path.join(publicRoot, 'phone-demo'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(publicRoot, 'phone-demo', 'keep.css'),
            'KEEP RESOURCE',
        );
        await fs.mkdir(runtime);
        const token = 'b'.repeat(64);
        await fs.writeFile(
            path.join(runtime, 'upload-auth.json'),
            JSON.stringify({ token }),
        );
        child = spawn(
            process.execPath,
            [path.join(projectRoot, 'src/server/server.cjs'), '0'],
            {
                windowsHide: true,
                env: {
                    ...process.env,
                    HTML_SHARE_ROOT: publicRoot,
                    HTML_SHARE_RUNTIME: runtime,
                    HTML_SHARE_PROJECTS_ROOT: path.join(fixture, 'projects'),
                    HTML_SHARE_ZIP_CACHE: path.join(runtime, 'cache'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const port = await new Promise((resolve, reject) => {
            let text = '';
            const timeout = setTimeout(
                () => reject(new Error('Server startup timed out')),
                10000,
            );
            child.stdout.on('data', (chunk) => {
                text += chunk;
                const match = text.match(/127\.0\.0\.1:(\d+)/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(match[1]);
                }
            });
            child.on('error', reject);
        });
        const base = `http://127.0.0.1:${port}`;
        const adminPath = managementPath(token);
        browser = await chromium.launch({
            ...(process.env.CHROME_PATH
                ? { executablePath: process.env.CHROME_PATH }
                : {}),
            headless: true,
        });
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        const tab = async (name) => {
            await page.locator('#tab-' + name).click();
            assert.equal(
                await page.locator('[role="tabpanel"]:visible').count(),
                1,
            );
            assert.equal(
                await page.locator('#panel-' + name).isVisible(),
                true,
            );
        };
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // Simulate ngrok's browser warning when a browser API request omits the bypass header.
        await page.route('**/_manage/*/api/**', (route) =>
            route.request().headers()['ngrok-skip-browser-warning']
                ? route.continue()
                : route.fulfill({
                      status: 200,
                      contentType: 'text/html',
                      body: '<!doctype html><title>ngrok warning</title>',
                  }),
        );
        assert.equal((await fetch(base + '/upload/')).status, 404);
        const landing = await (await fetch(base + '/')).text();
        assert.ok(
            !landing.includes(adminPath) &&
                !landing.includes(token) &&
                !landing.includes('/upload/'),
        );
        await page.goto(base + adminPath);
        await page.locator('#locked').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#upload-form').isVisible(), false);
        await page.goto(base + adminPath + '#key=' + token);
        await page.locator('#upload-form').waitFor({ state: 'visible' });
        const cleanupPickerAvailable = await page.evaluate(
            () =>
                typeof window.showOpenFilePicker === 'function' &&
                typeof FileSystemHandle !== 'undefined' &&
                typeof FileSystemHandle.prototype.remove === 'function',
        );
        assert.equal(
            await page
                .locator('#cleanup-choice')
                .evaluate((option) => option.hidden),
            !cleanupPickerAvailable,
        );
        assert.equal(
            await page.locator('#delete-original').isChecked(),
            cleanupPickerAvailable,
        );
        assert.equal(
            await page.locator('#cleanup-hint').evaluate((hint) => hint.hidden),
            !cleanupPickerAvailable,
        );
        assert.equal(
            await page.locator('#tab-upload').getAttribute('aria-selected'),
            'true',
        );
        assert.equal(
            await page.locator('[role="tabpanel"]:visible').count(),
            1,
        );
        assert.equal(await page.locator('#project').inputValue(), 'phone-demo');
        await tab('share');
        assert.doesNotMatch(
            await page.locator('#panel-share').innerText(),
            /phone-demo/,
        );
        await page.waitForFunction(
            () => !document.querySelector('#share-project').disabled,
        );
        await page.locator('#share-project').click();
        await page.locator('#share-dialog').waitFor({ state: 'visible' });
        assert.equal(
            await page.locator('#share-url').inputValue(),
            base + '/phone-demo/',
        );
        assert.match(
            await page.locator('#share-image').getAttribute('src'),
            /^data:image\/png;base64,/,
        );
        await page.locator('#share-close').click();
        assert.equal(await page.locator('#manage-dialog').isVisible(), false);
        assert.equal(
            await page.locator('#manage-image').getAttribute('src'),
            null,
        );
        const authBefore = await fs.readFile(
            path.join(runtime, 'upload-auth.json'),
            'utf8',
        );
        await page.locator('#manage-qr').click();
        await page.locator('#manage-dialog').waitFor({ state: 'visible' });
        assert.equal(
            await page.locator('#manage-url').inputValue(),
            base + adminPath + '#key=' + token,
        );
        assert.match(
            await page.locator('#manage-image').getAttribute('src'),
            /^data:image\/png;base64,/,
        );
        await page.locator('#manage-close').click();
        assert.equal(
            await page.locator('#manage-image').getAttribute('src'),
            null,
        );
        assert.equal(await page.locator('#manage-url').inputValue(), '');
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.locator('#manage-copy').click();
        assert.equal(
            await page.evaluate(() => navigator.clipboard.readText()),
            base + adminPath + '#key=' + token,
        );
        assert.equal(await page.locator('#manage-dialog').isVisible(), false);
        assert.equal(
            await fs.readFile(path.join(runtime, 'upload-auth.json'), 'utf8'),
            authBefore,
        );
        await tab('upload');
        await page.locator('#file').setInputFiles({
            name: 'phone page.html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>PHONE UPLOAD</h1>'),
        });
        await page.locator('#submit').click();
        await page.locator('#result').waitFor({ state: 'visible' });
        assert.equal(
            await page.locator('#result-project').textContent(),
            '새 파일을 적용했습니다',
        );
        assert.equal(
            new URL(page.url()).pathname,
            adminPath,
            'Default upload stays in manager',
        );
        assert.equal(
            await page.evaluate(() => document.activeElement?.id),
            'result',
        );
        assert.match(
            await page.locator('#result-file').textContent(),
            /phone page.html/,
        );
        await page.locator('#upload-next').click();
        assert.equal(
            await page.evaluate(() => document.activeElement?.id),
            'drop-zone',
        );
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /PHONE UPLOAD/,
        );
        const zip = new Zip();
        zip.addFile('bundle/latest.html', Buffer.from('<h1>ZIP UPLOAD</h1>'));
        zip.addFile('bundle/style.css', Buffer.from('body{color:blue}'));
        await page.locator('#file').setInputFiles({
            name: 'from-phone.zip',
            mimeType: 'application/zip',
            buffer: zip.toBuffer(),
        });
        await page.locator('#submit').click();
        await page.locator('#result').waitFor({ state: 'visible' });
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /ZIP UPLOAD/,
        );
        assert.equal(
            await (await fetch(base + '/phone-demo/style.css')).text(),
            'body{color:blue}',
        );
        await tab('files');
        await page.waitForFunction(
            () =>
                document.querySelectorAll('.file-card').length === 2 &&
                !document.querySelector('#cleanup').disabled,
        );
        const beforeDownload = await fs.stat(
            path.join(publicRoot, 'phone-demo', 'phone page.html'),
        );
        for (const [filename, expected] of [
            ['phone page.html', Buffer.from('<h1>PHONE UPLOAD</h1>')],
            [
                'from-phone.zip',
                await fs.readFile(
                    path.join(publicRoot, 'phone-demo', 'from-phone.zip'),
                ),
            ],
        ]) {
            const downloadEvent = page.waitForEvent('download');
            await page
                .getByRole('button', {
                    name: filename + ' 원본 다운로드',
                    exact: true,
                })
                .click();
            const download = await downloadEvent;
            assert.equal(download.suggestedFilename(), filename);
            assert.deepEqual(
                await fs.readFile(await download.path()),
                expected,
            );
            assert.equal(new URL(page.url()).pathname, adminPath);
            await page.waitForFunction(
                () => !document.querySelector('#files-refresh').disabled,
            );
        }
        assert.equal(
            (
                await fs.stat(
                    path.join(publicRoot, 'phone-demo', 'phone page.html'),
                )
            ).mtimeMs,
            beforeDownload.mtimeMs,
        );
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /ZIP UPLOAD/,
        );
        await page
            .getByRole('button', { name: '이 파일 적용', exact: true })
            .click();
        await page.waitForFunction(() =>
            document
                .querySelector('#status')
                .textContent.includes('phone page.html을 적용했습니다.'),
        );
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /PHONE UPLOAD/,
        );
        await page.locator('#cleanup').click();
        assert.equal(
            await page.locator('#cleanup-keep').textContent(),
            'phone page.html',
        );
        assert.match(
            await page.locator('#cleanup-files').textContent(),
            /from-phone.zip/,
        );
        await page.locator('#cleanup-cancel').click();
        assert.ok(
            (await fs.readdir(path.join(publicRoot, 'phone-demo'))).includes(
                'from-phone.zip',
            ),
        );
        await page.locator('#cleanup').click();
        await page.locator('#cleanup-confirm').click();
        await page.waitForFunction(() =>
            document
                .querySelector('#status')
                .textContent.includes('1개 파일을 정리했습니다.'),
        );
        assert.deepEqual(
            (await fs.readdir(path.join(publicRoot, 'phone-demo'))).sort(),
            ['keep.css', 'phone page.html'],
        );
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /PHONE UPLOAD/,
        );
        assert.equal(
            await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
        );
        await tab('pwa');
        await page.locator('#pwa-enabled').check();
        await page.locator('#pwa-name').fill('Phone Demo App');
        await page.locator('#pwa-short-name').fill('DEMO');
        await page.locator('#pwa-description').fill('Shared template test');
        await page.locator('#pwa-theme').fill('#112233');
        await page.locator('#pwa-save').click();
        await page.waitForFunction(() =>
            document
                .querySelector('#status')
                .textContent.includes('PWA 설정을 저장하고 반영했습니다.'),
        );
        const manifest = await (
            await fetch(base + '/phone-demo/manifest.webmanifest')
        ).json();
        assert.equal(manifest.name, 'Phone Demo App');
        assert.equal(manifest.theme_color, '#112233');
        assert.equal(
            await page.locator('#file').getAttribute('accept'),
            '.html,.htm',
        );
        assert.equal(
            await page.locator('#drop-zone').getAttribute('type'),
            'button',
        );
        assert.match(
            await page.locator('#pwa-build').textContent(),
            /PWA 적용 빌드/,
        );
        await page.locator('#pwa-name').fill('Phone Demo App');
        await tab('upload');
        await page.locator('#file').setInputFiles({
            name: 'updated.html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>PHONE UPLOAD UPDATED</h1>'),
        });
        assert.equal(await page.locator('#submit').isEnabled(), true);
        assert.equal(
            await page.locator('#submit').textContent(),
            '업로드만 하기',
        );
        await tab('pwa');
        await page
            .locator('#pwa-description')
            .fill('Saved together with upload');
        await tab('files');
        await tab('upload');
        assert.equal(
            await page
                .locator('#file')
                .evaluate((input) => input.files[0].name),
            'updated.html',
        );
        assert.equal(await page.locator('#submit').isEnabled(), true);
        assert.equal(
            await page.locator('#submit').textContent(),
            '설정 저장 후 업로드',
        );
        await page.locator('#submit').click();
        await page.locator('#result').waitFor({ state: 'visible' });
        assert.match(
            await (await fetch(base + '/phone-demo/')).text(),
            /PHONE UPLOAD UPDATED/,
        );
        assert.equal(
            (
                await (
                    await fetch(base + '/phone-demo/manifest.webmanifest')
                ).json()
            ).description,
            'Saved together with upload',
        );
        await page.evaluate(() => caches.open('unrelated-cache-sentinel'));
        const appPage = await page.context().newPage();
        appPage.on('console', (message) => {
            if (message.type() === 'warning' || message.type() === 'error')
                console.log(
                    'PWA browser ' + message.type() + ': ' + message.text(),
                );
        });
        appPage.on('pageerror', (error) =>
            console.log('PWA page error: ' + error.message),
        );
        appPage.on('response', (response) => {
            if (response.status() >= 400)
                console.log(
                    'PWA failed path: ' + new URL(response.url()).pathname,
                );
        });
        await appPage.goto(base + '/phone-demo/');
        try {
            await appPage.waitForFunction(
                () => !!navigator.serviceWorker.controller,
                {},
                { timeout: 15000 },
            );
        } catch (error) {
            console.log(
                await appPage.evaluate(async () =>
                    JSON.stringify({
                        secure: isSecureContext,
                        scripts: [...document.scripts].map((s) => s.src),
                        regs: (
                            await navigator.serviceWorker.getRegistrations()
                        ).map((r) => ({
                            scope: r.scope,
                            active: r.active?.state,
                            installing: r.installing?.state,
                            waiting: r.waiting?.state,
                        })),
                    }),
                ),
            );
            throw error;
        }
        assert.ok(
            (await appPage.evaluate(() => caches.keys())).includes(
                'unrelated-cache-sentinel',
            ),
        );
        await appPage.context().setOffline(true);
        await appPage.goto(base + '/phone-demo/?v=offline');
        assert.match(await appPage.locator('body').innerText(), /PHONE UPLOAD/);
        const offlineVersion = await appPage.evaluate(async () => {
            const r = await fetch('./version.json?t=12345');
            return r.json();
        });
        assert.ok(offlineVersion.build);
        await appPage.context().setOffline(false);
        await appPage.close();
        await fs.mkdir(path.join(projectRoot, 'test-results'), {
            recursive: true,
        });
        await page.screenshot({
            path: path.join(projectRoot, 'test-results', 'upload-mobile.png'),
            fullPage: true,
        });
        await tab('pwa');
        await page.reload();
        await page.locator('#workspace').waitFor({ state: 'visible' });
        await page.locator('#panel-pwa').waitFor({ state: 'visible' });
        assert.equal(
            new URLSearchParams(new URL(page.url()).hash.slice(1)).get('tab'),
            'pwa',
        );
        assert.equal(await page.locator('#project').inputValue(), 'phone-demo');
        await page.waitForFunction(
            () => document.querySelector('#pwa-enabled').checked,
        );
        assert.equal(
            await page.locator('#pwa-name').inputValue(),
            'Phone Demo App',
        );
        assert.equal(
            await page.evaluate(
                () => localStorage.length + sessionStorage.length,
            ),
            0,
        );
        assert.deepEqual(errors, []);
        await tab('upload');
        await fs.mkdir(path.join(publicRoot, 'debug-demo'), {
            recursive: true,
        });
        await page.locator('#refresh').click();
        await page.waitForFunction(
            () =>
                document.querySelector('#project').querySelectorAll('option')
                    .length === 3,
        );
        await page.locator('#project').selectOption('debug-demo');
        await page.waitForFunction(
            () =>
                !document.querySelector('#pwa-settings').disabled &&
                !document.querySelector('#pwa-settings').hidden,
        );
        const privateUrl = page.url();
        assert.equal(
            new URLSearchParams(new URL(privateUrl).hash.slice(1)).get(
                'project',
            ),
            'debug-demo',
        );
        assert.equal(
            new URLSearchParams(new URL(privateUrl).hash.slice(1)).get('key'),
            token,
        );
        const uploadPattern = '**/_manage/*/api/file?**';
        const rejectUpload = (route) =>
            route.fulfill({
                status: 422,
                contentType: 'application/json',
                body: '{"error":"Test failure"}',
            });
        await page.route(uploadPattern, rejectUpload);
        await page.locator('#file').setInputFiles({
            name: 'rejected.html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>REJECTED</h1>'),
        });
        const failedPopupEvent = context.waitForEvent('page');
        await page.locator('#submit-open').click();
        const failedPopup = await failedPopupEvent;
        await page.waitForFunction(() =>
            document.querySelector('#status').classList.contains('error'),
        );
        assert.equal(page.url(), privateUrl, 'Failed upload must not navigate');
        if (!failedPopup.isClosed()) await failedPopup.waitForEvent('close');
        await page.unroute(uploadPattern, rejectUpload);
        let pendingUpload;
        const holdUpload = (route) => {
            pendingUpload = route;
        };
        await page.route(uploadPattern, holdUpload);
        await page.locator('#file').setInputFiles({
            name: 'cancelled.html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>CANCELLED</h1>'),
        });
        const cancelledPopupEvent = context.waitForEvent('page');
        await page.locator('#submit-open').click();
        const cancelledPopup = await cancelledPopupEvent;
        assert.equal(await page.locator('#tab-files').isDisabled(), true);
        await page.locator('#cancel').click();
        await page.waitForFunction(() =>
            document.querySelector('#status').textContent.includes('취소'),
        );
        assert.equal(
            page.url(),
            privateUrl,
            'Cancelled upload must not navigate',
        );
        if (!cancelledPopup.isClosed())
            await cancelledPopup.waitForEvent('close');
        if (pendingUpload) await pendingUpload.abort().catch(() => {});
        await page.unroute(uploadPattern, holdUpload);
        await page.locator('#file').setInputFiles({
            name: 'debug.html',
            mimeType: 'text/html',
            buffer: Buffer.from('<h1>DEBUG FLOW</h1>'),
        });
        const tabsBefore = context.pages().length;
        const previewEvent = context.waitForEvent('page');
        await page.locator('#submit-open').click();
        const preview = await previewEvent;
        await preview.waitForURL(
            (url) =>
                url.origin === base &&
                url.pathname === '/debug-demo/' &&
                url.search === '' &&
                url.hash === '',
        );
        assert.match(await preview.locator('body').innerText(), /DEBUG FLOW/);
        assert.equal(preview.url(), `${base}/debug-demo/`);
        assert.ok(!preview.url().includes(token));
        assert.ok(!preview.url().includes(adminPath));
        assert.equal(await preview.evaluate(() => window.opener), null);
        assert.equal(await preview.evaluate(() => document.referrer), '');
        assert.equal(
            page.url(),
            privateUrl,
            'Management remains in its original tab',
        );
        assert.equal(
            context.pages().length,
            tabsBefore + 1,
            'Preview opens in a new tab',
        );
        await preview.close();
        await page.locator('#upload-form').waitFor({ state: 'visible' });
        await page.waitForFunction(
            () =>
                document.querySelector('#project').value === 'debug-demo' &&
                !document.querySelector('#pwa-settings').disabled,
        );
        assert.equal(await page.locator('#result').isVisible(), true);
        assert.equal(
            await page.evaluate(() => document.activeElement.id),
            'result',
        );
        assert.match(
            await page.locator('#current-project').textContent(),
            /debug\.html/,
        );
        const currentLink = await page
            .locator('#current-open')
            .getAttribute('href');
        assert.equal(new URL(currentLink, base).href, `${base}/debug-demo/`);
        await page.reload();
        await page.waitForFunction(
            () =>
                document.querySelector('#project').value === 'debug-demo' &&
                !document.querySelector('#pwa-settings').disabled,
        );
        assert.equal(
            new URLSearchParams(new URL(page.url()).hash.slice(1)).get('key'),
            token,
        );
        assert.equal(
            await page.evaluate(
                () => localStorage.length + sessionStorage.length,
            ),
            0,
        );
        assert.deepEqual(errors, []);
        await page.setViewportSize({ width: 320, height: 700 });
        for (const name of ['upload', 'files', 'pwa', 'share']) {
            await tab(name);
            assert.equal(
                await page.evaluate(
                    () => document.documentElement.scrollWidth > innerWidth,
                ),
                false,
                'No horizontal overflow in ' + name,
            );
        }
        await page.locator('#tab-share').focus();
        await page.keyboard.press('Home');
        assert.equal(
            await page.locator('#tab-upload').getAttribute('aria-selected'),
            'true',
        );
        await page.keyboard.press('ArrowRight');
        assert.equal(
            await page.locator('#tab-files').getAttribute('aria-selected'),
            'true',
        );
        await page.keyboard.press('End');
        assert.equal(
            await page.locator('#tab-share').getAttribute('aria-selected'),
            'true',
        );
        await page.keyboard.press('ArrowLeft');
        assert.equal(
            await page.locator('#tab-pwa').getAttribute('aria-selected'),
            'true',
        );
        const navigation = await page.getByRole('tablist').boundingBox();
        assert.ok(
            navigation &&
                navigation.y >= 0 &&
                navigation.y + navigation.height <= 701,
        );
        await tab('upload');
        await page.screenshot({
            path: path.join(
                projectRoot,
                'test-results',
                'upload-mobile-320.png',
            ),
            fullPage: true,
        });
        assert.deepEqual(errors, []);
        await fs.mkdir(path.join(publicRoot, 'untrusted-worker'));
        await fs.writeFile(
            path.join(publicRoot, 'untrusted-worker', 'index.html'),
            '<h1>Worker restriction test</h1>',
        );
        await fs.writeFile(
            path.join(publicRoot, 'untrusted-worker', 'probe.js'),
            'self.addEventListener("activate",e=>e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true})));',
        );
        const untrusted = await context.newPage();
        await untrusted.goto(base + '/untrusted-worker/');
        const registered = await untrusted.evaluate(async () => {
            try {
                await navigator.serviceWorker.register('./probe.js');
                return true;
            } catch {
                return false;
            }
        });
        assert.equal(
            registered,
            false,
            'Untrusted service worker registration must be blocked by HTTP handler',
        );
        await untrusted.close();
        console.log(
            'Mobile UI passed: four-tab flow and keyboard navigation, 390/320px no overflow, draft/file retention, tab/project reload memory, upload-stay/new-tab/cancel, isolated preview without referrer, QR/cleanup/PWA/offline, no storage credentials or page errors.',
        );
    } finally {
        if (browser) await browser.close();
        if (child && child.exitCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
        assert.equal(path.dirname(fixture), os.tmpdir());
        assert.ok(path.basename(fixture).startsWith('html-share-ui-'));
        await fs.rm(fixture, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
