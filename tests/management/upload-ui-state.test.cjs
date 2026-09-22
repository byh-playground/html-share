const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const elements = new Map(),
        requests = [],
        uploads = [],
        navigations = [],
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
        location,
        document,
        windowListeners,
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

test('default upload stays and focuses its result while upload-and-open uses credential-free current-tab URL', async () => {
    const stay = harness();
    ready(stay);
    await stay.element('upload-form').listeners.submit({
        preventDefault() {},
        submitter: stay.element('submit'),
    });
    uploadResult(stay.uploads[0].xhr);
    await tick();
    assert.equal(stay.navigations.length, 0);
    assert.equal(stay.element('result').hidden, false);
    assert.equal(stay.document.activeElement?.id, 'result');
    assert.match(stay.element('result-file').textContent, /page.html/);
    stay.element('upload-next').listeners.click();
    assert.equal(stay.document.activeElement?.id, 'file');
    const open = harness();
    ready(open);
    open.element('submit-open').dataset.openProject = 'true';
    await open.element('upload-form').listeners.submit({
        preventDefault() {},
        submitter: open.element('submit-open'),
    });
    uploadResult(open.uploads[0].xhr);
    await tick();
    assert.equal(open.navigations.length, 1);
    const url = new URL(open.navigations[0]);
    assert.equal(url.pathname, '/A/');
    assert.ok(url.searchParams.has('hs_preview'));
    assert.equal(url.hash, '');
    assert.ok(!url.href.includes('a'.repeat(64)));
});

test('upload-and-open failures and cancellation never navigate', async () => {
    for (const outcome of ['failure', 'cancel']) {
        const h = harness();
        ready(h);
        h.element('submit-open').dataset.openProject = 'true';
        await h.element('upload-form').listeners.submit({
            preventDefault() {},
            submitter: h.element('submit-open'),
        });
        if (outcome === 'failure') uploadResult(h.uploads[0].xhr, 422);
        else h.element('cancel').listeners.click();
        await tick();
        assert.equal(h.navigations.length, 0);
        assert.equal(h.run('activeRequest'), null);
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
