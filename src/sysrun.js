// Running things on a small shared box: memory caps through systemd user scopes when available,
// long-lived preview services, and a disk check before anything big starts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readText, writeFileAtomic } from './util.js';

let scopeOk;
let choomOk;

// The exact properties capped() uses. systemd rejects some service-only settings for scopes
// (OOMScoreAdjust, for one), so the probe must use the same list or it says yes to a broken setup.
const SCOPE_PROBE = ['-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=32M'];

// Can we put a process in its own cgroup with a memory cap, without root?
export function canScope() {
  if (scopeOk !== undefined) return scopeOk;
  if (process.env.CREW_NO_SYSTEMD) return (scopeOk = false);
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', ...SCOPE_PROBE, '--', 'true'], { encoding: 'utf8', timeout: 10000 });
  scopeOk = r.status === 0;
  return scopeOk;
}

function hasChoom() {
  if (choomOk === undefined) choomOk = spawnSync('choom', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
  return choomOk;
}

// Wrap a command so the kernel kills it (and its children) at memoryMax, before it can starve a database.
// slice: a parent cgroup such as crew.slice that caps everything crew runs together.
// choom raises the kill priority (scopes can't take OOMScoreAdjust; an unprivileged user may only raise it).
export function capped(cmd, args, { memoryMax, swapMax, name, slice = process.env.CREW_SLICE } = {}) {
  if (!memoryMax || !canScope()) return { cmd, args, unit: null };
  // Without MemorySwapMax the overflow just moves to swap and the box crawls instead of the job dying.
  const props = ['-p', `MemoryMax=${memoryMax}`, '-p', `MemorySwapMax=${swapMax || '512M'}`];
  const unit = `${name || 'crew-job'}-${process.pid}-${Date.now()}`;
  const parent = slice ? [`--slice=${slice}`] : [];
  const inner = hasChoom() ? ['choom', '-n', '500', '--', cmd, ...args] : [cmd, ...args];
  return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', '--unit', unit, ...parent, ...props, '--', ...inner], unit };
}

// Stop a capped job's whole cgroup (children that left the process group included).
export function stopScope(unit) {
  if (unit && canScope()) spawnSync('systemctl', ['--user', 'stop', `${unit}.scope`], { encoding: 'utf8', timeout: 20000 });
}

// After a crash: stop scopes left behind by an earlier crew process (coders, verifiers, gate runs).
export function stopOrphanScopes(prefixes = ['crew-coder', 'crew-verifier', 'crew-gate', 'crew-setup', 'crew-lead']) {
  if (!canScope()) return [];
  const r = spawnSync('systemctl', ['--user', 'list-units', '--type=scope', '--no-legend', '--plain'], { encoding: 'utf8', timeout: 10000 });
  // Unit names are <prefix>-<owner pid>-<ms>.scope: only scopes whose crew process is gone are orphans.
  const ownerAlive = (u) => {
    const pid = Number((u.match(/-(\d+)-\d+\.scope$/) || [])[1]);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  const units = (r.stdout || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && prefixes.some((p) => u.startsWith(`${p}-`)) && !ownerAlive(u));
  for (const u of units) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8', timeout: 20000 });
  return units;
}

export function freeDiskGb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return Infinity;
  }
}

// Run a shell command to completion, capturing output to a log file. Returns {code, out, timedOut}.
export function sh(command, { cwd, env, timeoutMs = 30 * 60e3, logFile, memoryMax, swapMax, name, slice, onLine } = {}) {
  return new Promise((resolve) => {
    const { cmd, args, unit } = capped('bash', ['-lc', command], { memoryMax, swapMax, name, slice });
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    let settled = false;
    let grace = null;
    const log = openLog(logFile);
    if (log) log.write(`$ ${command}\n`);
    const onData = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 400000) out = out.slice(-300000);
      log?.write(s);
      if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (code, signal, note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      log?.end(`\n[exit ${code ?? signal}${timedOut ? ', timed out' : ''}${note}]\n`);
      resolve({ code: code ?? (signal ? 128 : 1), signal, out, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      stopScope(unit);
    }, timeoutMs);
    child.on('close', (code, signal) => done(code, signal));
    // A background process left holding the output pipe must not hang the night shift.
    child.on('exit', (code, signal) => {
      grace = setTimeout(() => done(code, signal, ', output still held open by a child'), 15000);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log?.end(`\n[spawn error ${e.message}]\n`);
      resolve({ code: 127, out: String(e.message), timedOut: false });
    });
  });
}

// An append-only log that never crashes the caller (missing folder, full disk).
export function openLog(file) {
  if (!file) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  const s = fs.createWriteStream(file, { flags: 'a' });
  s.on('error', () => {});
  return s;
}

export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  if (signal === 'SIGTERM') setTimeout(() => killTree(pid, 'SIGKILL'), 10000).unref();
}

// ---- long-lived services (previews) --------------------------------------------------------

function pidFile(stateDir, unit) {
  return path.join(stateDir, `${unit}.pid`);
}

export function startService({ unit, cwd, command, env = {}, memoryMax, runtimeMaxSec, stateDir, logFile, slice = process.env.CREW_PREVIEW_SLICE }) {
  fs.mkdirSync(stateDir, { recursive: true });
  if (canScope()) {
    const props = ['-p', `WorkingDirectory=${cwd}`, '-p', 'OOMScoreAdjust=600'];
    if (slice) props.push(`--slice=${slice}`);
    if (memoryMax) props.push('-p', `MemoryMax=${memoryMax}`);
    if (runtimeMaxSec) props.push('-p', `RuntimeMaxSec=${runtimeMaxSec}`);
    if (logFile) props.push('-p', `StandardOutput=append:${logFile}`, '-p', `StandardError=append:${logFile}`);
    const setenv = Object.entries(env).flatMap(([k, v]) => [`--setenv=${k}=${v}`]);
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8' });
    const r = spawnSync('systemd-run', ['--user', '--unit', unit, '--collect', '--quiet', ...props, ...setenv, '--', 'bash', '-lc', command], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`systemd-run failed: ${r.stderr || r.stdout}`);
    return { unit, kind: 'systemd' };
  }
  const fd = logFile ? fs.openSync(logFile, 'a') : 'ignore';
  const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileAtomic(pidFile(stateDir, unit), `${child.pid}\n`);
  return { unit, kind: 'process', pid: child.pid };
}

export function stopService({ unit, stateDir }) {
  if (canScope()) {
    spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8' });
    return;
  }
  const pid = Number(readText(pidFile(stateDir, unit)).trim());
  if (pid) killTree(pid);
  fs.rmSync(pidFile(stateDir, unit), { force: true });
}

export function serviceActive({ unit, stateDir }) {
  if (canScope()) {
    const r = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' });
    return r.stdout.trim() === 'active';
  }
  const pid = Number(readText(pidFile(stateDir, unit)).trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
