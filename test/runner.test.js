import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { Runner, inlineImages } from '../src/runner.js';
import { Lead } from '../src/lead.js';
import { parseReset } from '../src/claude.js';
import { matchPath, allowedFromContract } from '../src/gate.js';
import { readJson, writeJson } from '../src/util.js';
import { ROOT, CONTRACT } from './helpers.js';

process.env.CREW_NO_SYSTEMD = '1';
const FAKE = path.join(ROOT, 'test', 'fake-claude.js');

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

function setup(env = {}) {
  const origin = makeOrigin();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  writeJson(path.join(home, 'crew.json'), {
    timezone: 'Europe/Warsaw',
    runner: { mode: 'always', tickSeconds: 1 },
    claude: { bin: FAKE },
    limits: { questionRounds: 3, gateRounds: 2, verifyRounds: 2, minFreeDiskGb: 0 },
  });
  writeJson(path.join(home, 'projects', 'demo', 'project.json'), {
    prefix: 'DM',
    name: 'Demo',
    repo: { url: origin, base: 'main' },
    gate: [{ name: 'syntax', run: 'node --check thing.js', stage: 'fast' }],
  });
  fs.mkdirSync(path.join(home, 'orchestrator'), { recursive: true });
  Object.assign(process.env, { CREW_HOME: home, CREW_ROOT: ROOT, FAKE_LOG: path.join(home, 'fake.log') }, env);
  const store = new Store(home);
  const lead = new Lead({ store });
  const runner = new Runner({ store, lead });
  return { home, origin, store, runner, lead };
}

function clearFakeEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
}

function queuedTicket(store, type = 'bug') {
  const t = store.newTicket({ type, title: 'Show active students' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'user' });
  return t.id;
}

test('a queued ticket goes through coder, gate and verifier to "ready to test"', async () => {
  clearFakeEnv();
  const { store, runner } = setup();
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.status, 'review');
  assert.equal(s.verdict.result, 'PASS');
  assert.equal(s.job.step, 'done');
  assert.match(store.readFile(id, 'check.md'), /demo\.trainer/);
  assert.match(store.readFile(id, 'verify.md'), /PASS/);
  assert.ok(fs.existsSync(path.join(store.home, 'worktrees', id, 'thing.js')));
  const usage = readJson(path.join(store.home, 'runner.json')).usage;
  assert.equal(usage.fiveHour.utilization, 0.2);
});

test('a verifier FAIL sends the work back to the coder once, then it passes', async () => {
  clearFakeEnv();
  const { store, runner } = setup({ FAKE_VERIFY: 'fail' });
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.verdict.result, 'PASS');
  assert.equal(s.verdict.round, 2);
  assert.ok(store.events(id).some((e) => e.type === 'verdict' && /FAIL/.test(e.text)));
});

test('a coder question is answered by the lead and the coder resumes', async () => {
  clearFakeEnv();
  const { store, runner, lead } = setup({ FAKE_CODER_ASKS: '1' });
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.questions[0].answeredBy, 'lead');
  assert.match(s.decisions[0].text, /DD\.MM\.YYYY/);
  assert.ok(lead.history().some((m) => m.role === 'lead' && /Answered Q1/.test(m.text)));
});

test('a product question goes to you; your answer resumes the same coder session', async () => {
  clearFakeEnv();
  const { store, runner } = setup({ FAKE_CODER_ASKS: '1', FAKE_LEAD_ESCALATES: '1' });
  const id = queuedTicket(store);
  const first = await runner.runOnce({ ticket: id });
  assert.equal(first.result, 'waiting', JSON.stringify(first));
  const waiting = store.state(id);
  assert.equal(waiting.status, 'waiting');
  const session = waiting.job.coderSession;
  store.answer(id, 'Q1', { text: 'ISO dates, like the API', by: 'user' });
  assert.equal(store.state(id).status, 'queued');
  const second = await runner.runOnce({ ticket: id });
  assert.equal(second.result, 'review', JSON.stringify(second));
  const s = store.state(id);
  assert.equal(s.job.coderSession, session);
  assert.equal(s.runs.length, 1);
  assert.match(fs.readFileSync(path.join(store.home, 'fake.log'), 'utf8'), /answer to your question[\s\S]*ISO dates/i);
});

test('a usage limit parks the job and keeps its place in the queue', async () => {
  clearFakeEnv();
  const { store, runner } = setup({ FAKE_LIMIT: '1' });
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'parked', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.status, 'queued');
  assert.equal(s.job.step, 'code');
  const rs = readJson(path.join(store.home, 'runner.json'));
  assert.ok(new Date(rs.parkedUntil) > new Date());
  assert.match(runner.holdReason(), /usage limit/);
});

test('the lead shapes a new bug into a queued ticket', async () => {
  clearFakeEnv();
  const { store, lead } = setup();
  const t = store.newTicket({ type: 'bug', title: 'Checkout typo' });
  const reply = await lead.say(`[event] The user added bug ${t.id}: "Checkout typo"`, { from: 'event' });
  assert.match(reply.text, /queued/);
  assert.equal(store.state(t.id).status, 'queued');
  assert.equal(lead.session().turns, 1);
});

test('a big lead conversation saves its notes and restarts from them', async () => {
  clearFakeEnv();
  const { store, lead } = setup({ FAKE_CONTEXT: '130000' });
  await lead.say('Please keep your answers short.');
  const first = lead.session();
  assert.equal(first.contextTokens, 130060);
  delete process.env.FAKE_CONTEXT;
  const reply = await lead.say('What do you remember about me?');
  const second = lead.session();
  assert.notEqual(second.id, first.id);
  assert.equal(second.turns, 1);
  assert.match(fs.readFileSync(path.join(store.home, 'orchestrator', 'notes.md'), 'utf8'), /short answers/);
  assert.match(reply.text, /From my notes: The user prefers short answers/);
  assert.ok(lead.history().some((m) => m.role === 'event' && /fresh conversation/.test(m.text)));
  // A small conversation is simply resumed.
  await lead.say('Thanks.');
  assert.equal(lead.session().id, second.id);
});

test('a design round writes a page and asks its decisions; an accepted round goes to planning', async () => {
  clearFakeEnv();
  const { store, runner } = setup();
  const t = store.newTicket({ type: 'idea', title: 'Progress reports' });
  store.requestRound(t.id, { note: 'how clients report progress', by: 'lead' });
  assert.equal(store.state(t.id).status, 'discussing');
  const r = await runner.tick();
  assert.equal(r.result, 'round', JSON.stringify(r));
  let s = store.state(t.id);
  assert.equal(s.discussion.state, 'ready');
  assert.ok(fs.existsSync(path.join(store.dir(t.id), 'discuss', 'round-1.html')));
  assert.match(fs.readFileSync(path.join(store.dir(t.id), 'discuss', 'r1', 'brief.md'), 'utf8'), /how clients report progress/);
  // Its two decisions wait for you, with the designer's pick marked.
  assert.equal(s.status, 'waiting');
  assert.deepEqual(s.discussion.rounds[0].questions, ['Q1', 'Q2']);
  assert.match(s.questions[0].options.join(' | '), /a: The client \(recommended\)/);
  store.answer(t.id, 'Q2', { text: 'a: Yes', by: 'user' });
  assert.throws(() => store.acceptRound(t.id, { by: 'lead' }), /Only you/);
  // Accepting answers what is left with the pick and sends the ticket to planning.
  s = store.acceptRound(t.id, { by: 'user' });
  assert.equal(s.status, 'shaping');
  assert.equal(s.discussion.acceptedRound, 1);
  assert.match(s.questions[0].answer, /The client \(accepted with round 1\)/);
  assert.equal(s.decisions.length, 2);
  // The coder of the accepted design gets the page in its brief.
  runner.writeBrief(s, store.dir(t.id));
  assert.ok(fs.existsSync(path.join(store.dir(t.id), '.crew', 'discussion.html')));
});

test('the next round replaces open decisions and builds on the earlier one', async () => {
  clearFakeEnv();
  const { store, runner } = setup();
  const t = store.newTicket({ type: 'idea', title: 'Progress reports' });
  store.requestRound(t.id, { by: 'user' });
  await runner.tick();
  store.answer(t.id, 'Q1', { text: 'b: The trainer', by: 'user' });
  let s = store.requestRound(t.id, { note: 'the trainer fills it in; show the form', by: 'user' });
  assert.equal(s.status, 'discussing');
  assert.ok(s.questions.find((q) => q.id === 'Q2').superseded);
  await runner.tick();
  s = store.state(t.id);
  assert.equal(s.discussion.rounds.length, 2);
  assert.deepEqual(s.discussion.rounds[1].questions, ['Q3', 'Q4']);
  const brief = fs.readFileSync(path.join(store.dir(t.id), 'discuss', 'r2', 'brief.md'), 'utf8');
  assert.match(brief, /### Round 1/);
  assert.match(brief, /The trainer/);
  assert.match(brief, /the trainer fills it in/);
});

test('a round page is shared only when it holds no sandbox values', async () => {
  clearFakeEnv();
  const { store, runner, home } = setup({ FAKE_DESIGN_LEAK: 'sandbox-secret-123' });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'crew.json'), 'utf8'));
  writeJson(path.join(home, 'crew.json'), { ...cfg, discuss: { publish: 'echo shared {file} as https://pages.test/x.html' } });
  fs.writeFileSync(path.join(home, 'projects', 'demo', 'agent.env'), 'API_KEY=sandbox-secret-123\n');
  const t = store.newTicket({ type: 'idea', title: 'Leaky page' });
  store.requestRound(t.id, { by: 'user' });
  await runner.tick();
  assert.equal(store.state(t.id).discussion.rounds[0].link, null);
  assert.ok(store.events(t.id).some((e) => /was not shared/.test(e.text)));
  delete process.env.FAKE_DESIGN_LEAK;
  store.requestRound(t.id, { by: 'user' });
  await runner.tick();
  assert.equal(store.state(t.id).discussion.rounds[1].link, 'https://pages.test/x.html');
});

test('a designer that writes no page gets one more turn, then the round fails', async () => {
  clearFakeEnv();
  const { store, runner } = setup({ FAKE_DESIGN_SKIP_PAGE: '1' });
  const t = store.newTicket({ type: 'idea', title: 'Quiet designer' });
  store.requestRound(t.id, { by: 'user' });
  const r = await runner.tick();
  // The reminder turn writes the page (the fake only skips its first turn).
  assert.equal(r.result, 'round', JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(store.dir(t.id), 'discuss', 'r1', 'designer-2.jsonl')));
});

test('a round page carries its own screenshots, and nothing from outside its folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-inline-'));
  fs.mkdirSync(path.join(dir, 'shots'));
  fs.writeFileSync(path.join(dir, 'shots', 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  const html = inlineImages('<img src="shots/a.jpg"><img src="../secret.png"><img src="https://x.test/b.png"><i style="background:url(shots/a.jpg)"></i>', dir);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 2);
  assert.match(html, /src="\.\.\/secret\.png"/);
  assert.match(html, /https:\/\/x\.test\/b\.png/);
});

test('changes requested after testing start a new run with the same coder', async () => {
  clearFakeEnv();
  const { store, runner } = setup();
  const id = queuedTicket(store);
  await runner.runOnce({ ticket: id });
  const session = store.state(id).job.coderSession;
  store.requestChanges(id, 'The empty message should say "Brak danych"');
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'review', JSON.stringify(r));
  const s = store.state(id);
  assert.equal(s.runs.length, 2);
  assert.equal(s.job.coderSession, session);
  assert.match(fs.readFileSync(path.join(store.home, 'worktrees', id, '.crew', 'ticket.md'), 'utf8'), /Brak danych/);
});

test('done tickets lose their worktree after 48 hours, not before', async () => {
  clearFakeEnv();
  const { store, runner } = setup();
  const id = queuedTicket(store);
  await runner.runOnce({ ticket: id });
  store.transition(id, 'done', { by: 'user' });
  assert.deepEqual(await runner.cleanup(), []);
  store.update(id, (s) => {
    s.updated = new Date(Date.now() - 49 * 3600e3).toISOString();
    return null;
  });
  const st = store.state(id);
  writeJson(path.join(store.dir(id), 'state.json'), { ...st, updated: new Date(Date.now() - 49 * 3600e3).toISOString() });
  assert.deepEqual(await runner.cleanup(), [id]);
  assert.ok(!fs.existsSync(path.join(store.home, 'worktrees', id)));
  assert.ok(store.state(id).job.cleanedAt);
});

test('a check killed for memory blocks as infrastructure, and Retry resumes at the gate', async () => {
  clearFakeEnv();
  const { store, runner, home } = setup();
  const pj = path.join(home, 'projects', 'demo', 'project.json');
  const project = readJson(pj);
  project.gate.push({ name: 'build', run: 'kill -9 $$', heavy: true });
  writeJson(pj, project);
  const id = queuedTicket(store);
  const r = await runner.runOnce({ ticket: id });
  assert.equal(r.result, 'blocked', JSON.stringify(r));
  let s = store.state(id);
  assert.match(s.job.lastError, /^infrastructure: build \(heavy\) was killed/);
  assert.equal(s.job.step, 'gate');
  assert.equal(fs.readdirSync(path.join(store.dir(id), 'runs', 'r1')).filter((f) => f.startsWith('coder-')).length, 1, 'no coder round was spent on it');
  project.gate.pop();
  writeJson(pj, project);
  s = store.transition(id, 'queued', { by: 'user', note: 'retry' });
  assert.equal(s.job.step, 'gate');
  const again = await runner.runOnce({ ticket: id });
  assert.equal(again.result, 'review', JSON.stringify(again));
});

test('reset times are parsed from the formats Claude Code uses', () => {
  const now = new Date('2026-10-21T20:00:00Z');
  assert.equal(parseReset('Claude usage limit reached|1792601400').toISOString(), new Date(1792601400 * 1000).toISOString());
  const d = parseReset("You've hit your limit · resets 3am (Europe/Warsaw)", { now });
  assert.equal(d.toISOString(), '2026-10-22T01:00:00.000Z');
  assert.equal(parseReset(1792601400).getTime(), 1792601400 * 1000);
  assert.equal(parseReset('nothing here'), null);
});

test('gate path rules and allowed changes from the contract', () => {
  assert.ok(matchPath('tests/setup/globalSetup.ts', 'tests/setup/**'));
  assert.ok(matchPath('vitest.config.mts', 'vitest.config.mts'));
  assert.ok(!matchPath('src/vitest.config.mts', 'vitest.config.mts'));
  assert.deepEqual(allowedFromContract('## Goal\nx\n## Allowed test changes\n- `tests/setup/**`\n- none\n## Notes\n'), ['tests/setup/**']);
});
