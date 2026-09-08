/**
 * Verifies the shell's list data (system/services/categories/institutions) is
 * primed into the SW API cache by the page's post-registration message, so the
 * services list survives offline.
 *
 * Run: node scripts/drive-offline-lists.mjs   (backend :8000 + frontend :3000 up)
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338;
const profile = join(tmpdir(), `gn-lists-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForTab() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP did not come up');
}

let msgId = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 20000);
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
  return r.result?.value;
}
async function waitFor(fn, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJS(fn)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const tab = await waitForTab();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLogs.push(args);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception');
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result ?? {});
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Console.enable');
  const consoleLogs = [];
  const pageErrors = [];

  console.log('1) load home, let SW register + prime lists…');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await waitFor(`!!document.querySelector('#ask')`, 'home');
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller !== null`, 'SW control');
  // The services list endpoint is slow (~6-10s locally), so poll the cache
  // until the prime + page writes land rather than guessing a sleep.
  await waitFor(`(async () => { const c = await caches.open('gn-api'); const u = (await c.keys()).map(r=>r.url).join(' '); return u.includes('/services') && u.includes('/institutions'); })()`, 'all list endpoints cached', 20000);
  await sleep(500);

  const caches = await evalJS(`(async () => {
    const keys = await caches.keys();
    const apiName = keys.find(k => k.startsWith('gn-api'));
    const api = await caches.open(apiName || '');
    const urls = apiName ? (await api.keys()).map(r => r.url) : [];
    return { keys, apiUrls: urls.sort() };
  })()`);
  console.log('   SW caches:', caches.keys.join(', '));
  console.log('   API cache urls:\n     ' + (caches.apiUrls.join('\n     ') || '(none)'));

  const wanted = ['/api/system', '/api/services', '/api/categories', '/api/institutions'];
  const missing = wanted.filter((w) => !caches.apiUrls.some((u) => u.includes(w)));
  console.log('\nLIST PRIME:', missing.length === 0 ? 'PASS — all shell lists cached' : `MISSING: ${missing.join(', ')}`);

  console.log('2) visit /services online (caches its HTML + JS chunks)…');
  await send('Page.navigate', { url: 'http://localhost:3000/services' });
  try {
    await waitFor(`document.querySelectorAll('a[href^="/service/"]').length > 0`, 'service cards online', 20000);
  } catch (e) {
    const diag = await evalJS(`({ text: document.body.innerText.slice(0,400), links: document.querySelectorAll('a').length, hrefs: [...document.querySelectorAll('a')].map(a=>a.getAttribute('href')||a.href).slice(0,15) })`);
    console.log('   ONLINE /services diagnostic:', JSON.stringify(diag, null, 2));
    console.log('   console errors:', consoleLogs.filter(l => /error|exception|failed|cannot/i.test(l)).slice(0, 8));
    console.log('   page errors:', pageErrors.slice(0, 5));
    throw e;
  }
  await sleep(1000);
  const onlineCards = await evalJS(`document.querySelectorAll('a[href^="/service/"]').length`);
  console.log('   online card links:', onlineCards);

  console.log('3) go OFFLINE, reload /services…');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Page.navigate', { url: 'http://localhost:3000/services' });
  await sleep(3500);
  const srv = await evalJS(`(() => {
    const links = document.querySelectorAll('a[href^="/service/"]');
    const body = document.body.innerText;
    return {
      cardLinks: links.length,
      skeletons: document.querySelectorAll('.skeleton').length,
      hasEmpty: body.includes('Nothing matches that filter'),
      hasError: /could not load|cannot reach/i.test(body),
      bodyLen: body.length,
      bodyTail: body.slice(0, 400),
    };
  })()`);
  console.log('   offline /services:', JSON.stringify(srv, null, 1));

  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const ok = missing.length === 0 && srv.cardLinks > 0;
  console.log('\nRESULT:', ok ? 'PASS — services list renders offline from primed cache' : 'FAIL — see above');
  if (!ok) {
    const es = pageErrors.slice(0, 3);
    const cs = consoleLogs.filter(l => /error|exception|failed|cannot/i.test(l)).slice(0, 6);
    if (es.length) console.log('page errors:\n' + es.join('\n'));
    if (cs.length) console.log('console errors:\n' + cs.join('\n'));
  }
  chrome.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});