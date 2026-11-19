// A headless browser for two jobs: checking a design page before you see it (script errors, sideways
// scrolling, requests to other sites) and taking screenshots of the lab. crew has no dependencies, so it
// uses a playwright-core and a Chromium already on the machine: tools.playwright and tools.chromium in
// crew.json, or the usual places below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CrewError } from './store.js';

export function findTools(cfg = {}) {
  const t = cfg.tools || {};
  const home = os.homedir();
  const candidates = [
    t.playwright,
    process.env.CREW_PLAYWRIGHT,
    cfg.home && path.join(cfg.home, 'tools', 'node_modules', 'playwright-core'),
    path.join(home, 'crew', 'tools', 'node_modules', 'playwright-core'),
    '/usr/local/lib/node_modules/playwright-core',
    '/usr/lib/node_modules/playwright-core',
  ].filter(Boolean);
  const playwright = candidates.find((p) => fs.existsSync(path.join(p, 'package.json'))) || null;
  let chromium = t.chromium || process.env.CREW_CHROMIUM || null;
  if (!chromium) {
    const base = path.join(home, '.cache', 'ms-playwright');
    const dirs = fs.existsSync(base)
      ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      : [];
    for (const d of dirs) {
      const f = ['chrome-linux64', 'chrome-linux'].map((sub) => path.join(base, d, sub, 'chrome')).find((x) => fs.existsSync(x));
      if (f) {
        chromium = f;
        break;
      }
    }
  }
  return { playwright, chromium: chromium && fs.existsSync(chromium) ? chromium : null };
}

async function launch(cfg) {
  const { playwright, chromium } = findTools(cfg);
  if (!playwright || !chromium) {
    throw new CrewError('No headless browser: set tools.playwright (a playwright-core folder) and tools.chromium in crew.json. See docs/INSTALL.md.');
  }
  const pw = createRequire(import.meta.url)(playwright);
  return pw.chromium.launch({ executablePath: chromium, args: ['--no-sandbox'] });
}

const INSIDE = /^(file|data|blob|about):/;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// Open a self-contained page at phone and desktop width. Problems are things you would notice:
// script errors, the page scrolling sideways, or loading anything from another site (fonts aside).
// With shotsDir it also saves the page in slices (check-phone-1.png …) so an agent can look at it.
export async function pageCheck(file, { cfg, shotsDir = null, slice = 1600 } = {}) {
  if (!fs.existsSync(file)) throw new CrewError(`No page at ${file}`);
  const browser = await launch(cfg);
  const problems = [];
  const shots = [];
  const outside = new Set();
  try {
    for (const [width, tag] of [[390, 'phone'], [1280, 'desktop']]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`${tag}: script error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon/i.test(m.text())) problems.push(`${tag}: console error: ${m.text().slice(0, 200)}`);
      });
      page.on('request', (r) => {
        const u = r.url();
        if (!INSIDE.test(u) && !FONTS.test(u)) outside.add(u.slice(0, 120));
      });
      await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const iw = window.innerWidth;
        const scrolls = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
          }
          return false;
        };
        const wide = [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > iw + 1 && !scrolls(e))
          .slice(0, 5)
          .map((e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''));
        return { sw: document.documentElement.scrollWidth, iw, wide, h: document.documentElement.scrollHeight };
      });
      if (r.sw > r.iw + 1) problems.push(`${tag} (${width}px): the page scrolls sideways (${r.sw}px wide); too wide: ${r.wide.join(', ') || 'unknown'}`);
      if (shotsDir) {
        fs.mkdirSync(shotsDir, { recursive: true });
        for (let y = 0, n = 1; y < r.h && n <= 12; y += slice, n++) {
          const f = path.join(shotsDir, `check-${tag}-${n}.png`);
          await page.screenshot({ path: f, fullPage: true, clip: { x: 0, y, width, height: Math.min(slice, r.h - y) } });
          shots.push(f);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  if (outside.size) problems.push(`loads from other sites (pages must be self-contained): ${[...outside].slice(0, 4).join(', ')}`);
  return { ok: !problems.length, problems, shots };
}

// One screenshot of a URL, optionally logged in first with a JSON login endpoint (email + password).
export async function screenshot({ cfg, url, out, width = 390, height = 900, full = true, login = null, storage = {}, waitMs = 800, maxHeight = 6000 }) {
  const browser = await launch(cfg);
  try {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    if (Object.keys(storage || {}).length) {
      await ctx.addInitScript((s) => {
        for (const [k, v] of Object.entries(s)) {
          try {
            localStorage.setItem(k, v);
          } catch {}
        }
      }, storage);
    }
    if (login) {
      const r = await ctx.request.post(login.url, { data: { email: login.email, password: login.password }, failOnStatusCode: false });
      if (!r.ok()) throw new CrewError(`Logging in as ${login.email} failed: HTTP ${r.status()}`);
    }
    const page = await ctx.newPage();
    let resp;
    try {
      resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      // Pages with a live connection (SSE, websockets) never go quiet: wait a little, not forever.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch (e) {
      throw new CrewError(`Could not open ${url}: ${String(e.message).split('\n')[0]}`);
    }
    await page.waitForTimeout(waitMs);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const type = /\.png$/i.test(out) ? 'png' : 'jpeg';
    const opts = { path: out, type, ...(type === 'jpeg' ? { quality: 72 } : {}) };
    if (full && h > maxHeight) opts.clip = { x: 0, y: 0, width, height: maxHeight };
    if (full) opts.fullPage = true;
    await page.screenshot(opts);
    return { out, status: resp?.status() ?? null, finalUrl: page.url(), height: h, clipped: full && h > maxHeight };
  } finally {
    await browser.close();
  }
}
