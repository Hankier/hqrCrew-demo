// The gate decides when a coder may stop. It is a script, not a prompt: the model can't argue past it.
// Stage "fast" runs inside the coder's Stop hook; stage "all" (with heavy checks such as the build)
// runs after the coder exits.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crewHome } from './config.js';
import { Store } from './store.js';
import { sh } from './sysrun.js';
import { readJson, writeJson, readText } from './util.js';
import { ticketEnv } from './env.js';

// Test files in the common layouts of JS/TS, Python and Go. project.testFiles (globs) replaces this.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
// Ways to switch a test off without deleting it. project.skipPatterns (regex strings) adds to these.
const SKIP_PATTERNS = [
  /\b(it|test|describe)\.(only|skip|todo)\s*\(/, // vitest, jest, mocha
  /\bx(it|describe|test)\s*\(/,
  /@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/, // python
  /\bt\.Skip(Now|f)?\s*\(/, // go
];
const MAX_HOOK_BLOCKS = 3;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Checks that need no commands: plan, check steps, a commit, a clean tree, tests not removed or skipped.
export function structuralChecks({ cwd, base, protectedPaths = [], allowedPaths = [], testFiles = null, skipPatterns = [] }) {
  const isTest = testFiles?.length ? (f) => testFiles.some((g) => matchPath(f, g)) : (f) => TEST_FILE.test(f);
  const skips = [...SKIP_PATTERNS, ...skipPatterns.map((r) => new RegExp(r))];
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail, kind: 'structure' });
  const crewDir = path.join(cwd, '.crew');

  const plan = readText(path.join(crewDir, 'plan.md')).trim();
  add('plan.md written before coding', plan.length >= 80, plan ? '' : 'Write .crew/plan.md: approach, files, tests, risks.');
  const check = readText(path.join(crewDir, 'check.md')).trim();
  add('check.md with steps for the user', check.length >= 80, check ? '' : 'Write .crew/check.md: how the user can try this in the preview, which demo account, what to click, what to expect.');

  const ahead = Number(git(cwd, ['rev-list', '--count', `${base}..HEAD`]).out || 0);
  add('work committed on the branch', ahead > 0, ahead ? `${ahead} commit(s)` : 'Commit your work on this branch (git add the files you changed, then git commit).');

  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all']).out
    .split('\n')
    .filter((l) => l.trim() && !l.slice(3).startsWith('.crew/'));
  add('nothing left uncommitted', dirty.length === 0, dirty.length ? `Uncommitted: ${dirty.slice(0, 8).map((l) => l.slice(3)).join(', ')}` : '');

  // -M reports renames as "R<score>\told\tnew": a test renamed into a non-test counts as deleted.
  const diff = git(cwd, ['diff', '--name-status', '-M', `${base}...HEAD`]).out.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const deletedTests = diff.filter(([st, a, b]) => (st === 'D' && isTest(a)) || (st.startsWith('R') && isTest(a) && !isTest(b))).map(([, a]) => a);
  add('no test files deleted', deletedTests.length === 0, deletedTests.join(', '));

  // Added lines in test files, in any language, that switch tests off (.only, .skip, pytest.mark.skip, t.Skip…).
  const switchedOff = [];
  let file = '';
  for (const l of git(cwd, ['diff', '-U0', `${base}...HEAD`]).out.split('\n')) {
    if (l.startsWith('+++ ')) file = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('+') && isTest(file) && skips.some((re) => re.test(l))) switchedOff.push(`${file}: ${l.slice(1).trim()}`);
  }
  add('no test switched off (.only, skip marks)', switchedOff.length === 0, switchedOff.slice(0, 5).join(' | '));

  const touched = diff.flatMap(([, a, b]) => (b ? [a, b] : [a]));
  const hitProtected = touched.filter((f) => protectedPaths.some((p) => matchPath(f, p)) && !allowedPaths.some((p) => matchPath(f, p)));
  add('test and tool config untouched', hitProtected.length === 0, hitProtected.length ? `Changed protected files: ${hitProtected.join(', ')}. Revert them, or ask the lead if the contract must allow it.` : '');
  return checks;
}

// "tests/setup/**", "vitest.config.mts", "src/migrations/*"
export function matchPath(file, pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$',
  );
  return re.test(file);
}

// Paths the contract explicitly allows ("## Allowed test changes" section, one path per bullet).
export function allowedFromContract(contract) {
  const m = String(contract || '').match(/^##\s+Allowed (?:test )?changes[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/`/g, '').trim())
    .filter((l) => l && !/^none$/i.test(l));
}

export async function runGate({ cwd, project, stage = 'all', env = {}, base, contract = '', logFile, timeoutMs, checkMax = '2500M' }) {
  const t0 = Date.now();
  const checks = structuralChecks({ cwd, base, protectedPaths: project.gateProtected || [], allowedPaths: allowedFromContract(contract), testFiles: project.testFiles, skipPatterns: project.skipPatterns || [] });
  const cmds = (project.gate || []).filter((g) => stage === 'all' || (g.stage || 'fast') === 'fast');
  for (const g of cmds) {
    const started = Date.now();
    const r = await sh(g.run, {
      cwd,
      env,
      logFile,
      timeoutMs: (g.timeoutMin || timeoutMs || 20) * 60e3,
      // Every check gets its own capped cgroup; uncapped, it would count against the crew service.
      memoryMax: g.memoryMax || (g.heavy ? '3G' : checkMax),
      slice: g.heavy ? process.env.CREW_HEAVY_SLICE : undefined,
      name: 'crew-gate',
    });
    checks.push({
      name: g.name,
      ok: r.code === 0,
      kind: 'command',
      heavy: !!g.heavy,
      code: r.code,
      ms: Date.now() - started,
      // Killed (out of memory at its cap, stopped) or timed out: the box failed, not the code.
      infra: r.code !== 0 && isInfraFailure(r),
      detail: r.code === 0 ? '' : tail(r.out, 40) + (r.timedOut ? '\n[timed out]' : '') + (r.signal ? `\n[killed by ${r.signal}]` : ''),
    });
  }
  const result = { ok: checks.every((c) => c.ok), stage, ms: Date.now() - t0, at: new Date().toISOString(), checks };
  writeJson(path.join(cwd, '.crew', `gate-${stage}.json`), result);
  return result;
}

export function isInfraFailure(r) {
  return !!r.signal || r.timedOut || [137, 143].includes(r.code) || /JavaScript heap out of memory|ENOMEM|Killed\s*$/m.test(String(r.out || '').slice(-4000));
}

// The failed checks, split into the coder's problems and the box's problems.
export function failures(result) {
  const failed = result.checks.filter((c) => !c.ok);
  return { failed, code: failed.filter((c) => !c.infra), infra: failed.filter((c) => c.infra) };
}

export function gateSummary(result, { max = 6 } = {}) {
  const failed = result.checks.filter((c) => !c.ok);
  if (!failed.length) return `Gate passed (${result.checks.length} checks).`;
  return failed
    .slice(0, max)
    .map((c) => `✗ ${c.name}${c.detail ? `\n${indent(c.detail.trim().split('\n').slice(-25).join('\n'))}` : ''}`)
    .join('\n');
}

const indent = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');
const tail = (s, n) => String(s || '').trim().split('\n').slice(-n).join('\n');

// `crew gate`: run by hand, by the runner, or as the coder's Stop hook (--hook).
export async function runGateCli({ store, values, out }) {
  const hookInput = values.hook ? safeJson(fs.readFileSync(0, 'utf8')) : null;
  const cwd = path.resolve(values.cwd || hookInput?.cwd || process.env.CREW_WORKTREE || process.cwd());
  const id = (values.ticket || process.env.CREW_TICKET || '').toUpperCase();
  if (!id) throw new Error('No ticket: set CREW_TICKET or pass --ticket');
  const st = store || new Store(crewHome());
  const s = st.state(id);
  const project = st.project(s.project);
  const base = process.env.CREW_BASE || s.job?.base || `${project.repo.remote}/${project.repo.base}`;

  if (values.hook) {
    // The coder asked the lead a question: let it stop and wait for the answer.
    if (fs.existsSync(path.join(cwd, '.crew', 'WAITING'))) return;
    const countFile = path.join(cwd, '.crew', 'gate-blocks.json');
    const counts = readJson(countFile, {});
    const key = hookInput?.session_id || 'session';
    if ((counts[key] || 0) >= MAX_HOOK_BLOCKS) return; // Let it stop; the runner's full gate will judge.
    const result = await runGate({ cwd, project, stage: 'fast', env: ticketEnv(st, project, s, { role: 'worker', cwd }), base, contract: st.readFile(id, 'contract.md'), checkMax: st.config().memory.checkMax });
    if (result.ok) return;
    // A check killed for memory or time is not the coder's to fix: let it stop; the runner decides.
    if (!failures(result).code.length) return;
    counts[key] = (counts[key] || 0) + 1;
    writeJson(countFile, counts);
    const reason = `The crew gate blocked you from stopping (${counts[key]}/${MAX_HOOK_BLOCKS}). Fix these, then stop again:\n${gateSummary(result)}\n\nIf you are stuck on a product question, run: crew worker-ask "<question>" and stop.`;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    return;
  }

  const result = await runGate({ cwd, project, stage: values.stage || 'all', env: ticketEnv(st, project, s, { role: 'worker', cwd }), base, contract: st.readFile(id, 'contract.md'), checkMax: st.config().memory.checkMax });
  if (values.json) return out(JSON.stringify(result, null, 2));
  out(result.ok ? `Gate passed: ${result.checks.map((c) => c.name).join(', ')}` : `Gate failed:\n${gateSummary(result)}`);
  if (!result.ok) process.exitCode = 1;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
