/**
 * Drives every page in headless Chrome via CDP and reports console errors,
 * page exceptions and failed HTTP responses per page. Run while the backend
 * (:8000, Supabase) and the current frontend build (:3000) are both up.
 *
 *   node scripts/drive-pages.mjs
 *
 * Targets:
 *   TARGET /home   /services   /service/:id   /institutions   /institutions/:id
 *   /admin   /saved   (both sign-in flows end-to-end, incl. related-service
 *   follow-up that navigates home with ?q=...)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const OUT = join(process.cwd(), 'scripts', '.pageshots');
const TARGET = process.env.TARGET ?? 'http://localhost:3000';
const API = process.env.API ?? 'http://localhost:8000/api';
mkdirSync(OUT, { recursive: true });

// Backend admin credentials come from backend/.env (the running server reads
// that file too). Values never appear in output.
const envPath = join(process.cwd(), 'backend', '.env');
const ENV = readFileSync(envPath, 'utf8');
const ADMIN_EMAIL = ENV.match(/^ADMIN_EMAIL=(.*)$/m)?.[1]?.trim();
const ADMIN_PASS = ENV.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim();
const CONTACT = `pages@${Date.now()}.test`; // fresh citizen each run

const profile = join(tmpdir(), `gn-pages-${Date.now()}`);
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
    }, 25000);
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

async function waitFor(fn, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJS(fn)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('    shot', name);
}

// --- error collection -------------------------------------------------------

let pageErrors = [];
let consoleErrors = [];
let networkErrors = [];

// These appear routinely even when nothing is wrong: Next.js RSC prefetching
// adjacent routes, service-worker registration in a headless profile with
// cache disabled, passive interruption of in-flight requests on navigation.
const ALLOWED = [
  /failed to fetch RSC payload/i,
  /rsc payload/i,
  /next\.js router/i,
  /aborted/i,
  /failed to load resource: (the server responded with a status of 404)/i,
  /net::err_/i,
];

function isRelevant(text, src) {
  return !ALLOWED.some((re) => re.test(text)) || src === 'exception';
}

function collectErrors() {
  pageErrors = [];
  consoleErrors = [];
  networkErrors = [];
}

function reportPage(label) {
  const relevantErrs = [
    ...pageErrors.filter((e) => isRelevant(e, 'exception')),
    ...consoleErrors.filter((e) => isRelevant(e, 'console')),
  ];
  const badNet = networkErrors.filter(([url, status]) => status >= 400);
  const ok = relevantErrs.length === 0 && badNet.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} ${label}`);
  for (const e of relevantErrs) console.log(`  page error: ${String(e).slice(0, 220)}`);
  for (const [url, status] of badNet) console.log(`  http ${status}: ${url}`);
  if (ok) console.log('  no console errors, no page exceptions, no HTTP >=400');
  return ok;
}

async function goto(url, label) {
  collectErrors();
  await send('Page.navigate', { url });
  await sleep(900);
  return label;
}

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function askOnHome(question) {
  await evalJS(`(() => {
    const el = document.querySelector('#ask');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(question)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  for (let i = 0; i < 10; i++) {
    const clicked = await evalJS(`(() => {
      const btn = document.querySelector('#ask').closest('form')?.querySelector('button[type="submit"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    if (clicked) return;
    await sleep(60);
  }
  throw new Error('submit never became enabled');
}

async function rideOut() {
  for (let i = 0; i < 30; i++) {
    const st = await evalJS(`(() => {
      if (document.querySelector('article')) return 'answered';
      const h2s = [...document.querySelectorAll('h2')];
      if (h2s.some((h) => h.textContent.includes('would rather not guess'))) return 'refused';
      if (h2s.some((h) => h.textContent.includes('outside what we do'))) return 'blocked';
      if (document.querySelector('.surface .grid button.surface-sunk')) return 'clarify';
      return 'loading';
    })()`);
    if (['answered', 'refused', 'blocked'].includes(st)) return st;
    if (st === 'clarify') {
      const clicked = await evalJS(`(() => {
        const opt = document.querySelector('.surface .grid button.surface-sunk');
        if (opt) { opt.click(); return true; }
        return false;
      })()`);
      if (clicked) { await sleep(1200); continue; }
    }
    await sleep(400);
  }
  return 'loop-ended';
}

async function setTokenOrigin(token) {
  // localStorage keys live under an origin; land there first, then store.
  await send('Page.navigate', { url: TARGET + '/' });
  await waitFor(`!!document.querySelector('#ask')`, 'home (for token)');
  await evalJS(`localStorage.setItem('gn.token', ${JSON.stringify(token)}); true`);
  await sleep(300);
}

async function main() {
  const tab = await waitForTab();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const results = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result ?? {});
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleErrors.push(text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    } else if (msg.method === 'Network.responseReceived') {
      const { response } = msg.params;
      if (response && response.status >= 400) networkErrors.push([response.url, response.status]);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  // ---------------------------------------------------------------- home
  let label = await goto(TARGET + '/', 'home');
  await waitFor(`!!document.querySelector('#ask')`, 'home ask box');
  await waitFor(`document.body.innerText.includes('Or browse what we have verified')`, 'home browse section');
  await screenshot('01-home');
  results.push([label, reportPage(label)]);

  // ------------------------------------------------- answer loop (live)
  label = await goto(TARGET + '/', 'home: ask');
  await waitFor(`!!document.querySelector('#ask')`, 'ask box');
  await askOnHome('I wan make my business proper');
  const outcome = await rideOut();
  console.log('    outcome:', outcome);
  await waitFor(`!!document.querySelector('article, h2')`, 'answer card');
  await screenshot('02-answer');
  results.push([label + ` (${outcome})`, reportPage(label)]);
  if (outcome === 'clarify' || outcome === 'loading') {
    // keep a terminal check from burning time: signal the walk, leave detail to console
    results[results.length - 1] = [label + ` (${outcome})`, true && results[results.length - 1][1]];
  }

  // ------------------------------------------------------------- services
  label = await goto(TARGET + '/services', 'services');
  await waitFor(`document.querySelectorAll('a[href^="/service/"]').length > 0`, 'service cards');
  const serviceCount = await evalJS(`document.querySelectorAll('a[href^="/service/"]').length`);
  await screenshot('03-services');
  console.log('    cards:', serviceCount);
  results.push([label, reportPage(label)]);

  // --------------------------------------------- service deep link + follow-up
  label = await goto(TARGET + '/service/business-name-registration', 'service deep link');
  await waitFor(`!!document.querySelector('article')`, 'service card');
  await waitFor(`document.body.innerText.includes('What to bring')`, 'tabs');
  await screenshot('04-service');
  const relatedClickable = await evalJS(
    `[...document.querySelectorAll('button')].filter(b => b.textContent.includes('You will probably need')).length > 0 ||
     [...document.querySelectorAll('button')].some(b => b.closest('.grid') && b.querySelector('.truncate'))`,
  );
  results.push([label, reportPage(label)]);

  // The related-services buttons on the deep link ask home with ?q=<name>.
  // Home must pick that up and ask it, or the click silently does nothing.
  const relatedBtn = await evalJS(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const rel = btns.find((b) => b.closest('.grid') && b.querySelector('.truncate') && !b.closest('form'));
    if (!rel) return null;
    rel.click();
    return rel.querySelector('.truncate')?.textContent.trim() ?? 'yes';
  })()`);
  if (relatedBtn) {
    console.log('    clicked related: ', String(relatedBtn).slice(0, 40));
    await waitFor(`!!document.querySelector('#ask')`, 'home after related click');
    // The fix: home auto-asks the ?q= question, so a "You" bubble appears.
    await waitFor(
      `[...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'You')`,
      'home auto-ask (You bubble)',
      15000,
    );
    await sleep(1500);
    await screenshot('04b-related-followup');
    const followup = await rideOut();
    console.log('    related follow-up outcome:', followup);
    results.push(['service→related follow-up', reportPage('service→related follow-up (auto-asked)')]);
  } else {
    console.log('    (no related-services buttons on this service)');
  }

  // ----------------------------------------------------------- institutions
  label = await goto(TARGET + '/institutions', 'institutions');
  await waitFor(`document.querySelectorAll('a[href^="/institutions/"]').length > 10`, 'institution cards');
  await screenshot('05-institutions');
  results.push([label, reportPage(label)]);

  label = await goto(TARGET + '/institutions/orc', 'institution detail');
  await waitFor(`document.querySelector('header h1')?.textContent.includes('Office of the Registrar of Companies')`, 'orc header');
  await waitFor(`document.body.innerText.includes('Services we have verified here')`, 'orc services');
  await screenshot('06-institution');
  results.push([label, reportPage(label)]);

  // ------------------------------------------------------------------ admin
  const login = await api('/auth/curator-login', {
    method: 'POST', body: { contact: ADMIN_EMAIL, code: ADMIN_PASS },
  });
  if (login.status !== 200) throw new Error(`curator login failed (${login.status}): ${JSON.stringify(login.json)}`);
  await setTokenOrigin(login.json.access_token);

  label = await goto(TARGET + '/admin', 'admin');
  await waitFor(`document.body.innerText.includes('Analytics')`, 'analytics section');
  await waitFor(`document.body.innerText.includes('Verification audit')`, 'audit section');
  await waitFor(`document.body.innerText.includes('Coverage backlog')`, 'coverage section');
  // The stat cards use the `.label` utility, whose text-transform: uppercase
  // also uppercases innerText — "Needs action" renders as "NEEDS ACTION". Match
  // case-insensitively so the wait sees the rendered text, not the JSX.
  await waitFor(`document.body.innerText.toUpperCase().includes('NEEDS ACTION')`, 'audit summary cards');
  await screenshot('07-admin');
  results.push([label, reportPage(label)]);

  // So we could not leave the UI user data while the SAVE flow still needs the
  // citizen token and /saved to hand the returned sign-in back to the card.
  // One code is single-use (verify_code flips consumed), so we must not verify
  // here to mint a token: the browser's own sign-in below is the only verify,
  // and its token is read back from localStorage afterwards.
  const codeRes = await api('/auth/request-code', { method: 'POST', body: { contact: CONTACT } });
  const code = codeRes.json.dev_code;
  if (!code) throw new Error('no dev_code in development backend');

  // Signed-out save must take a person to /saved?next=... and back again.
  await send('Page.navigate', { url: TARGET + '/' });
  await waitFor(`!!document.querySelector('#ask')`, 'home (reset ls)');
  await evalJS(`localStorage.removeItem('gn.token'); localStorage.removeItem('gn.low_bandwidth'); true`);

  label = await goto(TARGET + '/service/business-name-registration', 'save flow: card');
  await waitFor(`!!document.querySelector('article')`, 'service card (save flow)');
  const savedClick = await evalJS(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Save this checklist'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!savedClick) throw new Error('Save button not found');
  await waitFor(`location.pathname === '/saved'`, 'redirect to /saved');
  await waitFor(`!!document.querySelector('#contact')`, 'sign-in form');
  await screenshot('08-saved-signin');

  await evalJS(`(() => {
    const el = document.querySelector('#contact');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(CONTACT)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`!![...document.querySelectorAll('button')].find(b => !b.disabled && b.textContent.includes('Send me a code'))`, 'send-code button');
  const sendCode = await evalJS(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Send me a code'));
    b.click(); return true;
  })()`);
  await waitFor(`!!document.querySelector('#code')`, 'code input');
  await screenshot('09-saved-code');

  await evalJS(`(() => {
    const el = document.querySelector('#code');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify('' + code)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`[...document.querySelectorAll('button')].some(b => !b.disabled && b.textContent.includes('Sign in'))`, 'sign-in enabled');
  await evalJS(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('Sign in')).click(); return true; })()`);
  // After verifying, next=<service> brings the person back to the card …
  await waitFor(`location.pathname.startsWith('/service/')`, 'return to service card', 15000);
  // … and the card now reports it was saved.
  await waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Saved to your list'))`,
    'saved button state',
    15000,
  );
  await screenshot('10-saved-confirmed');
  // The sign-in stored the real citizen token in localStorage — read it back
  // for the sweeps below; the code is consumed so re-verifying is impossible.
  const citizenToken = await evalJS(`localStorage.getItem('gn.token')`);
  if (!citizenToken) throw new Error('no citizen token after browser sign-in');
  results.push(['save checklist → sign-in → return', reportPage('save flow (sign-in + save)')]);

  // Sweep: signed-in /saved should list the checklist we just kept.
  await setTokenOrigin(citizenToken);
  label = await goto(TARGET + '/saved', 'saved list');
  await waitFor(`document.body.innerText.includes('Your saved checklists')`, 'saved header');
  await waitFor(`document.querySelectorAll('a[href^="/service/"]').length >= 1`, 'saved item');
  const savedCount = await evalJS(`document.querySelectorAll('a[href^="/service/"]').length`);
  await screenshot('11-saved-list');
  console.log('    saved items:', savedCount);
  results.push([label, reportPage(label)]);

  // Leave the dev database as we found it: drop the checklist we created.
  const lists = await api('/checklists', {}, citizenToken);
  for (const item of lists.json) {
    await api(`/checklists/${item.id}`, { method: 'DELETE' }, citizenToken);
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n' + '='.repeat(56));
  console.log(` PAGES WALK — ${results.length - failed.length}/${results.length} pages clean`);
  for (const [label, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nWALK ERROR:', err.message);
  process.exitCode = 2;
}).finally(() => {
  setTimeout(() => chrome.kill(), 300);
});