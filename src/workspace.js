// Git plumbing: one mirror clone per project (the lead reads code there) and one worktree per ticket.
import fs from 'node:fs';
import path from 'node:path';
import { sh } from './sysrun.js';
import { shQuote, slugify } from './util.js';

// Unattended git must fail fast instead of waiting for a password or host-key prompt.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };

async function git(cwd, args, opts = {}) {
  const r = await sh(`git ${args}`, { cwd, timeoutMs: 10 * 60e3, ...opts, env: { ...GIT_ENV, ...opts.env } });
  if (r.code !== 0) throw new Error(`git ${args.split(' ')[0]} failed: ${r.out.trim().slice(-400)}`);
  return r.out.trim();
}

export function mirrorDir(store, project) {
  return path.join(store.home, 'mirrors', project.key);
}

export function worktreeDir(store, id) {
  return path.join(store.home, 'worktrees', id);
}

export function branchName(state) {
  return state.branch || `crew/${state.id.toLowerCase()}-${slugify(state.title, 32)}`;
}

export async function ensureMirror(store, project, { logFile } = {}) {
  const dir = mirrorDir(store, project);
  const { url, remote = 'origin', base = 'main' } = project.repo;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (!url) throw new Error(`Project ${project.key} has no repo.url`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), `clone --origin ${remote} ${shQuote(url)} ${shQuote(dir)}`, { logFile });
  }
  await git(dir, `fetch --prune ${remote}`, { logFile });
  await git(dir, `checkout -q --detach ${remote}/${base}`, { logFile });
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!ex.split('\n').includes('.crew/')) fs.appendFileSync(exclude, `${ex.endsWith('\n') || !ex ? '' : '\n'}.crew/\n`);
  return dir;
}

export async function ensureWorktree(store, project, state, { logFile } = {}) {
  const mirror = await ensureMirror(store, project, { logFile });
  const dir = worktreeDir(store, state.id);
  const branch = branchName(state);
  const { remote = 'origin', base = 'main' } = project.repo;
  if (fs.existsSync(path.join(dir, '.git'))) {
    const b = state.job?.base || (await git(mirror, `rev-parse ${remote}/${base}`));
    return { dir, branch, base: b, created: false, mirror };
  }
  const baseSha = await git(mirror, `rev-parse ${remote}/${base}`);
  const hasLocal = (await sh(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: mirror })).code === 0;
  const hasRemote = (await sh(`git show-ref --verify --quiet refs/remotes/${remote}/${branch}`, { cwd: mirror })).code === 0;
  await git(mirror, 'worktree prune', { logFile });
  if (hasLocal) await git(mirror, `worktree add ${shQuote(dir)} ${branch}`, { logFile });
  else if (hasRemote) await git(mirror, `worktree add -b ${branch} ${shQuote(dir)} ${remote}/${branch}`, { logFile });
  else await git(mirror, `worktree add -b ${branch} ${shQuote(dir)} ${baseSha}`, { logFile });
  return { dir, branch, base: baseSha, created: true, mirror };
}

export async function removeWorktree(store, project, id, { logFile } = {}) {
  const mirror = mirrorDir(store, project);
  const dir = worktreeDir(store, id);
  if (fs.existsSync(dir)) await sh(`git worktree remove --force ${shQuote(dir)}`, { cwd: mirror, logFile });
  await sh('git worktree prune', { cwd: mirror, logFile });
}

export async function diffStat(dir, base) {
  const r = await sh(`git diff --shortstat ${base}...HEAD`, { cwd: dir });
  return r.out.trim();
}

export async function headSha(dir) {
  const r = await sh('git rev-parse HEAD', { cwd: dir });
  return r.out.trim();
}

// Did an agent leave edits in tracked files? (The verifier must not change code.)
export async function dirtyFiles(dir) {
  const r = await sh('git status --porcelain --untracked-files=all', { cwd: dir });
  return r.out
    .split('\n')
    .filter((l) => l.trim() && !l.slice(3).startsWith('.crew/'))
    .map((l) => l.slice(3));
}

export async function discardChanges(dir) {
  await sh('git checkout -- . && git clean -fdq -e .crew', { cwd: dir });
}
