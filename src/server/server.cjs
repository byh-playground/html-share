const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
    ZipProjects,
    allowedName,
    inside: within,
} = require('../projects/zip-projects.cjs');
const { Uploads } = require('../management/upload.cjs');
const { PwaProjects } = require('../pwa/pwa-projects.cjs');
const {
    sourceType,
    compareSources,
} = require('../projects/source-selection.cjs');
const {
    managementPath,
    readManagementToken,
    reservedProject,
} = require('../management/management-route.cjs');

const root = fs.realpathSync(
    process.env.HTML_SHARE_ROOT || path.join(repositoryRoot, 'public'),
);
const port = Number(process.argv[2] || 8787);
const types = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
};
const cachePath = path.resolve(
    process.env.HTML_SHARE_ZIP_CACHE ||
        path.join(repositoryRoot, '.runtime', 'zip-cache'),
);
if (within(root, cachePath))
    throw new Error('ZIP cache must be outside public');
const archives = new ZipProjects(cachePath, undefined, root);
const runtime =
    process.env.HTML_SHARE_RUNTIME || path.join(repositoryRoot, '.runtime');
const pwa = new PwaProjects(root, runtime);
const uploads = new Uploads(root, runtime, undefined, pwa);
const adminRoot = path.resolve(
    process.env.HTML_SHARE_ADMIN_ROOT ||
        path.join(repositoryRoot, 'src/management/ui'),
);
const safe = (file, base = root) =>
    within(base, file) &&
    (file === base ||
        path.relative(base, file).split(path.sep).every(allowedName));
const escape = (value) =>
    value.replace(
        /[&<>"']/g,
        (ch) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[ch],
    );
async function children(directory, base = root) {
    const entries = await fs.promises.readdir(directory);
    const found = await Promise.all(
        entries.filter(allowedName).map(async (name) => {
            try {
                if (
                    (
                        await fs.promises.lstat(path.join(directory, name))
                    ).isSymbolicLink()
                )
                    return null;
                const file = await fs.promises.realpath(
                    path.join(directory, name),
                );
                if (!safe(file, base)) return null;
                const info = await fs.promises.stat(file);
                return { name, file, info };
            } catch {
                return null;
            } // Files may disappear while a page is being refreshed.
        }),
    );
    return found
        .filter(Boolean)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const htmlFiles = (entries) =>
    entries
        .filter((entry) => entry.info.isFile() && /\.html?$/i.test(entry.name))
        .sort(
            (a, b) =>
                b.info.mtimeMs - a.info.mtimeMs ||
                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
async function resolveSite(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length && (await pwa.enabled(parts[0]))) {
        const release = await pwa.resolve(parts[0]);
        return {
            file: path.join(release.root, ...parts.slice(1)),
            base: release.root,
            zipped: false,
            pwa: true,
        };
    }
    const managed = parts.length && (await pwa.managed(parts[0]));
    const routeRoot = managed ? await pwa.directory(parts[0]) : root;
    const routeParts = managed ? parts.slice(1) : parts;
    let current = routeRoot;
    for (let depth = 0; depth <= routeParts.length; depth++) {
        const real = await fs.promises.realpath(current);
        if (!safe(real, routeRoot)) {
            const error = new Error('Forbidden');
            error.code = 'FORBIDDEN';
            throw error;
        }
        if (!(await fs.promises.stat(real)).isDirectory()) break;
        const entries = await children(real, routeRoot);
        const selected = entries
            .filter((e) => e.info.isFile() && sourceType(e.name))
            .sort(compareSources)[0];
        const zip =
            selected && sourceType(selected.name) === 'zip' ? selected : null;
        if (
            zip &&
            current !== root &&
            !(depth === 0 && entries.some((e) => e.info.isDirectory()))
        ) {
            const snapshot = await archives.load(zip.file);
            return {
                file: path.join(snapshot.root, ...routeParts.slice(depth)),
                base: snapshot.root,
                zipped: true,
            };
        }
        if (depth < routeParts.length)
            current = path.join(current, routeParts[depth]);
    }
    return {
        file: path.join(routeRoot, ...routeParts),
        base: routeRoot,
        zipped: false,
    };
}
async function recursiveHtml(directory, base) {
    const entries = await children(directory, base);
    const found = htmlFiles(entries);
    for (const entry of entries.filter((e) => e.info.isDirectory()))
        found.push(...(await recursiveHtml(entry.file, base)));
    return found.sort(
        (a, b) =>
            b.info.mtimeMs - a.info.mtimeMs || a.file.localeCompare(b.file),
    );
}
const page = (title, content) =>
    `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:64px auto;padding:0 24px;color:#172033;background:#f6f8fc}main{background:white;border:1px solid #dce2eb;border-radius:16px;padding:28px}h1{font-size:26px}a{color:#2553be}li{margin:12px 0}p{color:#526075}</style><main><h1>${escape(title)}</h1>${content}</main></html>`;

const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (code, message) => {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : message);
    };
    try {
        const rawPath = req.url.split('?')[0];
        let pathname;
        try {
            pathname = decodeURIComponent(rawPath);
        } catch {
            return fail(400, 'Invalid URL');
        }
        const firstPart = pathname.split('/').filter(Boolean)[0];
        let site;
        const serviceWorkerRequest = req.headers['service-worker'] === 'script';
        if (reservedProject(firstPart)) {
            if (!rawPath.startsWith('/_manage/') || rawPath !== pathname)
                return fail(404, 'Not found');
            const token = await readManagementToken(runtime);
            const prefix = token ? managementPath(token) : null;
            if (!prefix || !rawPath.startsWith(prefix))
                return fail(404, 'Not found');
            res.setHeader(
                'Content-Security-Policy',
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            );
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
            if (serviceWorkerRequest)
                return fail(
                    403,
                    'Service workers must use the shared PWA template',
                );
            const suffix = rawPath.slice(prefix.length);
            if (suffix.startsWith('api/')) {
                req.url = '/upload/' + suffix + req.url.slice(rawPath.length);
                return uploads.handle(req, res);
            }
            const asset = suffix || 'index.html';
            if (!['index.html', 'app.js', 'style.css'].includes(asset))
                return fail(404, 'Not found');
            if (
                (await fs.promises.lstat(adminRoot)).isSymbolicLink() ||
                (
                    await fs.promises.lstat(path.join(adminRoot, asset))
                ).isSymbolicLink()
            )
                return fail(404, 'Not found');
            site = {
                file: path.join(adminRoot, asset),
                base: adminRoot,
                zipped: false,
            };
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.setHeader('Allow', 'GET, HEAD');
            return fail(405, 'Method not allowed');
        }
        if (
            !pathname.startsWith('/') ||
            /[\\:\x00-\x1f]/.test(pathname) ||
            pathname
                .split('/')
                .some((part) => part !== '' && !allowedName(part))
        ) {
            return fail(403, 'Forbidden');
        }
        if (!firstPart) {
            if (serviceWorkerRequest)
                return fail(403, 'Enable PWA to use the shared service worker');
            const projects = (await children(root)).filter(
                (entry) =>
                    entry.info.isDirectory() && !reservedProject(entry.name),
            );
            const links = projects
                .map(
                    (entry) =>
                        `<li><a href="./${encodeURIComponent(entry.name)}/">${escape(entry.name)}</a></li>`,
                )
                .join('');
            const listing = page(
                'HTML 프로젝트',
                `<p>프로젝트를 선택하세요.</p><ul>${links}</ul>`,
            );
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(listing),
            });
            return res.end(req.method === 'HEAD' ? undefined : listing);
        }
        if (!site) site = await resolveSite(pathname);
        // Arbitrary project workers can enumerate same-origin window URLs, including
        // private admin links. Only our generated PWA worker may be registered.
        if (
            serviceWorkerRequest &&
            (!site.pwa || path.relative(site.base, site.file) !== 'sw.js')
        )
            return fail(403, 'Enable PWA to use the shared service worker');
        if (serviceWorkerRequest)
            res.setHeader(
                'Service-Worker-Allowed',
                '/' +
                    encodeURIComponent(pathname.split('/').filter(Boolean)[0]) +
                    '/',
            );
        let file = await fs.promises.realpath(site.file);
        if (!safe(file, site.base)) return fail(403, 'Forbidden');
        let info = await fs.promises.stat(file);
        if (info.isDirectory()) {
            if (!rawPath.endsWith('/')) {
                // Encode the decoded path to keep redirects local, including leading double slashes.
                const location =
                    '/' +
                    pathname
                        .split('/')
                        .filter(Boolean)
                        .map(encodeURIComponent)
                        .join('/') +
                    '/';
                res.writeHead(301, {
                    Location: location + req.url.slice(rawPath.length),
                });
                return res.end();
            }
            const entries = await children(file, site.base);
            const latest = site.pwa
                ? entries.find(
                      (e) => e.name === 'index.html' && e.info.isFile(),
                  )
                : site.zipped
                  ? (await recursiveHtml(file, site.base))[0]
                  : htmlFiles(entries)[0];
            if (latest && site.zipped && path.dirname(latest.file) !== file) {
                const suffix = path
                    .relative(file, path.dirname(latest.file))
                    .split(path.sep)
                    .map(encodeURIComponent)
                    .join('/');
                const prefix =
                    '/' +
                    pathname
                        .split('/')
                        .filter(Boolean)
                        .map(encodeURIComponent)
                        .join('/');
                res.writeHead(302, {
                    Location:
                        prefix.replace(/\/$/, '') +
                        '/' +
                        suffix +
                        '/' +
                        req.url.slice(rawPath.length),
                });
                return res.end();
            }
            const projects = entries.filter((entry) =>
                entry.info.isDirectory(),
            );
            let listing;
            if (file === root && projects.length) {
                const links = projects
                    .map(
                        (entry) =>
                            `<li><a href="./${encodeURIComponent(entry.name)}/">${escape(entry.name)}</a></li>`,
                    )
                    .join('');
                const direct = latest
                    ? `<p>루트 HTML: <a href="./${encodeURIComponent(latest.name)}">${escape(latest.name)}</a></p>`
                    : '';
                listing = page(
                    'HTML 프로젝트',
                    `<p>프로젝트를 선택하면 수정 날짜가 가장 최근인 ZIP 또는 HTML을 엽니다. ZIP은 자동으로 압축을 풉니다.</p><ul>${links}</ul>${direct}`,
                );
            } else if (!latest) {
                listing = page(
                    'HTML 파일을 기다리고 있어요',
                    '<p>이 폴더에 ZIP 또는 HTML 파일을 넣고 새로고침하세요. 수정 날짜가 가장 최근인 ZIP 또는 HTML을 표시하며, ZIP은 최신 파일 하나만 자동으로 압축을 풉니다.</p>',
                );
            }
            if (listing) {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': Buffer.byteLength(listing),
                });
                return res.end(req.method === 'HEAD' ? undefined : listing);
            }
            ({ file, info } = latest);
        }
        if (!info.isFile() || /\.zip$/i.test(file))
            return fail(404, 'Not found');
        res.writeHead(200, {
            'Content-Type':
                types[path.extname(file).toLowerCase()] ||
                'application/octet-stream',
            'Content-Length': info.size,
        });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    } catch (error) {
        if (error.code === 'PWA_INVALID')
            return fail(
                503,
                'PWA update could not be applied: ' + error.message,
            );
        if (error.code === 'ZIP_INVALID')
            return fail(
                503,
                'ZIP could not be opened. Check that copying has finished and that the archive is valid, unencrypted, and within size limits.',
            );
        fail(
            error.code === 'FORBIDDEN'
                ? 403
                : ['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)
                  ? 404
                  : 500,
            'Not found',
        );
    }
});
server.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
});
server.listen(port, '127.0.0.1', () =>
    console.log(`Serving ${root} at http://127.0.0.1:${server.address().port}`),
);
