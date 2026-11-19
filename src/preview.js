// Previews: start a ticket's branch on a fixed slot (preview-1, preview-2…) with a fresh copy of
// the golden demo database, so you can log in as the demo trainer or admin and click around.
// Next.js bakes the site URL into the build, so a build belongs to one slot; the gate builds for slot 1.
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService, serviceActive, sh } from './sysrun.js';
import { ticketEnv, ticketVars, dbUrl } from './env.js';
import { heavyLock } from './heavy.js';
import * as db from './db.js';
import { readJson, writeJson, nowIso, fill, sleep, fmtTime } from './util.js';
import { CrewError } from './store.js';

export class Previews {
  constructor({ store, notify = async () => {}, onChange = () => {} }) {
    this.store = store;
    this.notify = notify;
    this.onChange = onChange;
    this.file = path.join(store.home, 'previews.json');
    this.stateDir = path.join(store.home, 'previews');
    this.busy = new Set();
  }

  slots(project) {
    return project.preview?.slots || [];
  }

  table() {
    return readJson(this.file, {});
  }

  // previews.json is shared by the server and CLI processes: read-modify-write under the store lock.
  saveSlot(key, value) {
    const t = this.store.locked(() => {
      const cur = this.table();
      if (value) cur[key] = value;
      else delete cur[key];
      writeJson(this.file, cur);
      return cur;
    });
    this.onChange(t);
  }

  slotUrl(project, slot) {
    return fill(project.preview.url || 'https://{host}', { host: slot.host, port: slot.port });
  }

  list() {
    return Object.entries(this.table()).map(([key, v]) => ({ key, ...v }));
  }

  // Checks that can fail at once (so the board gets a clear 400 instead of a silent background failure).
  // Returns null when the preview is already running (then up() just extends it).
  plan(id) {
    const store = this.store;
    const st = store.state(id);
    const project = store.project(st.project);
    const pv = project.preview;
    if (!pv) throw new CrewError(`${project.key} has no preview settings`);
    const dir = st.job?.worktree;
    if (!dir || !fs.existsSync(dir)) throw new CrewError(`${id} has no worktree yet; it needs a night-shift run first`);
    if (this.busy.has(id)) throw new CrewError(`${id} preview is already starting`);
    const table = this.table();
    const mine = Object.entries(table).find(([, v]) => v.ticket === id);
    if (mine && serviceActive({ unit: unitName(project, mine[1].slot), stateDir: this.stateDir })) return null;
    const now = Date.now();
    const free = this.slots(project).filter((s) => {
      const used = table[slotKey(project, s.n)];
      if (!used || used.ticket === id) return true;
      // Another preview is still being set up on this slot, unless the process doing it is gone.
      if (used.state === 'starting') return !ownerAlive(used.owner);
      return new Date(used.expiresAt).getTime() < now || !serviceActive({ unit: unitName(project, s.n), stateDir: this.stateDir });
    });
    if (!free.length) {
      const busy = this.slots(project).map((s) => table[slotKey(project, s.n)]).map((u) => `${u.ticket} until ${fmtTime(u.expiresAt, store.config().timezone)}`);
      throw new CrewError(`All preview slots are busy (${busy.join(', ')}). Stop one first.`);
    }
    const builtFor = st.preview?.builtFor;
    const slot = free.find((s) => s.n === builtFor) || free.find((s) => s.n === pv.buildFor) || free[0];
    return { st, project, pv, dir, table, slot, key: slotKey(project, slot.n), url: this.slotUrl(project, slot), ttl: pv.ttlMinutes || 120, now };
  }

  async up(id, { by = 'user', reset = true } = {}) {
    const store = this.store;
    const plan = this.plan(id);
    if (!plan) return this.extend(id, { by });
    const { st, project, pv, dir, table, slot, key, url, ttl, now } = plan;

    this.busy.add(id);
    this.saveSlot(key, { ticket: id, slot: slot.n, state: 'starting', url, startedAt: nowIso(), expiresAt: new Date(now + ttl * 60e3).toISOString(), owner: process.pid });
    this.mark(id, { state: 'starting', slot: slot.n, url }, `preview starting on slot ${slot.n}`, by);
    const logFile = path.join(store.dir(id), `preview-${slot.n}.log`);
    try {
      const base = ticketEnv(store, project, st, { role: 'runner', cwd: dir });
      const { vars } = ticketVars(store, project, st);
      const pvDb = fill(pv.db || 'pv_{slot}', { slot: slot.n, slug: vars.slug });
      const env = { ...base, PORT: String(slot.port) };
      if (project.db?.url) env.DATABASE_URI = dbUrl(project, vars, pvDb);
      for (const [k, v] of Object.entries(pv.env || {})) env[k] = fill(v, { ...vars, url, host: slot.host, port: slot.port, slot: slot.n });

      // Stop whatever ran on this slot before.
      stopService({ unit: unitName(project, slot.n), stateDir: this.stateDir });
      const prev = table[key];
      if (prev && prev.ticket !== id) this.mark(prev.ticket, { state: 'down' }, `preview stopped to free slot ${slot.n}`, 'runner');

      if (project.db?.url && (reset || !(await db.exists(project, env, pvDb)))) {
        await db.cloneDb(project, env, vars.golden, pvDb, { logFile });
      }
      if (pv.media?.from) {
        for (const m of [].concat(pv.media)) {
          const to = path.join(dir, m.to);
          if (!fs.existsSync(to) || !fs.readdirSync(to).length) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            await sh(`cp -al ${q(m.from)} ${q(to)} 2>/dev/null || cp -a ${q(m.from)} ${q(to)}`, { logFile });
          }
        }
      }
      if (pv.migrate) await must(pv.migrate, { cwd: dir, env, logFile, memoryMax: '1500M', name: 'crew-pv-migrate' });

      const head = (await sh('git rev-parse HEAD', { cwd: dir })).out.trim();
      const needBuild = !fs.existsSync(path.join(dir, '.next')) || st.preview?.builtFor !== slot.n || st.preview?.head !== head;
      if (needBuild && pv.build) {
        this.mark(id, { state: 'building', slot: slot.n, url }, `building for slot ${slot.n} (about 4 minutes)`, 'runner');
        await heavyLock(store.home, `preview build ${id}`, () => must(pv.build, { cwd: dir, env, logFile, timeoutMs: 25 * 60e3, memoryMax: pv.buildMemoryMax || '3G', swapMax: '512M' }));
        store.update(id, (x) => {
          x.preview = { ...(x.preview || {}), builtFor: slot.n, head, builtAt: nowIso() };
          return null;
        });
      }

      startService({
        unit: unitName(project, slot.n),
        cwd: dir,
        command: fill(pv.start, { port: slot.port }),
        env,
        memoryMax: pv.memoryMax || '1G',
        // A backstop only: the sweeper stops previews at their (extendable) time; systemd at 12 h.
        runtimeMaxSec: 12 * 3600,
        stateDir: this.stateDir,
        logFile,
      });
      await waitHealthy(`http://127.0.0.1:${slot.port}${pv.health || '/'}`, pv.startTimeoutSec || 120);
      const expiresAt = new Date(Date.now() + ttl * 60e3).toISOString();
      this.saveSlot(key, { ticket: id, slot: slot.n, state: 'up', url, startedAt: nowIso(), expiresAt, port: slot.port });
      this.mark(id, { state: 'up', slot: slot.n, url, port: slot.port, expiresAt, logins: pv.logins || '' }, `preview up: ${url}`, 'runner');
      await this.notify({ title: `Preview up · ${id}`, text: `${st.title}\n${url}\n${pv.logins || ''}\nStops at ${fmtTime(expiresAt, store.config().timezone)}.`, url, tags: 'eyes' });
      return this.store.state(id).preview;
    } catch (e) {
      stopService({ unit: unitName(project, slot.n), stateDir: this.stateDir });
      this.saveSlot(key, null);
      this.mark(id, { state: 'failed', slot: slot.n, url, error: String(e.message || e).slice(0, 400) }, `preview failed: ${String(e.message || e).split('\n')[0]}`, 'runner');
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }

  down(id, { by = 'user', reason = 'stopped' } = {}) {
    const store = this.store;
    const st = store.state(id);
    const project = store.project(st.project);
    for (const [key, v] of Object.entries(this.table())) {
      if (v.ticket !== id) continue;
      stopService({ unit: unitName(project, v.slot), stateDir: this.stateDir });
      this.saveSlot(key, null);
    }
    this.mark(id, { state: 'down' }, `preview ${reason}`, by);
    return store.state(id).preview;
  }

  extend(id, { by = 'user', minutes } = {}) {
    const store = this.store;
    const st = store.state(id);
    const project = store.project(st.project);
    const add = (minutes || project.preview?.ttlMinutes || 120) * 60e3;
    for (const [key, v] of Object.entries(this.table())) {
      if (v.ticket !== id) continue;
      const expiresAt = new Date(Math.max(Date.now(), new Date(v.expiresAt).getTime()) + add).toISOString();
      this.saveSlot(key, { ...v, expiresAt });
      this.mark(id, { expiresAt }, `preview extended to ${fmtTime(expiresAt, store.config().timezone)}`, by);
    }
    return store.state(id).preview;
  }

  // Called by the server's ticker: stop expired previews, notice ones that died.
  sweep() {
    const store = this.store;
    for (const [key, v] of Object.entries(this.table())) {
      if (v.state !== 'up') continue;
      let project;
      try {
        project = store.project(store.state(v.ticket).project);
      } catch {
        this.saveSlot(key, null);
        continue;
      }
      if (new Date(v.expiresAt) < new Date()) this.down(v.ticket, { by: 'runner', reason: 'stopped (time is up)' });
      else if (!serviceActive({ unit: unitName(project, v.slot), stateDir: this.stateDir })) {
        this.saveSlot(key, null);
        this.mark(v.ticket, { state: 'down' }, 'preview stopped on its own (see preview log)', 'runner');
      }
    }
  }

  mark(id, patch, text, by) {
    try {
      this.store.update(id, (x) => {
        x.preview = { ...(x.preview || {}), ...patch, updated: nowIso() };
        if (patch.state === 'down') {
          delete x.preview.expiresAt;
          delete x.preview.error;
        }
        return { type: 'preview', by, text };
      });
    } catch {}
  }
}

const slotKey = (project, n) => `${project.key}:${n}`;
const unitName = (project, n) => `crew-pv-${project.key}-${n}`;
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
  throw new Error(`the preview did not answer at ${url} within ${timeoutSec}s (${last})`);
}

// `crew preview up|down|extend <ID>` from a terminal.
export async function previewCli({ store, op, id, out, by }) {
  const { notify } = await import('./notify.js');
  const p = new Previews({ store, notify: (m) => notify(store.config(), m) });
  if (op === 'up') {
    const pv = await p.up(id, { by });
    return out(`${id} preview is up: ${pv.url} (until ${fmtTime(pv.expiresAt, store.config().timezone)})`);
  }
  if (op === 'down') {
    p.down(id, { by });
    return out(`${id} preview stopped`);
  }
  if (op === 'extend') {
    const pv = p.extend(id, { by });
    return out(`${id} preview runs until ${fmtTime(pv.expiresAt, store.config().timezone)}`);
  }
  if (op === 'list') return out(JSON.stringify(p.list(), null, 2));
  throw new CrewError('Use: crew preview up|down|extend <ID>');
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
