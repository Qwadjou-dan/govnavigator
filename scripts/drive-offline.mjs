/**
 * Verifies the Phase 4 offline flow in headless Chrome via CDP:
 *   1. Load the app, confirm the service worker registers and activates.
 *   2. Visit /services and open a service card (populates the SW API cache).
 *   3. Go fully offline, hard-reload that service page, and confirm the card
 *      still renders from the service worker cache.
 *
 * Run: node scripts/drive-offline.mjs   (both servers up, see README)
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const profile = join(tmpdir(), `gn-offline-${Date.now()}`);
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
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result ?? {});
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  console.log('1) load home, wait for SW registration…');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await waitFor(`!!document.querySelector('#ask')`, 'home');
  // Allow the load handler to run and the worker to activate.
  await waitFor(
    `navigator.serviceWorker && navigator.serviceWorker.controller !== null`,
    'SW to control the page', 15000,
  );
  const sw = await evalJS(`(() => ({ controlled: !!navigator.serviceWorker.controller }))()`);
  console.log('   page controlled by SW:', sw.controlled);

  console.log('2) visit /services and open the first service card…');
  await send('Page.navigate', { url: 'http://localhost:3000/services' });
  try {
    await waitFor(`!!document.querySelector('a[href^="/service/"]')`, 'service links', 20000);
  } catch (e) {
    const diag = await evalJS(`(() => ({
      body: document.body.innerText.slice(0, 200),
      links: document.querySelectorAll('a').length,
      apiError: !!document.body.innerText.match(/could not|error|failed/i),
    }))()`);
    console.log('   services page diagnostic:', JSON.stringify(diag));
    const full = await evalJS(`document.body.innerText`);
    console.log('   FULL BODY:\n' + full.slice(0, 600));
    // Did any API call fail? Listen briefly.
    await send('Network.enable');
    throw e;
  }
  await evalJS(`document.querySelector('a[href^="/service/"]').click(); true`);
  await waitFor(`!!document.querySelector('article')`, 'service card');
  const serviceId = await evalJS(`location.pathname`);
  console.log('   opened', serviceId, '(now cached by SW)');

  // Let the SW settle the cached copy (network-first writes it after success).
  await sleep(1500);
  const cachesBefore = await evalJS(`caches.keys()`);
  console.log('   SW caches present:', cachesBefore);

  console.log('3) go OFFLINE, hard-reload the service page…');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await send('Page.navigate', { url: `http://localhost:3000${serviceId}` });
  await sleep(2500);
  const offline = await evalJS(`(() => {
    const article = document.querySelector('article');
    return {
      rendered: !!article,
      heading: article ? (article.querySelector('h1,h2')?.textContent || '').trim().slice(0, 40) : null,
      bodyText: article ? article.textContent.length : 0,
    };
  })()`);
  console.log('   offline render:', JSON.stringify(offline));

  // Restore connectivity so the browser can be torn down cleanly.
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  console.log('\nRESULT:', offline.rendered && offline.bodyText > 200
    ? 'PASS — service card renders offline from SW cache'
    : 'FAIL — card did not render offline');
  chrome.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});
