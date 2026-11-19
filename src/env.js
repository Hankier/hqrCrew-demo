// The environment a job runs with: the project's sandbox secrets (agent.env), per-ticket databases
// and preview address, and crew itself on PATH. Never the real .env of the project.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, fill } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvFile(text) {
  const env = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

export function ticketSlug(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

// Values every template in project.json may use: {id}, {slug}, {host}, {db}, {worktree}, and agent.env keys.
export function ticketVars(store, project, state, extra = {}) {
  const cfg = store.config();
  const secrets = parseEnvFile(readText(path.join(project.dir, project.env?.file || 'agent.env')));
  const slug = ticketSlug(state.id);
  const worktree = path.join(store.home, 'worktrees', state.id);
  const vars = { ...secrets, id: state.id, idLower: state.id.toLowerCase(), slug, worktree, home: store.home, ...extra };
  // The gate builds for one preview slot, so {previewUrl} is that slot's public address.
  const slots = project.preview?.slots || [];
  const slot = slots.find((s) => s.n === (project.preview.buildFor || 1)) || slots[0];
  if (slot) vars.previewUrl = fill(project.preview.url || 'https://{host}', { host: slot.host, port: slot.port });
  if (project.db) {
    vars.worktreeDb = fill(project.db.worktreeDb || 'wt_{slug}', vars);
    vars.testDb = fill(project.db.testDb || 'test_{slug}', vars);
    vars.golden = project.db.golden || `${project.key}_golden`;
  }
  vars.timezone = cfg.timezone;
  return { vars, secrets };
}

export function dbUrl(project, vars, db) {
  return fill(project.db.url, { ...vars, db });
}

export function ticketEnv(store, project, state, { role = 'worker', cwd } = {}) {
  const { vars, secrets } = ticketVars(store, project, state);
  const env = { ...secrets };
  if (project.db?.url) {
    env.DATABASE_URI = dbUrl(project, vars, vars.worktreeDb);
    env.TEST_DATABASE_URI = dbUrl(project, vars, vars.testDb);
  }
  for (const [k, v] of Object.entries(project.env?.vars || {})) env[k] = fill(v, { ...vars, ...env });
  const shims = (project.shims || []).length ? [path.join(ROOT, 'shims')] : [];
  env.PATH = [...shims, path.join(ROOT, 'bin'), process.env.PATH].join(':');
  env.CREW_HOME = store.home;
  env.CREW_TICKET = state.id;
  env.CREW_ROLE = role;
  env.CREW_WORKTREE = cwd || vars.worktree;
  if (state.job?.base) env.CREW_BASE = state.job.base;
  return env;
}
