'use strict';

const BASE = new URL('./', location.href);
const LOCK_TIMEOUT_MS = 5000;
const RENEW_TIMEOUT_MS = 15000;
const DOWNLOAD_THREADS = 4;
const LOADER_VERSION = 3;
const NO_NETWORK = 'Нет связи. Для первого запуска нужен интернет.';

const $ = (id) => document.getElementById(id);
const appUrl = (p) => new URL('app/' + p, BASE).toString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function show(section) {
  for (const id of ['login', 'progress', 'problem']) $(id).hidden = id !== section;
}

function subtitle(text) {
  $('subtitle').textContent = text;
}

function progress(text, done, total, bytes, totalBytes) {
  show('progress');
  $('progressText').textContent = text;
  $('progressBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('progressBytes').textContent = totalBytes ? `${formatMb(bytes)} из ${formatMb(totalBytes)}` : '';
}

function problem(text, open) {
  show('problem');
  $('problemText').textContent = text;
  $('retryButton').onclick = () => location.reload();
  $('openButton').hidden = !open;
  $('openButton').onclick = open;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function report(event, data) {
  if (!NAV_TEST) return;
  fetch(new URL('_log', BASE), { method: 'POST', body: JSON.stringify({ event, data, ua: navigator.userAgent }) }).catch(() => {});
}

function platformKind() {
  if (NAV_TEST) {
    const forced = new URLSearchParams(location.search).get('kind');
    if (forced) return forced;
  }
  const ua = navigator.userAgent || '';
  const uad = navigator.userAgentData;
  const media = (query) => !!(window.matchMedia && window.matchMedia(query).matches);
  const touchOnly = media('(pointer: coarse)') && media('(hover: none)');
  const gecko = 'mozInnerScreenX' in window || !!(window.CSS && CSS.supports && CSS.supports('-moz-appearance', 'none'));
  const blink = !gecko && !!uad && Array.isArray(uad.brands);
  const webkit = !gecko && !blink && ('GestureEvent' in window || 'safari' in window || /AppleWebKit/.test(ua));
  const apple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua);
  const ios = apple && (/iPhone|iPad|iPod/.test(ua) || navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua) || (!!uad && uad.platform === 'Android') || (/Linux/.test(ua) && touchOnly);
  if (webkit && ios) return 'ios';
  if (webkit && apple) return 'mac';
  if (android && (blink || gecko)) return 'android';
  if (blink && !android && (uad.platform === 'Windows' || uad.platform === 'macOS')) return 'cookie';
  return 'refuse';
}

async function pretendOffline() {
  await sleep(LOCK_TIMEOUT_MS + Math.round(Math.random() * 1500));
  problem(NO_NETWORK, null);
}

async function readyServiceWorker() {
  const registration = await navigator.serviceWorker.register('sw.js');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const worker = registration.active;
    const version = worker ? await askWorker(worker, { op: 'version' }, 1500).catch(() => null) : null;
    if (version === SW_VERSION) return registration;
    if (!registration.installing && !registration.waiting) await registration.update().catch(() => {});
    await sleep(300);
  }
  throw new Error('service worker не запустился');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLock() {
  const response = await fetchWithTimeout(new URL(`lock.json?t=${Date.now()}`, BASE), { cache: 'no-store' }, LOCK_TIMEOUT_MS);
  if (!response.ok) throw new Error(`lock.json: ${response.status}`);
  return response.json();
}

async function authCall(lock, body, timeoutMs = 25000, retries = 0) {
  return scriptJson(new URL(lock.auth, BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
    cache: 'no-store',
  }, timeoutMs, retries);
}

async function scriptJson(url, options, timeoutMs, retries) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithTimeout(url, options, timeoutMs);
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch (_) {
      }
    }
    if (attempt >= retries) throw new Error(`сервер ответил ошибкой (код ${response.status})`);
    await sleep(attempt ? 4000 : 1500);
  }
}

async function fetchSiteFile(name) {
  const response = await fetch(new URL(`files/${name}`, BASE));
  if (!response.ok) throw new Error(`Приложение, файл ${name}: ${response.status}`);
  return response.arrayBuffer();
}

async function fetchDataBatch(source, entries, session) {
  const list = entries.map((entry) => encodeURIComponent(`${entry.p}.tpe`)).join('%7C');
  const result = await scriptJson(`${new URL(source.url, BASE)}?s=${encodeURIComponent(session)}&f=${list}`, { cache: 'no-store' }, 180000, 2);
  if (result.error === 'forbidden') throw Object.assign(new Error('Доступ этого устройства закрыт'), { revoked: true });
  if (result.error) throw new Error(`Хранилище: ${result.error}`);
  const out = new Map();
  for (const entry of entries) {
    const text = result.files && result.files[`${entry.p}.tpe`];
    if (!text) throw new Error(`В хранилище нет файла ${entry.p}`);
    out.set(entry.p, fromBase64(text));
  }
  return out;
}

function dataBatches(entries) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const entry of entries) {
    if (current.length && (current.length >= 15 || bytes + entry.s > 3 * 1024 * 1024)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.s;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function runPool(items, threads, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(threads, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function openServerBlob(key, name, buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 32 || bytes[0] !== 0x54 || bytes[1] !== 0x50 || bytes[2] !== 0x45 || bytes[3] !== 0x31) {
    throw new Error(`${name}: файл повреждён`);
  }
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(4, 16), additionalData: utf8.encode(name) }, key, bytes.slice(16));
  return new Uint8Array(plain);
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function openJson(key, name, buffer) {
  return JSON.parse(new TextDecoder().decode(await gunzip(await openServerBlob(key, name, buffer))));
}

async function deriveProof(password, saltBase64, iter) {
  const base = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(saltBase64), iterations: iter }, base, 256);
  return new Uint8Array(bits);
}

async function cacheComplete(state) {
  if (!state) return false;
  const cache = await caches.open(FILES_CACHE);
  return (await cache.keys()).length === state.files;
}

async function sync(lock, mainKey, dkey, session) {
  progress('Проверяю обновления…', 0, 0, 0, 0);
  const appIndex = await openJson(mainKey, '@app-index', await fetchSiteFile(lock.rev));
  const dataIndex = appIndex.data;

  const wanted = new Map();
  for (const entry of appIndex.files) wanted.set(entry.p, { ...entry, from: 'site' });
  for (const entry of dataIndex.files) wanted.set(entry.p, { ...entry, from: 'data' });

  const cache = await caches.open(FILES_CACHE);
  const todo = [];
  for (const entry of wanted.values()) {
    const cached = await cache.match(appUrl(entry.p));
    if (!cached || cached.headers.get('x-nav-h') !== entry.h) todo.push(entry);
  }

  report('sync', { todo: todo.map((entry) => entry.p), wanted: wanted.size });
  const totalBytes = todo.reduce((sum, entry) => sum + entry.s, 0);
  let done = 0;
  let bytes = 0;
  const staged = [];
  if (todo.length) progress(`Загружаю файлы: 0 из ${todo.length}`, 0, todo.length, 0, totalBytes);
  const tasks = [
    ...todo.filter((entry) => entry.from === 'site').map((entry) => ({ site: true, entries: [entry] })),
    ...dataBatches(todo.filter((entry) => entry.from === 'data')).map((entries) => ({ site: false, entries })),
  ];
  await runPool(tasks, DOWNLOAD_THREADS, async (task) => {
    const blobs = task.site
      ? new Map([[task.entries[0].p, await fetchSiteFile(task.entries[0].b)]])
      : await fetchDataBatch(dataIndex, task.entries, session);
    for (const entry of task.entries) {
      let content = await openServerBlob(mainKey, entry.p, blobs.get(entry.p));
      if (entry.z) content = await gunzip(content);
      if ((await sha256hex(content)).slice(0, 32) !== entry.h) {
        throw new Error(`${entry.p}: в хранилище другая версия файла (идёт выгрузка?) — повторите через минуту`);
      }
      const url = appUrl(entry.p);
      staged.push([entry, url, await sealBytes(dkey, new URL(url).pathname, content)]);
      done += 1;
      bytes += entry.s;
      progress(`Загружаю файлы: ${done} из ${todo.length}`, done, todo.length, bytes, totalBytes);
    }
  });

  for (const [entry, url, sealed] of staged) {
    await cache.put(url, new Response(sealed, { headers: { 'Content-Type': entry.t, 'x-nav-h': entry.h } }));
  }
  const keep = new Set([...wanted.keys()].map(appUrl));
  for (const request of await cache.keys()) {
    if (!keep.has(request.url)) await cache.delete(request);
  }

  const state = {
    rev: lock.rev,
    appBuilt: appIndex.built,
    dataBuilt: dataIndex.built,
    dataMode: dataIndex.mode,
    files: wanted.size,
    synced: new Date(now()).toISOString(),
  };
  await kvSet('state', state);
  return state;
}

function passwordForm({ text, submit, skip, error }) {
  return new Promise((resolve) => {
    show('login');
    subtitle(text);
    const input = $('password');
    input.value = '';
    $('loginError').textContent = error || '';
    $('skipButton').hidden = !skip;
    $('skipButton').onclick = () => resolve('skip');
    setTimeout(() => input.focus(), 50);
    $('login').onsubmit = async (event) => {
      event.preventDefault();
      const password = input.value.trim();
      if (!password) return;
      $('loginButton').disabled = true;
      $('loginError').textContent = 'Проверяю…';
      try {
        const error = await submit(password);
        $('loginError').textContent = error || '';
        if (!error) resolve('ok');
      } catch (error) {
        $('loginError').textContent = `Нет связи с сервером входа: ${error.message || error}`;
      } finally {
        $('loginButton').disabled = false;
      }
    };
  });
}

function loginError(answer) {
  if (answer.error === 'password' || answer.error === 'wrong') {
    return `Неверный пароль${Number.isFinite(answer.left) ? ` (осталось попыток: ${answer.left})` : ''}`;
  }
  if (answer.error === 'locked') return 'Слишком много неверных паролей с этого устройства — вход закрыт на 10 минут';
  if (answer.error === 'busy') {
    return 'С этим паролем уже вошли на другом устройстве. Если это новый телефон — попросите того, кто дал пароль, сбросить привязку.';
  }
  return `Вход не удался: ${answer.error || 'нет ответа'}`;
}

async function newDevice(lock, kind) {
  if (!lock) {
    problem(NO_NETWORK, null);
    return;
  }
  const mode = kind === 'cookie' ? 'cookie' : 'key';
  try {
    await kvSet('selftest', await sealSecret('pass', randomBytes(32), mode));
    if (!(await getSecret('selftest', 'pass'))) throw new Error('ключ не читается');
    await kvDelete(['selftest']);
  } catch (error) {
    report('selftest', String(error?.message || error));
    problem(`Не удалось подготовить хранилище ключей: ${error?.message || error}`, null);
    return;
  }
  let install = await kvGet('install');
  if (!install) {
    install = toBase64Url(randomBytes(12));
    await kvSet('install', install);
  }
  let session = null;
  let mainKey = null;
  await passwordForm({
    text: 'Введите свой пароль, который вам дали вместе со ссылкой.',
    submit: async (password) => {
      const proof = await deriveProof(password, lock.salt, lock.iter);
      const nonce = toBase64(randomBytes(16));
      const answer = await authCall(lock, { op: 'login', proof: toBase64(proof), install, nonce, info: navigator.userAgent, mode });
      if (!answer.ok) return loginError(answer);
      const key = await importHmac(proof);
      const pass = await unwrapSecret(key, 'pass', nonce, answer.pass, answer.passKcv);
      const dkey = await unwrapSecret(key, 'dkey', nonce, answer.dkey, answer.dkeyKcv);
      mainKey = await importAes(await unwrapSecret(key, 'fkey', nonce, answer.fkey, answer.fkeyKcv));
      const t = now();
      await kvBatch([
        ['put', 'mode', mode],
        ['put', 'dev', { id: answer.dev, kind }],
        ['put', 'pass', await sealSecret('pass', pass, mode)],
        ['put', 'dkey', await sealSecret('dkey', dkey, mode)],
        ['put', 'lease', { at: t, until: t + (answer.until - answer.now), week: t + (answer.week - answer.now) }],
        ['put', 'clock', t],
      ]);
      session = answer.session;
      report('login', { mode });
      return null;
    },
  });
  await workerCall({ op: 'reset' }).catch(() => {});
  const dkey = await getSecret('dkey', 'dkey');
  await syncAndLaunch(lock, mainKey, dkey, session);
}

async function syncAndLaunch(lock, mainKey, dkey, session) {
  try {
    launch(await sync(lock, mainKey, dkey, session));
  } catch (error) {
    console.error(error);
    if (error && error.revoked) {
      await wipeDevice();
      problem('Доступ этого устройства закрыт.', null);
      return;
    }
    const message = error?.name === 'OperationError' ? 'файл не расшифровался — повторите через минуту' : String(error?.message || error);
    const state = await kvGet('state');
    problem(`Не удалось обновить: ${message}`, (await canOpenSaved(state)) ? () => launch(state) : null);
  }
}

async function renew(lock, dev, { wantKey, proof }) {
  const pass = await getSecret('pass', 'pass');
  if (!pass) return { error: 'lost' };
  const pendingKey = await importAes(await hmacBytes(pass, 'nav3|pending'));
  let next = null;
  const pending = await kvGet('pending');
  if (pending) {
    next = await openBytes(pendingKey, 'nav3|pending', pending).catch(() => null);
  }
  if (!next) {
    next = randomBytes(32);
    await kvSet('pending', await sealBytes(pendingKey, 'nav3|pending', next));
  }
  const hadKey = !!(await kvGet('dkey'));
  const nonce = toBase64(randomBytes(16));
  const pad = await hmacBytes(pass, `nav3|next|${nonce}`);
  const body = {
    op: 'renew',
    dev: dev.id,
    nonce,
    next: toBase64(next.map((b, i) => b ^ pad[i])),
    want: wantKey ? 'key' : '',
    dk: !hadKey,
    proof: proof || '',
  };
  const canon = ['nav3', 'renew', body.dev, body.nonce, body.next, body.want, body.dk ? '1' : '0', body.proof].join('|');
  body.mac = toBase64(await hmacBytes(pass, canon));
  const answer = await authCall(lock, body, RENEW_TIMEOUT_MS, 2);
  if (!answer.ok) return answer;

  const mode = (await kvGet('mode')) || 'key';
  const mainKey = answer.fkey ? await importAes(await unwrapSecret(pass, 'fkey', nonce, answer.fkey, answer.fkeyKcv)) : null;
  const dkeyRecord = answer.dkey ? await sealSecret('dkey', await unwrapSecret(pass, 'dkey', nonce, answer.dkey, answer.dkeyKcv), mode) : null;
  const passRecord = await sealSecret('pass', next, mode);
  const t = now();
  await kvBatch([
    ['put', 'pass', passRecord],
    ['delete', 'pending'],
    dkeyRecord && ['put', 'dkey', dkeyRecord],
    ['put', 'lease', { at: t, until: t + (answer.until - answer.now), week: t + (answer.week - answer.now) }],
    ['put', 'clock', t],
  ]);
  if (mode === 'cookie') await cookieHalf(false, true).catch(() => {});
  await workerCall({ op: 'reset' }).catch(() => {});
  return { ok: true, mainKey, session: answer.session };
}

async function leaseOk() {
  const t = now();
  const lease = leaseState(await kvGet('lease'), await kvGet('clock'), t);
  if (lease === 'ok') {
    await bumpClock(t);
    return true;
  }
  if (lease !== 'none') {
    await kvDelete(['dkey']);
    await workerCall({ op: 'reset' }).catch(() => {});
    report('lease', lease);
  }
  return false;
}

async function canOpenSaved(state) {
  return !!state && (await leaseOk()) && !!(await kvGet('dkey')) && (await cacheComplete(state));
}

async function openSaved(state, reason) {
  if (await canOpenSaved(state)) {
    launch(state);
    return;
  }
  problem(reason, null);
}

async function existingDevice(lock, dev) {
  const state = await kvGet('state');
  const offlineText = 'Нет связи. Без интернета приложение открывается 3 дня после последней связи — подключитесь к интернету.';
  if (!lock) {
    await openSaved(state, offlineText);
    return;
  }

  await leaseOk();
  const wantKey = !state || state.rev !== lock.rev || !(await cacheComplete(state));
  subtitle('Проверяю доступ…');
  let proof = '';
  let answer;
  for (;;) {
    try {
      answer = await withRenewLock(() => renew(lock, dev, { wantKey, proof }));
    } catch (error) {
      console.warn('renew', error);
      await openSaved(state, offlineText);
      return;
    }
    if (answer.error !== 'password' && answer.error !== 'wrong') break;
    const canSkip = await canOpenSaved(state);
    let password = '';
    const choice = await passwordForm({
      text: 'Раз в неделю нужен ваш пароль.',
      skip: canSkip,
      error: answer.error === 'wrong' ? loginError(answer) : '',
      submit: async (value) => {
        password = value;
        return null;
      },
    });
    if (choice === 'skip') {
      launch(state);
      return;
    }
    proof = toBase64(await deriveProof(password, lock.salt, lock.iter));
    subtitle('Проверяю пароль…');
    show(null);
  }

  if (answer.error === 'revoked') {
    report('revoked', null);
    await wipeDevice();
    location.replace(new URL('?closed=1', BASE));
    return;
  }
  if (answer.error === 'lost') {
    await wipeDevice();
    location.replace(new URL('?lost=1', BASE));
    return;
  }
  if (answer.error) {
    const text = answer.error === 'locked'
      ? 'Слишком много неверных паролей с этого устройства — подождите 10 минут.'
      : 'Устройство не прошло проверку. Попросите того, кто дал пароль, сбросить привязку.';
    problem(text, (await canOpenSaved(state)) ? () => launch(state) : null);
    return;
  }

  const dkey = await getSecret('dkey', 'dkey');
  if (answer.mainKey && dkey) {
    await syncAndLaunch(lock, answer.mainKey, dkey, answer.session);
    return;
  }
  if (state && dkey) {
    await kvSet('state', { ...state, synced: new Date(now()).toISOString() });
    launch(state);
    return;
  }
  problem('Не удалось открыть: нет ключа устройства.', null);
}

function withRenewLock(task) {
  return navigator.locks ? navigator.locks.request('nav-renew', task) : task();
}

async function wipeDevice() {
  await kvClear();
  for (const name of await caches.keys()) {
    if (!name.startsWith('nav-shell')) await caches.delete(name);
  }
  try {
    localStorage.clear();
  } catch (_) {
  }
  await workerCall({ op: 'wipe' }).catch(() => {});
}

async function dropV2() {
  await kvDelete(['auth', 'dk', 'device']);
}

function launch(state) {
  subtitle('Открываю карту…');
  show(null);
  location.replace(new URL(`app/web-map/index.html?v=${encodeURIComponent(state.rev.slice(0, 8))}`, BASE));
}

async function main() {
  const kind = platformKind();
  report('platform', kind);
  if (kind === 'refuse') {
    await pretendOffline();
    return;
  }
  if (!('serviceWorker' in navigator) || !('caches' in window) || !window.crypto?.subtle || !('DecompressionStream' in window) || !window.indexedDB) {
    problem('Этот браузер не подходит: нужен Safari на iOS 16.4 или новее.', null);
    return;
  }
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (kind === 'ios' && !standalone) {
    subtitle('Добавьте приложение на экран «Домой»: «Поделиться» → «На экран «Домой»», и открывайте с иконки.');
    return;
  }

  try {
    await readyServiceWorker();
  } catch (error) {
    console.warn('service worker', error);
    problem('Не удалось запустить приложение. Закройте его и откройте снова.', null);
    return;
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  await loadTestShift();
  await dropV2();

  const params = new URLSearchParams(location.search);
  if (params.has('closed')) $('footer').textContent = 'Доступ этого устройства был закрыт — всё скачанное стёрто.';
  if (params.has('lost')) $('footer').textContent = 'Ключи этого устройства потеряны — войдите заново.';

  let lock = null;
  try {
    lock = await fetchLock();
  } catch (error) {
    console.warn('lock.json', error);
  }

  if (lock && lock.v > LOADER_VERSION) {
    if (!sessionStorage.getItem('nav-reloaded')) {
      sessionStorage.setItem('nav-reloaded', '1');
      for (const name of await caches.keys()) if (name.startsWith('nav-shell')) await caches.delete(name);
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.update().catch(() => {});
      location.reload();
      return;
    }
    const state = await kvGet('state');
    problem('Страница входа устарела. Закройте приложение и откройте снова.', (await canOpenSaved(state)) ? () => launch(state) : null);
    return;
  }
  sessionStorage.removeItem('nav-reloaded');

  const dev = await kvGet('dev');
  if (dev && dev.id) await existingDevice(lock, dev);
  else await newDevice(lock, kind);

  const state = await kvGet('state');
  if (state) $('footer').textContent = `Данные от ${formatDate(state.dataBuilt)}`;
}

main();
