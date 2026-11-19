#!/usr/bin/env node
// Browser check for ui/index.html, run against the demo server (never against the real crew on 20100):
//   export CREW_HOME=/tmp/crew-ui && node test/fixtures.js        (the fixtures listen on 127.0.0.1:20190)
//   CREW_DEMO=1 CREW_NO_SYSTEMD=1 node bin/crew.js serve &
//   CREW_URL=http://127.0.0.1:20190 node test/ui-check.cjs
// Env: CREW_URL (default http://127.0.0.1:20190), SHOTS (screenshot folder), CHROME (browser binary),
// PLAYWRIGHT_CORE (where playwright-core is installed).
// It changes the demo data (answers, approves, accepts rounds, starts and stops the lab, creates tickets),
// so re-run the fixtures before each run.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
// PLAYWRIGHT_CORE: path to a playwright-core install (e.g. ~/crew/tools/node_modules/playwright-core).
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const BASE = process.env.CREW_URL || 'http://127.0.0.1:20190';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'crew-ui-shots');
const CHROME = process.env.CHROME || undefined; // undefined: playwright's own Chromium
const PROJECT_NAME = 'Demo shop';

const results = [];
const errors = [];
const shots = [];
// The browser logs every 4xx response as a console error; a step that provokes one on purpose says so here.
let expected400 = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 3).join('\n        ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}
async function api(p, opt) {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
const post = (p, body) => api(p, { method: 'POST', headers: { 'X-Crew': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const allCards = (st) => [...st.board.columns.flatMap((c) => c.tickets), ...st.board.parked];
const ticket = (id) => api('/api/tickets/' + id);
const youCount = async () => (await api('/api/state')).board.columns.find((c) => c.key === 'you').tickets.length;

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expected400 > 0 && /status of 400/.test(m.text())) { expected400--; return; }
    errors.push(`[${label}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] page error: ${e.message}`));
  page.on('dialog', (d) => {
    errors.push(`[${label}] unexpected dialog: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
}
async function shot(page, name) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(120);
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file });
  shots.push(file);
}
// No horizontal page scroll: the document is never wider than the viewport.
async function noOverflow(page, where) {
  const m = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= vw + 1) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') { clipped = true; break; }
      }
      if (!clipped && out.length < 4) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} right=${Math.round(r.right)}`);
    }
    return { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw, out };
  });
  if (m.doc > m.vw + 1 || m.body > m.vw + 1) throw new Error(`horizontal overflow at ${where}: page ${m.doc}px / body ${m.body}px in a ${m.vw}px viewport. ${m.out.join('; ')}`);
}
async function visibleIn(page, sel) {
  const box = await page.locator(sel).first().boundingBox();
  const vp = page.viewportSize();
  return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1;
}
// Visible controls under 40 px tall (phones), outside rendered markdown.
async function smallTargets(page, sel) {
  return page.$$eval(sel, (els) => els
    .filter((e) => e.offsetParent && !e.closest('.md'))
    .filter((e) => e.getBoundingClientRect().height < 40)
    .map((e) => (e.dataset.key || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height) + 'px'));
}
// Run fn (a click) and return the JSON body and headers of the POST it sends to a URL containing urlPart.
async function postOf(page, urlPart, fn) {
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(urlPart), { timeout: 8000 }),
    fn(),
  ]);
  return { body: req.postDataJSON(), headers: req.headers() };
}
// The header is the app's: brand "hqrCrew", no project name (one project), title "(N) hqrCrew".
async function checkHeader(page) {
  const brand = await page.$eval('.brand', (e) => ({ text: e.textContent.replace('▚', '').trim(), label: e.getAttribute('aria-label'), tt: getComputedStyle(e).textTransform }));
  if (brand.text !== 'hqrCrew' || brand.tt !== 'none') throw new Error(`brand shows "${brand.text}" (text-transform ${brand.tt})`);
  if (brand.label !== 'hqrCrew board') throw new Error(`brand aria-label is "${brand.label}"`);
  const proj = await page.$eval('#proj', (e) => ({ hidden: e.hidden, text: e.textContent, w: e.getBoundingClientRect().width }));
  if (!proj.hidden || proj.text || proj.w) throw new Error(`#proj should be empty and hidden with one project: ${JSON.stringify(proj)}`);
  if ((await page.textContent('#bar')).includes(PROJECT_NAME)) throw new Error('the header shows the project name');
  const n = await youCount();
  await until(async () => (await page.title()) === (n ? `(${n}) hqrCrew` : 'hqrCrew'), 4000, `the title "(${n}) hqrCrew" (it is "${await page.title()}")`);
}
// A stand-in for the Web Speech API: the test says what was "heard" through window.__sr.
function fakeSpeech() {
  window.__srLog = [];
  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      window.__sr = this;
    }
    start() { window.__srLog.push(['start', this.lang, this.continuous, this.interimResults]); }
    stop() { window.__srLog.push(['stop']); setTimeout(() => this.onend && this.onend({}), 30); }
    abort() { window.__srLog.push(['abort']); setTimeout(() => this.onend && this.onend({}), 0); }
    // items: this session's results so far, [[text, isFinal], ...]; from: the first one that changed.
    say(items, from) {
      const res = items.map(([t, f]) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = f; return r; });
      if (this.onresult) this.onresult({ resultIndex: from || 0, results: res });
    }
    fail(error) {
      if (this.onerror) this.onerror({ error });
      setTimeout(() => this.onend && this.onend({}), 0);
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}
function noSpeech() {
  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    try { delete window[k]; } catch {}
    if (k in window) Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
  }
}
// Keeps every toast text in window.__toasts (toasts vanish after a few seconds).
async function recordToasts(page) {
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList && window.__toasts.push((n.classList.contains('error') ? 'error: ' : '') + n.textContent))))
      .observe(document.querySelector('#toasts'), { childList: true });
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const health = await fetch(BASE + '/healthz').then((r) => r.text()).catch(() => '');
  if (health !== 'ok') {
    console.error(`No crew server at ${BASE}. Start it with CREW_DEMO=1 CREW_NO_SYSTEMD=1 node bin/crew.js serve`);
    process.exit(2);
  }
  const before = await api('/api/state');
  const fresh = allCards(before).some((c) => c.id === 'PA-003' && c.status === 'waiting') &&
    allCards(before).some((c) => c.id === 'PA-014' && c.status === 'waiting' && c.discussion) &&
    allCards(before).some((c) => c.id === 'PA-013' && c.status === 'discussing');
  if (!fresh) {
    console.error('The demo data is not fresh (PA-003/PA-014 not waiting or PA-013 not discussing). Re-run: node test/fixtures.js');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  console.log(`crew UI check against ${BASE}\n`);

  // ---------------- desktop ----------------
  const desk = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await desk.newPage();
  watch(page, 'desktop');

  await step('desktop 1400×900: the board loads with seven columns side by side; the header is the app', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card[data-id="PA-003"]', { timeout: 10000 });
    await page.waitForSelector('#live[data-state="live"]', { timeout: 10000 });
    const boxes = await page.$$eval('#board .col', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { key: e.dataset.key, x: r.x, y: r.y, w: r.width, right: r.right }; }));
    if (boxes.length !== 7) throw new Error(`expected 7 columns, got ${boxes.length}`);
    const vw = page.viewportSize().width;
    for (let i = 0; i < boxes.length; i++) {
      if (Math.abs(boxes[i].y - boxes[0].y) > 1) throw new Error(`column ${boxes[i].key} is not on the same row`);
      if (boxes[i].right > vw) throw new Error(`column ${boxes[i].key} is cut off at ${boxes[i].right}px`);
      if (i && boxes[i].x <= boxes[i - 1].x) throw new Error('columns are not left to right');
    }
    const keys = boxes.map((b) => b.key).join(',');
    if (keys !== 'inbox,discuss,you,queue,building,test,done') throw new Error(`column order ${keys}`);
    const you = boxes.find((b) => b.key === 'you');
    if (boxes.some((b) => b.key !== 'you' && b.w > you.w)) throw new Error('Needs you is no longer the widest column');
    const chip = await page.textContent('#runtxt');
    if (!/PA-007 · gate · \d/.test(chip)) throw new Error(`runner chip says "${chip}"`);
    if ((await page.$$('#meters .meter')).length !== 2) throw new Error('usage meters missing');
    if (!(await page.textContent('#pvs')).includes('PA-008')) throw new Error('active preview missing from the top bar');
    if ((await page.$$('#board .col.building .card .c-step')).length !== 1) throw new Error('build step missing on the building card');
    if (!(await page.textContent('.card[data-id="PA-008"]')).includes('PASS 8/10')) throw new Error('verdict missing on PA-008');
    if (!(await page.$('.card.blocked[data-id="PA-010"]'))) throw new Error('blocked card PA-010 has no blocked edge');
    await checkHeader(page);
    await noOverflow(page, 'desktop board');
    await shot(page, 'desktop-board.png');
  });

  await step('desktop: open PA-003 and answer Q1 with one tap', async () => {
    await page.click('.card[data-id="PA-003"]');
    await page.waitForSelector('#drawer:not([hidden]) .q');
    if (!page.url().endsWith('#PA-003')) throw new Error(`URL is ${page.url()}`);
    const head = await page.textContent('#dr-head');
    if (/null|undefined/.test(head)) throw new Error(`stray text in the ticket header: "${head}"`);
    await page.locator('#drawer button.opt[data-q="Q1"]', { hasText: 'yes, greyed out' }).click();
    await until(async () => {
      const t = await api('/api/tickets/PA-003');
      return t.state.questions.find((q) => q.id === 'Q1').answer === 'yes, greyed out';
    }, 8000, 'Q1 to be answered on the server');
    await until(async () => (await page.$$('#drawer button.opt[data-q="Q1"]')).length === 0 && (await page.$$('#drawer button.opt[data-q="Q2"]')).length === 2, 6000, 'Q1 to leave the Needs you block');
    await shot(page, 'desktop-ticket-PA-003-answered.png');
  });

  await step('desktop: approve the plan of PA-004', async () => {
    await page.click('.card[data-id="PA-004"]');
    await page.waitForFunction(() => location.hash === '#PA-004' && document.querySelector('#drawer .contract-box'));
    await shot(page, 'desktop-ticket-PA-004-ready.png');
    await page.click('#drawer button[data-action="approve"]');
    await until(async () => (await api('/api/tickets/PA-004')).state.status === 'queued', 8000, 'PA-004 to be queued');
    await page.waitForSelector('#col-queue .card[data-id="PA-004"]', { timeout: 8000 });
    await page.waitForSelector('#dr-head .st:has-text("Queued")', { timeout: 8000 });
  });

  let newId = null;
  await step('desktop: create a bug from the New sheet; the lead shapes it live', async () => {
    await page.click('#btn-new');
    await page.waitForSelector('#new-modal:not([hidden])');
    await page.click('#new-form label:has(input[value="bug"])');
    await page.fill('#new-title', 'UI check: cart total ignores the coupon after a refresh');
    await page.fill('#new-body', 'Add DEMO10 in the cart, refresh the page: the total is back to the full price.');
    if ((await page.textContent('#new-submit')).trim() !== 'Add bug') throw new Error('submit button does not say "Add bug"');
    if (!(await page.isChecked('#new-shape'))) throw new Error('"Let the lead shape it" is not on by default');
    if (await page.isChecked('#new-discuss')) throw new Error('"Discuss first" is on for a bug');
    await shot(page, 'desktop-new-sheet.png');
    const { body } = await postOf(page, '/api/tickets', () => page.click('#new-submit'));
    if ('discuss' in body) throw new Error(`a bug was sent with discuss: ${JSON.stringify(body)}`);
    newId = await until(async () => {
      const c = allCards(await api('/api/state')).find((x) => x.title.startsWith('UI check: cart total'));
      return c && c.id;
    }, 8000, 'the new ticket on the server');
    await page.waitForFunction((id) => location.hash === '#' + id && (document.querySelector('#dr-title') || {}).textContent === 'UI check: cart total ignores the coupon after a refresh', newId, { timeout: 8000 });
    const t = await api('/api/tickets/' + newId);
    if (t.state.type !== 'bug') throw new Error(`new ticket type is ${t.state.type}`);
    await until(async () => (await api('/api/tickets/' + newId)).state.status === 'queued', 20000, 'the fake lead to shape and queue the bug');
    await page.waitForSelector('#dr-head .st:has-text("Queued")', { timeout: 8000 });
    await page.waitForSelector(`#col-queue .card[data-id="${newId}"]`, { timeout: 8000 });
    await shot(page, 'desktop-new-ticket.png');
  });

  await step('desktop: chat with the lead; the fake reply appears', async () => {
    await page.click('#btn-chat');
    await page.waitForSelector('#chat:not([hidden])');
    await page.fill('#chat-in', 'first line');
    await page.press('#chat-in', 'Shift+Enter');
    if ((await page.inputValue('#chat-in')) !== 'first line\n') throw new Error('Shift+Enter did not start a new line');
    const text = `UI check ping ${Date.now()}`;
    await page.fill('#chat-in', text);
    await page.press('#chat-in', 'Enter');
    await page.locator('#msgs .msg.me', { hasText: text }).waitFor({ timeout: 15000 });
    await page.locator('#msgs .msg.lead', { hasText: `(fake lead) Noted: ${text}` }).waitFor({ timeout: 20000 });
    if ((await page.inputValue('#chat-in')) !== '') throw new Error('the input was not cleared after sending');
    const links = await page.$$eval('#msgs a.tid', (els) => els.map((e) => e.getAttribute('href')));
    if (!links.includes('#PA-008')) throw new Error('ticket IDs in chat are not links');
    await shot(page, 'desktop-chat.png');
  });

  await step('desktop: Esc closes the ticket, PA-008 shows its preview link', async () => {
    await page.click('#dr-title');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#drawer', { state: 'hidden' });
    if (page.url().includes('#')) throw new Error(`hash left after closing: ${page.url()}`);
    await page.click('.card[data-id="PA-008"]');
    await page.waitForSelector('#drawer a.pv-open[href="https://preview-1.example.com"]', { timeout: 8000 });
    const pv = await page.textContent('#drawer .blk.pv');
    const logins = (await api('/api/tickets/PA-008')).state.preview.logins || (await api('/api/state')).projects[0].logins;
    if (!logins || !pv.includes(logins.split(' · ')[0])) throw new Error(`demo logins missing (expected "${logins}")`);
    if (!/Stops at \d\d:\d\d/.test(pv)) throw new Error('"Stops at HH:MM" missing');
    for (const op of ['extend', 'down']) if (!(await page.$(`#drawer button[data-act="pv"][data-op="${op}"]`))) throw new Error(`preview ${op} button missing`);
    await shot(page, 'desktop-ticket-PA-008-preview.png');
  });

  await step('desktop: open a log from the Runs tab', async () => {
    await page.click('#drawer [role="tab"][data-tab="runs"]');
    await page.click('#drawer button[data-act="log"][data-file="gate-1.log"]');
    await page.waitForSelector('#log-modal:not([hidden])');
    await until(async () => (await page.textContent('#log-pre')).includes('pnpm lint'), 8000, 'the log text');
    await shot(page, 'desktop-log.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#log-modal', { state: 'hidden' });
    if (await page.isHidden('#drawer')) throw new Error('Esc on the log also closed the ticket');
  });

  await step('desktop: Verifier tab renders the markdown table', async () => {
    await page.click('#drawer [role="tab"][data-tab="verify"]');
    const rows = await page.$$eval('#drawer .tabpanel table tbody tr', (els) => els.length);
    if (rows !== 2) throw new Error(`expected 2 table rows, got ${rows}`);
  });

  await step('desktop: Drop asks inline, never with a dialog', async () => {
    await page.click('#drawer button[data-act="drop-ask"]');
    await page.waitForSelector('#drawer .confirm button[data-action="drop"]');
    await page.click('#drawer button[data-act="drop-cancel"]');
    await page.waitForSelector('#drawer .confirm', { state: 'detached' });
    if ((await api('/api/tickets/PA-008')).state.status !== 'review') throw new Error('PA-008 changed status');
  });

  await step('desktop: runner menu', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#drawer', { state: 'hidden' });
    await page.click('#runchip');
    await page.waitForSelector('#runmenu:not([hidden]) button[data-act="mode"][aria-pressed="true"]');
    const modes = await page.$$eval('#runmenu button[data-act="mode"]', (els) => els.map((e) => e.textContent));
    if (modes.join() !== 'Night,Always,Paused') throw new Error(`modes: ${modes}`);
    if (!(await page.$('#runmenu button[data-act="wake"]'))) throw new Error('"Check now" missing');
    await shot(page, 'desktop-runner-menu.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#runmenu', { state: 'hidden' });
  });

  await step('XSS: hostile ticket text stays text', async () => {
    const r = await post('/api/tickets', {
      type: 'idea',
      title: '<img src=x onerror="window.__xss=1">Pwn title',
      body: '<script>window.__xss=2</script>\n\n[click me](javascript:window.__xss=3)\n\n**<svg onload="window.__xss=4">** and `<b>code</b>`',
      shape: false,
    });
    if (!r.id) throw new Error(`could not create the hostile ticket: ${JSON.stringify(r)}`);
    await page.goto(`${BASE}/#${r.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (document.querySelector('#dr-title') || {}).textContent === '<img src=x onerror="window.__xss=1">Pwn title');
    await page.waitForSelector('#drawer .tabpanel .md');
    await sleep(300);
    const bad = await page.evaluate(() => ({
      xss: window.__xss || null,
      els: document.querySelectorAll('#drawer img, #drawer script, #drawer .md svg, .card img').length,
      js: document.querySelectorAll('a[href^="javascript"]').length,
    }));
    if (bad.xss || bad.els || bad.js) throw new Error(`unsafe rendering: ${JSON.stringify(bad)}`);
  });
  await desk.close();

  // ---------------- desktop 1280: design rounds, read only ----------------
  const d12 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await d12.newPage();
  watch(dp, 'desktop-1280');
  const dzCard = async (col, id) => {
    const el = await dp.$(`#col-${col} .card[data-id="${id}"]`);
    if (!el) throw new Error(`${id} is not in the ${col} column`);
    return (await el.$eval('.dzb', (e) => e.textContent).catch(() => '')).trim();
  };

  await step('desktop 1280: Discussing column and round badges on cards', async () => {
    await dp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('.card[data-id="PA-013"]', { timeout: 10000 });
    const cols = await dp.$$eval('#board .col', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { key: e.dataset.key, y: r.y, right: r.right }; }));
    if (cols.length !== 7 || cols.some((c) => Math.abs(c.y - cols[0].y) > 1 || c.right > 1280)) throw new Error(`columns at 1280: ${JSON.stringify(cols)}`);
    const title = await dp.textContent('#col-discuss .col-title');
    if (!/^Discussing\s*3$/.test(title.trim())) throw new Error(`Discussing column title "${title}"`);
    const want = [['discuss', 'PA-013', 'Round 2 ready'], ['discuss', 'PA-015', 'Designing round 1 · check'], ['discuss', 'PA-016', 'Round 2 failed'], ['you', 'PA-014', 'Round 1 ready'], ['inbox', 'PA-017', 'Accepted round 2']];
    for (const [col, id, text] of want) {
      const got = await dzCard(col, id);
      if (got !== text) throw new Error(`${id} badge "${got}", expected "${text}"`);
    }
    const boxed = await dp.$eval('.card[data-id="PA-015"] .dzb', (e) => getComputedStyle(e).borderTopStyle);
    if (boxed !== 'none') throw new Error('the designing badge is drawn as a box');
    await checkHeader(dp);
    await noOverflow(dp, '1280 board');
    await shot(dp, 'desktop1280-board.png');
  });

  await step('desktop 1280: a round with open decisions leads the ticket (PA-014)', async () => {
    await dp.goto(BASE + '/#PA-014', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#drawer .blk.dz .dz-round');
    const order = await dp.$$eval('#dr-body > *', (els) => els.map((e) => e.className || e.tagName));
    if (!/\bdz\b/.test(order[1] || '')) throw new Error(`the Discussion section is not right under the title: ${order.join(' | ')}`);
    if (await dp.$('#drawer .blk.needs')) throw new Error('the round decisions are shown twice (also in Needs you)');
    const page1 = await dp.$eval('#drawer .dz-round a[data-key="dz-page-1"]', (a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent }));
    if (page1.href !== '/api/tickets/PA-014/discuss/round-1.html' || page1.target !== '_blank' || !/noopener/.test(page1.rel)) throw new Error(`Open page link: ${JSON.stringify(page1)}`);
    const res = await fetch(BASE + page1.href);
    if (res.status !== 200 || !/sandbox/.test(res.headers.get('content-security-policy') || '')) throw new Error(`the round page answers ${res.status} without a sandbox`);
    if (await dp.$('#drawer a[data-key="dz-link-1"]')) throw new Error('"Open link" shown for a round without a public link');
    if (!(await dp.textContent('#drawer .dz-round')).includes('Page not checked')) throw new Error('the skipped page check is not mentioned');
    const qs = await dp.$$eval('#drawer .blk.dz .q', (els) => els.map((q) => ({
      picks: Array.from(q.querySelectorAll('.opt.pick')).map((b) => ({ data: b.dataset.text, shown: b.textContent, tag: !!b.querySelector('.pick-tag'), label: b.getAttribute('aria-label') })),
      why: (q.querySelector('.q-why') || {}).textContent || '',
      mic: !!q.querySelector('.mic'),
    })));
    if (qs.length !== 3) throw new Error(`expected 3 decisions in the Discussion section, got ${qs.length}`);
    for (const q of qs) {
      if (q.picks.length !== 1) throw new Error(`a decision has ${q.picks.length} picks`);
      const p = q.picks[0];
      if (!/\(recommended\)$/.test(p.data) || /recommended/.test(p.shown) || !p.tag || !/\(recommended\)$/.test(p.label || '')) throw new Error(`pick option: ${JSON.stringify(p)}`);
      if (!q.why) throw new Error('the reason of a decision is not shown');
    }
    for (const k of ['dz-accept', 'dz-send']) if (!(await dp.$(`#drawer [data-key="${k}"]`))) throw new Error(`${k} missing`);
    if ((await dp.textContent('#drawer [data-key="dz-send"]')).trim() !== 'Next round') throw new Error('the round button is not "Next round"');
    await noOverflow(dp, '1280 PA-014');
    await shot(dp, 'desktop1280-discussion-PA-014.png');
    await dp.$eval('#drawer .dz-step', (e) => e.scrollIntoView({ block: 'end' }));
    await shot(dp, 'desktop1280-discussion-PA-014-decide.png');
  });

  await step('desktop 1280: two rounds newest first, public link, Show more (PA-013)', async () => {
    await dp.goto(BASE + '/#PA-013', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#drawer .blk.dz .dz-round');
    const heads = await dp.$$eval('#drawer .dz-round h4', (els) => els.map((e) => e.textContent));
    if (heads.join() !== 'Round 2,Round 1') throw new Error(`rounds in order ${heads}`);
    const link = await dp.$eval('#drawer a[data-key="dz-link-2"]', (a) => ({ href: a.href, target: a.target, rel: a.rel }));
    if (link.href !== 'https://pages.example.com/p/pa-013-discussion.html' || link.target !== '_blank' || !/noopener/.test(link.rel)) throw new Error(`Open link: ${JSON.stringify(link)}`);
    if (await dp.$('#drawer a[data-key="dz-link-1"]')) throw new Error('round 1 has no public link but shows one');
    const rh = await dp.$$eval('#drawer .blk.dz > .dz-round .dz-rh > *',(els) => els.map((e) => [e.textContent, getComputedStyle(e, '::before').content]));
    const rhOk = rh.length === 3 && rh[0][0] === 'Round 2' && /^\d\d:\d\d$/.test(rh[1][0]) && rh[2][0] === 'asked by you' && rh[1][1] === '"·"' && rh[2][1] === '"·"';
    if (!rhOk) throw new Error(`round header ${JSON.stringify(rh)}`);
    const more = dp.locator('#drawer button[data-act="dz-more"][data-n="2"]');
    await more.waitFor({ state: 'visible', timeout: 4000 });
    const h0 = await dp.$eval('#dz-sum-2', (e) => e.clientHeight);
    await more.click();
    await dp.waitForSelector('#drawer button[data-act="dz-more"][data-n="2"][aria-expanded="true"]');
    const h1 = await dp.$eval('#dz-sum-2', (e) => e.clientHeight);
    if (!(h1 > h0)) throw new Error(`Show more did not open the summary (${h0} → ${h1}px)`);
    if (!(await dp.textContent('#dz-sum-2')).includes('Touches: course page')) throw new Error('the full summary is not shown');
    await dp.click('#drawer button[data-act="dz-more"][data-n="2"]');
    await dp.waitForSelector('#drawer button[data-act="dz-more"][data-n="2"][aria-expanded="false"]');
    if (!(await dp.textContent('#drawer .dz-check')).includes('Page check: 1 problem')) throw new Error('the page check problem is not listed');
    if (!(await dp.textContent('#drawer .dz-state')).includes('Round 2 is ready')) throw new Error('status line missing');
    await noOverflow(dp, '1280 PA-013');
    await shot(dp, 'desktop1280-discussion-PA-013.png');
  });

  await step('desktop 1280: designing, failed and accepted rounds (PA-015, PA-016, PA-017)', async () => {
    await dp.goto(BASE + '/#PA-015', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#drawer .blk.dz');
    const s15 = await dp.textContent('#drawer .blk.dz');
    if (!s15.includes('Designing round 1 · check') || !s15.includes('Checking the page') || !/Started \d\d:\d\d, \d+m ago/.test(s15)) throw new Error(`designing status: "${s15.slice(0, 200)}"`);
    if (await dp.$('#drawer [data-key="dz-accept"], #drawer [data-key="dz-send"]')) throw new Error('accept or next round offered while the designer works');
    await shot(dp, 'desktop1280-discussion-PA-015.png');
    await dp.goto(BASE + '/#PA-016', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#drawer .blk.dz');
    const s16 = await dp.textContent('#drawer .blk.dz .dz-state');
    if (!s16.includes('Round 2 failed: the designer ran out of time without writing page.html')) throw new Error(`failed status: "${s16}"`);
    if (!(await dp.$('#drawer button[data-act="dz-retry"]'))) throw new Error('"Try again" missing');
    if ((await dp.textContent('#drawer [data-key="dz-accept"]')).trim() !== 'Accept round 1') throw new Error('round 1 cannot be accepted after round 2 failed');
    const zone = await dp.$eval('#drawer [data-key="dz-accept"]', (b) => getComputedStyle(b).color);
    if (zone === (await dp.$eval('#drawer button[data-act="dz-retry"]', (b) => getComputedStyle(b).color))) throw new Error('Accept is drawn in the failure colour');
    await shot(dp, 'desktop1280-discussion-PA-016.png');
    await dp.goto(BASE + '/#PA-017', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#drawer .blk.dz');
    const order = await dp.$$eval('#dr-body > *', (els) => els.map((e) => e.className || e.tagName));
    if (order.indexOf(order.find((c) => /\bdz\b/.test(c))) < order.indexOf(order.find((c) => /\bacts\b/.test(c)))) throw new Error('an accepted discussion should sit below the actions');
    const s17 = await dp.textContent('#drawer .blk.dz');
    if (!/You accepted round 2 at \d\d:\d\d/.test(s17) || !s17.includes('accepted')) throw new Error(`accepted status: "${s17.slice(0, 160)}"`);
    if (await dp.$('#drawer [data-key="dz-accept"], #drawer [data-key="dz-send"], #drawer [data-action="discuss"]')) throw new Error('an accepted discussion still offers rounds');
    await dp.$eval('#drawer .blk.dz', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(dp, 'desktop1280-discussion-PA-017.png');
  });

  await step('desktop 1280: the lab chip and menu (state, Open, logins without passwords)', async () => {
    await dp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#labchip:not([hidden])[data-tone="up"]');
    if (!/^Lab\s*until \d\d:\d\d$/.test((await dp.textContent('#labchip')).trim())) throw new Error(`lab chip says "${await dp.textContent('#labchip')}"`);
    await dp.click('#labchip');
    await dp.waitForSelector('#labmenu:not([hidden])');
    const m = await dp.textContent('#labmenu');
    if (!/Up until \d\d:\d\d/.test(m) || !/Stops at \d\d:\d\d/.test(m)) throw new Error(`lab menu: "${m.slice(0, 120)}"`);
    const open = await dp.$eval('#labmenu a.pv-open', (a) => ({ href: a.href, target: a.target }));
    if (open.href !== 'http://localhost:20119/' || open.target !== '_blank') throw new Error(`Open: ${JSON.stringify(open)}`);
    for (const e of ['demo.trainer@example.com', 'demo.admin@example.com', 'demo.active@example.com']) if (!m.includes(e)) throw new Error(`login ${e} missing`);
    if (/password|DEMO_PASSWORD/i.test(m)) throw new Error('the lab menu talks about passwords');
    for (const op of ['extend', 'down']) if (!(await dp.$(`#labmenu button[data-act="lab"][data-op="${op}"]`))) throw new Error(`lab ${op} button missing`);
    await noOverflow(dp, '1280 lab menu');
    await shot(dp, 'desktop1280-lab.png');
    await dp.keyboard.press('Escape');
    await dp.waitForSelector('#labmenu', { state: 'hidden' });
    if (!(await dp.evaluate(() => document.activeElement && document.activeElement.id === 'labchip'))) throw new Error('Esc did not return focus to the lab chip');
  });
  await d12.close();

  // ---------------- phone ----------------
  const phoneCtx = (w, h, init) => browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  }).then(async (c) => { if (init) await c.addInitScript(init); return c; });
  const phone = await phoneCtx(390, 844);
  const mp = await phone.newPage();
  watch(mp, 'phone');

  await step('phone 390×844: opens on Needs you, cards stack, no overflow', async () => {
    await mp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#tabs .tab.you[aria-selected="true"]', { timeout: 10000 });
    await mp.waitForSelector('#col-you.on .card[data-id="PA-003"]');
    if (await mp.isVisible('#col-inbox')) throw new Error('other columns are visible too');
    const widths = await mp.$$eval('#col-you .card', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    if (!widths.length || widths.some((w) => w < 340)) throw new Error(`cards do not stack full width: ${widths}`);
    const small = await mp.$$eval('.bar button, .bar a, .tabs button, #col-you .card', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.id || e.className));
    if (small.length) throw new Error(`touch targets under 40 px: ${small.join(', ')}`);
    await checkHeader(mp);
    await noOverflow(mp, 'phone board');
    await shot(mp, 'phone-board.png');
  });

  await step('phone 390: seven tabs fit; Talk lists the design rounds', async () => {
    const tabs = await mp.$$eval('#tabs .tab', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { key: e.dataset.tab, y: r.y, label: e.querySelector('.tl-short').textContent, clipped: e.querySelector('.tl-short').scrollWidth > e.querySelector('.tl-short').clientWidth + 1 }; }));
    if (tabs.length !== 7 || tabs.some((t) => Math.abs(t.y - tabs[0].y) > 1)) throw new Error(`tabs: ${JSON.stringify(tabs)}`);
    if (tabs.some((t) => t.clipped)) throw new Error(`clipped tab labels: ${tabs.filter((t) => t.clipped).map((t) => t.label)}`);
    const bar = await mp.$eval('#bar', (e) => e.getBoundingClientRect().height);
    if (bar > 115) throw new Error(`the top bar takes ${bar}px (three rows?)`);
    await mp.tap('#tabs .tab.discuss');
    await mp.waitForSelector('#col-discuss.on .card[data-id="PA-013"]');
    if ((await mp.$$('#col-discuss.on .card')).length !== 3) throw new Error('Talk does not list three discussions');
    await noOverflow(mp, 'phone talk tab');
    await shot(mp, 'phone-board-talk.png');
  });

  await step('phone 390: the Discussion section of PA-014 and PA-013', async () => {
    await mp.tap('#tabs .tab.you');
    await mp.tap('#col-you .card[data-id="PA-014"]');
    await mp.waitForSelector('#drawer:not([hidden]) .blk.dz .dz-round');
    await noOverflow(mp, 'phone PA-014');
    const small = await smallTargets(mp, '#drawer button, #drawer a, #drawer select, #drawer textarea');
    if (small.length) throw new Error(`touch targets under 40 px in the discussion: ${small.join(', ')}`);
    if (!(await visibleIn(mp, '#drawer a[data-key="dz-page-1"]'))) throw new Error('"Open page" is not on the first screen');
    await shot(mp, 'phone-discussion-PA-014.png');
    await mp.$eval('#drawer .dz-step', (e) => e.scrollIntoView({ block: 'end' }));
    await shot(mp, 'phone-discussion-PA-014-decide.png');
    await mp.goBack();
    await mp.waitForSelector('#drawer', { state: 'hidden' });
    await mp.goto(BASE + '/#PA-013', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#drawer:not([hidden]) .blk.dz .dz-round');
    await noOverflow(mp, 'phone PA-013');
    await shot(mp, 'phone-discussion-PA-013.png');
    await mp.goBack();
    await mp.waitForSelector('#drawer', { state: 'hidden' });
  });

  await step('phone 390: the lab chip is compact and its menu fits', async () => {
    await mp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#labchip:not([hidden])');
    const box = await mp.$eval('#labchip', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    if (box.h < 40 || box.w > 60) throw new Error(`lab chip is ${JSON.stringify(box)}`);
    await mp.tap('#labchip');
    await mp.waitForSelector('#labmenu:not([hidden]) a.pv-open');
    await noOverflow(mp, 'phone lab menu');
    const small = await smallTargets(mp, '#labmenu button, #labmenu a');
    if (small.length) throw new Error(`touch targets under 40 px in the lab menu: ${small.join(', ')}`);
    await shot(mp, 'phone-lab.png');
    await mp.tap('#labchip');
    await mp.waitForSelector('#labmenu', { state: 'hidden' });
  });

  await step('phone: Test it tab', async () => {
    await mp.tap('#tabs .tab.test');
    await mp.waitForSelector('#col-test.on .card[data-id="PA-008"]');
    await noOverflow(mp, 'phone test tab');
    await shot(mp, 'phone-board-test.png');
  });

  await step('phone: ticket opens full screen and Back closes it', async () => {
    await mp.tap('#tabs .tab.you');
    await mp.tap('#col-you .card[data-id="PA-003"]');
    await mp.waitForSelector('#drawer:not([hidden]) .q');
    const box = await mp.locator('#drawer').boundingBox();
    if (Math.round(box.width) !== 390 || box.y > 0) throw new Error(`sheet is not full screen: ${JSON.stringify(box)}`);
    await noOverflow(mp, 'phone ticket');
    const smallInDrawer = await smallTargets(mp, '#drawer button, #drawer a, #drawer select, #drawer textarea');
    if (smallInDrawer.length) throw new Error(`touch targets under 40 px in the ticket: ${smallInDrawer.join(', ')}`);
    await shot(mp, 'phone-ticket-PA-003.png');
    await mp.goBack();
    await mp.waitForSelector('#drawer', { state: 'hidden' });
  });

  await step('phone: PA-008 preview block', async () => {
    await mp.tap('#tabs .tab.test');
    await mp.tap('#col-test .card[data-id="PA-008"]');
    await mp.waitForSelector('#drawer a.pv-open');
    if (!(await visibleIn(mp, '#drawer a.pv-open'))) throw new Error('the preview link is not on the first screen');
    await noOverflow(mp, 'phone PA-008');
    await shot(mp, 'phone-ticket-PA-008.png');
    await mp.tap('#drawer [role="tab"][data-tab="verify"]');
    await noOverflow(mp, 'phone verifier table');
    await mp.goBack();
    await mp.waitForSelector('#drawer', { state: 'hidden' });
  });

  await step('phone: chat is a full-screen view at #chat', async () => {
    await mp.tap('#btn-chat');
    await mp.waitForSelector('#chat:not([hidden])');
    if (!mp.url().endsWith('#chat')) throw new Error(`URL is ${mp.url()}`);
    const box = await mp.locator('#chat').boundingBox();
    if (Math.round(box.width) !== 390 || box.y > 0) throw new Error('chat is not full screen');
    const covered = await mp.evaluate(() => {
      const r = document.querySelector('#chat-h').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
      return !el || !el.closest('#chat');
    });
    if (covered) throw new Error('something covers the chat header');
    await mp.waitForSelector('#msgs .msg.lead');
    await noOverflow(mp, 'phone chat');
    await shot(mp, 'phone-chat.png');
    await mp.tap('#msgs a.tid[href="#PA-008"] >> nth=0');
    await mp.waitForSelector('#drawer:not([hidden]) a.pv-open');
    await mp.goBack();
    await mp.waitForSelector('#drawer', { state: 'hidden' });
    if (await mp.isHidden('#chat')) throw new Error('Back from a ticket opened in chat did not return to the chat');
    await mp.goBack();
    await mp.waitForSelector('#chat', { state: 'hidden' });
  });

  await step('phone: New sheet', async () => {
    await mp.tap('#btn-new');
    await mp.waitForSelector('#new-modal:not([hidden])');
    await noOverflow(mp, 'phone new sheet');
    await shot(mp, 'phone-new.png');
    await mp.goBack();
    await mp.waitForSelector('#new-modal', { state: 'hidden' });
  });

  await step('phone: runner menu', async () => {
    await mp.tap('#runchip');
    await mp.waitForSelector('#runmenu:not([hidden])');
    await noOverflow(mp, 'phone runner menu');
    await shot(mp, 'phone-runner-menu.png');
    await mp.tap('#runchip');
    await mp.waitForSelector('#runmenu', { state: 'hidden' });
  });
  await phone.close();

  // ---------------- desktop 1280: design-round actions and the lab (these change the demo data) ----------------
  const d2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ap = await d2.newPage();
  watch(ap, 'desktop-actions');

  await step('desktop: tapping a recommended pick answers with the full option text', async () => {
    await ap.goto(BASE + '/#PA-014', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('#drawer .blk.dz .q .opt.pick[data-q="Q1"]');
    const full = await ap.$eval('#drawer .opt.pick[data-q="Q1"]', (b) => b.dataset.text);
    const { body, headers } = await postOf(ap, '/api/tickets/PA-014/answer', () => ap.click('#drawer .opt.pick[data-q="Q1"]'));
    if (body.q !== 'Q1' || body.text !== full || headers['x-crew'] !== '1') throw new Error(`answer sent ${JSON.stringify(body)}`);
    await until(async () => (await ticket('PA-014')).state.questions.find((q) => q.id === 'Q1').answer === 'b: The trainer, after the session (recommended)', 8000, 'Q1 answered with the full text');
    await until(async () => (await ap.$$('#drawer .blk.dz .q')).length === 2, 6000, 'two decisions left');
  });

  await step('desktop: Next round sends the note; the round shows as queued', async () => {
    const note = 'Compare a chart with plain numbers for clients';
    await ap.fill('#dz-in', note);
    const { body } = await postOf(ap, '/api/tickets/PA-014/action', () => ap.click('#drawer [data-key="dz-send"]'));
    if (body.action !== 'discuss' || body.note !== note) throw new Error(`sent ${JSON.stringify(body)}`);
    const t = await until(async () => { const x = await ticket('PA-014'); return x.state.discussion.state === 'queued' && x; }, 8000, 'round 2 to be queued');
    if (t.state.status !== 'discussing' || t.state.discussion.pending.round !== 2 || t.state.discussion.pending.note !== note) throw new Error(`server state ${JSON.stringify({ status: t.state.status, pending: t.state.discussion.pending })}`);
    await ap.waitForSelector('#drawer .blk.dz .blk-top .st:has-text("Round 2 queued")', { timeout: 8000 });
    await until(() => ap.evaluate(() => document.activeElement && document.activeElement.id === 'dz-h'), 3000, 'focus on the Discussion heading');
    if (await ap.$('#drawer [data-key="dz-send"], #drawer [data-key="dz-accept"]')) throw new Error('round controls still shown while round 2 is queued');
    if (!(await ap.textContent('#drawer .dz-state')).includes(note)) throw new Error('the focus note of the queued round is not shown');
    await ap.waitForSelector('#col-discuss .card[data-id="PA-014"] .dzb:has-text("Round 2 queued")', { timeout: 8000 });
    await shot(ap, 'desktop1280-discussion-PA-014-queued.png');
  });

  await step('desktop: Accept asks in the page, then accepts round 2 (PA-013)', async () => {
    await ap.goto(BASE + '/#PA-013', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('#drawer [data-key="dz-accept"]');
    await ap.click('#drawer [data-key="dz-accept"]');
    await ap.waitForSelector('#drawer .confirm.calm');
    const text = (await ap.textContent('#drawer .confirm.calm > span')).trim();
    if (text !== 'Accept round 2? Open decisions take the recommended pick, and the lead plans the build.') throw new Error(`confirm text "${text}"`);
    await until(() => ap.evaluate(() => document.activeElement && document.activeElement.dataset.key === 'dz-accept-no'), 2000, 'focus on "Not yet"');
    await ap.$eval('#drawer .confirm.calm', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(ap, 'desktop1280-discussion-PA-013-accept.png');
    await ap.keyboard.press('Escape');
    await ap.waitForSelector('#drawer .confirm', { state: 'detached' });
    if (await ap.isHidden('#drawer')) throw new Error('Esc on the confirm closed the ticket');
    if ((await ticket('PA-013')).state.status !== 'discussing') throw new Error('PA-013 changed without a confirm');
    await ap.click('#drawer [data-key="dz-accept"]');
    const { body } = await postOf(ap, '/api/tickets/PA-013/action', () => ap.click('#drawer [data-key="dz-accept-yes"]'));
    if (body.action !== 'accept' || body.round !== 2) throw new Error(`sent ${JSON.stringify(body)}`);
    const t = await until(async () => { const x = await ticket('PA-013'); return x.state.status === 'shaping' && x; }, 8000, 'PA-013 to go to shaping');
    if (t.state.discussion.acceptedRound !== 2 || t.state.discussion.state !== 'accepted') throw new Error(`discussion ${JSON.stringify(t.state.discussion.state)}`);
    await ap.waitForSelector('#dr-head .st:has-text("Shaping")', { timeout: 8000 });
    await ap.waitForSelector('#drawer .blk.dz .blk-top .st:has-text("Accepted round 2")', { timeout: 8000 });
    await ap.waitForSelector('#col-inbox .card[data-id="PA-013"] .dzb:has-text("Accepted round 2")', { timeout: 8000 });
  });

  await step('desktop: Try again on a failed round keeps its focus (PA-016)', async () => {
    await ap.goto(BASE + '/#PA-016', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('#drawer button[data-act="dz-retry"]');
    const { body } = await postOf(ap, '/api/tickets/PA-016/action', () => ap.click('#drawer button[data-act="dz-retry"]'));
    if (body.action !== 'discuss' || body.note !== 'Try a calendar view instead of the week strip') throw new Error(`sent ${JSON.stringify(body)}`);
    await until(async () => { const d = (await ticket('PA-016')).state.discussion; return d.state === 'queued' && d.pending.round === 2; }, 8000, 'round 2 queued again');
    await ap.waitForSelector('#drawer .blk.dz .blk-top .st:has-text("Round 2 queued")', { timeout: 8000 });
  });

  await step('desktop: Discuss first on an inbox ticket (PA-001)', async () => {
    await ap.goto(BASE + '/#PA-001', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('#drawer button[data-action="discuss"]');
    if ((await ap.textContent('#drawer button[data-action="discuss"]')).trim() !== 'Discuss first') throw new Error('the button is not "Discuss first"');
    const { body } = await postOf(ap, '/api/tickets/PA-001/action', () => ap.click('#drawer button[data-action="discuss"]'));
    if (body.action !== 'discuss') throw new Error(`sent ${JSON.stringify(body)}`);
    await until(async () => { const s = (await ticket('PA-001')).state; return s.status === 'discussing' && s.discussion.state === 'queued' && s.discussion.pending.round === 1; }, 8000, 'PA-001 to be discussing with round 1 queued');
    await ap.waitForSelector('#drawer .blk.dz .blk-top .st:has-text("Round 1 queued")', { timeout: 8000 });
    await ap.waitForSelector('#col-discuss .card[data-id="PA-001"] .dzb:has-text("Round 1 queued")', { timeout: 8000 });
    if (await ap.$('#drawer button[data-action="discuss"]')) throw new Error('"Discuss first" still shown');
  });

  let dzId = null;
  await step('desktop: New sheet: Discuss first follows the type and sends discuss:true', async () => {
    await ap.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('.card[data-id="PA-003"]');
    await ap.click('#btn-new');
    await ap.waitForSelector('#new-modal:not([hidden])');
    const st = async () => ({ on: await ap.isChecked('#new-discuss'), shape: await ap.isVisible('#new-shape-wrap') });
    for (const [type, on] of [['bug', false], ['feature', true], ['chore', false], ['idea', true]]) {
      await ap.click(`#new-form label:has(input[value="${type}"])`);
      const s = await st();
      if (s.on !== on || s.shape === on) throw new Error(`${type}: Discuss first ${s.on}, shape option ${s.shape ? 'shown' : 'hidden'}`);
    }
    await ap.click('#new-form label[for="new-discuss"]');
    await ap.click('#new-form label:has(input[value="feature"])');
    if (await ap.isChecked('#new-discuss')) throw new Error('the type overrode your own choice');
    await ap.keyboard.press('Escape');
    await ap.waitForSelector('#new-modal', { state: 'hidden' });
    await ap.click('#btn-new');
    await ap.waitForSelector('#new-modal:not([hidden])');
    await ap.click('#new-form label:has(input[value="feature"])');
    if (!(await ap.isChecked('#new-discuss'))) throw new Error('reopening the sheet remembered the old choice');
    await ap.fill('#new-title', 'UI check: remind clients the day before their slot');
    await ap.fill('#new-body', 'An email or a push the evening before; trainers want fewer no-shows.');
    await shot(ap, 'desktop1280-new-discuss.png');
    const { body } = await postOf(ap, '/api/tickets', () => ap.click('#new-submit'));
    if (body.discuss !== true || body.type !== 'feature' || body.title !== 'UI check: remind clients the day before their slot' || body.priority !== 2) throw new Error(`sent ${JSON.stringify(body)}`);
    dzId = await until(async () => { const c = allCards(await api('/api/state')).find((x) => x.title.startsWith('UI check: remind clients')); return c && c.id; }, 8000, 'the new ticket');
    const s = (await ticket(dzId)).state;
    if (s.status !== 'discussing' || !s.discussion || s.discussion.state !== 'new') throw new Error(`new ticket ${s.status} / ${JSON.stringify(s.discussion)}`);
    await ap.waitForFunction((id) => location.hash === '#' + id && document.querySelector('#drawer .blk.dz [data-key="dz-send"]'), dzId, { timeout: 8000 });
    if ((await ap.textContent('#drawer [data-key="dz-send"]')).trim() !== 'Start round 1') throw new Error('the first round button is not "Start round 1"');
    if (!(await ap.textContent('#drawer .blk.dz')).includes('No round yet')) throw new Error('"No round yet" missing');
    await shot(ap, 'desktop1280-discussion-new.png');
  });

  await step('desktop: a refused action shows the server error; Start round 1 sends the focus', async () => {
    if (!dzId) throw new Error('no new discussion ticket');
    await recordToasts(ap);
    const msg = `${dzId} already has round 1 waiting to start`;
    await ap.route(`**/api/tickets/${dzId}/action`, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: msg }) }), { times: 1 });
    expected400 = 1;
    await ap.click('#drawer [data-key="dz-send"]');
    await ap.waitForSelector(`.toast.error:has-text("${msg}")`, { timeout: 6000 });
    await ap.unroute(`**/api/tickets/${dzId}/action`);
    await until(() => expected400 === 0, 3000, 'the refused request to be logged');
    if ((await ticket(dzId)).state.discussion.state !== 'new') throw new Error('the refused request changed the ticket');
    await ap.fill('#dz-in', 'Email only, Polish copy');
    const { body } = await postOf(ap, `/api/tickets/${dzId}/action`, () => ap.click('#drawer [data-key="dz-send"]'));
    if (body.action !== 'discuss' || body.note !== 'Email only, Polish copy') throw new Error(`sent ${JSON.stringify(body)}`);
    await until(async () => { const d = (await ticket(dzId)).state.discussion; return d.state === 'queued' && d.pending.round === 1 && d.pending.note === 'Email only, Polish copy'; }, 8000, 'round 1 queued with the note');
    await ap.waitForSelector('#drawer .blk.dz .blk-top .st:has-text("Round 1 queued")', { timeout: 8000 });
  });

  let labUpAt = 0;
  await step('desktop: the lab: +2 h, Stop and Start send their calls', async () => {
    await ap.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await ap.waitForSelector('#labchip[data-tone="up"]');
    await recordToasts(ap);
    const exp0 = Date.parse((await api('/api/state')).lab[0].expiresAt);
    await ap.click('#labchip');
    await ap.waitForSelector('#labmenu button[data-op="extend"]');
    let sent = await postOf(ap, '/api/lab', () => ap.click('#labmenu button[data-op="extend"]'));
    if (JSON.stringify(sent.body) !== JSON.stringify({ project: 'shop', op: 'extend' }) || sent.headers['x-crew'] !== '1') throw new Error(`extend sent ${JSON.stringify(sent.body)}`);
    await until(async () => Date.parse((await api('/api/state')).lab[0].expiresAt) > exp0 + 60 * 60e3, 6000, 'the lab to run longer');
    await ap.waitForSelector('#labmenu:not([hidden]) button[data-op="down"]');
    sent = await postOf(ap, '/api/lab', () => ap.click('#labmenu button[data-op="down"]'));
    if (JSON.stringify(sent.body) !== JSON.stringify({ project: 'shop', op: 'down' })) throw new Error(`stop sent ${JSON.stringify(sent.body)}`);
    await until(async () => (await api('/api/state')).lab[0].state === 'down', 6000, 'the lab to be down');
    await ap.waitForSelector('#labmenu:not([hidden]) button[data-op="up"]:has-text("Start lab")', { timeout: 6000 });
    await ap.waitForSelector('#labchip[data-tone="off"]');
    if (!(await ap.textContent('#labmenu')).includes('about 5 minutes')) throw new Error('the first build time is not mentioned');
    sent = await postOf(ap, '/api/lab', () => ap.click('#labmenu button[data-op="up"]'));
    if (JSON.stringify(sent.body) !== JSON.stringify({ project: 'shop', op: 'up' })) throw new Error(`start sent ${JSON.stringify(sent.body)}`);
    labUpAt = Date.now();
    // The demo project has no repo, so the start fails at once, and the board shows why.
    await ap.waitForSelector('#labmenu .pv-err:has-text("no repo.url")', { timeout: 8000 });
    await ap.waitForSelector('#labmenu button[data-op="up"]:has-text("Try again")');
    await ap.waitForSelector('#labchip[data-tone="bad"]');
    await shot(ap, 'desktop1280-lab-failed.png');
  });

  // ---------------- dictation ----------------
  const quiet = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await quiet.addInitScript(noSpeech);
  const qp = await quiet.newPage();
  watch(qp, 'no-speech');
  await step('dictation: no mic buttons where the browser has no speech recognition', async () => {
    await qp.goto(BASE + '/#PA-003', { waitUntil: 'domcontentloaded' });
    await qp.waitForSelector('#drawer .q textarea');
    await qp.click('#btn-chat');
    await qp.waitForSelector('#chat:not([hidden])');
    await qp.goto(BASE + '/#new', { waitUntil: 'domcontentloaded' });
    await qp.waitForSelector('#new-modal:not([hidden])');
    const n = await qp.evaluate(() => ({ mics: document.querySelectorAll('.mic, .vlang').length, voice: document.documentElement.classList.contains('voice'), pad: getComputedStyle(document.querySelector('#chat-in')).paddingRight }));
    if (n.mics || n.voice || n.pad !== '11px') throw new Error(`speech UI without speech recognition: ${JSON.stringify(n)}`);
  });
  await quiet.close();

  const talk = await phoneCtx(390, 844, fakeSpeech);
  const vp = await talk.newPage();
  watch(vp, 'dictation');
  await step('dictation: chat mic with a fake recognizer (PL/EN, interim and final words, errors)', async () => {
    await vp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await vp.waitForSelector('#tabs .tab');
    await recordToasts(vp);
    await vp.tap('#btn-chat');
    await vp.waitForSelector('#chat:not([hidden]) #chat-form .mic');
    const mic = '#chat-form .mic';
    const m0 = await vp.$eval(mic, (b) => ({ label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), h: b.getBoundingClientRect().height, lang: document.querySelector('#chat-form .vlang').textContent }));
    if (m0.label !== 'Dictate' || m0.pressed !== 'false' || m0.h < 40 || m0.lang !== 'PL') throw new Error(`chat mic: ${JSON.stringify(m0)}`);
    await vp.fill('#chat-in', 'Uwaga:');
    await vp.tap(mic);
    await vp.waitForSelector(`${mic}[aria-pressed="true"]`);
    const start = await vp.evaluate(() => window.__srLog[window.__srLog.length - 1]);
    if (JSON.stringify(start) !== JSON.stringify(['start', 'pl-PL', true, true])) throw new Error(`started with ${JSON.stringify(start)}`);
    await vp.evaluate(() => window.__sr.say([['dzień', false]], 0));
    if ((await vp.inputValue('#chat-in')) !== 'Uwaga: dzień') throw new Error(`interim: "${await vp.inputValue('#chat-in')}"`);
    await vp.evaluate(() => window.__sr.say([['dzień dobry', true]], 0));
    await vp.evaluate(() => window.__sr.say([['dzień dobry', true], ['jak', false]], 1));
    await vp.evaluate(() => window.__sr.say([['dzień dobry', true], ['jak się masz', true]], 1));
    if ((await vp.inputValue('#chat-in')) !== 'Uwaga: dzień dobry jak się masz') throw new Error(`final: "${await vp.inputValue('#chat-in')}"`);
    await shot(vp, 'phone-dictation-chat.png');
    await vp.tap(mic);
    await vp.waitForSelector(`${mic}[aria-pressed="false"]`);
    if ((await vp.evaluate(() => window.__srLog[window.__srLog.length - 1][0])) !== 'stop') throw new Error('tapping again did not stop');
    await vp.tap('#chat-form .vlang');
    if ((await vp.textContent('#chat-form .vlang')) !== 'EN' || (await vp.evaluate(() => localStorage.getItem('crew.voiceLang'))) !== 'en-US') throw new Error('the language toggle did not switch to EN');
    await vp.tap(mic);
    if ((await vp.evaluate(() => window.__srLog[window.__srLog.length - 1][1])) !== 'en-US') throw new Error('EN was not used');
    await vp.evaluate(() => window.__sr.fail('not-allowed'));
    await vp.waitForSelector(`${mic}[aria-pressed="false"]`);
    await until(async () => (await vp.evaluate(() => window.__toasts.join('\n'))).includes('microphone is blocked'), 3000, 'the not-allowed message');
    const free = await vp.evaluate(() => {
      const r = document.querySelector('#chat-form .mic').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!el && !!el.closest('.mic') && !!document.querySelector('.toast.error');
    });
    if (!free) throw new Error('the error message covers the mic (or is gone)');
    await vp.tap(mic);
    await vp.evaluate(() => window.__sr.fail('no-speech'));
    await until(async () => (await vp.evaluate(() => window.__toasts.join('\n'))).includes('No speech heard'), 3000, 'the no-speech message');
    await vp.reload({ waitUntil: 'domcontentloaded' });
    await vp.waitForSelector('#chat-form .vlang');
    if ((await vp.textContent('#chat-form .vlang')) !== 'EN') throw new Error('the language was not kept');
    await vp.tap('#chat-form .vlang');
    await noOverflow(vp, 'phone chat with mic');
  });

  await step('dictation: a ticket that re-renders keeps receiving the words', async () => {
    await vp.goto(BASE + '/#PA-003', { waitUntil: 'domcontentloaded' });
    await vp.waitForSelector('#drawer .q .mic');
    const key = await vp.$eval('#drawer .q .mic', (b) => b.dataset.mic);
    const box = `#drawer textarea[data-draft="${key}"]`;
    const mic = `#drawer .mic[data-mic="${key}"]`;
    await vp.tap(mic);
    await vp.waitForSelector(`${mic}[aria-pressed="true"]`);
    await vp.evaluate(() => window.__sr.say([['tak', true]], 0));
    await vp.evaluate(() => { window.__before = document.querySelector('#drawer .q textarea'); });
    await post('/api/tickets/PA-003/action', { action: 'note', note: 'UI check: a note that re-renders the ticket' });
    await until(async () => vp.evaluate(() => !document.contains(window.__before)), 8000, 'the ticket to re-render');
    await vp.waitForSelector(`${mic}[aria-pressed="true"]`);
    await vp.evaluate(() => window.__sr.say([['tak', true], ['do końca dostępu', true]], 1));
    if ((await vp.inputValue(box)) !== 'tak do końca dostępu') throw new Error(`answer box: "${await vp.inputValue(box)}"`);
    const small = await smallTargets(vp, '#drawer .mic');
    if (small.length) throw new Error(`mic under 40 px: ${small}`);
    await vp.tap(mic);
    await vp.waitForSelector(`${mic}[aria-pressed="false"]`);
    for (const sel of ['#note-in']) if (!(await vp.$(`#drawer .tbox:has(${sel}) .mic`))) throw new Error(`no mic next to ${sel}`);
    await vp.goto(BASE + '/#new', { waitUntil: 'domcontentloaded' });
    await vp.waitForSelector('#new-body-box .mic');
    await vp.tap('#new-body-box .mic');
    await vp.evaluate(() => window.__sr.say([['Kasia prosi o przypomnienie', true]], 0));
    if ((await vp.inputValue('#new-body')) !== 'Kasia prosi o przypomnienie') throw new Error('the new item details did not take the words');
    await vp.goBack();
    await vp.waitForSelector('#new-modal', { state: 'hidden' });
    if ((await vp.evaluate(() => window.__srLog[window.__srLog.length - 1][0])) !== 'abort') throw new Error('closing the sheet did not stop the dictation');
  });
  await talk.close();

  const small = await phoneCtx(360, 740);
  const sp = await small.newPage();
  watch(sp, 'phone-360');
  await step('phone 360×740: board and a shared ticket link fit; Back lands on the board', async () => {
    await sp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await sp.waitForSelector('#col-you.on .card');
    await noOverflow(sp, '360 board');
    await shot(sp, 'phone360-board.png');
    await sp.goto(BASE + '/#PA-008', { waitUntil: 'domcontentloaded' });
    await sp.waitForSelector('#drawer a.pv-open');
    await noOverflow(sp, '360 ticket');
    await shot(sp, 'phone360-ticket-PA-008.png');
    await sp.goBack();
    await sp.waitForSelector('#drawer', { state: 'hidden' });
    if (sp.url().includes('#')) throw new Error('Back from a shared ticket link did not land on the board');
  });
  await small.close();

  await step('the lab: a failed start is reported by the server, so the 30 s fallback stays quiet', async () => {
    if (!labUpAt) throw new Error('the lab was not started');
    await sleep(Math.max(0, labUpAt + 31500 - Date.now()));
    const toasts = await ap.evaluate(() => window.__toasts.join('\n'));
    if (toasts.includes('The lab has not reported back')) throw new Error('the fallback fired although the server reported the failure');
    const l = (await api('/api/state')).lab[0];
    if (l.state !== 'failed' || !/no repo\.url/.test(l.error || '')) throw new Error(`lab is ${l.state}: ${l.error}`);
    await ap.waitForSelector('#labchip[data-tone="bad"]');
  });
  await d2.close();
  await browser.close();

  await step('no console errors, page errors or dialogs', async () => {
    if (errors.length) throw new Error(errors.join('\n'));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}:`);
  for (const f of shots) console.log(`  ${f}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
