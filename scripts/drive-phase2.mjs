/**
 * Drives the Phase 2 flows in headless Chrome via CDP and screenshots each
 * state: answer → "Not what you meant?" → "Talk to a human" → follow-up on the
 * same thread → "Start over". Run while both dev servers are up.
 *
 * Usage: node scripts/drive-phase2.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const OUT = join(process.cwd(), 'scripts', '.shots');
mkdirSync(OUT, { recursive: true });

const profile = join(tmpdir(), `gn-cdp-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTab() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
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
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 20000);
  });
}

async function evalJS(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(`page error: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
  return r.result?.value;
}

async function clickByText(text, scope = 'document') {
  const ok = await evalJS(`(() => {
    const root = ${scope};
    const els = [...root.querySelectorAll('button, a, [role=button]')];
    console.log('  DEBUG: looking for', ${JSON.stringify(text)}, 'in', els.map(e => e.textContent));
    const el = els.find((e) => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`could not find clickable "${text}"`);
}

async function screenshot(name, { full = false } = {}) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
    ...(full ? {} : { clip: undefined }),
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('  shot', name, full ? '(full-page)' : '');
}

async function waitFor(fn, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJS(fn)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function submit(question) {
  await evalJS(`(() => {
    const el = document.querySelector('#ask');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(question)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // The submit button is disabled until React re-renders with the new text.
  // Give the render a moment, then click once it is enabled.
  for (let i = 0; i < 10; i++) {
    const clicked = await evalJS(`(() => {
      const btn = document.querySelector('#ask').closest('form')?.querySelector('button[type="submit"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    if (clicked) return;
    await sleep(50);
  }
  throw new Error('submit button never became enabled');
}

/**
 * Keep answering a clarify card until a terminal card appears.
 *
 * The result area can only be in one of these states, and each has a
 * distinctive marker: the answered ServiceCard is the only <article>; the
 * ClarifyCard option buttons live in a .grid inside .surface; refused and
 * blocked cards each have their own <h2>. Working from those avoids any
 * dependency on the wording of a question.
 */
async function rideOutClarify() {
  for (let i = 0; i < 25; i++) {
    const st = await evalJS(`(() => {
      if (document.querySelector('article')) return 'answered'; // ServiceCard
      const h2s = [...document.querySelectorAll('h2')];
      if (h2s.some((h) => h.textContent.includes('would rather not guess'))) return 'refused';
      if (h2s.some((h) => h.textContent.includes('outside what we do'))) return 'blocked';
      if (document.querySelector('.surface .grid button.surface-sunk')) return 'clarify'; // ClarifyCard options
      return 'loading';
    })()`);
    console.log('    poll state:', st);
    if (st === 'answered' || st === 'refused' || st === 'blocked') return st;
    if (st === 'clarify') {
      const clicked = await evalJS(`(() => {
        const skip = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('most common case'));
        if (skip) { skip.click(); return 'skip'; }
        const opt = document.querySelector('.surface .grid button.surface-sunk');
        if (opt) { opt.click(); return opt.textContent.trim(); }
        return null;
      })()`);
      console.log('    clicked clarify option:', clicked);
      await sleep(1200);
      continue;
    }
    await sleep(400);
  }
  return 'loop-ended';
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('navigating…');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await waitFor(`!!document.querySelector('#ask')`, 'home ask box');
  await sleep(600);
  await screenshot('1-home');

  console.log('asking first question…');
  await submit('I wan make my business proper');
  // This example is deliberately one the pipeline needs a detail on, so we
  // expect a ClarifyCard, not an answer. Wait for its option buttons.
  await waitFor(`!!document.querySelector('.surface .grid button.surface-sunk')`, 'clarify card');
  await sleep(500);
  await screenshot('2-clarify');

  console.log('riding out clarify…');
  const first = await rideOutClarify();
  console.log('first outcome:', first);
  await sleep(700);
  await screenshot('3-answered');

  console.log('opening Not what you meant…');
  await clickByText('Not what you meant?');
  await sleep(500);
  const nwym = await evalJS(`(() => {
    const open = document.querySelector('button[aria-expanded="true"]');
    if (!open) return { error: 'disclosure did not open' };
    return {
      ariaExpanded: open.getAttribute('aria-expanded'),
      candidateButtons: [...open.closest('.surface').querySelectorAll('.surface-sunk button')].length,
    };
  })()`);
  console.log('  Not-what-you-meant state:', JSON.stringify(nwym));
  if (nwym.error) throw new Error(nwym.error);
  await screenshot('3-not-what-i-meant', { full: true });

  console.log('talking to a human…');
  const escalate = await evalJS(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Talk to a human'));
    if (!btn) return { error: 'no Talk to a human button' };
    btn.click();
    return true;
  })()`);
  if (escalate.error) throw new Error(escalate.error);
  // Escalation is optimistic: the confirmation with contact details appears
  // once state flips to 'sent', no network round-trip required (the log POST
  // runs in the background and never blocks the render).
  await waitFor(
    `!!document.querySelector('.surface-sunk [class]') && [...document.querySelectorAll('p')].some((p) => p.textContent.includes('flagged this for a member of the team'))`,
    'escalation confirmation',
    8000,
  );
  const escBlock = await evalJS(`(() => {
    const dl = document.querySelector('.surface-sunk dl');
    return dl ? {
      institution: dl.querySelector('dd')?.textContent,
      rows: dl.children.length / 2,
      officialLink: !!document.querySelector('a[href]')?.textContent?.includes('Official website'),
    } : { note: 'confirmation text present, contact block still open' };
  })()`);
  console.log('  escalation state:', JSON.stringify(escBlock));
  await sleep(500);
  await screenshot('4-talk-to-human', { full: true });

  console.log('asking a follow-up…');
  await submit('how much I go pay');
  await waitFor(`document.querySelectorAll('.rounded-2xl').length >= 2`, 'second thread chip');
  await sleep(900);
  const threadInfo = await evalJS(`(() => ({
    chips: document.querySelectorAll('.rounded-2xl').length,
    followupPlaceholder: document.querySelector('#ask')?.placeholder,
  }))()`);
  console.log('  follow-up state:', JSON.stringify(threadInfo));
  await screenshot('5-followup-thread', { full: true });

  console.log('starting over…');
  await clickByText('Start over');
  await sleep(700);
  const afterReset = await evalJS(`(() => ({
    chips: document.querySelectorAll('.rounded-2xl').length,
    hasArticle: !!document.querySelector('article'),
    heroVisible: !!document.querySelector('h1'),
    placeholder: document.querySelector('#ask')?.placeholder,
  }))()`);
  console.log('  after start-over:', JSON.stringify(afterReset));
  await screenshot('6-after-start-over', { full: true });

  console.log('\nDONE. Screenshots in', OUT);
  chrome.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});