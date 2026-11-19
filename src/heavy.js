// One heavy thing at a time (a build, the gate's test run, a preview build): the box has ~4 GB to spare.
// A lock directory shared by the server and any CLI process.
import fs from 'node:fs';
import path from 'node:path';
import { readText, sleep } from './util.js';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function heavyHolder(home) {
  const owner = readText(path.join(home, '.heavy', 'owner')).trim();
  if (!owner) return null;
  const [pid, ...what] = owner.split(' ');
  return alive(Number(pid)) ? { pid: Number(pid), what: what.join(' ') } : null;
}

export async function heavyLock(home, what, fn, { waitMs = 3 * 3600e3 } = {}) {
  const dir = path.join(home, '.heavy');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${what}`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!heavyHolder(home)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > waitMs) throw new Error(`Waited too long for the heavy-work slot (${heavyHolder(home)?.what})`);
      await sleep(2000);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
