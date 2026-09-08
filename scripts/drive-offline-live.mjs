/**
 * Replicates the phone offline test against the LIVE deployed site:
 *   https://govnavigator.vercel.app  (frontend) + Render API (cross-origin).
 *
 * Load a service card online, wait for the SW caches, go fully offline via CDP
 * network emulation, hard-reload the card, and check whether it still renders.
 * Run: node scripts/drive-offline-live.mjs
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const BASE = 'https://govnavigator.vercel.app';
const profile = join(tmpdir(), `gn-live-${Date.now()}`);
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
const consoleLogs = [];
let ws;
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 25000);
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
  return r.result?.value;
}
async function waitFor(fn, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJS(fn)) return;
    await sleep(300);
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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__gnErrors = [];
      window.addEventListener('error', e => window.__gnErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.__gnErrors.push(String(e.reason)));
    `
  });

  console.log('1) load live home, wait for SW…');
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`!!document.querySelector('#ask')`, 'home');
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller !== null`, 'SW control', 20000);
  console.log('   SW controls page:', await evalJS(`!!navigator.serviceWorker.controller`));

  console.log('2) open a service card online…');
  await send('Page.navigate', { url: `${BASE}/services` });
  await sleep(5000);
  try {
    await waitFor(`!!document.querySelector('a[href^="/service/"]')`, 'service links', 20000);
  } catch (e) {
    const diag = await evalJS(`(() => ({
      body: document.body.innerText.slice(0, 500),
      links: document.querySelectorAll('a').length,
      hrefs: [...document.querySelectorAll('a')].map(a => a.getAttribute('href') || a.href).slice(0, 20),
      errors: window.__gnErrors || [],
    }))()`);
    console.log('   services page diagnostic:', JSON.stringify(diag, null, 2));
    throw e;
  }
  await evalJS(`document.querySelector('a[href^="/service/"]').click(); true`);
  await waitFor(`!!document.querySelector('article')`, 'service card', 20000);
  const path = await evalJS(`location.pathname`);
  console.log('   opened', path);
  await sleep(2500);

  const state = await evalJS(`(async () => {
    const keys = await caches.keys();
    let apiEntries = 0;
    for (const k of keys) { const c = await caches.open(k); apiEntries += (await c.keys()).length; }
    return { caches: keys, totalEntries: apiEntries };
  })()`);
  console.log('   SW caches:', JSON.stringify(state));

  console.log('3) go OFFLINE, hard-reload the card…');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await send('Page.navigate', { url: `${BASE}${path}` });
  await sleep(3500);
  const offline = await evalJS(`(() => {
    const article = document.querySelector('article');
    const err = [...document.querySelectorAll('p')].map(p=>p.textContent).find(t=>/could not load/i.test(t)) || null;
    return { rendered: !!article, bodyText: article ? article.textContent.length : 0, error: err };
  })()`);
  console.log('   offline render:', JSON.stringify(offline));

  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  console.log('\nRESULT:', offline.rendered && offline.bodyText > 200
    ? 'PASS — card renders offline from SW cache'
    : 'FAIL — ' + (offline.error || 'card did not render'));
  console.log('console errors:', consoleLogs.filter((l) => /error|sw:|fail/i.test(l)).slice(0, 10));
  console.log('page errors:', await evalJS(`window.__gnErrors || []`));
  chrome.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});
