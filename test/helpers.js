import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../src/util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpHome(extraConfig = {}, project = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
  writeJson(path.join(home, 'crew.json'), { timezone: 'Europe/Warsaw', ...extraConfig });
  writeJson(path.join(home, 'projects', 'demo', 'project.json'), { prefix: 'DM', name: 'Demo', ...project });
  return home;
}

export function crew(home, args, { role = 'user', input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'crew.js'), ...args], {
    env: { ...process.env, CREW_HOME: home, CREW_ROLE: role, ...env },
    input,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

export const CONTRACT = `# Contract

## Goal
Trainers see the number of active students on their dashboard.

## Acceptance
- A1. The dashboard shows "Active students: N" where N counts students with an active subscription.
- A2. A trainer with no students sees "Active students: 0".
`;
