const CACHE_NAME = __PWA_CACHE_NAME__;
const PRECACHE = __PWA_PRECACHE__;
const SCOPE = self.registration.scope;
const PREFIX =
    CACHE_NAME.split(':release:')[0] + ':' + encodeURIComponent(SCOPE) + ':';
const CACHE = PREFIX + CACHE_NAME.split(':release:')[1];
async function network(request) {
    const headers = new Headers(request.headers);
    headers.set('ngrok-skip-browser-warning', '1');
    const response = await fetch(
        new Request(request, { headers, cache: 'no-store' }),
    );
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const url = new URL(request.url);
    const type = response.headers.get('content-type') || '';
    if (
        /\.(json|webmanifest|js|png|svg|ico)$/.test(url.pathname) &&
        type.includes('text/html')
    )
        throw new Error('Unexpected HTML');
    return response;
}
self.addEventListener('install', (event) =>
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            const results = await Promise.allSettled(
                PRECACHE.map(async (item) => {
                    const request = new Request(new URL(item, SCOPE));
                    // Consume each response immediately: waiting for all headers before draining
                    // large icon bodies can exhaust the browser's per-origin connection pool.
                    await cache.put(request, await network(request));
                }),
            );
            const failure = results.find(
                (result) => result.status === 'rejected',
            );
            if (failure) {
                await caches.delete(CACHE);
                throw failure.reason;
            }
        })(),
    ),
);
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', (event) =>
    event.waitUntil(
        (async () => {
            await Promise.all(
                (await caches.keys())
                    .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
                    .map((key) => caches.delete(key)),
            );
            await self.clients.claim();
        })(),
    ),
);
self.addEventListener('fetch', (event) => {
    const request = event.request,
        url = new URL(request.url);
    if (
        request.method !== 'GET' ||
        url.origin !== self.location.origin ||
        !url.href.startsWith(SCOPE)
    )
        return;
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE);
            const fresh =
                request.mode === 'navigate' ||
                /\.(html?|json|webmanifest)$/.test(url.pathname) ||
                url.pathname.endsWith('/');
            let saved = await cache.match(request);
            const version =
                url.pathname === new URL('version.json', SCOPE).pathname;
            const document =
                request.mode === 'navigate' ||
                /\.html?$/.test(url.pathname) ||
                url.pathname === new URL(SCOPE).pathname;
            if (!saved && (document || version))
                saved = await cache.match(request, { ignoreSearch: true });
            if (!saved && request.mode === 'navigate')
                saved = await cache.match(new URL('index.html', SCOPE).href);
            if (!fresh && saved) return saved;
            try {
                const response = await network(request);
                await cache.put(request, response.clone());
                return response;
            } catch (error) {
                if (saved) return saved;
                throw error;
            }
        })(),
    );
});
