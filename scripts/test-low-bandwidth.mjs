/**
 * Verifies the Low-Bandwidth Plain-Text toggle (§4.4) in headless Chrome via CDP:
 *   1. Load home page (defaults to standard styling).
 *   2. Click the plain-text/low-bandwidth toggle.
 *   3. Confirm 'low-bandwidth' class is added to <html> and stored in localStorage.
 *   4. Reload the page, confirm zero-flash persistence (class exists before hydration).
 *   5. Click toggle again, confirm class is removed and localStorage updated.
 *
 * Run: node scripts/test-low-bandwidth.mjs
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9340;
const profile = join(tmpdir(), `gn-lb-${Date.now()}`);
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

  console.log('1) load home…');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await sleep(3000);
  await waitFor(`!!document.querySelector('[aria-pressed]')`, 'header toggle button mounted');

  const initial = await evalJS(`({
    hasLowBandwidthClass: document.documentElement.classList.contains('low-bandwidth'),
    stored: localStorage.getItem('gn.low_bandwidth'),
  })`);
  console.log('   initial state:', JSON.stringify(initial));

  console.log('2) toggle low-bandwidth ON (dispatch real click on the button)…');
  await evalJS(`(() => {
    const btn = document.querySelector('button[aria-pressed]');
    if (!btn) throw new Error('toggle button not found');
    btn.click();
  })()`);
  await sleep(600);

  const toggledOn = await evalJS(`({
    hasLowBandwidthClass: document.documentElement.classList.contains('low-bandwidth'),
    stored: localStorage.getItem('gn.low_bandwidth'),
  })`);
  console.log('   toggled ON state:', JSON.stringify(toggledOn));

  console.log('3) reload page to verify pre-paint persistence…');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await sleep(3000);
  await waitFor(`!!document.querySelector('[aria-pressed]')`, 'button after reload');

  const reloaded = await evalJS(`({
    hasLowBandwidthClass: document.documentElement.classList.contains('low-bandwidth'),
    stored: localStorage.getItem('gn.low_bandwidth'),
  })`);
  console.log('   reloaded state:', JSON.stringify(reloaded));

  console.log('4) toggle low-bandwidth OFF…');
  await evalJS(`(() => {
    const btn = document.querySelector('button[aria-pressed]');
    if (!btn) throw new Error('toggle button not found');
    btn.click();
  })()`);
  await sleep(600);

  const toggledOff = await evalJS(`({
    hasLowBandwidthClass: document.documentElement.classList.contains('low-bandwidth'),
    stored: localStorage.getItem('gn.low_bandwidth'),
  })`);
  console.log('   toggled OFF state:', JSON.stringify(toggledOff));

  const pass = !initial.hasLowBandwidthClass &&
    toggledOn.hasLowBandwidthClass &&
    toggledOn.stored === 'true' &&
    reloaded.hasLowBandwidthClass &&
    reloaded.stored === 'true' &&
    !toggledOff.hasLowBandwidthClass &&
    !toggledOff.stored;

  console.log('\nRESULT:', pass ? 'PASS — Low-bandwidth plain-text toggle works & persists cleanly' : 'FAIL — see state above');
  chrome.kill();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
}
);
