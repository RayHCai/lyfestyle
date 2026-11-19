// The web build's service worker (registered in `src/main.tsx` for `--mode web` only). It keeps
// the app shell so the installed app opens without a network: pages go to the network first and
// fall back to the last copy, and hashed build assets are cached once since they never change.
// Anything cross-origin, the API included, is left to the browser and never cached here.
const CACHE = 'lyfestyle-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
            )
            .then(() => self.clients.claim()),
    );
});

async function networkFirst(request, key) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) await cache.put(key, response.clone());
        return response;
    } catch (e) {
        const cached = await cache.match(key);
        if (cached) return cached;
        throw e;
    }
}

/** Each deploy brings new asset names and this file rarely changes, so old builds' assets are
 *  dropped oldest first (keys come back in insertion order) once there are more than this. */
const MAX_ASSETS = 120;

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        await cache.put(request, response.clone());
        const assets = (await cache.keys()).filter((r) =>
            new URL(r.url).pathname.startsWith('/assets/'),
        );
        await Promise.all(
            assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((r) => cache.delete(r)),
        );
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    // Every route is the same single page, so one cached copy serves them all.
    if (request.mode === 'navigate') event.respondWith(networkFirst(request, '/'));
    else if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
    else if (SHELL.includes(url.pathname)) event.respondWith(networkFirst(request, url.pathname));
});
