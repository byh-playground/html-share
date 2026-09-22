const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const QRCode = require('qrcode');
const {
    readManagementToken,
    isReservedProject,
    managementPath,
} = require('./management-route.cjs');
const {
    ZipProjects,
    LIMITS,
    allowedName,
    inside,
} = require('../projects/zip-projects.cjs');
const {
    snapshot,
    listing,
    identity,
    sourceType,
} = require('../projects/source-selection.cjs');
const { notifyProjectUpdate } = require('../notifications/notifications.cjs');

const component = (value) =>
    typeof value === 'string' &&
    value.length <= 180 &&
    !value.includes('/') &&
    allowedName(value);
const problem = (status, message) =>
    Object.assign(new Error(message), { status });
class Uploads {
    constructor(root, runtime, limit = LIMITS.archive, pwa) {
        this.root = root;
        this.runtime = path.resolve(runtime);
        this.limit = limit;
        this.pwa =
            pwa ||
            new (require('../pwa/pwa-projects.cjs').PwaProjects)(
                root,
                this.runtime,
            );
        if (inside(root, this.runtime))
            throw new Error('Upload runtime must be outside public');
        this.commits = Promise.resolve();
    }
    async project(name) {
        if (!component(name) || isReservedProject(name))
            throw problem(403, 'Invalid project');
        const directory = path.join(this.root, name);
        let info;
        try {
            info = await fs.lstat(directory);
        } catch (error) {
            if (error.code === 'ENOENT')
                throw problem(404, 'Project not found');
            throw error;
        }
        if (
            info.isSymbolicLink() ||
            !info.isDirectory() ||
            (await fs.realpath(directory)) !== directory
        )
            throw problem(403, 'Invalid project');
        return this.pwa.directory(name);
    }
    async state(project, directory) {
        const state = await snapshot(directory);
        if (!(await this.pwa.enabled(project))) return state;
        state.files = state.files.filter(
            (entry) => sourceType(entry.name) === 'html',
        );
        const directoryInfo = await fs.lstat(directory);
        state.revision = crypto
            .createHash('sha256')
            .update(
                JSON.stringify([
                    directoryInfo.dev,
                    directoryInfo.ino,
                    state.files.map((entry) => [
                        entry.name,
                        identity(entry.info),
                    ]),
                ]),
            )
            .digest('hex');
        return state;
    }
    async fileListing(project, directory) {
        const result = listing(project, await this.state(project, directory));
        if (await this.pwa.enabled(project)) {
            let release, error;
            try {
                release = await this.pwa.resolve(project);
            } catch (failure) {
                error = failure.message;
                release =
                    failure.active ||
                    (await this.pwa.readActive(project).catch(() => null));
            }
            result.pwa = {
                enabled: true,
                build: release?.build || null,
                release: release?.id || null,
                source: release?.source || null,
                ...(error ? { error } : {}),
            };
        } else if (await this.pwa.managed(project))
            result.pwa = { enabled: false };
        return result;
    }
    async prepare(project, file, name) {
        try {
            return await this.pwa.prepare(project, file, name);
        } catch (error) {
            throw problem(422, error.message || 'Invalid PWA HTML');
        }
    }
    async authorized(req) {
        const token = await readManagementToken(this.runtime);
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token))
            return false;
        const supplied = req.headers.authorization;
        if (typeof supplied !== 'string' || !supplied.startsWith('Bearer '))
            return false;
        const a = Buffer.from(token),
            b = Buffer.from(supplied.slice(7));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    serialize(action) {
        const pending = this.commits.then(action);
        this.commits = pending.catch(() => {});
        return pending;
    }
    async validation(file) {
        if (sourceType(file) !== 'zip') return;
        await fs.mkdir(this.runtime, { recursive: true });
        if (
            (await fs.lstat(this.runtime)).isSymbolicLink() ||
            inside(this.root, await fs.realpath(this.runtime))
        )
            throw problem(500, 'Invalid runtime');
        const temporary = await fs.mkdtemp(
            path.join(this.runtime, 'upload-validate-'),
        );
        try {
            await new ZipProjects(
                path.join(temporary, 'cache'),
                LIMITS,
                this.root,
            ).load(file);
        } catch {
            throw problem(
                422,
                'Invalid or unsupported ZIP; no files were deleted',
            );
        } finally {
            if (
                inside(this.runtime, temporary) &&
                path.dirname(temporary) === this.runtime
            )
                await fs.rm(temporary, { recursive: true, force: true });
        }
    }
    async jsonBody(req, settings = false) {
        if (
            (req.headers['content-type'] || '').split(';')[0].trim() !==
            'application/json'
        )
            throw problem(415, 'Use application/json');
        let size = 0;
        const chunks = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            size += chunk.length;
            if (size > 8192) throw problem(413, 'Request too large');
            chunks.push(chunk);
        }
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw problem(400, 'Invalid JSON');
        }
        if (
            !body ||
            typeof body.revision !== 'string' ||
            !(settings ? /^[a-zA-Z0-9-]{1,128}$/ : /^[a-f0-9]{64}$/).test(
                body.revision,
            )
        )
            throw problem(400, 'Valid revision required');
        return body;
    }
    async manage(project, operation, body) {
        return this.serialize(async () => {
            const directory = await this.project(project);
            const pwa = await this.pwa.enabled(project);
            const state = await this.state(project, directory);
            if (state.revision !== body.revision)
                throw problem(409, 'Files changed; refresh the list');
            const selected =
                operation === 'apply'
                    ? state.files.find((entry) => entry.name === body.filename)
                    : state.files[0];
            if (
                operation === 'apply' &&
                (!component(body.filename) || !selected)
            )
                throw problem(400, 'Select a listed file');
            let release;
            if (selected) {
                if (pwa)
                    release = await this.prepare(
                        project,
                        selected.file,
                        selected.name,
                    );
                else await this.validation(selected.file);
            }
            if (
                (await this.project(project)) !== directory ||
                (await this.state(project, directory)).revision !==
                    state.revision
            )
                throw problem(409, 'Files changed; refresh the list');
            if (operation === 'apply') {
                const handle = await fs.open(selected.file, 'r+');
                try {
                    if (
                        identity(await handle.stat()) !==
                        identity(selected.info)
                    )
                        throw problem(409, 'File changed; refresh the list');
                    const newest = Math.max(
                        Date.now(),
                        ...state.files.map(
                            (entry) => entry.info.mtimeMs + 1000,
                        ),
                    );
                    await handle.utimes(new Date(newest), new Date(newest));
                } finally {
                    await handle.close();
                }
                if (pwa) await this.pwa.activate(project, release);
                const result = await this.fileListing(project, directory);
                void notifyProjectUpdate(
                    this.runtime,
                    project,
                    'applied',
                ).catch(() => {});
                return result;
            }
            const deleted = [];
            let freedBytes = 0;
            for (const entry of state.files.slice(1)) {
                let current;
                try {
                    await this.project(project);
                    if (
                        identity(await fs.lstat(selected.file)) !==
                        identity(selected.info)
                    )
                        throw problem(
                            409,
                            'Active file changed during cleanup; refresh the list',
                        );
                    current = await fs.lstat(entry.file);
                } catch {
                    throw problem(
                        409,
                        'File changed during cleanup; refresh the list',
                    );
                }
                if (
                    !current.isFile() ||
                    current.isSymbolicLink() ||
                    identity(current) !== identity(entry.info)
                )
                    throw problem(
                        409,
                        'File changed during cleanup; refresh the list',
                    );
                await fs.unlink(entry.file);
                deleted.push(entry.name);
                freedBytes += entry.info.size;
            }
            return {
                project,
                deleted,
                kept: selected?.name || null,
                freedBytes,
            };
        });
    }
    async handle(req, res) {
        const reply = (status, body) => {
            if (!res.destroyed) {
                res.writeHead(status, {
                    'Content-Type': 'application/json; charset=utf-8',
                });
                res.end(JSON.stringify(body));
            }
        };
        let temporary;
        try {
            if (!(await this.authorized(req)))
                throw problem(401, 'Authentication required');
            if (req.headers.origin) {
                let origin;
                try {
                    origin = new URL(req.headers.origin);
                } catch {
                    throw problem(403, 'Invalid origin');
                }
                if (
                    !['https:', 'http:'].includes(origin.protocol) ||
                    origin.host !== req.headers.host
                )
                    throw problem(403, 'Invalid origin');
            }
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/upload/api/download') {
                if (req.method !== 'GET')
                    throw problem(405, 'Method not allowed');
                const project = url.searchParams.get('project'),
                    filename = url.searchParams.get('filename'),
                    revision = url.searchParams.get('revision');
                if (!revision || !/^[a-f0-9]{64}$/.test(revision))
                    throw problem(400, 'Valid revision required');
                if (!component(filename) || !sourceType(filename))
                    throw problem(400, 'Select a listed file');
                const opened = await this.serialize(async () => {
                    const directory = await this.project(project),
                        state = await this.state(project, directory);
                    if (state.revision !== revision)
                        throw problem(409, 'Files changed; refresh the list');
                    const selected = state.files.find(
                        (entry) => entry.name === filename,
                    );
                    if (!selected) throw problem(400, 'Select a listed file');
                    let handle;
                    try {
                        handle = await fs.open(selected.file, 'r');
                        const info = await handle.stat(),
                            current = await fs.lstat(selected.file);
                        if (
                            !info.isFile() ||
                            current.isSymbolicLink() ||
                            identity(info) !== identity(selected.info) ||
                            identity(current) !== identity(selected.info) ||
                            (await this.project(project)) !== directory ||
                            (await this.state(project, directory)).revision !==
                                revision
                        )
                            throw problem(
                                409,
                                'Files changed; refresh the list',
                            );
                        return { handle, size: info.size };
                    } catch (error) {
                        if (handle) await handle.close();
                        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code))
                            throw problem(
                                409,
                                'Files changed; refresh the list',
                            );
                        throw error;
                    }
                });
                try {
                    const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const encoded = encodeURIComponent(filename).replace(
                        /[!'()*]/g,
                        (char) =>
                            '%' + char.charCodeAt(0).toString(16).toUpperCase(),
                    );
                    res.writeHead(200, {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': opened.size,
                        'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
                        'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'no-store',
                    });
                    await pipeline(
                        opened.handle.createReadStream({ autoClose: false }),
                        res,
                    );
                } finally {
                    await opened.handle.close();
                }
                return;
            }
            if (
                url.pathname === '/upload/api/manage-qr' &&
                req.method === 'GET'
            ) {
                // Reuse the exact token authenticated above; never generate or rotate it.
                const token = req.headers.authorization.slice(7);
                const protocol =
                    req.headers['x-forwarded-proto'] === 'https' ||
                    req.socket.encrypted
                        ? 'https:'
                        : 'http:';
                let origin;
                try {
                    const endpoint = new URL(
                        protocol + '//' + req.headers.host,
                    );
                    if (endpoint.username || endpoint.password) throw Error();
                    origin = endpoint.origin;
                } catch {
                    throw problem(400, 'Invalid management host');
                }
                const manageUrl =
                    origin + managementPath(token) + '#key=' + token;
                const image = await QRCode.toDataURL(manageUrl, {
                    errorCorrectionLevel: 'M',
                    margin: 4,
                    scale: 8,
                });
                return reply(200, { url: manageUrl, image });
            }
            if (
                url.pathname === '/upload/api/share-qr' &&
                req.method === 'GET'
            ) {
                const project = url.searchParams.get('project');
                await this.project(project);
                const protocol =
                    req.headers['x-forwarded-proto'] === 'https' ||
                    req.socket.encrypted
                        ? 'https:'
                        : 'http:';
                let origin;
                try {
                    const endpoint = new URL(
                        protocol + '//' + req.headers.host,
                    );
                    if (endpoint.username || endpoint.password) throw Error();
                    origin = endpoint.origin;
                } catch {
                    throw problem(400, 'Invalid public host');
                }
                const publicUrl =
                    origin + '/' + encodeURIComponent(project) + '/';
                const image = await QRCode.toDataURL(publicUrl, {
                    errorCorrectionLevel: 'M',
                    margin: 4,
                    scale: 8,
                });
                return reply(200, { project, url: publicUrl, image });
            }
            if (url.pathname === '/upload/api/pwa') {
                const project = url.searchParams.get('project');
                await this.project(project);
                if (req.method === 'GET')
                    return reply(200, await this.pwa.settings(project));
                if (req.method !== 'POST')
                    throw problem(405, 'Method not allowed');
                const body = await this.jsonBody(req, true);
                const result = await this.serialize(async () => {
                    await this.project(project);
                    try {
                        return await this.pwa.configure(project, body);
                    } catch (error) {
                        throw problem(
                            error.status ||
                                (['PWA_STALE', 'PWA_CONFLICT'].includes(
                                    error.code,
                                )
                                    ? 409
                                    : error.code === 'PWA_INVALID'
                                      ? 422
                                      : 500),
                            error.message || 'PWA settings could not be saved',
                        );
                    }
                });
                void notifyProjectUpdate(
                    this.runtime,
                    project,
                    'PWA settings',
                ).catch(() => {});
                return reply(200, result);
            }
            if (url.pathname === '/upload/api/files' && req.method === 'GET') {
                const project = url.searchParams.get('project');
                return reply(
                    200,
                    await this.fileListing(
                        project,
                        await this.project(project),
                    ),
                );
            }
            if (
                ['/upload/api/cleanup', '/upload/api/apply'].includes(
                    url.pathname,
                )
            ) {
                if (req.method !== 'POST')
                    throw problem(405, 'Method not allowed');
                const project = url.searchParams.get('project');
                await this.project(project);
                const body = await this.jsonBody(req);
                return reply(
                    200,
                    await this.manage(
                        project,
                        url.pathname.endsWith('/apply') ? 'apply' : 'cleanup',
                        body,
                    ),
                );
            }
            if (
                url.pathname === '/upload/api/projects' &&
                req.method === 'GET'
            ) {
                const projects = [];
                for (const entry of await fs.readdir(this.root, {
                    withFileTypes: true,
                })) {
                    if (!entry.isDirectory() || entry.isSymbolicLink())
                        continue;
                    try {
                        await this.project(entry.name);
                        projects.push({
                            name: entry.name,
                            ...((await this.pwa.enabled(entry.name))
                                ? { pwa: true }
                                : {}),
                        });
                    } catch {}
                }
                projects.sort((a, b) => a.name.localeCompare(b.name));
                return reply(200, { projects });
            }
            if (url.pathname !== '/upload/api/file')
                throw problem(404, 'Not found');
            if (req.method !== 'PUT') throw problem(405, 'Method not allowed');
            const project = url.searchParams.get('project'),
                filename = url.searchParams.get('filename');
            const directory = await this.project(project);
            let pwa = await this.pwa.enabled(project);
            if (!component(filename)) throw problem(403, 'Invalid filename');
            const extension = path.extname(filename).toLowerCase();
            if (!['.zip', '.html', '.htm'].includes(extension))
                throw problem(415, 'Only ZIP and HTML files are supported');
            if (pwa && extension === '.zip')
                throw problem(415, 'PWA projects accept HTML files only');
            if (
                (req.headers['content-type'] || '').split(';')[0].trim() !==
                'application/octet-stream'
            )
                throw problem(415, 'Use application/octet-stream');
            if (Number(req.headers['content-length']) > this.limit)
                throw problem(413, 'File too large');
            await fs.mkdir(this.runtime, { recursive: true });
            if (
                (await fs.lstat(this.runtime)).isSymbolicLink() ||
                inside(this.root, await fs.realpath(this.runtime))
            )
                throw problem(500, 'Invalid runtime');
            temporary = await fs.mkdtemp(path.join(this.runtime, 'upload-'));
            const incoming = path.join(temporary, 'incoming');
            const handle = await fs.open(incoming, 'wx');
            let size = 0;
            try {
                for await (const chunk of req.iterator({
                    destroyOnReturn: false,
                })) {
                    size += chunk.length;
                    if (size > this.limit) throw problem(413, 'File too large');
                    await handle.writeFile(chunk);
                }
                if (!req.complete) throw problem(400, 'Incomplete upload');
            } finally {
                await handle.close();
            }
            if (!size) throw problem(422, 'Empty file');
            if (extension === '.zip') {
                try {
                    await new ZipProjects(
                        path.join(temporary, 'validate'),
                        LIMITS,
                        this.root,
                    ).load(incoming);
                } catch {
                    throw problem(422, 'Invalid or unsupported ZIP');
                }
            }
            const commit = async () => {
                if ((await this.project(project)) !== directory)
                    throw problem(403, 'Project changed');
                pwa = await this.pwa.enabled(project);
                if (pwa && extension === '.zip')
                    throw problem(415, 'PWA projects accept HTML files only');
                let newest = Date.now();
                for (const entry of (await this.state(project, directory))
                    .files)
                    newest = Math.max(newest, entry.info.mtimeMs + 1000);
                await fs.utimes(incoming, new Date(newest), new Date(newest));
                const stem = filename.slice(0, -extension.length);
                for (let n = 0; n < 10000; n++) {
                    const name = n ? `${stem}-${n}${extension}` : filename;
                    const destination = path.join(directory, name);
                    try {
                        await fs.lstat(destination);
                        continue;
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                    }
                    const release = pwa
                        ? await this.prepare(project, incoming, name)
                        : null;
                    try {
                        await fs.link(incoming, destination);
                        if (pwa) {
                            try {
                                await this.pwa.activate(project, release);
                            } catch (error) {
                                if (
                                    identity(await fs.lstat(destination)) ===
                                    identity(await fs.stat(incoming))
                                )
                                    await fs.unlink(destination);
                                throw error;
                            }
                        }
                        return { name, release };
                    } catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                    }
                }
                throw problem(409, 'Too many files with this name');
            };
            const committed = this.commits.then(commit);
            this.commits = committed.catch(() => {});
            const { name, release } = await committed;
            void notifyProjectUpdate(this.runtime, project, 'upload').catch(
                () => {},
            );
            reply(201, {
                project,
                filename: name,
                url: `/${encodeURIComponent(project)}/`,
                fileUrl: pwa
                    ? `/${encodeURIComponent(project)}/`
                    : `/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
                size,
                ...(release
                    ? {
                          pwa: {
                              enabled: true,
                              build: release.build,
                              release: release.id,
                              source: release.source,
                          },
                      }
                    : {}),
            });
        } catch (error) {
            if (res.headersSent) res.destroy();
            else
                reply(error.status || 500, {
                    error: error.status ? error.message : 'Upload failed',
                });
            if (!req.destroyed) req.resume();
        } finally {
            if (
                temporary &&
                inside(this.runtime, temporary) &&
                path.dirname(temporary) === this.runtime
            )
                await fs
                    .rm(temporary, { recursive: true, force: true })
                    .catch(() => {});
        }
    }
}
module.exports = { Uploads };
