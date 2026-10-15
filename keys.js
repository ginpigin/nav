'use strict';

const NAV_TEST = false;
const SW_VERSION = 3;
const DB_NAME = 'nav-web';
const FILES_CACHE = 'nav-files-v2';
const COOKIE_NAME = 'nk';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SLACK_MS = 10 * 60 * 1000;
const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const utf8 = new TextEncoder();

const SECRET_KINDS = {
  pass: { aad: 'hmac', alg: { name: 'HMAC', hash: 'SHA-256' }, usages: ['sign'] },
  dkey: { aad: 'aes', alg: { name: 'AES-GCM' }, usages: ['encrypt', 'decrypt'] },
};

let dbPromise = null;

function navDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => {
        const conn = request.result;
        conn.onversionchange = () => {
          conn.close();
          dbPromise = null;
        };
        resolve(conn);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

async function kvGet(key) {
  const conn = await navDb();
  return new Promise((resolve, reject) => {
    const request = conn.transaction('kv').objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function kvBatch(ops) {
  const conn = await navDb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    for (const op of ops) {
      if (!op) continue;
      if (op[0] === 'put') store.put(op[2], op[1]);
      else store.delete(op[1]);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const kvSet = (key, value) => kvBatch([['put', key, value]]);
const kvDelete = (keys) => kvBatch(keys.map((key) => ['delete', key]));

async function kvClear() {
  const conn = await navDb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('kv', 'readwrite');
    tx.objectStore('kv').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let testShift = 0;

async function loadTestShift() {
  if (NAV_TEST) testShift = Number(await kvGet('testShift')) || 0;
}

function now() {
  return Date.now() + testShift;
}

async function bumpClock(t) {
  const conn = await navDb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    let value = t;
    const request = store.get('clock');
    request.onsuccess = () => {
      value = Math.max(Number(request.result) || 0, t);
      store.put(value, 'clock');
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

function leaseState(lease, clock, t) {
  if (!lease) return 'none';
  if (t < lease.at - CLOCK_SLACK_MS || t < (Number(clock) || 0) - CLOCK_SLACK_MS) return 'clock';
  if (t > lease.until) return 'expired';
  return 'ok';
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacBytes(key, text) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(text)));
}

const importHmac = (raw) => crypto.subtle.importKey('raw', raw, SECRET_KINDS.pass.alg, false, ['sign']);
const importAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function unwrapSecret(key, label, nonce, text, kcv) {
  const wrapped = fromBase64(String(text || ''));
  const pad = await hmacBytes(key, `nav3|${label}|${nonce}`);
  if (wrapped.length !== 32) throw new Error(`ответ сервера: ${label}`);
  const raw = wrapped.map((b, i) => b ^ pad[i]);
  if ((await sha256hex(raw)).slice(0, 16) !== kcv) throw new Error(`ответ сервера не сходится: ${label}`);
  return raw;
}

function cookiePlace() {
  return new URL(`${self.location.origin}${self.location.pathname}/_k/`);
}

async function cookieHalf(create, refresh) {
  if (!IN_WORKER) return workerCall({ op: 'cookie', create, refresh });
  const where = cookiePlace();
  const found = await self.cookieStore.get({ name: COOKIE_NAME, url: where.href });
  let value = found && found.value;
  if (!value && !create) return null;
  if (!value) value = toBase64Url(randomBytes(32));
  if (!found || refresh) {
    await self.cookieStore.set({ name: COOKIE_NAME, value, path: where.pathname, expires: Date.now() + 400 * DAY_MS, sameSite: 'strict' });
  }
  return fromBase64Url(value);
}

async function cookieWrapKey(create) {
  const half = await cookieHalf(create, false);
  if (!half) return null;
  return importAes(await crypto.subtle.digest('SHA-256', concatBytes(utf8.encode('nav3|cookie|'), half)));
}

async function sealSecret(kind, raw, mode) {
  const spec = SECRET_KINDS[kind];
  if (mode === 'cookie') {
    const wrapKey = await cookieWrapKey(true);
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`nav3|${spec.aad}`) }, wrapKey, raw));
    return { iv, ct };
  }
  return { key: await crypto.subtle.importKey('raw', raw, spec.alg, false, spec.usages) };
}

async function openSecret(kind, record) {
  if (!record) return null;
  if (record.key) return record.key;
  if (!record.ct) return null;
  const spec = SECRET_KINDS[kind];
  const wrapKey = await cookieWrapKey(false);
  if (!wrapKey) return null;
  try {
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: utf8.encode(`nav3|${spec.aad}`) }, wrapKey, record.ct));
    return await crypto.subtle.importKey('raw', raw, spec.alg, false, spec.usages);
  } catch (_) {
    return null;
  }
}

const getSecret = async (name, kind) => openSecret(kind, await kvGet(name));

async function sealBytes(key, aad, plain) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, plain));
  return concatBytes(iv, ct);
}

async function openBytes(key, aad, buffer) {
  const bytes = new Uint8Array(buffer);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8.encode(aad) }, key, bytes.slice(12)));
}

async function workerCall(message, timeoutMs = 10000) {
  const registration = await navigator.serviceWorker.ready;
  return askWorker(registration.active, message, timeoutMs);
}

function askWorker(worker, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('нет service worker'));
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('service worker не отвечает')), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const data = event.data || {};
      if (data.error) reject(new Error(data.error));
      else resolve(data.value);
    };
    worker.postMessage(message, [channel.port2]);
  });
}
