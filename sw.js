'use strict';

importScripts('keys.js');

const SHELL_CACHE = 'nav-shell-v3';
const TILES_CACHE = 'nav-tiles-v1';
const SHELL_FILES = ['./', 'index.html', 'loader.js', 'keys.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
const TILE_HOSTS = new Set(['tiles.openfreemap.org', 'server.arcgisonline.com']);
const SHELL_TIMEOUT_MS = 3000;
const KEY_RELOAD_MS = 15000;
const CLOCK_WRITE_MS = 60000;

const scopeUrl = new URL(self.registration.scope);
const appPrefix = new URL('app/', scopeUrl).pathname;
const shellPaths = new Set(SHELL_FILES.map((name) => new URL(name, scopeUrl).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES.map((name) => new Request(name, { cache: 'reload' })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const current = new Set([SHELL_CACHE, FILES_CACHE, TILES_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => !current.has(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  const data = event.data || {};
  event.waitUntil(
    (async () => {
      try {
        let value = null;
        if (data.op === 'version') value = SW_VERSION;
        else if (data.op === 'cookie') value = await cookieHalf(!!data.create, !!data.refresh);
        else if (data.op === 'reset') unlocked = null;
        else if (data.op === 'wipe') {
          unlocked = null;
          await self.cookieStore?.delete({ name: COOKIE_NAME, path: cookiePlace().pathname }).catch(() => {});
        }
        if (port) port.postMessage({ value });
      } catch (error) {
        if (port) port.postMessage({ error: String((error && error.message) || error) });
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin === scopeUrl.origin) {
    if (url.pathname.startsWith(appPrefix)) {
      if (request.method === 'POST' && url.pathname === `${appPrefix}__store`) event.respondWith(saveStore(request));
      else if (request.method === 'GET') event.respondWith(fromAppFiles(request, url));
    } else if (request.method === 'GET' && shellPaths.has(url.pathname)) {
      event.respondWith(shellNetworkFirst(request));
    }
    return;
  }

  if (request.method === 'GET' && TILE_HOSTS.has(url.hostname)) {
    event.respondWith(/\.(pbf|png|jpe?g|webp)$/i.test(url.pathname) || url.hostname === 'server.arcgisonline.com'
      ? tileCacheFirst(request)
      : networkFirst(TILES_CACHE, request));
  }
});

let unlocked = null;

async function loadUnlocked() {
  await loadTestShift();
  const [lease, clock, record] = await Promise.all([kvGet('lease'), kvGet('clock'), kvGet('dkey')]);
  return { lease, clock: Number(clock) || 0, record, key: null };
}

async function deviceKey() {
  if (!unlocked || Date.now() - unlocked.loaded > KEY_RELOAD_MS) unlocked = { loaded: Date.now(), ready: loadUnlocked() };
  const current = unlocked;
  let state;
  try {
    state = await current.ready;
  } catch (_) {
    if (unlocked === current) unlocked = null;
    return null;
  }
  const t = now();
  const lease = leaseState(state.lease, state.clock, t);
  if (lease !== 'ok') {
    if (lease !== 'none' && state.record) {
      state.record = null;
      await kvDelete(['dkey']);
    }
    if (unlocked === current) unlocked = null;
    return null;
  }
  if (t - state.clock > CLOCK_WRITE_MS) {
    state.clock = t;
    bumpClock(t).catch(() => {});
  }
  if (!state.key && state.record) state.key = openSecret('dkey', state.record);
  return state.key ? state.key : null;
}

function locked(request) {
  if (request.mode === 'navigate') {
    const target = JSON.stringify(scopeUrl.href);
    return new Response(`<!doctype html><meta charset="utf-8"><script>(window.top || window).location.replace(${target})</script>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response('', { status: 403 });
}

async function fromAppFiles(request, url) {
  if (url.pathname === `${appPrefix}__lease`) {
    return new Response(null, { status: (await deviceKey()) ? 204 : 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const key = await deviceKey();
  if (!key) return locked(request);
  if (url.pathname === `${appPrefix}__state.js`) return stateScript(key);
  const cache = await caches.open(FILES_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return new Response('Нет файла в приложении', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  try {
    const plain = await openBytes(key, url.pathname, await cached.arrayBuffer());
    return new Response(plain, { headers: { 'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream' } });
  } catch (_) {
    unlocked = null;
    return locked(request);
  }
}

async function stateScript(key) {
  let store = {};
  const record = await kvGet('store');
  if (record) {
    try {
      store = JSON.parse(new TextDecoder().decode(await openBytes(key, '@store', record)));
    } catch (_) {
      store = {};
    }
  }
  return new Response(`window.__navStore = ${JSON.stringify(store)};\n`, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function saveStore(request) {
  const key = await deviceKey();
  if (!key) return new Response('', { status: 403 });
  const text = await request.text();
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad store');
  } catch (_) {
    return new Response('', { status: 400 });
  }
  await kvSet('store', await sealBytes(key, '@store', utf8.encode(text)));
  return new Response(null, { status: 204 });
}

async function shellNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {});
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_TIMEOUT_MS));
  try {
    return (await Promise.race([network, timeout])) || cached;
  } catch (_) {
    return cached;
  }
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

async function tileCacheFirst(request) {
  const cache = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
