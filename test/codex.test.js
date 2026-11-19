// Codex as the agent CLI: argument building, events, usage windows, and the whole night pipeline
// (lead, coder with its Stop-hook gate, verifier, designer) on test/fake-codex.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { Lead } from '../src/lead.js';
import { buildCodexArgs, tomlValue, strictSchema, parseCodexReset, findRollout, readRolloutUsage, sandboxFor } from '../src/codex.js';
import { agentFor, engineFor, claudeOptions } from '../src/agent.js';
import { buildArgs } from '../src/claude.js';
import { loadConfig } from '../src/config.js';
import { readJson, writeJson } from '../src/util.js';
import { ROOT, CONTRACT } from './helpers.js';

process.env.CREW_NO_SYSTEMD = '1';
const FAKE = path.join(ROOT, 'test', 'fake-codex.js');

test('-c values are TOML: strings, arrays and inline tables', () => {
  assert.equal(tomlValue('a "b"\nc'), '"a \\"b\\"\\nc"');
  assert.equal(tomlValue(true), 'true');
  assert.equal(tomlValue(['/x', '/y']), '["/x", "/y"]');
  assert.equal(tomlValue([{ hooks: [{ type: 'command', command: "'node' gate", timeout: 30 }] }]), '[{ hooks = [{ type = "command", command = "\'node\' gate", timeout = 30 }] }]');
  assert.equal(tomlValue({ 'a.b': 1 }), '{ "a.b" = 1 }');
});

test('codex args: fresh and resumed runs get the same settings through -c', () => {
  const fresh = buildCodexArgs({ permissionMode: 'dontAsk', addDirs: ['/crew'], effort: 'max', appendSystemPrompt: 'You are the coder.', model: 'gpt-x', stopHook: { command: 'crew gate --hook', timeout: 1800 } }, { schemaFile: '/tmp/s.json' });
  assert.deepEqual(fresh.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  const cs = fresh.filter((x, i) => fresh[i - 1] === '-c');
  assert.ok(cs.includes('approval_policy="never"'));
  assert.ok(cs.includes('sandbox_mode="workspace-write"'));
  assert.ok(cs.includes('sandbox_workspace_write.writable_roots=["/crew"]'));
  assert.ok(cs.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(cs.includes('model_reasoning_effort="xhigh"'));
  assert.ok(cs.includes('developer_instructions="You are the coder."'));
  assert.ok(cs.includes('shell_environment_policy.ignore_default_excludes=true'));
  assert.ok(cs.some((c) => c.startsWith('hooks.Stop=[{ hooks = [{ type = "command", command = "crew gate --hook", timeout = 1800 }] }]')));
  assert.ok(fresh.includes('--dangerously-bypass-hook-trust'));
  assert.deepEqual(fresh.slice(-5), ['-m', 'gpt-x', '--output-schema', '/tmp/s.json', '-']);
  const resumed = buildCodexArgs({ resume: 'abc', permissionMode: 'bypassPermissions' });
  assert.deepEqual(resumed.slice(0, 5), ['exec', 'resume', 'abc', '--json', '--skip-git-repo-check']);
  assert.ok(resumed.includes('sandbox_mode="danger-full-access"'));
  assert.ok(!resumed.some((x) => x.startsWith('sandbox_workspace_write')));
  assert.equal(sandboxFor({ permissionMode: 'bypassPermissions', sandbox: 'workspace-write' }), 'workspace-write');
});

test('the verdict schema is made strict for Codex', () => {
  const s = strictSchema({ type: 'object', properties: { a: { type: 'string' }, list: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } }, required: [] } } }, required: ['a'] });
  assert.deepEqual(s.required, ['a', 'list']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.list.items.required, ['x']);
  assert.equal(s.properties.list.items.additionalProperties, false);
});

test('Codex reset times: "try again in …" and "try again at …"', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  assert.equal(parseCodexReset('You have hit your usage limit. Try again in 1 hour 5 minutes.', { now }).toISOString(), '2026-11-19T11:05:00.000Z');
  assert.equal(parseCodexReset('try again in 2 days 3 hours', { now }).toISOString(), '2026-11-21T13:00:00.000Z');
  const at = parseCodexReset('Upgrade to Pro or try again at Nov 20th, 2026 9:41 AM.', { now });
  assert.equal(at.getDate(), 20);
  assert.equal(at.getMinutes(), 41);
  assert.equal(parseCodexReset('something else', { now }), null);
});

test('usage windows and context size come from the rollout file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const dir = path.join(home, 'sessions', '2026', '11', '19');
  fs.mkdirSync(dir, { recursive: true });
  const id = '01a1f3aa-0000-7000-8000-000000000001';
  const ev = { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 15000, output_tokens: 25 } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1795107393 }, secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1795694193 }, rate_limit_reached_type: null } } };
  fs.writeFileSync(path.join(dir, `rollout-2026-11-19T12-00-00-${id}.jsonl`), '{"type":"session_meta"}\n' + JSON.stringify(ev) + '\n');
  const file = findRollout(id, { home });
  assert.ok(file.endsWith(`${id}.jsonl`));
  const u = readRolloutUsage(file);
  assert.deepEqual(u.windows, { five_hour: { utilization: 0.42, resetsAt: 1795107393 }, seven_day: { utilization: 0.07, resetsAt: 1795694193 } });
  assert.equal(u.contextTokens, 15025);
  assert.equal(findRollout('missing', { home }), null);
});

test('crew.json picks the CLI per role, or one for all', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-engine-'));
  writeJson(path.join(home, 'crew.json'), { engine: 'codex' });
  let cfg = loadConfig(home);
  assert.equal(engineFor(cfg, 'lead'), 'codex');
  assert.equal(engineFor(cfg, 'verifier'), 'codex');
  writeJson(path.join(home, 'crew.json'), { engine: { coder: 'codex' }, codex: { models: { coder: 'gpt-x' }, sandbox: { coder: 'workspace-write' } } });
  cfg = loadConfig(home);
  assert.equal(engineFor(cfg, 'lead'), 'claude');
  assert.deepEqual([agentFor(cfg, 'coder').engine, agentFor(cfg, 'coder').model, agentFor(cfg, 'coder').sandbox], ['codex', 'gpt-x', 'workspace-write']);
  assert.equal(agentFor(cfg, 'lead').model, 'opus');
  writeJson(path.join(home, 'crew.json'), { engine: { coder: 'gemini' } });
  assert.throws(() => engineFor(loadConfig(home), 'coder'), /Unknown engine/);
});

test('on Claude Code the same Stop hook goes through --settings', () => {
  const a = buildArgs(claudeOptions({ engine: 'claude', stopHook: { command: 'crew gate --hook', timeout: 1800 } }));
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'crew gate --hook', timeout: 1800 }] }]);
});

// ---- the pipeline on fake Codex ------------------------------------------------------------

function makeOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-origin-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo app\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return dir;
}

function setup(env = {}, extra = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
  const origin = makeOrigin();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  writeJson(path.join(home, 'crew.json'), {
    timezone: 'Europe/Warsaw',
    runner: { mode: 'always', tickSeconds: 1 },
    engine: 'codex',
    codex: { bin: FAKE },
    claude: { bin: '/nonexistent/claude' },
    limits: { questionRounds: 3, gateRounds: 2, verifyRounds: 2, minFreeDiskGb: 0 },
    ...extra,
  });
  writeJson(path.join(home, 'projects', 'demo', 'project.json'), {
    prefix: 'DM',
    name: 'Demo',
    repo: { url: origin, base: 'main' },
    gate: [{ name: 'syntax', run: 'node --check thing.js', stage: 'fast' }],
  });
  fs.mkdirSync(path.join(home, 'orchestrator'), { recursive: true });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  Object.assign(process.env, { CREW_HOME: home, CREW_ROOT: ROOT, CODEX_HOME: codexHome, FAKE_LOG: path.join(home, 'fake.log') }, env);
  const store = new Store(home);
  const lead = new Lead({ store });
  const runner = new Runner({ store, lead });
  return { home, store, runner, lead, log: () => fs.readFileSync(path.join(home, 'fake.log'), 'utf8') };
}

function queuedTicket(store) {
  const t = store.newTicket({ type: 'bug', title: 'Show active students' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'user' });
  return t.id;
}

test('on Codex, a queued ticket goes through coder, gate and verifier to "ready to test"', async () => {
  const { store, runner, log } = setup();
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.verdict.result, 'PASS');
  assert.equal(s.job.coderEngine, 'codex');
  assert.match(s.job.coderSession, /^[0-9a-f-]{36}$/);
  const usage = readJson(path.join(store.home, 'runner.json')).usage;
  assert.equal(usage.fiveHour.utilization, 0.2);
  assert.equal(usage.sevenDay.utilization, 0.1);
  const lines = log();
  assert.match(lines, /codex id=.* sandbox="danger-full-access" dev=yes hook=yes schema=no/);
  assert.match(lines, /codex id=.* schema=yes prompt=Verify DM-001/);
  assert.ok(store.events(id).some((e) => e.type === 'coder' && /\(Codex\) ended · \d+ turns$/.test(e.text)));
});

test('on Codex, the Stop-hook gate blocks a broken change and the coder fixes it before stopping', async () => {
  const { store, runner, log } = setup({ FAKE_CODEX_BREAK: '1' });
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  assert.match(log(), /stop hook blocked: The crew gate blocked you from stopping \(1\/\d\)/);
  const counts = readJson(path.join(store.home, 'worktrees', id, '.crew', 'gate-blocks.json'));
  assert.equal(Object.values(counts)[0], 1);
  // The fix landed in the same session: the full gate passed on the first round.
  assert.equal(store.state(id).job.rounds.gate, 0);
});

test('on Codex, a usage limit parks the job until the reset', async () => {
  const { store, runner } = setup({ FAKE_LIMIT: '1' });
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'parked', JSON.stringify(r));
  const rs = readJson(path.join(store.home, 'runner.json'));
  const mins = (new Date(rs.parkedUntil) - Date.now()) / 60e3;
  assert.ok(mins > 55 && mins < 70, `parked ${mins} min`);
  assert.equal(store.state(id).status, 'queued');
});

test('on Codex, the lead shapes a ticket and keeps the thread Codex named', async () => {
  const { store, lead, home } = setup();
  const t = store.newTicket({ type: 'bug', title: 'Checkout typo' });
  const reply = await lead.say(`[event] The user added bug ${t.id}: "Checkout typo"`, { from: 'event' });
  assert.match(reply.text, /queued/);
  assert.equal(store.state(t.id).status, 'queued');
  const sess = lead.session();
  assert.equal(sess.engine, 'codex');
  assert.ok(fs.existsSync(path.join(home, 'orchestrator', 'AGENTS.md')));
  await lead.say('Thanks.');
  assert.equal(lead.session().id, sess.id);
  assert.equal(lead.session().turns, 2);
});

test('switching the lead from Claude Code to Codex starts a fresh conversation', async () => {
  const { lead, home } = setup();
  writeJson(path.join(home, 'orchestrator', 'session.json'), { id: 'claude-session', engine: 'claude', turns: 5 });
  await lead.say('Hello.');
  const sess = lead.session();
  assert.notEqual(sess.id, 'claude-session');
  assert.equal(sess.engine, 'codex');
  assert.equal(sess.turns, 1);
});

test('a big Codex lead conversation saves its notes and restarts', async () => {
  const { lead } = setup({ FAKE_CONTEXT: '130000' });
  await lead.say('Please keep your answers short.');
  const first = lead.session();
  assert.equal(first.contextTokens, 130060);
  delete process.env.FAKE_CONTEXT;
  const reply = await lead.say('What do you remember about me?');
  assert.notEqual(lead.session().id, first.id);
  assert.match(reply.text, /From my notes: The user prefers short answers/);
});

test('a design round runs on Codex too', async () => {
  const { store, runner } = setup();
  const t = store.newTicket({ type: 'idea', title: 'Progress reports' });
  store.requestRound(t.id, { note: 'how clients report progress', by: 'lead' });
  const r = await runner.tick();
  assert.equal(r.result, 'round', JSON.stringify(r));
  const s = store.state(t.id);
  assert.equal(s.discussion.state, 'ready');
  assert.deepEqual(s.discussion.rounds[0].questions, ['Q1', 'Q2']);
  assert.ok(fs.existsSync(path.join(store.dir(t.id), 'discuss', 'round-1.html')));
  assert.ok(store.events(t.id).some((e) => e.type === 'designer' && /\(Codex\)/.test(e.text)));
});
