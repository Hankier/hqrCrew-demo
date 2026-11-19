// Small helpers shared by every module: atomic files, JSONL, a cross-process lock, time zones.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw e;
  }
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl(file, { limit } = {}) {
  const text = readText(file);
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line from a crash is skipped, not fatal.
    }
  }
  return limit ? out.slice(-limit) : out;
}

export const nowIso = () => new Date().toISOString();

export function slugify(text, max = 40) {
  const s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '') || 'ticket';
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A lock that works across processes (the CLI, the server, agents calling the CLI).
// mkdir is atomic; the owner pid lets a crashed holder be detected.
export function withLock(lockDir, fn, { timeoutMs = 15000, staleMs = 120000 } = {}) {
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid} ${Date.now()}`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const [pid, at] = readText(path.join(lockDir, 'owner'), '0 0').split(' ').map(Number);
      const stale = (pid && !pidAlive(pid)) || (at && Date.now() - at > staleMs);
      if (stale) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for lock ${lockDir}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

// Wall-clock parts of a date in a time zone, e.g. Europe/Warsaw.
export function zoned(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    weekday: get('weekday'),
  };
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

// Is `date` inside a daily window such as 23:00–07:00 (may wrap midnight)?
export function inWindow(date, start, end, tz) {
  const z = zoned(date, tz);
  const t = z.hh * 60 + z.mm;
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

// The calendar day a night belongs to: the night of the 21st runs 21st 23:00 → 22nd 07:00.
export function nightKey(date, start, tz) {
  const z = zoned(date, tz);
  const t = z.hh * 60 + z.mm;
  if (t >= toMin(start)) return z.date;
  return zoned(new Date(date.getTime() - 24 * 3600e3), tz).date;
}

export function fmtTime(iso, tz) {
  if (!iso) return '';
  const z = zoned(new Date(iso), tz);
  return `${String(z.hh).padStart(2, '0')}:${String(z.mm).padStart(2, '0')}`;
}

export function fmtAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.round(s / 86400)}d`;
}

export function uuid() {
  return crypto.randomUUID();
}

export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Fill {placeholders} in a template string from a map; unknown keys stay as they are.
export function fill(template, vars) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
