// `crew doctor`: is this box ready for the night shift? Read-only checks, one line each.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canScope, freeDiskGb } from './sysrun.js';
import { ticketEnv, ticketVars, parseEnvFile } from './env.js';
import * as db from './db.js';
import { fill, readText } from './util.js';
import { findTools } from './pagetools.js';
import { labConfig } from './lab.js';
import { ROLES, engineFor, engineName } from './agent.js';

const ok = (m) => `  ✓ ${m}`;
const warn = (m) => `  ! ${m}`;
const bad = (m) => `  ✗ ${m}`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

// Can this user open a TCP connection to 127.0.0.1:port? (The guard rule should say no.)
function reachable(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function doctor({ store, out }) {
  const cfg = store.config();
  const lines = [`crew doctor · CREW_HOME=${store.home}`];
  let problems = 0;
  const fail = (m) => {
    problems++;
    lines.push(bad(m));
  };

  lines.push('Basics');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 22 ? lines.push(ok(`node ${process.versions.node}`)) : fail(`node ${process.versions.node}; crew needs 22+`);
  fs.existsSync(path.join(store.home, 'crew.json')) ? lines.push(ok('crew.json')) : fail('no crew.json; run crew init');
  fs.existsSync(path.join(store.home, 'orchestrator', 'CLAUDE.md')) ? lines.push(ok("lead's CLAUDE.md")) : fail('no orchestrator/CLAUDE.md; run crew init');
  // A plain psql is needed only where a project doesn't run it some other way (e.g. docker exec on a dev machine).
  const needsPsql = store.projects().some((p) => p.db && /^psql\b/.test(p.db.psql || 'psql'));
  for (const [cmd, args] of [['git', ['--version']], ['pnpm', ['--version']], ...(needsPsql ? [['psql', ['--version']]] : [])]) {
    const r = run(cmd, args);
    r.code === 0 ? lines.push(ok(`${cmd} ${r.out.split('\n')[0].replace(/^git version |^psql \(PostgreSQL\) /, '')}`)) : lines.push(warn(`${cmd} not found`));
  }
  const gb = freeDiskGb(store.home);
  gb >= cfg.limits.minFreeDiskGb ? lines.push(ok(`${gb.toFixed(1)} GB disk free`)) : fail(`${gb.toFixed(1)} GB disk free; the runner waits below ${cfg.limits.minFreeDiskGb} GB`);
  canScope() ? lines.push(ok('memory caps via systemd-run --user')) : lines.push(warn('no systemd user scopes: jobs run without memory caps'));
  const linger = run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger']);
  if (linger.code === 0) /yes/.test(linger.out) ? lines.push(ok('linger on (services survive logout)')) : lines.push(warn('linger off: run `loginctl enable-linger` so crew keeps running after you log out'));

  lines.push('Safety');
  const safety = cfg.safety || {};
  for (const port of safety.forbiddenPorts || []) {
    (await reachable(port)) ? fail(`this user can reach 127.0.0.1:${port} (a live database or app); load deploy/root/crew-guard.nft`) : lines.push(ok(`127.0.0.1:${port} is out of reach`));
  }
  for (const dir of safety.privateDirs || []) {
    let readable = false;
    try {
      fs.readdirSync(dir);
      readable = true;
    } catch {}
    readable ? fail(`this user can read ${dir}; chmod 750 it`) : lines.push(ok(`${dir} is not readable`));
  }
  if (safety.backupStatusFile) {
    let okAt = null;
    try {
      okAt = JSON.parse(fs.readFileSync(safety.backupStatusFile, 'utf8')).okAt;
    } catch {}
    const h = okAt ? (Date.now() - new Date(okAt)) / 3600e3 : Infinity;
    h <= safety.backupMaxAgeHours ? lines.push(ok(`last good backup ${h.toFixed(1)} h ago`)) : fail(`no good backup in ${safety.backupMaxAgeHours} h (${safety.backupStatusFile}); the night shift won't start`);
  }
  const localOnly = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(cfg.publicUrl || '');
  if (cfg.publicUrl && !localOnly && !cfg.auth?.token && !(cfg.auth?.cfAccess?.team && cfg.auth?.cfAccess?.aud)) lines.push(warn('publicUrl is set but no login: the board answers 503 through the tunnel until auth is set'));

  // Only the CLIs some role uses (crew.json "engine").
  let roles;
  try {
    roles = Object.fromEntries(ROLES.map((r) => [r, engineFor(cfg, r)]));
  } catch (e) {
    fail(e.message);
    roles = {};
  }
  const uses = (engine) => Object.entries(roles).filter(([, e]) => e === engine).map(([r]) => r);
  if (uses('claude').length) {
    lines.push(`Claude Code (${uses('claude').join(', ')})`);
    const v = run(cfg.claude.bin, ['--version']);
    v.code === 0 ? lines.push(ok(v.out.split('\n')[0])) : fail(`${cfg.claude.bin} not found`);
    if (process.env.ANTHROPIC_API_KEY) lines.push(warn('ANTHROPIC_API_KEY is set in this shell; crew removes it for its runs so they use the subscription'));
    const auth = run(cfg.claude.bin, ['auth', 'status']);
    try {
      const a = JSON.parse(auth.out);
      a.loggedIn ? lines.push(ok(`logged in (${a.authMethod}, ${a.subscriptionType || 'plan unknown'})`)) : fail('not logged in: run `claude` once and /login, or `claude setup-token`');
    } catch {
      lines.push(warn(`could not read \`claude auth status\`: ${auth.out.split('\n')[0].slice(0, 120)}`));
    }
  }
  if (uses('codex').length) {
    const bin = cfg.codex?.bin || 'codex';
    lines.push(`Codex (${uses('codex').join(', ')})`);
    const v = run(bin, ['--version']);
    v.code === 0 ? lines.push(ok(v.out.split('\n')[0])) : fail(`${bin} not found`);
    if (process.env.OPENAI_API_KEY) lines.push(warn('OPENAI_API_KEY is set in this shell; crew removes it for its runs so they use your Codex login'));
    const auth = run(bin, ['login', 'status']);
    auth.code === 0 ? lines.push(ok(auth.out.split('\n')[0] || 'logged in')) : fail('not logged in: run `codex login` (or `codex login --device-auth` on a server)');
    const hooks = run(bin, ['features', 'list']);
    if (hooks.code === 0 && !/^hooks\s+\S+\s+true/m.test(hooks.out)) fail('Codex hooks are off: the coder\'s Stop-hook gate needs `codex features enable hooks`');
    if (uses('codex').includes('lead')) lines.push(warn(`the lead on Codex has no per-command allowlist: it runs in Codex's workspace-write sandbox (no network) with write access to ${store.home}`));
  }

  for (const project of store.projects()) {
    lines.push(`Project ${project.key} (${project.prefix})`);
    const envFile = path.join(project.dir, project.env?.file || 'agent.env');
    if (!fs.existsSync(envFile)) fail(`${envFile} missing`);
    else {
      const mode = fs.statSync(envFile).mode & 0o777;
      mode & 0o077 ? lines.push(warn(`${path.basename(envFile)} is readable by others (chmod 600)`)) : lines.push(ok(`${path.basename(envFile)} (600)`));
    }
    fs.existsSync(path.join(project.dir, 'vision.md')) ? lines.push(ok('vision.md')) : lines.push(warn('no vision.md: the lead has no product intent to work from'));
    if (project.repo?.url) {
      const r = run('git', ['ls-remote', '--heads', project.repo.url, project.repo.base], { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } });
      r.code === 0 && r.out ? lines.push(ok(`repo reachable, ${project.repo.base} at ${r.out.slice(0, 7)}`)) : fail(`cannot read ${project.repo.url}: ${r.out.split('\n')[0].slice(0, 160)}`);
    } else fail('repo.url is empty');
    lines.push(ok(`gate: ${(project.gate || []).map((g) => g.name).join(', ') || 'no checks!'}`));
    if (project.db?.url) {
      const fake = { id: `${project.prefix}-000`, title: 'doctor', project: project.key, job: null, questions: [], decisions: [] };
      const env = ticketEnv(store, project, fake, { role: 'runner' });
      const { vars } = ticketVars(store, project, fake);
      try {
        await db.sql(project, env, 'SELECT 1');
        lines.push(ok(`crew Postgres reachable as ${env.PGUSER || '?'}`));
        (await db.exists(project, env, vars.golden)) ? lines.push(ok(`golden database ${vars.golden}`)) : lines.push(warn(`no ${vars.golden} yet; the first job builds it from db.goldenBuild`));
      } catch (e) {
        fail(`crew Postgres: ${String(e.message).split('\n')[0].slice(0, 200)}`);
      }
    }
    for (const s of project.preview?.slots || []) {
      const url = fill(project.preview.url || 'https://{host}', { host: s.host, port: s.port });
      (await portFree(s.port)) ? lines.push(ok(`preview slot ${s.n}: port ${s.port} free (${url})`)) : lines.push(warn(`preview slot ${s.n}: port ${s.port} in use (a preview may be running)`));
    }
  }

  // Design rounds: the headless browser for page checks and lab screenshots, and each project's lab.
  lines.push('Discuss first');
  const tools = findTools(cfg);
  tools.playwright && tools.chromium ? lines.push(ok(`headless browser: ${path.basename(path.dirname(path.dirname(tools.chromium)))}`)) : lines.push(warn('no headless browser (tools.playwright, tools.chromium): round pages are not checked and lab screenshots fail'));
  lines.push(cfg.discuss?.publish ? ok(`round pages are shared with: ${cfg.discuss.publish.split(' ')[0]}`) : ok('round pages stay on the board (discuss.publish not set)'));
  for (const project of store.projects()) {
    const lc = labConfig(project);
    if (!lc) {
      lines.push(ok(`${project.key}: no lab (designers read the code instead)`));
      continue;
    }
    const secrets = parseEnvFile(readText(path.join(project.dir, project.env?.file || 'agent.env')));
    const roles = Object.keys(lc.logins);
    if (roles.length && !(lc.passwordEnv && secrets[lc.passwordEnv])) lines.push(warn(`${project.key} lab: ${lc.passwordEnv || 'passwordEnv'} is not in agent.env, so screenshots can't log in as ${roles.join(', ')}`));
    else lines.push(ok(`${project.key} lab: ${lc.url} · logins: ${roles.join(', ') || 'guest only'}`));
  }

  lines.push('Notifications');
  if (cfg.notify?.ntfy?.url || cfg.notify?.discordWebhook) lines.push(ok([cfg.notify.ntfy?.url && 'ntfy', cfg.notify.discordWebhook && 'Discord'].filter(Boolean).join(' + ')));
  else lines.push(warn('none set: Ready and Blocked messages will only show on the board'));

  lines.push(problems ? `${problems} problem(s) to fix.` : 'Ready for the night shift.');
  out(lines.join('\n'));
  if (problems) process.exitCode = 1;
}
