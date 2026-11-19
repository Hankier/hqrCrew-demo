// Where crew keeps its state, and the settings that shape the night shift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './util.js';

export const DEFAULTS = {
  timezone: 'Europe/Warsaw',
  listen: { host: '127.0.0.1', port: 20100 },
  // Public address of the board, used in notifications (e.g. https://crew.example.com).
  publicUrl: '',
  // When the queue runs on its own. "Run now" on a ticket ignores the window.
  nightShift: { start: '23:00', end: '07:00', maxJobsPerNight: 6, maxJobMinutes: 120 },
  // mode: night (window only), always, paused.
  runner: { mode: 'night', concurrency: 1, tickSeconds: 20 },
  // Round limits; past them a ticket is Blocked and asks you.
  // recoveries: crashes/restarts during one job before it is blocked; parks: usage-limit parks per job.
  limits: { questionRounds: 3, gateRounds: 2, verifyRounds: 2, minFreeDiskGb: 8, recoveries: 2, parks: 3, leadWaitMinutes: 20 },
  models: { lead: 'opus', designer: 'opus', coder: 'sonnet', verifier: 'opus' },
  effort: { lead: 'high', designer: 'high', coder: 'high', verifier: 'medium' },
  permissionMode: { lead: 'dontAsk', designer: 'bypassPermissions', coder: 'bypassPermissions', verifier: 'bypassPermissions' },
  // Design rounds (the Discuss stage). publish: a command that shares the round's page, e.g. "pub {file}";
  // its first https:// link is shown on the board. null keeps pages on the board only.
  discuss: { maxMinutes: 60, publish: null },
  // Headless browser for page checks and lab screenshots: the playwright-core folder and a Chromium binary.
  // null = look in the usual places (see src/pagetools.js).
  tools: { playwright: null, chromium: null },
  // Which agent CLI runs each role: "claude" (Claude Code) or "codex" (OpenAI Codex CLI).
  // One string sets every role ("engine": "codex"); an object sets roles one by one.
  engine: { lead: 'claude', designer: 'claude', coder: 'claude', verifier: 'claude' },
  claude: { bin: 'claude', env: {} },
  // Codex: models per role (null = the default in ~/.codex/config.toml); effort comes from `effort`.
  // sandbox per role overrides the mapping from permissionMode (bypassPermissions → danger-full-access,
  // dontAsk → workspace-write). network: internet inside workspace-write (the lead's; off by default).
  // config: extra `-c key=value` settings for every Codex run.
  codex: { bin: 'codex', env: {}, models: { lead: null, designer: null, coder: null, verifier: null }, sandbox: {}, network: false, config: {} },
  // cgroup caps (systemd-run --user) so a runaway build dies before a database does.
  // Every agent, check and preview runs in its own capped cgroup, never inside the crew service itself.
  memory: { jobMax: '3500M', checkMax: '2500M', leadMax: '1500M', previewMax: '1G', swapMax: '1G' },
  // Which ticket types the lead may queue without your approval.
  autoQueue: { bug: true, chore: true, feature: false, idea: false },
  digest: { at: '07:30' },
  // The lead's conversation restarts (after saving its notes) at this size or this many turns.
  lead: { rotateAtTokens: 120000, rotateAfterTurns: 60, web: false },
  notify: { ntfy: null, discordWebhook: null },
  // No fresh backup of the box's databases, no night shift (written by deploy/backup/backup.sh).
  safety: { backupStatusFile: null, backupMaxAgeHours: 36, forbiddenPorts: [], privateDirs: [] },
  // Login for the board when it has a public address: Cloudflare Access (team + audience tag) or a token.
  auth: { cfAccess: null, emails: [], token: null },
};

export const PROJECT_DEFAULTS = {
  prefix: 'T',
  name: '',
  repo: { url: '', base: 'main', remote: 'origin', push: false, compareUrl: '' },
  // Commands run once per worktree before the coder starts.
  setup: [],
  // Gate checks. stage "fast" runs in the coder's Stop hook; all stages run after the coder exits.
  gate: [],
  env: { file: 'agent.env' },
  preview: null,
  // The lab: today's app (base branch) with the demo data, for design rounds and for you to click around.
  // Missing keys come from preview (build, start, migrate, env, health). See docs/DESIGN.md.
  lab: null,
};

export function crewHome() {
  return path.resolve(process.env.CREW_HOME || path.join(os.homedir(), 'crew'));
}

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(home = crewHome()) {
  const raw = readJson(path.join(home, 'crew.json'), {});
  // "engine": "codex" is short for every role on Codex.
  if (typeof raw.engine === 'string') raw.engine = Object.fromEntries(Object.keys(DEFAULTS.engine).map((r) => [r, raw.engine]));
  const cfg = merge(DEFAULTS, raw);
  cfg.home = home;
  return cfg;
}

export function projectDir(home, key) {
  return path.join(home, 'projects', key);
}

export function loadProject(home, key) {
  const dir = projectDir(home, key);
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) throw new Error(`Unknown project "${key}" (no ${file})`);
  const p = merge(PROJECT_DEFAULTS, readJson(file));
  p.key = key;
  p.dir = dir;
  return p;
}

export function listProjects(home) {
  const dir = path.join(home, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((k) => fs.existsSync(path.join(dir, k, 'project.json')))
    .map((k) => loadProject(home, k));
}

export function projectByPrefix(home, prefix) {
  return listProjects(home).find((p) => p.prefix === prefix);
}
