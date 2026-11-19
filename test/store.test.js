import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, checkContract } from '../src/store.js';
import { boardModel, digest, queueOrder } from '../src/board.js';
import { inWindow, nightKey } from '../src/util.js';
import { tmpHome, crew, CONTRACT } from './helpers.js';

test('a ticket moves from inbox to queued only with a contract and your approval', () => {
  const home = tmpHome();
  const store = new Store(home);
  const t = store.newTicket({ type: 'feature', title: 'Active students on the dashboard', body: 'Trainers asked for it.' });
  assert.equal(t.id, 'DM-001');
  assert.equal(t.approval, 'user');
  assert.match(store.readFile(t.id, 'story.md'), /Trainers asked for it/);

  assert.throws(() => store.transition(t.id, 'queued', { by: 'user' }), /no contract/);
  store.setContract(t.id, CONTRACT, { by: 'lead' });
  assert.equal(store.state(t.id).status, 'ready');
  assert.throws(() => store.transition(t.id, 'queued', { by: 'lead' }), /needs your approval/);
  store.transition(t.id, 'queued', { by: 'user' });
  assert.equal(store.state(t.id).status, 'queued');

  const second = store.newTicket({ type: 'bug', title: 'Typo on checkout' });
  assert.equal(second.id, 'DM-002');
  assert.equal(second.approval, 'auto');
});

test('questions to you put a ticket on hold and answers become decisions', () => {
  const home = tmpHome();
  const store = new Store(home);
  const t = store.newTicket({ type: 'idea', title: 'Archive old courses' });
  store.transition(t.id, 'shaping', { by: 'lead' });
  const { qid } = store.ask(t.id, { text: 'Should trainers still see archived courses?', to: 'user', from: 'lead', options: ['yes', 'no'] });
  assert.equal(qid, 'Q1');
  assert.equal(store.state(t.id).status, 'waiting');
  assert.throws(() => store.answer(t.id, 'Q1', { text: 'yes', by: 'lead' }), /for the user/);
  const { decision, state } = store.answer(t.id, 'q1', { text: 'Yes, greyed out', by: 'user' });
  assert.equal(decision, 'D1');
  assert.equal(state.status, 'shaping');
  assert.match(store.readFile(t.id, 'decisions.md'), /D1.*Yes, greyed out/);
  assert.match(store.readFile(t.id, 'questions.md'), /Q1 · answered/);
});

test('a worker question goes to the lead; an escalation parks the job until you answer', () => {
  const home = tmpHome();
  const store = new Store(home);
  const t = store.newTicket({ type: 'bug', title: 'Wrong VAT on invoices' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'lead' });
  store.transition(t.id, 'building', { by: 'runner' });
  const { qid } = store.ask(t.id, { text: 'Round per line or per invoice?', to: 'lead', from: 'worker' });
  assert.equal(store.state(t.id).status, 'building');
  store.escalate(t.id, qid, { by: 'lead', text: 'Accounting rule; your call.' });
  assert.equal(store.state(t.id).status, 'waiting');
  store.answer(t.id, qid, { text: 'Per invoice', by: 'user' });
  assert.equal(store.state(t.id).status, 'queued');
});

test('roles: only the runner builds, only you finish or drop', () => {
  const home = tmpHome();
  const store = new Store(home);
  const t = store.newTicket({ type: 'chore', title: 'Bump deps' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'lead' });
  assert.throws(() => store.transition(t.id, 'building', { by: 'lead' }), /Only the runner/);
  store.transition(t.id, 'building', { by: 'runner' });
  store.transition(t.id, 'review', { by: 'runner' });
  assert.throws(() => store.transition(t.id, 'done', { by: 'lead' }), /Only you/);
  assert.throws(() => store.transition(t.id, 'done', { by: 'worker' }));
  store.transition(t.id, 'done', { by: 'user' });
  assert.equal(store.state(t.id).status, 'done');
});

test('contract check wants a goal and acceptance lines', () => {
  assert.deepEqual(checkContract(CONTRACT), []);
  assert.equal(checkContract('## Goal\nx\n## Acceptance\nnothing here\n').length, 1);
  assert.equal(checkContract('just text').length, 2);
  assert.deepEqual(checkContract('## Goal\nx\n\n## Acceptance\n1. works\n## Out of scope\n- y\n'), []);
});

test('board columns, queue order and digest', () => {
  const home = tmpHome();
  const store = new Store(home);
  const a = store.newTicket({ type: 'bug', title: 'A' });
  const b = store.newTicket({ type: 'bug', title: 'B', priority: 1 });
  const c = store.newTicket({ type: 'feature', title: 'C' });
  for (const t of [a, b]) {
    store.setContract(t.id, CONTRACT);
    store.transition(t.id, 'queued', { by: 'lead' });
  }
  store.setContract(c.id, CONTRACT);
  const model = boardModel(store.list());
  const col = (k) => model.columns.find((x) => x.key === k).tickets.map((t) => t.id);
  assert.deepEqual(col('queue'), ['DM-002', 'DM-001']);
  assert.deepEqual(col('you'), ['DM-003']);
  assert.equal(queueOrder(store.list())[0].id, 'DM-002');
  assert.match(digest(store.list()), /Queue \(2\)/);
  assert.match(digest(store.list()), /Approve the plan/);
});

test('night window wraps midnight in Warsaw time', () => {
  const tz = 'Europe/Warsaw';
  assert.equal(inWindow(new Date('2026-10-21T21:30:00Z'), '23:00', '07:00', tz), true); // 23:30 local
  assert.equal(inWindow(new Date('2026-10-22T04:00:00Z'), '23:00', '07:00', tz), true); // 06:00 local
  assert.equal(inWindow(new Date('2026-10-22T06:00:00Z'), '23:00', '07:00', tz), false); // 08:00 local
  assert.equal(nightKey(new Date('2026-10-22T03:00:00Z'), '23:00', tz), '2026-10-21');
  assert.equal(nightKey(new Date('2026-10-21T21:30:00Z'), '23:00', tz), '2026-10-21');
});

test('CLI: create, contract, approve and roles', () => {
  const home = tmpHome();
  let r = crew(home, ['new', 'feature', 'Show', 'active', 'students', '--body', 'From a trainer call']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DM-001 created/);
  r = crew(home, ['contract', 'DM-001', '--stdin'], { role: 'lead', input: CONTRACT });
  assert.equal(r.code, 0, r.err);
  r = crew(home, ['queue', 'DM-001'], { role: 'lead' });
  assert.equal(r.code, 2);
  assert.match(r.err, /needs your approval/);
  r = crew(home, ['approve', 'DM-001']);
  assert.equal(r.code, 0, r.err);
  // A discussion ends when the user accepts a round, not when someone moves the card.
  const store = new Store(home);
  const idea = store.newTicket({ type: 'idea', title: 'Explore first' });
  store.requestRound(idea.id, { by: 'lead' });
  assert.throws(() => store.transition(idea.id, 'shaping', { by: 'lead' }), /accepts a round/);
  assert.throws(() => store.requestRound(idea.id, { by: 'lead' }), /already has round 1/);
  assert.throws(() => store.requestRound(idea.id, { by: 'worker' }), /Only the lead or the user/);
  assert.throws(() => store.acceptRound(idea.id, { by: 'user' }), /no design round/);
  assert.throws(() => store.setContract(idea.id, CONTRACT, { by: 'lead' }), /being discussed/);
  // Trying a failed round again keeps its focus note.
  store.update(idea.id, (x) => {
    x.discussion = { ...x.discussion, state: 'failed', pending: { ...x.discussion.pending, note: 'how trainers see it' } };
    return null;
  });
  assert.equal(store.requestRound(idea.id, { by: 'user' }).discussion.pending.note, 'how trainers see it');
  // The lead records your chat answer to your question only with a quote from your messages.
  const asked = store.ask(idea.id, { text: 'Round 1 · decision 1: Who fills it in?', to: 'user', from: 'designer', options: ['a: client (recommended)', 'b: trainer'] });
  fs.mkdirSync(path.join(home, 'orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(home, 'orchestrator', 'chat.jsonl'), JSON.stringify({ ts: new Date().toISOString(), role: 'user', text: 'OK so 1b, and 2: not yet' }) + '\n');
  r = crew(home, ['answer', idea.id, asked.qid, 'b: trainer'], { role: 'lead' });
  assert.notEqual(r.code, 0);
  r = crew(home, ['answer', idea.id, asked.qid, 'b: trainer', '--quote', '1a'], { role: 'lead' });
  assert.notEqual(r.code, 0);
  r = crew(home, ['answer', idea.id, asked.qid, 'b: trainer', '--quote', '1b'], { role: 'lead' });
  assert.equal(r.code, 0, r.err);
  assert.match(store.state(idea.id).questions.find((q) => q.id === asked.qid).answer, /relayed by the lead from: "1b"/);
  r = crew(home, ['notes', '--body', 'Coders must not write here'], { role: 'worker' });
  assert.notEqual(r.code, 0);
  r = crew(home, ['notes', '--stdin'], { role: 'lead', input: 'User: short answers.\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(crew(home, ['notes']).out, /short answers/);
  r = crew(home, ['ask', 'DM-001', 'Which', 'currency?'], { role: 'worker' });
  assert.match(r.out, /Q1 asked/);
  r = crew(home, ['show', 'DM-001', '--json']);
  const shown = JSON.parse(r.out);
  assert.equal(shown.state.questions[0].to, 'lead');
  assert.ok(fs.existsSync(path.join(home, 'feed.jsonl')));
  r = crew(home, ['digest']);
  assert.match(r.out, /Queue \(1\)/);
});
