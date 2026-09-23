const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function harness({ popupBlocked = false, cleanupPicker = false } = {}) {
    let picker = null;
    const elements = new Map(),
        requests = [],
        uploads = [],
        navigations = [],
        popups = [],
        windowListeners = {};
    const location = {
        hash: '',
        search: '',
        origin: 'http://localhost',
        pathname: '/_manage/test/',
        href: 'http://localhost/_manage/test/',
        assign(url) {
            navigations.push(String(url));
        },
    };
    const document = {
        getElementById: element,
        createElement: () => element(Symbol()),
        activeElement: null,
    };
    function element(id) {
        if (!elements.has(id))
            elements.set(id, {
                id,
                value: '',
                checked: false,
                hidden: false,
                disabled: false,
                textContent: '',
                files: [],
                dataset: {},
                listeners: {},
                classList: { add() {}, remove() {}, toggle() {} },
                clicks: 0,
                addEventListener(type, fn) {
                    this.listeners[type] = fn;
                },
                replaceChildren() {},
                querySelectorAll() {
                    return [];
                },
                append() {},
                add() {},
                focus() {
                    document.activeElement = this;
                },
                click() {
                    this.clicks++;
                    this.listeners.click?.({
                        currentTarget: this,
                        target: this,
                    });
                },
                scrollIntoView() {},
                setAttribute(name, value) {
                    this[name] = String(value);
                },
                getAttribute(name) {
                    return this[name] ?? null;
                },
            });
        return elements.get(id);
    }
    class Xhr {
        constructor() {
            this.upload = { addEventListener() {} };
            this.listeners = {};
        }
        open(method, url) {
            this.url = url;
        }
        setRequestHeader() {}
        addEventListener(type, fn) {
            this.listeners[type] = fn;
        }
        send(file) {
            uploads.push({ url: this.url, file, xhr: this });
        }
        abort() {
            this.listeners.abort?.();
            this.listeners.loadend?.();
        }
    }
    const history = {
        replaceState(_state, _title, url) {
            const parsed = new URL(url, location.href);
            location.href = parsed.href;
            location.hash = parsed.hash;
            location.pathname = parsed.pathname;
        },
    };
    const context = vm.createContext({
        document,
        window: {
            location,
            history,
            showOpenFilePicker: cleanupPicker
                ? (...args) => picker(...args)
                : undefined,
            open(url, target) {
                if (popupBlocked) return null;
                const popup = {
                    url,
                    target,
                    opener: {},
                    closed: false,
                    navigations: [],
                    document: {
                        html: '',
                        closed: false,
                        open() {},
                        write(html) {
                            this.html += html;
                        },
                        close() {
                            this.closed = true;
                        },
                    },
                    location: {
                        replace(url) {
                            popup.navigations.push(String(url));
                        },
                    },
                    close() {
                        this.closed = true;
                    },
                };
                popups.push(popup);
                return popup;
            },
            addEventListener(type, fn) {
                windowListeners[type] = fn;
            },
        },
        location,
        history,
        URL,
        URLSearchParams,
        Map,
        Option: function () {},
        XMLHttpRequest: Xhr,
        crypto: webcrypto,
        FileSystemHandle: class {
            remove() {}
        },
        fetch: (url, options) =>
            new Promise((resolve) => requests.push({ url, options, resolve })),
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (fn) => fn(),
        console,
    });
    vm.runInContext(
        fs.readFileSync(
            path.join(repositoryRoot, 'src/management/ui/app.js'),
            'utf8',
        ),
        context,
    );
    const run = (code) => vm.runInContext(code, context);
    const respond = (request, data) =>
        request.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => data,
        });
    const settings = (name) => ({
        revision: 'initial',
        enabled: false,
        name,
        shortName: name,
        description: '',
        themeColor: '#123456',
        backgroundColor: '#ffffff',
    });
    const files = (project) => ({
        project,
        active: null,
        files: [],
        cleanup: { count: 0, bytes: 0 },
    });
    return {
        element,
        requests,
        uploads,
        run,
        respond,
        settings,
        files,
        navigations,
        popups,
        location,
        document,
        windowListeners,
        setPicker(fn) {
            picker = fn;
        },
    };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('switching projects cannot submit a previous unsaved PWA draft during delayed loading', async () => {
    const h = harness();
    h.run(
        `authenticated=true;token='a'.repeat(64);$('project').value='A';selected={name:'page.html',size:100};fillPwaSettings(${JSON.stringify(h.settings('A'))});$('pwa-name').value='Unsaved A';pwaDirty=true;updateSubmit();`,
    );
    assert.equal(h.element('submit').disabled, false);
    h.element('project').value = 'B';
    h.element('project').listeners.change();
    assert.equal(h.element('submit').disabled, true);
    assert.equal(h.element('submit').textContent, '프로젝트 불러오는 중');
    assert.equal(h.run('pwaSettings'), null);
    assert.equal(h.run('pwaDirty'), false);
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    assert.equal(await h.run('savePwaSettings()'), false);
    assert.equal(
        h.requests.filter((req) => req.options.method === 'POST').length,
        0,
    );
    assert.equal(h.uploads.length, 0);
    for (const request of h.requests)
        h.respond(
            request,
            request.url.includes('/pwa?') ? h.settings('B') : h.files('B'),
        );
    await tick();
    assert.equal(h.element('submit').disabled, false);
    assert.equal(h.run('settingsProject'), 'B');
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    assert.equal(h.uploads.length, 1);
    assert.match(h.uploads[0].url, /project=B&/);
    assert.equal(
        h.requests.filter((req) => req.options.method === 'POST').length,
        0,
    );
});

test('saving changed settings still resumes the selected upload after refreshed settings arrive', async () => {
    const h = harness();
    h.run(
        `authenticated=true;token='a'.repeat(64);$('project').value='A';selected={name:'page.html',size:100};fillPwaSettings(${JSON.stringify(h.settings('A'))});$('pwa-name').value='New A';pwaDirty=true;updateSubmit();`,
    );
    const pending = h
        .element('upload-form')
        .listeners.submit({ preventDefault() {} });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.method, 'POST');
    assert.equal(JSON.parse(h.requests[0].options.body).name, 'New A');
    h.respond(h.requests[0], { ...h.settings('New A'), revision: 'saved' });
    await tick();
    assert.equal(h.uploads.length, 0);
    assert.equal(h.element('submit').disabled, true);
    for (const request of h.requests.slice(1))
        h.respond(
            request,
            request.url.includes('/pwa?')
                ? { ...h.settings('New A'), revision: 'saved' }
                : h.files('A'),
        );
    await pending;
    assert.equal(h.uploads.length, 1);
    assert.match(h.uploads[0].url, /project=A&/);
});

test('stale project responses and a settings-project mismatch cannot enable upload', async () => {
    const h = harness();
    h.run(
        `authenticated=true;$('project').value='A';selected={name:'page.html',size:100};loadFiles();`,
    );
    h.element('project').value = 'B';
    h.element('project').listeners.change();
    for (const request of h.requests.slice(0, 2))
        h.respond(
            request,
            request.url.includes('/pwa?') ? h.settings('A') : h.files('A'),
        );
    await tick();
    assert.equal(h.element('submit').disabled, true);
    assert.equal(h.run('pwaSettings'), null);
    for (const request of h.requests.slice(2))
        h.respond(
            request,
            request.url.includes('/pwa?') ? h.settings('B') : h.files('B'),
        );
    await tick();
    assert.equal(h.element('submit').disabled, false);
    h.run(`settingsProject='A';updateSubmit();`);
    assert.equal(h.element('submit').disabled, true);
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    assert.equal(h.uploads.length, 0);
});

function ready(h) {
    h.location.hash = '#key=' + 'a'.repeat(64) + '&project=A';
    h.location.href = h.location.origin + h.location.pathname + h.location.hash;
    h.run(
        `authenticated=true;token='a'.repeat(64);$('project').value='A';selected={name:'page.html',size:100};fillPwaSettings(${JSON.stringify(h.settings('A'))});updateSubmit();`,
    );
}
function uploadResult(xhr, status = 201) {
    xhr.status = status;
    xhr.responseText = JSON.stringify(
        status === 201
            ? { project: 'A', filename: 'page.html', url: '/A/', size: 100 }
            : { error: 'Rejected' },
    );
    xhr.listeners.load();
    xhr.listeners.loadend();
}

test('default upload stays while upload-and-open uses an isolated new tab and refreshes management', async () => {
    const stay = harness();
    ready(stay);
    await stay.element('upload-form').listeners.submit({
        preventDefault() {},
        submitter: stay.element('submit'),
    });
    uploadResult(stay.uploads[0].xhr);
    await tick();
    assert.equal(stay.navigations.length, 0);
    assert.equal(stay.popups.length, 0);
    assert.equal(stay.element('result').hidden, false);
    assert.equal(stay.document.activeElement?.id, 'result');
    assert.match(stay.element('result-file').textContent, /page.html/);
    stay.element('upload-next').listeners.click();
    assert.equal(stay.document.activeElement?.id, 'drop-zone');
    const open = harness();
    ready(open);
    open.element('submit-open').dataset.openProject = 'true';
    await open.element('upload-form').listeners.submit({
        preventDefault() {},
        submitter: open.element('submit-open'),
    });
    uploadResult(open.uploads[0].xhr);
    await tick();
    assert.equal(open.navigations.length, 0);
    assert.equal(open.popups.length, 1);
    const popup = open.popups[0];
    assert.equal(popup.url, 'about:blank');
    assert.equal(popup.target, '_blank');
    assert.equal(popup.opener, null);
    assert.match(
        popup.document.html,
        /<meta\s+name=["']referrer["']\s+content=["']no-referrer["']/i,
    );
    assert.match(popup.document.html, /<title>/i);
    assert.ok(!popup.document.html.includes('a'.repeat(64)));
    assert.equal(popup.document.closed, true);
    assert.equal(popup.closed, false);
    assert.equal(popup.navigations.length, 1);
    const url = new URL(popup.navigations[0]);
    assert.equal(url.pathname, '/A/');
    assert.ok(url.searchParams.has('hs_preview'));
    assert.equal(url.hash, '');
    assert.ok(!url.href.includes('a'.repeat(64)));
    assert.equal(open.document.activeElement?.id, 'result');
    assert.ok(
        open.requests.some((request) => request.url.includes('/api/files?')),
    );
});

test('upload-and-open failures, cancellation, network errors and timeout close the waiting tab', async () => {
    for (const outcome of [
        'failure',
        'cancel',
        'error',
        'timeout',
        'invalid',
    ]) {
        const h = harness();
        ready(h);
        h.element('submit-open').dataset.openProject = 'true';
        await h.element('upload-form').listeners.submit({
            preventDefault() {},
            submitter: h.element('submit-open'),
        });
        if (outcome === 'failure') uploadResult(h.uploads[0].xhr, 422);
        else if (outcome === 'cancel') h.element('cancel').listeners.click();
        else if (outcome === 'invalid') {
            const xhr = h.uploads[0].xhr;
            xhr.status = 201;
            xhr.responseText = 'invalid JSON';
            xhr.listeners.load();
            xhr.listeners.loadend();
        } else {
            h.uploads[0].xhr.listeners[outcome]();
            h.uploads[0].xhr.listeners.loadend();
        }
        await tick();
        assert.equal(h.navigations.length, 0);
        assert.equal(h.run('activeRequest'), null);
        assert.equal(h.popups.length, 1);
        assert.equal(h.popups[0].closed, true, outcome);
        assert.equal(h.popups[0].navigations.length, 0, outcome);
    }
});

test('blocked or manually closed preview tabs leave a usable upload result in management', async () => {
    for (const popupBlocked of [true, false]) {
        const h = harness({ popupBlocked });
        ready(h);
        await h.element('upload-form').listeners.submit({
            preventDefault() {},
            submitter: h.element('submit-open'),
        });
        if (!popupBlocked) h.popups[0].close();
        uploadResult(h.uploads[0].xhr);
        await tick();
        assert.equal(h.navigations.length, 0);
        assert.equal(h.element('result').hidden, false);
        assert.equal(h.document.activeElement?.id, 'result');
        assert.match(h.element('status').textContent, /직접|눌러/);
        assert.equal(new URL(h.element('open-latest').href).pathname, '/A/');
        assert.ok(
            h.requests.some((request) => request.url.includes('/api/files?')),
        );
        if (!popupBlocked) assert.equal(h.popups[0].navigations.length, 0);
    }
});

test('upload-and-open reserves a tab before saving PWA settings and closes it if saving fails or state changes', async () => {
    for (const outcome of ['success', 'failure', 'state-change']) {
        const h = harness();
        ready(h);
        h.run(`$('pwa-name').value='New A';pwaDirty=true;`);
        const pending = h.element('upload-form').listeners.submit({
            preventDefault() {},
            submitter: h.element('submit-open'),
        });
        assert.equal(
            h.popups.length,
            1,
            'Tab must open before the first await',
        );
        assert.equal(h.popups[0].opener, null);
        assert.equal(h.uploads.length, 0);
        assert.equal(h.requests.length, 1);
        if (outcome === 'failure') {
            h.requests[0].resolve({ ok: false, status: 500 });
        } else {
            h.respond(h.requests[0], {
                ...h.settings('New A'),
                revision: 'saved',
            });
            await tick();
            if (outcome === 'state-change')
                h.run(`selected={name:'other.html',size:200};`);
            for (const request of h.requests.slice(1))
                h.respond(
                    request,
                    request.url.includes('/pwa?')
                        ? h.settings('New A')
                        : h.files('A'),
                );
        }
        await pending;
        assert.equal(h.popups[0].closed, outcome !== 'success');
        assert.equal(h.uploads.length, outcome === 'success' ? 1 : 0);
        if (outcome === 'success') {
            uploadResult(h.uploads[0].xhr);
            assert.equal(h.popups[0].navigations.length, 1);
        }
    }
});

test('bfcache return clears stale activity and reloads remembered project without moving auth into storage', async () => {
    const h = harness();
    ready(h);
    h.run('activeRequest={abort(){}};managementBusy=true;filesLoading=true;');
    assert.equal(typeof h.windowListeners.pageshow, 'function');
    h.windowListeners.pageshow({ persisted: true });
    await tick();
    assert.equal(h.run('activeRequest'), null);
    assert.equal(h.run('managementBusy'), false);
    assert.ok(
        h.requests.some((request) => request.url.includes('/api/projects')),
    );
    assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get('key'),
        'a'.repeat(64),
    );
    assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get('project'),
        'A',
    );
});

test('tab round trips preserve selected HTML and unsaved PWA settings', () => {
    const h = harness();
    ready(h);
    h.element('tab-pwa').click();
    h.element('pwa-description').value = 'Unsaved draft';
    h.element('pwa-description').listeners.input();
    assert.equal(h.run('pwaDirty'), true);
    assert.equal(h.element('pwa-draft-badge').hidden, false);
    h.element('tab-files').click();
    h.element('tab-upload').click();
    assert.equal(h.run('selected.name'), 'page.html');
    assert.equal(h.element('pwa-description').value, 'Unsaved draft');
    assert.equal(h.run('pwaDirty'), true);
    assert.equal(h.element('pwa-draft-badge').hidden, false);
    assert.equal(h.element('panel-upload').hidden, false);
    for (const name of ['files', 'pwa', 'share'])
        assert.equal(h.element('panel-' + name).hidden, true);
    assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get('tab'),
        'upload',
    );
    assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get('project'),
        'A',
    );
    assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get('key'),
        'a'.repeat(64),
    );
    assert.equal(
        h.requests.length,
        0,
        'Switching tabs must not reload and discard the draft',
    );
});

test('tab selection is blocked while uploading and keyboard navigation works after completion', () => {
    const h = harness();
    ready(h);
    h.element('tab-upload').click();
    h.run('activeRequest={abort(){}};updateSubmit();');
    assert.equal(h.element('tab-files').disabled, true);
    h.element('tab-files').click();
    assert.equal(h.element('panel-upload').hidden, false);
    h.run('activeRequest=null;updateSubmit();');
    h.element('tab-upload').listeners.keydown({
        key: 'ArrowRight',
        preventDefault() {},
        currentTarget: h.element('tab-upload'),
    });
    assert.equal(h.element('panel-files').hidden, false);
    h.element('tab-files').listeners.keydown({
        key: 'End',
        preventDefault() {},
        currentTarget: h.element('tab-files'),
    });
    assert.equal(h.element('panel-share').hidden, false);
    h.element('tab-share').listeners.keydown({
        key: 'Home',
        preventDefault() {},
        currentTarget: h.element('tab-share'),
    });
    assert.equal(h.element('panel-upload').hidden, false);
});

function cleanupFileHandle({ permission = 'granted' } = {}) {
    let bytes = Buffer.alloc(100, 65);
    let modified = 1234;
    const calls = { permission: 0, getFile: 0, remove: 0 };
    const handle = {
        async requestPermission(options) {
            assert.equal(options.mode, 'readwrite');
            calls.permission++;
            return permission;
        },
        async getFile() {
            calls.getFile++;
            const snapshot = Buffer.from(bytes);
            return {
                name: 'page.html',
                size: snapshot.length,
                lastModified: modified,
                async arrayBuffer() {
                    return snapshot.buffer.slice(
                        snapshot.byteOffset,
                        snapshot.byteOffset + snapshot.byteLength,
                    );
                },
            };
        },
        async remove() {
            calls.remove++;
        },
    };
    return {
        handle,
        calls,
        changeContent() {
            bytes = Buffer.alloc(100, 66);
        },
        changeModified() {
            modified++;
        },
    };
}

async function selectCleanupFile(h, fixture) {
    h.setPicker(async () => [fixture.handle]);
    h.element('delete-original').checked = true;
    h.element('delete-original').listeners.change();
    assert.equal(h.element('cleanup-hint').hidden, false);
    await h.element('drop-zone').listeners.click({ isTrusted: true });
    for (
        let attempt = 0;
        attempt < 100 && h.element('submit').disabled;
        attempt++
    )
        await tick();
    assert.equal(fixture.calls.permission, 1);
    assert.equal(h.element('submit').disabled, false);
    assert.match(h.element('file-detail').textContent, /삭제/);
}

test('cleanup selection removes the same original only after validated upload completion and still opens preview', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    ready(h);
    await selectCleanupFile(h, fixture);
    await h.element('upload-form').listeners.submit({
        preventDefault() {},
        submitter: h.element('submit-open'),
    });
    assert.equal(h.uploads.length, 1);
    assert.equal(fixture.calls.remove, 0);
    const xhr = h.uploads[0].xhr;
    xhr.status = 201;
    xhr.responseText = JSON.stringify({
        project: 'A',
        filename: 'page.html',
        url: '/A/',
        size: 100,
    });
    xhr.listeners.load();
    assert.equal(fixture.calls.remove, 0, 'Do not remove before loadend');
    await xhr.listeners.loadend();
    assert.equal(fixture.calls.remove, 1);
    assert.equal(h.popups.length, 1);
    assert.equal(h.popups[0].closed, false);
    assert.equal(new URL(h.popups[0].navigations[0]).pathname, '/A/');
});

test('cleanup selection preserves the original after rejected, cancelled, or invalid uploads', async () => {
    for (const outcome of ['rejected', 'cancelled', 'invalid']) {
        const h = harness({ cleanupPicker: true });
        const fixture = cleanupFileHandle();
        ready(h);
        await selectCleanupFile(h, fixture);
        await h
            .element('upload-form')
            .listeners.submit({ preventDefault() {} });
        const xhr = h.uploads[0].xhr;
        if (outcome === 'cancelled') h.element('cancel').listeners.click();
        else {
            xhr.status = outcome === 'rejected' ? 422 : 201;
            xhr.responseText =
                outcome === 'rejected' ? '{"error":"Rejected"}' : 'bad JSON';
            xhr.listeners.load();
            await xhr.listeners.loadend();
        }
        await tick();
        assert.equal(fixture.calls.remove, 0, outcome);
    }
});

test('cleanup selection preserves the original when a 2xx response describes another upload', async () => {
    for (const result of [
        { project: 'B', size: 100 },
        { project: 'A', size: 101 },
    ]) {
        const h = harness({ cleanupPicker: true });
        const fixture = cleanupFileHandle();
        ready(h);
        await selectCleanupFile(h, fixture);
        await h
            .element('upload-form')
            .listeners.submit({ preventDefault() {} });
        const xhr = h.uploads[0].xhr;
        xhr.status = 201;
        xhr.responseText = JSON.stringify({
            ...result,
            filename: 'page.html',
            url: '/A/',
        });
        xhr.listeners.load();
        await xhr.listeners.loadend();
        assert.equal(fixture.calls.remove, 0);
        assert.match(h.element('status').textContent, /응답/);
    }
});

test('cleanup selection preserves an original that changes before upload completion', async () => {
    for (const change of ['content', 'modified']) {
        const h = harness({ cleanupPicker: true });
        const fixture = cleanupFileHandle();
        ready(h);
        await selectCleanupFile(h, fixture);
        await h
            .element('upload-form')
            .listeners.submit({ preventDefault() {} });
        if (change === 'content') fixture.changeContent();
        else fixture.changeModified();
        const xhr = h.uploads[0].xhr;
        xhr.status = 201;
        xhr.responseText = JSON.stringify({
            project: 'A',
            filename: 'page.html',
            url: '/A/',
            size: 100,
        });
        xhr.listeners.load();
        await xhr.listeners.loadend();
        assert.equal(fixture.calls.remove, 0, change);
        assert.match(h.element('status').textContent, /원본|변경|삭제/);
    }
});

test('ordinary file selection never removes a previous cleanup handle', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    ready(h);
    await selectCleanupFile(h, fixture);
    const ordinary = await fixture.handle.getFile();
    h.element('file').files = [ordinary];
    h.element('file').listeners.change({ target: h.element('file') });
    assert.doesNotMatch(h.element('file-detail').textContent, /원본 삭제/);
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    uploadResult(h.uploads[0].xhr);
    await tick();
    assert.equal(fixture.calls.remove, 0);
});

test('permission refusal leaves deletion disabled and ordinary upload available', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle({ permission: 'denied' });
    ready(h);
    h.setPicker(async () => [fixture.handle]);
    h.element('delete-original').checked = true;
    h.element('delete-original').listeners.change();
    await h.element('drop-zone').listeners.click({ isTrusted: true });
    for (
        let attempt = 0;
        attempt < 100 && h.element('submit').disabled;
        attempt++
    )
        await tick();
    assert.equal(fixture.calls.remove, 0);
    const ordinary = await fixture.handle.getFile();
    h.element('file').files = [ordinary];
    h.element('file').listeners.change({ target: h.element('file') });
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    uploadResult(h.uploads[0].xhr);
    await tick();
    assert.equal(fixture.calls.remove, 0);
});

test('cleanup picker is hidden when the browser does not provide removable file handles', () => {
    const h = harness();
    assert.equal(h.element('cleanup-choice').hidden, true);
    assert.equal(h.element('file-cleanup-help').hidden, false);
    assert.equal(h.element('delete-original').checked, false);
});

test('one file button chooses exactly one picker according to the delete-original option', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    let cleanupPickerCalls = 0;
    h.setPicker(async () => {
        cleanupPickerCalls++;
        return [fixture.handle];
    });
    ready(h);
    h.element('delete-original').checked = false;
    h.element('delete-original').listeners.change();
    await h.element('drop-zone').listeners.click({ isTrusted: true });
    assert.equal(h.element('file').clicks, 1);
    assert.equal(cleanupPickerCalls, 0);
    h.element('delete-original').checked = true;
    h.element('delete-original').listeners.change();
    await h.element('drop-zone').listeners.click({ isTrusted: true });
    await tick();
    assert.equal(h.element('file').clicks, 1);
    assert.equal(cleanupPickerCalls, 1);
    assert.equal(fixture.calls.permission, 1);
});

test('supported browsers initially select the removable-file picker', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    let cleanupPickerCalls = 0;
    h.setPicker(async () => {
        cleanupPickerCalls++;
        return [fixture.handle];
    });
    ready(h);
    assert.equal(h.element('cleanup-choice').hidden, false);
    assert.equal(h.element('delete-original').checked, true);
    assert.equal(h.element('cleanup-hint').hidden, false);
    await h.element('drop-zone').listeners.click({ isTrusted: true });
    for (
        let attempt = 0;
        attempt < 100 && h.element('submit').disabled;
        attempt++
    )
        await tick();
    assert.equal(cleanupPickerCalls, 1);
    assert.equal(h.element('file').clicks, 0);
    assert.equal(h.element('submit').disabled, false);
});

test('changing delete-original option clears a previously chosen file and requires reselection', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    ready(h);
    await selectCleanupFile(h, fixture);
    h.element('delete-original').checked = false;
    h.element('delete-original').listeners.change();
    assert.equal(h.run('selected'), null);
    assert.equal(h.element('cleanup-hint').hidden, true);
    assert.equal(h.element('submit').disabled, true);
    assert.equal(h.run('cleanupSelection'), null);
    assert.equal(fixture.calls.remove, 0);
});

test('dropping a file turns deletion off and uploads without removing the prior original', async () => {
    const h = harness({ cleanupPicker: true });
    const fixture = cleanupFileHandle();
    ready(h);
    await selectCleanupFile(h, fixture);
    const ordinary = await fixture.handle.getFile();
    h.element('drop-zone').listeners.drop({
        preventDefault() {},
        dataTransfer: { files: [ordinary] },
    });
    assert.equal(h.element('delete-original').checked, false);
    assert.equal(h.element('cleanup-hint').hidden, true);
    assert.equal(h.run('cleanupSelection'), null);
    assert.match(h.element('status').textContent, /일반 업로드/);
    await h.element('upload-form').listeners.submit({ preventDefault() {} });
    uploadResult(h.uploads[0].xhr);
    await tick();
    assert.equal(fixture.calls.remove, 0);
});
