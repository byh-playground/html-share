const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    allowedName,
    inside,
    ZipProjects,
} = require('../projects/zip-projects.cjs');
const {
    sourceType,
    compareSources,
} = require('../projects/source-selection.cjs');
const acorn = require('acorn');
const { parse: parseHtml } = require('parse5');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const invalid = (message) =>
    Object.assign(new Error(message), { code: 'PWA_INVALID' });
function declaredBuilds(html) {
    const builds = [];
    const visit = (node) => {
        if (node.tagName === 'script') {
            const attrs = Object.fromEntries(
                (node.attrs || []).map((attr) => [attr.name, attr.value]),
            );
            const type = (attrs.type || '').trim().toLowerCase().split(';')[0];
            const executable =
                !type ||
                type === 'module' ||
                /^(text|application)\/(x-)?(java|ecma)script(?:1\.[0-5])?$/.test(
                    type,
                );
            if (executable && !Object.hasOwn(attrs, 'src')) {
                const script = (node.childNodes || [])
                    .map((child) => child.value || '')
                    .join('');
                let tree;
                try {
                    tree = acorn.parse(script, {
                        ecmaVersion: 'latest',
                        sourceType: type === 'module' ? 'module' : 'script',
                    });
                } catch (error) {
                    throw invalid(
                        'Inline JavaScript syntax error at line ' +
                            error.loc?.line +
                            ': ' +
                            error.message,
                    );
                }
                const walk = (value) => {
                    if (!value || typeof value !== 'object') return;
                    if (
                        value.type === 'VariableDeclarator' &&
                        value.id?.type === 'Identifier' &&
                        value.id.name === 'PWA_BUILD_ID'
                    ) {
                        if (
                            value.init?.type !== 'Literal' ||
                            typeof value.init.value !== 'string'
                        )
                            throw invalid(
                                'PWA_BUILD_ID must be a literal string',
                            );
                        builds.push(value.init.value);
                    }
                    for (const child of Object.values(value))
                        if (Array.isArray(child)) child.forEach(walk);
                        else if (child && typeof child === 'object')
                            walk(child);
                };
                walk(tree);
            }
        }
        // Template contents are inert until user code explicitly instantiates them.
        for (const child of node.childNodes || []) visit(child);
    };
    visit(parseHtml(html));
    return builds;
}

// A waiting worker is activated only by the application's explicit update gate.
const SW_TEMPLATE = `const CACHE_NAME = __PWA_CACHE_NAME__;
const PRECACHE = __PWA_PRECACHE__;
const SCOPE = self.registration.scope;
const PREFIX = CACHE_NAME.split(':release:')[0] + ':' + encodeURIComponent(SCOPE) + ':';
const CACHE = PREFIX + CACHE_NAME.split(':release:')[1];
async function network(request) {
  const headers = new Headers(request.headers);
  headers.set('ngrok-skip-browser-warning', '1');
  const response = await fetch(new Request(request, {headers, cache: 'no-store'}));
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const url = new URL(request.url);
  const type = response.headers.get('content-type') || '';
  if (/\\.(json|webmanifest|js|png|svg|ico)$/.test(url.pathname) && type.includes('text/html')) throw new Error('Unexpected HTML');
  return response;
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const results = await Promise.allSettled(PRECACHE.map(async item => {
    const request = new Request(new URL(item, SCOPE));
    // Consume each response immediately: waiting for all headers before draining
    // large icon bodies can exhaust the browser's per-origin connection pool.
    await cache.put(request, await network(request));
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) { await caches.delete(CACHE); throw failure.reason; }
})()));
self.addEventListener('message', event => { if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  if (url.pathname.endsWith('/sw.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fresh = request.mode === 'navigate' || /\\.(html?|json|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
    let saved = await cache.match(request);
    const version = url.pathname === new URL('version.json', SCOPE).pathname;
    const document = request.mode === 'navigate' || /\\.html?$/.test(url.pathname) || url.pathname === new URL(SCOPE).pathname;
    if (!saved && (document || version)) saved = await cache.match(request, {ignoreSearch:true});
    if (!saved && request.mode === 'navigate') saved = await cache.match(new URL('index.html', SCOPE).href);
    if (!fresh && saved) return saved;
    try { const response = await network(request); await cache.put(request,response.clone()); return response; }
    catch (error) { if (saved) return saved; throw error; }
  })());
});
`;

class PwaProjects {
    constructor(
        publicRoot,
        runtime,
        projectsRoot = process.env.HTML_SHARE_PROJECTS_ROOT ||
            path.join(repositoryRoot, 'projects'),
    ) {
        this.publicRoot = path.resolve(publicRoot);
        this.runtime = path.resolve(runtime);
        this.projectsRoot = path.resolve(projectsRoot);
        this.pending = new Map();
        this.templateRoot = path.resolve(
            process.env.HTML_SHARE_PWA_TEMPLATE ||
                path.join(repositoryRoot, 'src/pwa/template'),
        );
        if (
            inside(this.publicRoot, this.projectsRoot) ||
            inside(this.publicRoot, this.runtime)
        )
            throw invalid('PWA private storage must be outside public');
    }
    async safePath(file, directory = false) {
        const full = path.resolve(file),
            parsed = path.parse(full);
        let current = parsed.root;
        for (const part of full
            .slice(parsed.root.length)
            .split(path.sep)
            .filter(Boolean)) {
            current = path.join(current, part);
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink())
                    throw invalid('PWA symlinks are not allowed');
            } catch (error) {
                if (error.code === 'ENOENT') break;
                throw error;
            }
        }
        if (directory) await fs.mkdir(full, { recursive: true });
        return full;
    }
    project(name) {
        if (!allowedName(name) || name.includes('/') || name === 'upload')
            throw invalid('Invalid PWA project name');
        return path.join(this.projectsRoot, name);
    }
    async config(name) {
        try {
            return JSON.parse(
                await fs.readFile(
                    await this.safePath(
                        path.join(this.project(name), 'pwa.json'),
                    ),
                    'utf8',
                ),
            );
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }
    async legacy(name) {
        const base = await this.safePath(
            path.join(this.project(name), 'pwa-base'),
        );
        try {
            return (await fs.stat(base)).isDirectory();
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }
    async managed(name) {
        return Boolean(await this.config(name)) || (await this.legacy(name));
    }
    async enabled(name) {
        const config = await this.config(name);
        return config ? config.enabled === true : this.legacy(name);
    }
    async directory(name) {
        return this.safePath(
            (await this.managed(name))
                ? path.join(this.project(name), 'uploads')
                : path.join(this.publicRoot, name),
            true,
        );
    }
    async settings(name) {
        const existing = await this.config(name);
        if (existing) return existing;
        let manifest = {};
        if (await this.legacy(name))
            for (const filename of ['manifest.json', 'manifest.webmanifest']) {
                try {
                    manifest = JSON.parse(
                        await fs.readFile(
                            await this.safePath(
                                path.join(
                                    this.project(name),
                                    'pwa-base',
                                    filename,
                                ),
                            ),
                            'utf8',
                        ),
                    );
                    break;
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
        return {
            enabled: await this.legacy(name),
            name: manifest.name || name,
            shortName: manifest.short_name || name.slice(0, 12),
            description: manifest.description || '',
            themeColor: manifest.theme_color || '#245fd6',
            backgroundColor: manifest.background_color || '#eef2f5',
            revision: 'initial',
        };
    }
    validateSettings(input, current) {
        if (
            !input ||
            typeof input !== 'object' ||
            typeof input.enabled !== 'boolean'
        )
            throw invalid('PWA enabled must be boolean');
        if (input.revision !== undefined && input.revision !== current.revision)
            throw Object.assign(
                invalid('PWA settings changed; refresh before saving'),
                { code: 'PWA_CONFLICT' },
            );
        const next = { enabled: input.enabled };
        for (const [key, max] of [
            ['name', 100],
            ['shortName', 30],
            ['description', 500],
        ]) {
            const value = input[key] ?? current[key];
            if (
                typeof value !== 'string' ||
                value.length > max ||
                /[\x00-\x1f]/.test(value) ||
                (key !== 'description' && !value.trim())
            )
                throw invalid('Invalid PWA ' + key);
            next[key] = value.trim();
        }
        for (const key of ['themeColor', 'backgroundColor']) {
            const value = input[key] ?? current[key];
            if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value))
                throw invalid('Invalid PWA ' + key);
            next[key] = value;
        }
        next.revision = crypto.randomUUID();
        return next;
    }
    async copyTree(source, target, filter = () => true) {
        const snapshot = await this.snapshot(source);
        for (const entry of snapshot.entries)
            if (filter(entry.name)) {
                const output = await this.safePath(
                    path.join(target, ...entry.name.split('/')),
                );
                await fs.mkdir(path.dirname(output), { recursive: true });
                try {
                    await fs.writeFile(output, entry.data, { flag: 'wx' });
                    const info = await fs.stat(
                        path.join(source, ...entry.name.split('/')),
                    );
                    await fs.utimes(output, info.atime, info.mtime);
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                }
            }
    }
    configure(name, input) {
        return this.serial(name, async () => {
            const current = await this.settings(name),
                next = this.validateSettings(input, current),
                wasManaged = await this.managed(name);
            let existed = true;
            try {
                await fs.stat(this.project(name));
            } catch (error) {
                if (error.code === 'ENOENT') existed = false;
                else throw error;
            }
            let stage,
                retainStage = false;
            try {
                const project = await this.safePath(this.project(name), true),
                    uploads = await this.safePath(
                        path.join(project, 'uploads'),
                        true,
                    ),
                    assets = await this.safePath(
                        path.join(project, 'pwa-assets'),
                        true,
                    );
                const assetFilter = (filename) =>
                    !(
                        /\.html?$/i.test(filename) ||
                        /^(manifest\.(json|webmanifest)|sw(\.template)?\.js|version\.json)$/.test(
                            filename,
                        )
                    );
                const sourceDir = wasManaged
                    ? uploads
                    : await this.safePath(
                          path.join(this.publicRoot, name),
                          true,
                      );
                const entries = await Promise.all(
                    (await fs.readdir(sourceDir))
                        .filter(allowedName)
                        .map(async (name) => ({
                            name,
                            file: await this.safePath(
                                path.join(sourceDir, name),
                            ),
                            info: await fs.stat(path.join(sourceDir, name)),
                        })),
                );
                const selected = entries
                    .filter((e) => e.info.isFile() && sourceType(e.name))
                    .sort(compareSources)[0];
                const importZip =
                    next.enabled &&
                    !current.enabled &&
                    selected &&
                    sourceType(selected.name) === 'zip';
                const convertLegacy =
                    (await this.legacy(name)) && !(await this.config(name));
                let stagedUploads = uploads,
                    stagedAssets = assets,
                    archive;
                if (!wasManaged || importZip || convertLegacy) {
                    stage = await this.safePath(
                        path.join(project, '.configure-' + crypto.randomUUID()),
                        true,
                    );
                    stagedUploads = await this.safePath(
                        path.join(stage, 'uploads'),
                        true,
                    );
                    stagedAssets = await this.safePath(
                        path.join(stage, 'assets'),
                        true,
                    );
                    await this.copyTree(uploads, stagedUploads);
                    await this.copyTree(assets, stagedAssets);
                    if (convertLegacy)
                        await this.copyTree(
                            path.join(project, 'pwa-base'),
                            stagedAssets,
                            assetFilter,
                        );
                    if (!wasManaged) {
                        await this.copyTree(
                            sourceDir,
                            stagedUploads,
                            (filename) =>
                                !next.enabled || !/\.zip$/i.test(filename),
                        );
                        await this.copyTree(
                            sourceDir,
                            stagedAssets,
                            (filename) =>
                                assetFilter(filename) &&
                                !/\.zip$/i.test(filename),
                        );
                    }
                    if (importZip) {
                        const zipHash = hash(await fs.readFile(selected.file));
                        const zip = new ZipProjects(
                            path.join(this.runtime, 'pwa-import'),
                            undefined,
                            this.publicRoot,
                        );
                        const unpacked = await zip.load(selected.file);
                        const files = await this.snapshot(unpacked.root);
                        const htmls = [];
                        for (const entry of files.entries)
                            if (/\.html?$/i.test(entry.name)) {
                                const file = path.join(
                                    unpacked.root,
                                    ...entry.name.split('/'),
                                );
                                htmls.push({
                                    file,
                                    name: entry.name,
                                    info: await fs.stat(file),
                                });
                            }
                        htmls.sort(
                            (a, b) =>
                                b.info.mtimeMs - a.info.mtimeMs ||
                                a.name.localeCompare(b.name),
                        );
                        if (!htmls.length)
                            throw invalid('ZIP contains no HTML');
                        if (path.dirname(htmls[0].file) !== unpacked.root)
                            throw invalid(
                                'ZIP HTML is nested below its asset root. Move the entry HTML and its relative assets to the ZIP root before enabling PWA; parent-folder references cannot be relocated safely.',
                            );
                        // A new ZIP's assets replace old names in staging, never in the live base.
                        for (const entry of files.entries)
                            if (assetFilter(entry.name)) {
                                const output = await this.safePath(
                                    path.join(
                                        stagedAssets,
                                        ...entry.name.split('/'),
                                    ),
                                );
                                await fs.mkdir(path.dirname(output), {
                                    recursive: true,
                                });
                                await fs.writeFile(output, entry.data);
                            }
                        const seed = path.join(
                            stagedUploads,
                            'imported-' + zipHash.slice(0, 16) + '.html',
                        );
                        await fs.copyFile(htmls[0].file, seed);
                        // ZIP wins source ties; one millisecond preserves that choice after import.
                        await fs.utimes(
                            seed,
                            selected.info.atime,
                            new Date(selected.info.mtimeMs + 1),
                        );
                        const archived = path.join(stage, 'archive.zip');
                        await fs.copyFile(selected.file, archived);
                        if (
                            hash(await fs.readFile(selected.file)) !==
                                zipHash ||
                            hash(await fs.readFile(archived)) !== zipHash
                        )
                            throw invalid(
                                'ZIP changed during PWA import; finish copying and try again',
                            );
                        archive = {
                            file: archived,
                            name: zipHash.slice(0, 16) + '-' + selected.name,
                        };
                    }
                }
                let release;
                if (next.enabled) {
                    const source = await this.latest(stagedUploads);
                    if (source)
                        release = await this._prepare(
                            name,
                            source.file,
                            source.source,
                            next,
                            stagedAssets,
                        );
                }
                const pointer = await this.safePath(
                        path.join(project, 'pwa.json'),
                    ),
                    temp = pointer + '.tmp-' + crypto.randomUUID();
                const old = await this.config(name),
                    oldActive = await this.readActive(name),
                    promoted = [];
                try {
                    if (stage)
                        for (const [target, prepared, label] of [
                            [uploads, stagedUploads, 'uploads'],
                            [assets, stagedAssets, 'assets'],
                        ]) {
                            const backup = path.join(
                                stage,
                                'previous-' + label,
                            );
                            await fs.rename(target, backup);
                            promoted.push({ target, backup });
                            await fs.rename(prepared, target);
                        }
                    if (archive) {
                        const archiveDir = await this.safePath(
                            path.join(project, 'archives'),
                            true,
                        );
                        await fs.copyFile(
                            archive.file,
                            path.join(archiveDir, archive.name),
                        );
                    }
                    await fs.writeFile(temp, JSON.stringify(next, null, 2));
                    await fs.rename(temp, pointer);
                    if (release) await this._activate(name, release);
                } catch (error) {
                    try {
                        for (const { target, backup } of promoted.reverse()) {
                            if (!inside(project, target) || target === project)
                                throw invalid('Unsafe rollback path');
                            await fs.rm(target, {
                                recursive: true,
                                force: true,
                            });
                            await fs.rename(backup, target);
                        }
                        if (old) {
                            await fs.writeFile(
                                temp,
                                JSON.stringify(old, null, 2),
                            );
                            await fs.rename(temp, pointer);
                        } else await fs.rm(pointer, { force: true });
                        if (oldActive) await this._activate(name, oldActive);
                        else
                            await fs.rm(path.join(project, 'active.json'), {
                                force: true,
                            });
                    } catch (recoveryError) {
                        retainStage = true;
                        throw invalid(
                            'PWA settings rollback could not finish; retained backup at ' +
                                stage +
                                '. ' +
                                recoveryError.message,
                        );
                    }
                    throw error;
                } finally {
                    await fs.rm(temp, { force: true });
                }
                return next;
            } catch (error) {
                if (!existed && !retainStage) {
                    const target = this.project(name);
                    if (
                        !inside(this.projectsRoot, target) ||
                        target === this.projectsRoot
                    )
                        throw invalid('Unsafe project cleanup');
                    await fs.rm(target, { recursive: true, force: true });
                }
                throw error;
            } finally {
                if (stage && !retainStage) {
                    if (!inside(this.project(name), stage))
                        throw invalid('Unsafe staging cleanup');
                    await fs.rm(stage, { recursive: true, force: true });
                }
            }
        });
    }
    serial(name, job) {
        const next = (this.pending.get(name) || Promise.resolve())
            .catch(() => {})
            .then(job);
        this.pending.set(name, next);
        next.finally(() => {
            if (this.pending.get(name) === next) this.pending.delete(name);
        }).catch(() => {});
        return next;
    }
    async snapshot(base) {
        const entries = [];
        const visit = async (directory) => {
            for (const name of (await fs.readdir(directory)).sort()) {
                if (!allowedName(name))
                    throw invalid('Unsafe PWA base file name');
                const file = await this.safePath(path.join(directory, name)),
                    stat = await fs.stat(file);
                if (stat.isDirectory()) await visit(file);
                else if (stat.isFile()) {
                    const data = await fs.readFile(file);
                    entries.push({
                        name: path
                            .relative(base, file)
                            .split(path.sep)
                            .join('/'),
                        data,
                    });
                } else throw invalid('Unsupported PWA base file');
            }
        };
        await visit(base);
        return {
            entries,
            digest: hash(
                Buffer.concat(
                    entries.flatMap((e) => [
                        Buffer.from(e.name + '\0' + e.data.length + '\0'),
                        e.data,
                    ]),
                ),
            ),
        };
    }
    async bundle(name, override, assetRoot) {
        const config = override || (await this.config(name));
        if (!config)
            return this.snapshot(path.join(this.project(name), 'pwa-base'));
        const merged = new Map();
        for (const directory of [
            this.templateRoot,
            assetRoot || path.join(this.project(name), 'pwa-assets'),
        ]) {
            await this.safePath(directory);
            try {
                for (const entry of (await this.snapshot(directory)).entries)
                    merged.set(entry.name, entry);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        const icons = ['192', '512']
            .filter((size) => merged.has('icons/icon-' + size + '.png'))
            .map((size) => ({
                src: 'icons/icon-' + size + '.png',
                sizes: size + 'x' + size,
                type: 'image/png',
            }));
        if (merged.has('icons/icon-maskable-512.png'))
            icons.push({
                src: 'icons/icon-maskable-512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
            });
        let legacy = {};
        if (await this.legacy(name))
            for (const file of ['manifest.json', 'manifest.webmanifest']) {
                try {
                    legacy = JSON.parse(
                        await fs.readFile(
                            await this.safePath(
                                path.join(this.project(name), 'pwa-base', file),
                            ),
                            'utf8',
                        ),
                    );
                    break;
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
        const legacyIcons = legacy.icons?.filter(
            (icon) =>
                typeof icon.src === 'string' &&
                merged.has(icon.src.replace(/^\.\//, '')),
        );
        // Manifest IDs resolve against the origin, unlike start_url/scope. './' would
        // make every project share the same app identity at the site's root.
        const projectId = '/' + encodeURIComponent(name) + '/';
        let appId = projectId;
        if (typeof legacy.id === 'string') {
            const previousId = new URL(legacy.id, 'https://pwa.invalid/');
            if (
                previousId.origin === 'https://pwa.invalid' &&
                previousId.pathname.startsWith(projectId)
            )
                appId = previousId.pathname + previousId.search;
        }
        const manifest = {
            ...legacy,
            id: appId,
            start_url: legacy.start_url || './',
            scope: legacy.scope || './',
            display: legacy.display || 'standalone',
            name: config.name,
            short_name: config.shortName,
            description: config.description,
            theme_color: config.themeColor,
            background_color: config.backgroundColor,
            icons: legacyIcons?.length ? legacyIcons : icons,
        };
        for (const filename of ['manifest.json', 'manifest.webmanifest'])
            merged.set(filename, {
                name: filename,
                data: Buffer.from(JSON.stringify(manifest, null, 2)),
            });
        if (!merged.has('sw.template.js'))
            merged.set('sw.template.js', {
                name: 'sw.template.js',
                data: Buffer.from(SW_TEMPLATE),
            });
        merged.set('pwa-register.js', {
            name: 'pwa-register.js',
            data: Buffer.from(
                "if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(error => console.warn('PWA registration failed', error)); }); }\n",
            ),
        });
        const entries = [...merged.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
        );
        return {
            entries,
            digest: hash(
                JSON.stringify(config) +
                    Buffer.concat(
                        entries.flatMap((e) => [
                            Buffer.from(e.name + '\0' + e.data.length + '\0'),
                            e.data,
                        ]),
                    ).toString('base64'),
            ),
            config,
        };
    }
    async latest(directory) {
        const entries = [];
        for (const source of await fs.readdir(directory))
            if (allowedName(source) && /\.html?$/i.test(source)) {
                const file = await this.safePath(path.join(directory, source)),
                    info = await fs.stat(file);
                if (info.isFile())
                    entries.push({ source, file, mtime: info.mtimeMs });
            }
        return entries.sort(
            (a, b) =>
                b.mtime - a.mtime ||
                (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
        )[0];
    }
    prepare(name, sourcePath, sourceName = path.basename(sourcePath)) {
        return this.serial(name, () =>
            this._prepare(name, sourcePath, sourceName),
        );
    }
    async _prepare(name, sourcePath, sourceName, override, assetRoot) {
        if (!override && !(await this.enabled(name)))
            throw invalid('PWA is not enabled');
        if (
            !allowedName(sourceName) ||
            sourceName.includes('/') ||
            !/\.html?$/i.test(sourceName)
        )
            throw invalid('PWA updates require HTML');
        await this.safePath(sourcePath);
        const data = await fs.readFile(sourcePath),
            html = data.toString('utf8');
        const builds = declaredBuilds(html);
        if (
            new Set(builds).size > 1 ||
            (builds.length && !/^[\w.-]{1,128}$/.test(builds[0]))
        )
            throw invalid('HTML needs one consistent literal PWA_BUILD_ID');
        const sourceHash = hash(data),
            build = builds[0] || sourceHash.slice(0, 16);
        const snapshot = await this.bundle(name, override, assetRoot);
        const manifests = snapshot.entries.filter((e) =>
            ['manifest.json', 'manifest.webmanifest'].includes(e.name),
        );
        if (!manifests.length)
            throw invalid(
                'PWA base needs manifest.json or manifest.webmanifest',
            );
        for (const manifest of manifests) {
            let value;
            try {
                value = JSON.parse(manifest.data);
            } catch {
                throw invalid('Invalid PWA manifest');
            }
            for (const key of ['id', 'scope', 'start_url'])
                if (value[key] !== undefined) {
                    const url = new URL(
                        value[key],
                        `https://pwa.invalid/${encodeURIComponent(name)}/`,
                    );
                    if (
                        url.origin !== 'https://pwa.invalid' ||
                        !url.pathname.startsWith(
                            '/' + encodeURIComponent(name) + '/',
                        )
                    )
                        throw invalid(
                            'PWA manifest ' + key + ' escapes project scope',
                        );
                }
        }
        const template =
            snapshot.entries
                .find((e) => e.name === 'sw.template.js')
                ?.data.toString('utf8') || SW_TEMPLATE;
        if (
            !template.includes('__PWA_CACHE_NAME__') ||
            !template.includes('__PWA_PRECACHE__')
        )
            throw invalid('PWA SW template placeholders missing');
        const id = hash(
                sourceHash + snapshot.digest + SW_TEMPLATE + ':renderer-2',
            ),
            releaseDir = await this.safePath(
                path.join(this.runtime, 'pwa', name, 'releases', id),
            );
        const root = path.join(releaseDir, 'site');
        const release = {
            id,
            build,
            source: sourceName,
            sourceHash,
            baseHash: snapshot.digest,
            root,
            publishedAt: new Date().toISOString(),
        };
        // Compare bytes again before publishing; interrupted copies cannot replace the active pointer.
        if (
            hash(await fs.readFile(sourcePath)) !== sourceHash ||
            (await this.bundle(name, override, assetRoot)).digest !==
                snapshot.digest
        )
            throw invalid('PWA source or base changed while preparing');
        try {
            const previous = JSON.parse(
                await fs.readFile(
                    path.join(releaseDir, 'release.json'),
                    'utf8',
                ),
            );
            if (
                previous.id === id &&
                (await fs.stat(path.join(root, 'index.html'))).isFile()
            )
                return { ...previous, source: sourceName, root };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const temporary = await this.safePath(
                releaseDir + '.tmp-' + crypto.randomUUID(),
                true,
            ),
            site = path.join(temporary, 'site');
        await fs.mkdir(site);
        try {
            for (const entry of snapshot.entries) {
                if (
                    [
                        'index.html',
                        'sw.js',
                        'sw.template.js',
                        'version.json',
                    ].includes(entry.name)
                )
                    continue;
                const target = path.join(site, ...entry.name.split('/'));
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, entry.data);
            }
            let output = html;
            if (snapshot.config) {
                output = output
                    .replace(
                        /<link\b(?=[^>]*\brel\s*=\s*['"](?:manifest|apple-touch-icon)['"])[^>]*>/gi,
                        '',
                    )
                    .replace(
                        /<meta\b(?=[^>]*\bname\s*=\s*['"]theme-color['"])[^>]*>/gi,
                        '',
                    );
                const apple = snapshot.entries.some(
                    (e) => e.name === 'icons/icon-180.png',
                )
                    ? '<link rel="apple-touch-icon" href="./icons/icon-180.png">'
                    : '';
                const tags =
                    '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials"><meta name="theme-color" content="' +
                    snapshot.config.themeColor +
                    '">' +
                    apple;
                output = /<\/head\s*>/i.test(output)
                    ? output.replace(/<\/head\s*>/i, tags + '</head>')
                    : tags + output;
                if (!/serviceWorker\s*\.\s*register\s*\(/.test(html))
                    output +=
                        '\n<script src="./pwa-register.js" defer></script>';
            }
            await fs.writeFile(path.join(site, 'index.html'), output);
            await fs.writeFile(
                path.join(site, 'version.json'),
                JSON.stringify({
                    build,
                    publishedAt: release.publishedAt,
                    required: true,
                }),
            );
            const precache = [
                './',
                './index.html',
                './version.json',
                ...snapshot.entries
                    .filter((e) =>
                        /^(manifest\.(json|webmanifest)|pwa-register\.js|icons\/)/.test(
                            e.name,
                        ),
                    )
                    .map(
                        (e) =>
                            './' +
                            e.name.split('/').map(encodeURIComponent).join('/'),
                    ),
            ];
            const worker = template
                .replaceAll(
                    '__PWA_CACHE_NAME__',
                    JSON.stringify(
                        'html-share:' +
                            encodeURIComponent(name) +
                            ':release:' +
                            id,
                    ),
                )
                .replaceAll('__PWA_PRECACHE__', JSON.stringify(precache));
            await fs.writeFile(path.join(site, 'sw.js'), worker);
            await fs.writeFile(
                path.join(temporary, 'release.json'),
                JSON.stringify(release),
            );
            if (
                hash(await fs.readFile(sourcePath)) !== sourceHash ||
                (await this.bundle(name, override, assetRoot)).digest !==
                    snapshot.digest
            )
                throw invalid('PWA source or base changed while preparing');
            await fs.rename(temporary, releaseDir);
        } finally {
            await fs.rm(temporary, { recursive: true, force: true });
        }
        return release;
    }
    activate(name, release) {
        return this.serial(name, () => this._activate(name, release));
    }
    async readActive(name) {
        const pointer = await this.safePath(
            path.join(this.project(name), 'active.json'),
        );
        try {
            return JSON.parse(await fs.readFile(pointer, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }
    async _activate(name, release) {
        const expected = path.join(
            this.runtime,
            'pwa',
            name,
            'releases',
            release.id,
            'site',
        );
        if (
            !/^[a-f0-9]{64}$/.test(release.id) ||
            path.resolve(release.root) !== expected
        )
            throw invalid('Invalid PWA release');
        await this.safePath(expected);
        await fs.access(path.join(expected, 'index.html'));
        const pointer = await this.safePath(
            path.join(this.project(name), 'active.json'),
        );
        const temporary = pointer + '.tmp-' + crypto.randomUUID();
        try {
            await fs.writeFile(temporary, JSON.stringify(release, null, 2));
            await fs.rename(temporary, pointer);
        } finally {
            await fs.rm(temporary, { force: true });
        }
        return release;
    }
    resolve(name) {
        return this.serial(name, async () => {
            const directory = await this.directory(name);
            const source = await this.latest(directory);
            if (!source)
                throw invalid('Upload an HTML file to this PWA project');
            const release = await this._prepare(
                name,
                source.file,
                source.source,
            );
            let active;
            try {
                active = JSON.parse(
                    await fs.readFile(
                        path.join(this.project(name), 'active.json'),
                        'utf8',
                    ),
                );
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (active?.id !== release.id || active?.source !== release.source)
                await this._activate(name, release);
            return release;
        });
    }
}
module.exports = { PwaProjects, SW_TEMPLATE };
