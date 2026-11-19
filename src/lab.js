// The lab: today's app (the base branch) with a fresh copy of the demo data, on its own port. A designer
// screenshots it for "how it works today", and you can click around in it. It never runs a ticket's code.
// Settings come from project.json "lab", and anything missing from "preview" (build, start, migrate, env).
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService, serviceActive, sh } from './sysrun.js';
import { ticketEnv, ticketVars, dbUrl, parseEnvFile } from './env.js';
import { heavyLock } from './heavy.js';
import { ensureMirror } from './workspace.js';
import { screenshot } from './pagetools.js';
import * as db from './db.js';
import { readJson, readText, writeJson, nowIso, fill, sleep, fmtTime } from './util.js';
import { CrewError } from './store.js';

export function labConfig(project) {
  const lab = project.lab;
  if (!lab) return null;
  const pv = project.preview || {};
  const port = lab.port || 20119;
  const host = lab.host || '';
  return {
    port,
    host,
    url: fill(lab.url || pv.url || 'http://localhost:{port}', { host, port }),
    db: lab.db || `lab_${project.key}`,
    migrate: lab.migrate ?? pv.migrate ?? null,
    build: lab.build ?? pv.build ?? null,
    buildMemoryMax: lab.buildMemoryMax || pv.buildMemoryMax || '3G',
    start: lab.start ?? pv.start,
    env: { ...(pv.env || {}), ...(lab.env || {}) },
    health: lab.health || pv.health || '/',
    memoryMax: lab.memoryMax || pv.memoryMax || '1G',
    startTimeoutSec: lab.startTimeoutSec || pv.startTimeoutSec || 120,
    ttlMinutes: lab.ttlMinutes || 120,
    // Who you can be in the lab: role → demo email. The password is read from agent.env (passwordEnv).
    logins: lab.logins || {},
    passwordEnv: lab.passwordEnv || null,
    loginPath: lab.loginPath || null,
    // Browser storage set before each screenshot, e.g. a cookie-banner choice so it doesn't cover the page.
    localStorage: lab.localStorage || {},
  };
}

export class Lab {
  constructor({ store, onChange = () => {}, log = () => {} }) {
    this.store = store;
    this.onChange = onChange;
    this.log = log;
    this.file = path.join(store.home, 'lab.json');
    this.stateDir = path.join(store.home, 'lab');
  }

  table() {
    return readJson(this.file, {});
  }

  list() {
    return this.store
      .projects()
      .filter((p) => p.lab)
      .map((p) => {
        const c = labConfig(p);
        return { project: p.key, url: c.url, logins: Object.keys(c.logins), state: 'down', ...this.table()[p.key] };
      });
  }

  save(key, value) {
    const t = this.store.locked(() => {
      const cur = this.table();
      if (value) cur[key] = value;
      else delete cur[key];
      writeJson(this.file, cur);
      return cur;
    });
    this.onChange(t);
    return t[key] || null;
  }

  project(key) {
    const p = key ? this.store.project(key) : this.store.projects().find((x) => x.lab);
    if (!p) throw new CrewError('No project has lab settings (project.json "lab")');
    if (!p.lab) throw new CrewError(`${p.key} has no lab settings (project.json "lab")`);
    return p;
  }

  dir(project) {
    return path.join(this.store.home, 'worktrees', `_${project.key}-lab`);
  }

  // The env the app runs with: the project's sandbox values, the lab database and the lab's address.
  env(project, c) {
    const fake = { id: `${project.prefix}-000`, job: null };
    const { vars } = ticketVars(this.store, project, fake, { worktree: this.dir(project) });
    const env = { ...ticketEnv(this.store, project, fake, { role: 'runner', cwd: this.dir(project) }), PORT: String(c.port) };
    // Paths in project env vars ({worktree}) point into the lab's own checkout.
    for (const [k, v] of Object.entries(project.env?.vars || {})) if (String(v).includes('{worktree}')) env[k] = fill(v, vars);
    if (project.db?.url) env.DATABASE_URI = dbUrl(project, vars, c.db);
    for (const [k, v] of Object.entries(c.env)) env[k] = fill(v, { ...vars, url: c.url, host: c.host, port: c.port, slot: 'lab' });
    delete env.CREW_TICKET;
    return env;
  }

  // Start (or keep) the lab on the latest base branch. Builds only when the code or the address changed.
  async up(key, { by = 'user', reset = false } = {}) {
    const store = this.store;
    const project = this.project(key);
    const c = labConfig(project);
    const unit = `crew-lab-${project.key}`;
    const cur = this.table()[project.key];
    if (cur?.state === 'starting' || cur?.state === 'building') {
      if (ownerAlive(cur.owner)) throw new CrewError(`The ${project.key} lab is already starting`);
    }
    fs.mkdirSync(this.stateDir, { recursive: true });
    const logFile = path.join(this.stateDir, `${project.key}.log`);
    const mark = (patch) => this.save(project.key, { ...(this.table()[project.key] || {}), url: c.url, owner: process.pid, updated: nowIso(), ...patch });
    const fail = (e) => mark({ state: 'failed', owner: null, error: String(e.message || e).split('\n')[0].slice(0, 400) });
    const running = cur?.state === 'up' && serviceActive({ unit, stateDir: this.stateDir });
    // Say "starting" at once, so a failure in the slow parts below shows on the board.
    if (!running) mark({ state: 'starting', startedAt: nowIso(), by, error: null, expiresAt: null });
    const ref = `${project.repo.remote || 'origin'}/${project.repo.base}`;
    let mirror;
    let sha;
    try {
      mirror = await ensureMirror(store, project, { logFile });
      sha = (await sh(`git rev-parse ${ref}`, { cwd: mirror })).out.trim();
    } catch (e) {
      if (!running) fail(e);
      throw e;
    }
    if (running && cur.sha === sha && !reset) return this.extend(project.key);
    if (running) mark({ state: 'starting', startedAt: nowIso(), by, error: null, expiresAt: null });
    try {
      stopService({ unit, stateDir: this.stateDir });
      const dir = this.dir(project);
      if (!fs.existsSync(path.join(dir, '.git'))) await must(`git worktree add --detach ${q(dir)} ${ref}`, { cwd: mirror, logFile });
      // Back to the base branch exactly; ignored files (node_modules, the build) stay.
      else await must(`git checkout -q -f --detach ${ref} && git clean -fdq`, { cwd: dir, logFile });
      const env = this.env(project, c);
      // Inside .crew/ (git-excluded), so git clean keeps it; the app's files dir lives there too.
      fs.mkdirSync(path.join(dir, '.crew', 'training_files'), { recursive: true });
      const marker = path.join(dir, '.crew', 'lab-build.json');
      const built = readJson(marker, {});
      if (built.sha !== sha || !fs.existsSync(path.join(dir, 'node_modules'))) {
        for (const cmd of project.setup || []) await must(cmd, { cwd: dir, env, logFile, timeoutMs: 30 * 60e3, memoryMax: store.config().memory.jobMax, name: 'crew-setup' });
      }
      if (project.db?.url) {
        const { Runner } = await import('./runner.js');
        await new Runner({ store }).ensureGolden(project, { logFile });
        const { vars } = ticketVars(store, project, { id: `${project.prefix}-000`, job: null });
        if (reset || !(await db.exists(project, env, c.db))) await db.cloneDb(project, env, vars.golden, c.db, { logFile });
      }
      if (c.migrate) await must(c.migrate, { cwd: dir, env, logFile, memoryMax: '1500M', name: 'crew-lab-migrate' });
      if (c.build && (built.sha !== sha || built.url !== c.url || !fs.existsSync(path.join(dir, '.next')))) {
        mark({ state: 'building' });
        await heavyLock(store.home, `lab build ${project.key}`, () => must(c.build, { cwd: dir, env, logFile, timeoutMs: 25 * 60e3, memoryMax: c.buildMemoryMax, swapMax: '512M', name: 'crew-lab-build' }));
        writeJson(marker, { sha, url: c.url, at: nowIso() });
      } else if (!c.build) writeJson(marker, { sha, url: c.url, at: nowIso() });
      startService({ unit, cwd: dir, command: fill(c.start, { port: c.port }), env, memoryMax: c.memoryMax, runtimeMaxSec: 12 * 3600, stateDir: this.stateDir, logFile });
      await waitHealthy(`http://127.0.0.1:${c.port}${c.health}`, c.startTimeoutSec);
      return mark({ state: 'up', sha, owner: null, expiresAt: new Date(Date.now() + c.ttlMinutes * 60e3).toISOString() });
    } catch (e) {
      stopService({ unit, stateDir: this.stateDir });
      fail(e);
      throw e;
    }
  }

  down(key) {
    const project = this.project(key);
    stopService({ unit: `crew-lab-${project.key}`, stateDir: this.stateDir });
    return this.save(project.key, { ...(this.table()[project.key] || {}), state: 'down', expiresAt: null, owner: null, updated: nowIso() });
  }

  extend(key, { minutes } = {}) {
    const project = this.project(key);
    const c = labConfig(project);
    const cur = this.table()[project.key] || {};
    const from = Math.max(Date.now(), new Date(cur.expiresAt || 0).getTime());
    return this.save(project.key, { ...cur, expiresAt: new Date(from + (minutes || c.ttlMinutes) * 60e3).toISOString(), updated: nowIso() });
  }

  // Called by the server's ticker: stop a lab whose time is up, notice one that died.
  sweep() {
    for (const [key, v] of Object.entries(this.table())) {
      if (v.state !== 'up') continue;
      let project;
      try {
        project = this.store.project(key);
      } catch {
        this.save(key, null);
        continue;
      }
      const unit = `crew-lab-${project.key}`;
      if (v.expiresAt && new Date(v.expiresAt) < new Date()) this.down(key);
      else if (!serviceActive({ unit, stateDir: this.stateDir })) this.save(key, { ...v, state: 'down', expiresAt: null, error: 'stopped on its own (see lab log)' });
    }
  }

  // A screenshot of one lab page, logged in as a demo role if asked. Paths only: the lab is the only site.
  async shot(key, { page = '/', as = null, width = 390, out, full = true }) {
    const project = this.project(key);
    const c = labConfig(project);
    const cur = this.table()[project.key];
    if (cur?.state !== 'up') throw new CrewError(`The ${project.key} lab is not running; start it with: crew lab up`);
    if (!String(page).startsWith('/')) throw new CrewError('Give a path in the lab, like /konto');
    // Use the address the app was built for when it is local, so the app's own requests stay same-origin.
    const local = c.url.replace(/\/$/, '');
    const base = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(local) ? local : `http://127.0.0.1:${c.port}`;
    let login = null;
    if (as) {
      const email = c.logins[as] || (String(as).includes('@') ? as : null);
      if (!email) throw new CrewError(`No demo login "${as}". Known: ${Object.keys(c.logins).join(', ') || 'none'}`);
      const secrets = parseEnvFile(readText(path.join(project.dir, project.env?.file || 'agent.env')));
      const password = c.passwordEnv ? secrets[c.passwordEnv] : null;
      if (!password || !c.loginPath) throw new CrewError(`Logging in needs lab.loginPath in project.json and ${c.passwordEnv || 'a password key'} in agent.env`);
      login = { url: `${base}${c.loginPath}`, email, password };
    }
    this.extend(project.key, { minutes: 30 });
    return screenshot({ cfg: this.store.config(), url: `${base}${page}`, out, width: Number(width) || 390, full, login, storage: c.localStorage });
  }
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function must(cmd, opts) {
  const r = await sh(cmd, { timeoutMs: 15 * 60e3, ...opts });
  if (r.code !== 0) throw new Error(`${cmd.split(' ').slice(0, 4).join(' ')} failed: ${r.out.trim().split('\n').slice(-6).join(' | ')}`);
  return r;
}

async function waitHealthy(url, timeoutSec) {
  const end = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return true;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    await sleep(1500);
  }
  throw new Error(`the lab did not answer at ${url} within ${timeoutSec}s (${last})`);
}

function ownerAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// `crew lab up|down|status|shot` from a terminal (or from a designer's session).
export async function labCli({ store, op, args, values, out }) {
  const lab = new Lab({ store });
  const key = values.project;
  const tz = store.config().timezone;
  if (op === 'up') {
    out('Starting the lab (the first time it installs and builds, about 5 minutes)…');
    const s = await lab.up(key, { by: process.env.CREW_ROLE || 'user', reset: !!values.reset });
    return out(`The lab is up: ${s.url} (until ${fmtTime(s.expiresAt, tz)})`);
  }
  if (op === 'down') {
    lab.down(key);
    return out('The lab is stopped');
  }
  if (op === 'status') {
    const rows = lab.list();
    if (!rows.length) return out('No project has lab settings');
    return out(rows.map((r) => `${r.project}: ${r.state}${r.state === 'up' ? ` · ${r.url} until ${fmtTime(r.expiresAt, tz)}` : ''}${r.error ? ` · ${r.error}` : ''} · logins: ${r.logins.join(', ') || 'none'}`).join('\n'));
  }
  if (op === 'shot') {
    const page = args[0];
    if (!page) throw new CrewError('Usage: crew lab shot <path> [--as ROLE] [--width 390|1280] [--out FILE] [--viewport]');
    const outFile = values.out || `lab-${String(page).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}-${values.as || 'guest'}-${values.width || 390}.jpg`;
    const r = await lab.shot(key, { page, as: values.as || null, width: values.width, out: outFile, full: !values.viewport });
    return out(`${r.out} · HTTP ${r.status} · ended at ${r.finalUrl.replace(/^https?:\/\/[^/]+/, '')}${r.clipped ? ` · cut at 6000 of ${r.height}px` : ''}`);
  }
  throw new CrewError('Use: crew lab up|down|status|shot');
}
