#!/usr/bin/env node
// Fill a CREW_HOME with tickets in every state, a chat history, runner usage and a live preview,
// so the board can be built and checked without real agents. Usage:
//   CREW_HOME=/tmp/crew-demo node test/fixtures.js && CREW_HOME=/tmp/crew-demo node bin/crew.js serve
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { writeJson, appendJsonl, writeFileAtomic } from '../src/util.js';
import { ROOT, CONTRACT } from './helpers.js';

const home = process.env.CREW_HOME;
if (!home) throw new Error('Set CREW_HOME to an empty folder');
fs.rmSync(home, { recursive: true, force: true });
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const inMin = (min) => new Date(Date.now() + min * 60e3).toISOString();

writeJson(path.join(home, 'crew.json'), {
  timezone: 'Europe/Warsaw',
  listen: { host: '127.0.0.1', port: 20190 },
  runner: { mode: 'paused', tickSeconds: 5 },
  claude: { bin: path.join(ROOT, 'test', 'fake-claude.js') },
  publicUrl: 'https://crew.example.com',
});
writeJson(path.join(home, 'projects', 'shop', 'project.json'), {
  prefix: 'PA',
  name: 'Demo shop',
  repo: { url: '', base: 'main' },
  preview: {
    url: 'https://{host}',
    buildFor: 1,
    ttlMinutes: 120,
    slots: [
      { n: 1, host: 'preview-1.example.com', port: 20111 },
      { n: 2, host: 'preview-2.example.com', port: 20112 },
    ],
    logins: 'Demo trainer, demo admin or a demo customer · password in your notes',
  },
  lab: {
    port: 20119,
    url: 'http://localhost:{port}',
    logins: { trainer: 'demo.trainer@example.com', admin: 'demo.admin@example.com', client: 'demo.active@example.com' },
    passwordEnv: 'DEMO_PASSWORD',
    loginPath: '/api/users/login',
  },
});
fs.mkdirSync(path.join(home, 'orchestrator'), { recursive: true });
const store = new Store(home);
const mk = (type, title, body) => store.newTicket({ project: 'shop', type, title, body, by: 'user' });

// Inbox
const a = mk('idea', 'Trainers want a weekly summary email of their clients', 'From the call with Kasia: every Monday a short list of who trained and who did not.');
// Shaping
const b = mk('feature', 'Receptionist role: can check people in, cannot see payments', 'Spec exists in docs/superpowers/specs/2026-09-24-receptionist-role-review.md');
store.transition(b.id, 'shaping', { by: 'lead' });
store.decide(b.id, { text: 'Reuse the existing roles field; add "recepcja" as a new value', why: 'Matches how trener works; one migration', by: 'lead' });
// Waiting on you
const c = mk('feature', 'Archive old courses instead of deleting them', '');
store.transition(c.id, 'shaping', { by: 'lead' });
store.ask(c.id, { text: 'Should trainers still see archived courses in their panel?', to: 'user', from: 'lead', options: ['yes, greyed out', 'no, hide them'] });
store.ask(c.id, { text: 'Do customers keep access to an archived course they paid for?', to: 'user', from: 'lead', options: ['yes until their access ends', 'no'] });
// Ready (approve)
const d = mk('feature', 'Show "active students" count on the trainer dashboard', 'Trainers asked for it.');
store.setContract(d.id, CONTRACT, { by: 'lead' });
// Queue
const e = mk('bug', 'Training file names with Polish letters break the download', 'Kasia uploaded "Ćwiczenia ŁÓDŹ.pdf" and the link 404s.');
store.setContract(e.id, CONTRACT.replace('Trainers see the number of active students on their dashboard.', 'Uploads keep working with Polish letters in file names.'), { by: 'lead' });
store.transition(e.id, 'queued', { by: 'lead' });
const f = mk('chore', 'Add test:unit and typecheck scripts to package.json', '');
store.setContract(f.id, CONTRACT, { by: 'lead' });
store.transition(f.id, 'queued', { by: 'lead' });
store.setField(f.id, 'priority', 1);
// Building
const g = mk('bug', 'Access request accept/decline is not atomic', 'Two admins clicking at once can both succeed.');
store.setContract(g.id, CONTRACT, { by: 'lead' });
store.transition(g.id, 'queued', { by: 'lead' });
store.update(g.id, (s) => {
  s.status = 'building';
  s.branch = 'crew/pa-007-access-request-atomic';
  s.job = { run: 'r1', step: 'gate', startedAt: ago(38), rounds: { gate: 0, verify: 0, questions: 1, errors: 0 }, worktree: '/home/crew/crew/worktrees/PA-007', base: 'df1a123' };
  s.runs = [{ run: 'r1', startedAt: ago(38), result: null, costUsd: 1.42 }];
  return [
    { type: 'step', by: 'runner', text: 'code' },
    { type: 'question', by: 'worker', text: 'Q1 for the lead: Should the second click get a 409 or a friendly message?' },
    { type: 'answer', by: 'lead', text: 'Q1: 409 from the API, the panel shows "Ktoś już rozpatrzył tę prośbę".' },
    { type: 'step', by: 'runner', text: 'gate' },
  ];
});
// Ready to test, preview up
const h = mk('bug', 'Checkout: coupon field accepts spaces and fails silently', '');
store.setContract(h.id, CONTRACT, { by: 'lead' });
store.update(h.id, (s) => {
  s.status = 'review';
  s.branch = 'crew/pa-008-coupon-trim';
  s.verdict = { result: 'PASS', score: 8, at: ago(300), run: 'r1', round: 1 };
  s.job = { run: 'r1', step: 'done', startedAt: ago(420), finishedAt: ago(300), worktree: '/home/crew/crew/worktrees/PA-008', base: 'df1a123', diffStat: '4 files changed, 61 insertions(+), 3 deletions(-)', lastGate: { ok: true, checks: [{ name: 'lint', ok: true, ms: 21000 }, { name: 'typecheck', ok: true, ms: 64000 }, { name: 'unit tests', ok: true, ms: 18000 }, { name: 'integration tests', ok: true, ms: 211000 }, { name: 'build', ok: true, ms: 232000 }] } };
  s.runs = [{ run: 'r1', startedAt: ago(420), finishedAt: ago(300), result: 'PASS', costUsd: 2.87 }];
  s.preview = { state: 'up', slot: 1, url: 'https://preview-1.example.com', port: 20111, expiresAt: inMin(95), builtFor: 1, logins: 'Demo trainer, demo admin or a demo customer · password in your notes' };
  return [{ type: 'verdict', by: 'verifier', text: 'PASS · lowest line 8/10 · Trims spaces, shows an error for unknown codes.' }, { type: 'status', by: 'runner', text: 'building → review · ready to test' }, { type: 'preview', by: 'runner', text: 'preview up: https://preview-1.example.com' }];
});
store.writeTicketFile(h.id, 'plan.md', '# Plan\n\n- Trim the coupon code on input and on the server (`src/lib/coupons/apply.ts`).\n- Show "Nieznany kod rabatowy" when no coupon matches.\n- Tests: unit for trim, integration for the unknown-code path.\n', { by: 'worker' });
store.writeTicketFile(h.id, 'check.md', '# Try it\n\n1. Open the preview and log in as the **demo customer** (active access).\n2. Add "Demo pakiet treningowy" to the cart.\n3. In the coupon field type ` DEMO10 ` with spaces. The discount applies.\n4. Type `NOPE`. You see "Nieznany kod rabatowy" under the field.\n', { by: 'worker' });
store.writeTicketFile(h.id, 'verify.md', '# Verifier · PA-008 · round 1\n\n**PASS** · lowest line 8/10\n\nTrims spaces and shows an error for unknown codes.\n\n| Line | Score | Acceptance | Evidence | Note |\n|---|---|---|---|---|\n| A1 | 9/10 | Spaces are trimmed | src/lib/coupons/apply.ts:14, tests/int/coupons.int.spec.ts:88 | |\n| A2 | 8/10 | Unknown code shows an error | src/components/Checkout/Coupon.tsx:52 | Message is Polish, as asked |\n', { by: 'verifier' });
fs.mkdirSync(path.join(store.dir(h.id), 'runs', 'r1'), { recursive: true });
writeFileAtomic(path.join(store.dir(h.id), 'runs', 'r1', 'gate-1.log'), '$ pnpm lint\n✓ no problems\n$ npx tsc --noEmit\n$ pnpm vitest run -c vitest.unit.config.mts\n 31 passed\n');
// Ready to test, preview built (not running)
const i = mk('feature', 'Trainer can add a private note to a client', '');
store.setContract(i.id, CONTRACT, { by: 'lead' });
store.update(i.id, (s) => {
  s.status = 'review';
  s.branch = 'crew/pa-009-client-notes';
  s.verdict = { result: 'PASS', score: 7, at: ago(200), run: 'r2', round: 1 };
  s.job = { run: 'r2', step: 'done', worktree: '/home/crew/crew/worktrees/PA-009', base: 'df1a123', diffStat: '9 files changed, 240 insertions(+)' };
  s.runs = [{ run: 'r1', result: 'BLOCKED', costUsd: 3.1 }, { run: 'r2', result: 'PASS', costUsd: 2.2 }];
  s.preview = { state: 'built', builtFor: 1 };
  s.pr = { url: 'https://github.com/example/shop/compare/main...crew/pa-009-client-notes?expand=1' };
  return { type: 'status', by: 'runner', text: 'building → review · ready to test' };
});
// Blocked
const j = mk('bug', 'Subscription renewal email shows the wrong date', '');
store.setContract(j.id, CONTRACT, { by: 'lead' });
store.update(j.id, (s) => {
  s.status = 'blocked';
  s.job = { run: 'r1', step: 'gate', lastError: 'gate still failing after 2 fix rounds: integration tests', worktree: '/home/crew/crew/worktrees/PA-010', base: 'df1a123' };
  return { type: 'status', by: 'runner', text: 'building → blocked · gate still failing after 2 fix rounds: integration tests' };
});
// Done and parked
const k = mk('chore', 'Remove the stale old-fixes worktree note from CLAUDE.md', '');
store.update(k.id, (s) => {
  s.status = 'done';
  return { type: 'status', by: 'user', text: 'review → done' };
});
const l = mk('idea', 'Discord: weekly leaderboard of training streaks', '');
store.update(l.id, (s) => {
  s.status = 'parked';
  return { type: 'status', by: 'user', text: 'inbox → parked' };
});

// ---- Discussions: design rounds before a plan, one ticket per state (PA-013 … PA-017) ----
// Each round goes the way the runner publishes one: page and summary on disk, the decisions asked
// as questions from the designer ("b: … (recommended)"), then the round on the ticket.
const escHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function roundPage(id, n, r) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${id} · round ${n}</title>
<style>
:root{--ink:#f4f4f5;--ink-2:#d4d4d8;--muted:#a1a1aa;--gold:#e8a33d;--gold-hi:#ffd08a;--line:rgba(228,228,231,.14);--panel:rgba(228,228,231,.03)}
*{box-sizing:border-box}
body{margin:0;background:#09090b;color:var(--ink);font:400 16px/1.6 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}
.label{font:500 11px/1.3 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
h1{font:500 32px/1.15 Georgia,serif;margin:10px 0 12px}
h2{font:500 22px/1.2 Georgia,serif;margin:36px 0 12px}
.lede{color:var(--ink-2)}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.opt{border:1px solid var(--line);border-radius:3px;padding:14px;background:var(--panel)}
.opt.pick{border-color:var(--gold)}
.opt b{display:block;margin-bottom:6px}
.phone{margin:10px 0;border:1px solid var(--line);border-radius:14px;padding:12px;background:#111114}
.bar{height:10px;border-radius:2px;background:rgba(228,228,231,.12);margin:6px 0}
.bar.on{background:var(--gold)}
ol.dec>li{margin:14px 0}
.pick{color:var(--gold-hi);font:500 12px ui-monospace,monospace}
</style></head><body><main>
<p class="label">${id} · round ${n} · discuss only, nothing built</p>
<h1>${escHtml(r.claim)}</h1>
<p class="lede">${escHtml(r.lede)} The decisions at the end are yours.</p>
<h2>Recommendation</h2>
<ul>${r.recommend.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
<h2>Options</h2>
<div class="opts">${r.options.map((o) => `<div class="opt${o.pick ? ' pick' : ''}"><b>${escHtml(o.name)}${o.pick ? ' · recommended' : ''}</b><span>${escHtml(o.shows)}</span><div class="phone"><div class="bar on" style="width:70%"></div><div class="bar"></div><div class="bar" style="width:55%"></div></div><span class="label">Cost ${escHtml(o.cost)}</span></div>`).join('')}</div>
<h2>Decisions</h2>
<ol class="dec">${r.decisions.map((d) => `<li>${escHtml(d.q)}<br>${d.options.map(([k, t]) => `${k}) ${escHtml(t)}`).join(' · ')}<br><span class="pick">Pick: ${d.pick}</span> · ${escHtml(d.why)}</li>`).join('')}</ol>
</main></body></html>
`;
}
function roundSummary(r) {
  return [
    `Recommendation: ${r.recommend[0]}`,
    ...r.recommend.slice(1).map((x) => `- ${x}`),
    '',
    'Options:',
    ...r.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.name}${o.pick ? ' (recommended)' : ''}: ${o.shows} Cost ${o.cost}.`),
    '',
    'Decisions:',
    ...r.decisions.map((d) => `${d.n}. ${d.q} ${d.options.map(([k, t]) => `${k}) ${t}`).join(' / ')}. Pick: ${d.pick}.`),
    '',
    `Touches: ${r.touches}`,
  ].join('\n');
}
const recommended = (d) => d.options.map(([k, t]) => `${k}: ${t}${k === d.pick ? ' (recommended)' : ''}`);
// Publish the round asked for last (discussion.pending), as runner.publishRound does.
function publishRound(id, r, { at, link = null, check = { ok: true, skipped: false, problems: [] }, cost = 1.8 } = {}) {
  const n = store.state(id).discussion.pending.round;
  const dir = path.join(store.dir(id), 'discuss');
  fs.mkdirSync(dir, { recursive: true });
  const summary = (r.summary || roundSummary(r)).trim();
  writeFileAtomic(path.join(dir, `round-${n}.html`), roundPage(id, n, r));
  writeFileAtomic(path.join(dir, `round-${n}.md`), summary + '\n');
  const qids = r.decisions.map((d) => store.ask(id, { text: `Round ${n} · decision ${d.n}: ${d.q}\n${d.why}`, to: 'user', from: 'designer', options: recommended(d) }).qid);
  store.update(id, (s) => {
    const p = s.discussion.pending;
    s.discussion = {
      ...s.discussion,
      state: 'ready',
      step: null,
      pending: null,
      lastError: null,
      recoveries: 0,
      costUsd: Math.round(((s.discussion.costUsd || 0) + cost) * 100) / 100,
      rounds: [...s.discussion.rounds, { n, at, by: p.by, note: p.note, summary: summary.slice(0, 2000), page: `round-${n}.html`, link, questions: qids, check }],
    };
    return { type: 'discussion', by: 'runner', text: `round ${n} is ready${link ? `: ${link}` : ''} · decisions ${qids.join(', ')}` };
  });
  return qids;
}
const answerAll = (id, qids, picks) => qids.forEach((q, i) => store.answer(id, q, { text: picks[i], by: 'user' }));

// Discussing, two rounds, round 2 ready with a public link; all decisions answered.
const booking = mk('feature', 'Clients book a training slot from the course calendar', 'Kasia: clients keep asking on WhatsApp which slots are free. Let them pick a slot in the app; the trainer confirms it.');
store.requestRound(booking.id, { by: 'lead', note: 'Start from how clients ask for a slot today; one simple weekly grid' });
const m1 = {
  claim: 'Clients pick a free slot themselves; the trainer confirms it',
  lede: 'Kasia wants clients to stop asking on WhatsApp which training slots are free.',
  recommend: ['A weekly grid of free slots on the course page; a tap asks for the slot, the trainer confirms. Size M.', 'Touches the course page, a new bookings collection and one email.'],
  options: [{ name: 'Weekly grid', shows: 'Seven days, free slots as chips.', cost: 'M', pick: true }, { name: 'Next free slot only', shows: 'One button, the earliest free slot.', cost: 'S' }],
  decisions: [
    { n: 1, q: 'Who confirms a booked slot?', options: [['a', 'Nobody, it is booked at once'], ['b', 'The trainer, with one tap']], pick: 'b', why: 'Trainers asked to keep control of their week.' },
    { n: 2, q: 'How far ahead can clients book?', options: [['a', 'Two weeks'], ['b', 'Four weeks']], pick: 'a', why: 'Trainers plan two weeks ahead.' },
  ],
  touches: 'course page, bookings collection (new), one email to the trainer.',
};
answerAll(booking.id, publishRound(booking.id, m1, { at: ago(26 * 60), cost: 1.62 }), recommended(m1.decisions[0]).slice(1).concat(recommended(m1.decisions[1]).slice(0, 1)));
store.requestRound(booking.id, { by: 'user', note: 'Show the trainer side too, and what happens when a slot fills up' });
const m2 = {
  claim: 'Trainers confirm from one list; full slots say so and offer the next one',
  lede: 'Round 2 adds the trainer side and the moment a slot fills up while a client is choosing.',
  recommend: [
    'Keep the weekly grid; trainers get a "Requests" list with confirm and decline. Size M.',
    'A full slot turns grey and offers the next free one, so nobody gets a dead end.',
    'One email to the trainer per request, none to the client until it is confirmed.',
    'No payments change: a booking is free; the course access stays as it is.',
  ],
  options: [
    { name: 'Requests list for trainers', shows: 'A list on the trainer dashboard with confirm and decline.', cost: 'M', pick: true },
    { name: 'Calendar for trainers', shows: 'The same grid, with requests marked in it.', cost: 'L' },
    { name: 'Email only', shows: 'The trainer confirms from a link in the email.', cost: 'S' },
  ],
  decisions: [
    { n: 3, q: 'Where does the trainer confirm a request?', options: [['a', 'In the email'], ['b', 'In a Requests list on the dashboard']], pick: 'b', why: 'Emails get lost; the dashboard is open all day.' },
    { n: 4, q: 'What does a client see when the slot fills up?', options: [['a', 'An error'], ['b', 'The next free slot, one tap away']], pick: 'b', why: 'No dead ends.' },
  ],
  touches: 'course page, trainer dashboard (Requests list), bookings collection (new), one email to the trainer, no payment changes.',
};
answerAll(booking.id, publishRound(booking.id, m2, {
  at: ago(55),
  link: 'https://pages.example.com/p/pa-013-discussion.html',
  check: { ok: true, skipped: false, problems: ['390 px: the week grid scrolls sideways inside its own box (allowed)'] },
  cost: 1.95,
}), [recommended(m2.decisions[0])[1], recommended(m2.decisions[1])[1]]);

// Waiting on you: round 1 ready with three open decisions (status waiting, resumes to discussing).
const progress = mk('feature', 'Client progress page: weights and personal records', 'Clients want to see their progress: the weights they lift and their records. Trainers want to add them after a session.');
store.requestRound(progress.id, { by: 'lead', note: 'Who sees what (client, trainer) and how the numbers get in' });
publishRound(progress.id, {
  claim: 'A progress page the trainer fills in after a session, and the client reads',
  lede: 'Clients want to see their weights and records; trainers want to add them in seconds after a session.',
  recommend: ['A "Progress" tab on the client profile; the trainer adds a lift in three taps. Size M.', 'Records are found by the app, not typed in.'],
  options: [{ name: 'Trainer fills in', shows: 'The trainer adds lifts after a session.', cost: 'M', pick: true }, { name: 'Client fills in', shows: 'The client logs their own lifts.', cost: 'M' }],
  decisions: [
    { n: 1, q: 'Who adds the numbers?', options: [['a', 'The client'], ['b', 'The trainer, after the session']], pick: 'b', why: 'Trainers already write notes after each session.' },
    { n: 2, q: 'Which lifts are tracked?', options: [['a', 'A fixed list of 8 lifts'], ['b', 'Any lift the trainer types']], pick: 'a', why: 'A fixed list makes records comparable.' },
    { n: 3, q: 'Does the client see a chart?', options: [['a', 'Yes, per lift over time'], ['b', 'Only the numbers']], pick: 'a', why: 'The chart is the motivating part; it is cheap with the fixed list.' },
  ],
  touches: 'client profile (new Progress tab), lifts collection (new), trainer panel.',
}, { at: ago(40), check: { ok: true, skipped: true, problems: ['not checked: no headless browser (tools.playwright, tools.chromium)'] }, cost: 2.31 });

// The designer is checking round 1.
const referral = mk('idea', 'Referral codes: a client invites a friend', 'A client shares a code; the friend gets 10% off the first package and the client a free session.');
store.requestRound(referral.id, { by: 'lead', note: 'Show the invite flow on the phone, and what the friend sees' });
store.update(referral.id, (s) => {
  s.discussion = { ...s.discussion, state: 'designing', step: 'check', startedAt: ago(7), pending: { ...s.discussion.pending, at: ago(9) } };
  return [{ type: 'discussion', by: 'runner', text: 'round 1: the designer started' }];
});

// Round 2 failed; round 1 is there and can still be accepted.
const availability = mk('feature', 'Trainer availability on the course page', 'Show when each trainer has free hours, so clients pick the course with a trainer who fits their week.');
store.requestRound(availability.id, { by: 'lead', note: 'How availability is entered and where clients see it' });
const p1 = {
  claim: 'Trainers mark their usual hours once; the course page shows them',
  lede: 'Clients want to know when a trainer is free before they buy a course.',
  recommend: ['Usual hours per weekday in the trainer profile, shown as a small week strip on the course page. Size S.'],
  options: [{ name: 'Usual hours', shows: 'A week strip from the trainer profile.', cost: 'S', pick: true }, { name: 'Live calendar', shows: 'Real free slots, synced with bookings.', cost: 'L' }],
  decisions: [
    { n: 1, q: 'What do clients see?', options: [['a', 'Usual hours per weekday'], ['b', 'Exact free slots']], pick: 'a', why: 'Exact slots need the booking feature first.' },
    { n: 2, q: 'Who edits the hours?', options: [['a', 'The trainer'], ['b', 'The admin']], pick: 'a', why: 'Trainers know their week.' },
  ],
  summary: 'Recommendation: usual hours per weekday in the trainer profile, shown as a week strip on the course page. Size S.\nOptions: A. usual hours (recommended), B. live calendar (L, needs bookings).\nDecisions: 1. what clients see, pick a; 2. who edits, pick a.\nTouches: trainer profile, course page.',
};
answerAll(availability.id, publishRound(availability.id, p1, { at: ago(5 * 60), cost: 1.4 }), [recommended(p1.decisions[0])[0], recommended(p1.decisions[1])[0]]);
store.requestRound(availability.id, { by: 'user', note: 'Try a calendar view instead of the week strip' });
store.update(availability.id, (s) => {
  s.discussion = { ...s.discussion, state: 'failed', step: null, startedAt: ago(70), lastError: 'the designer ran out of time without writing page.html', costUsd: 2.65 };
  return [{ type: 'discussion', by: 'runner', text: 'round 2: the designer started' }, { type: 'discussion', by: 'runner', text: 'round 2 failed: the designer ran out of time without writing page.html' }];
});

// Accepted round 2: the lead plans the build (shaping).
const voucher = mk('feature', 'Gift vouchers for a training package', 'Clients want to give a training package as a gift, with a code the friend redeems.');
store.requestRound(voucher.id, { by: 'lead', note: 'The buying and redeeming flow, and what the admin sees' });
const q1 = {
  claim: 'A voucher is a package bought for someone else, redeemed with a code',
  lede: 'Clients want to give a training package as a present.',
  recommend: ['Buy a package "as a gift", get a code and a printable card; the friend redeems the code. Size M.'],
  options: [{ name: 'Code and card', shows: 'A code plus a printable card.', cost: 'M', pick: true }, { name: 'Email to the friend', shows: 'The shop emails the friend directly.', cost: 'M' }],
  decisions: [{ n: 1, q: 'How does the friend get the voucher?', options: [['a', 'A code and a printable card'], ['b', 'An email from the shop']], pick: 'a', why: 'People like to hand over a gift themselves.' }],
  touches: 'checkout, vouchers collection (new), the account page.',
};
answerAll(voucher.id, publishRound(voucher.id, q1, { at: ago(2 * 24 * 60), cost: 1.5 }), [recommended(q1.decisions[0])[0]]);
store.requestRound(voucher.id, { by: 'user', note: 'What happens when a voucher expires or is half used' });
const q2 = {
  claim: 'Vouchers last a year and cover one package, whole',
  lede: 'Round 2 settles expiry and partial use.',
  recommend: ['Valid 12 months, one package, no change given. Size M.', 'The admin sees vouchers sold and redeemed in one list.'],
  options: [{ name: 'Whole package', shows: 'A voucher pays one package in full.', cost: 'M', pick: true }, { name: 'Money value', shows: 'A voucher holds an amount, spent over time.', cost: 'L' }],
  decisions: [
    { n: 2, q: 'How long is a voucher valid?', options: [['a', '6 months'], ['b', '12 months']], pick: 'b', why: 'A gift should not expire before it is used.' },
    { n: 3, q: 'Can a voucher be partly used?', options: [['a', 'No, one package, whole'], ['b', 'Yes, as a money balance']], pick: 'a', why: 'A balance needs accounting the shop does not have.' },
  ],
  touches: 'checkout, vouchers collection (new), account page, admin list.',
};
const q2ids = publishRound(voucher.id, q2, { at: ago(20 * 60), link: 'https://pages.example.com/p/pa-017-discussion.html', cost: 1.7 });
store.answer(voucher.id, q2ids[0], { text: recommended(q2.decisions[0])[1], by: 'user' });
store.acceptRound(voucher.id, { round: 2, by: 'user' });

writeJson(path.join(home, 'runner.json'), {
  mode: 'night',
  current: { ticket: g.id, run: 'r1', step: 'gate', startedAt: ago(38) },
  tonight: { key: new Date().toISOString().slice(0, 10), jobs: 2 },
  usage: { at: ago(3), fiveHour: { utilization: 0.46, resetsAt: inMin(140) }, sevenDay: { utilization: 0.31, resetsAt: inMin(60 * 24 * 4) } },
});
writeJson(path.join(home, 'previews.json'), { 'shop:1': { ticket: h.id, slot: 1, state: 'up', url: 'https://preview-1.example.com', startedAt: ago(25), expiresAt: inMin(95), port: 20111 } });
// The lab (today's app with the demo data) is up. Nothing listens on 20119 in the demo; the link is for show.
writeJson(path.join(home, 'lab.json'), {
  shop: { url: 'http://localhost:20119', state: 'up', by: 'user', startedAt: ago(33), updated: ago(31), expiresAt: inMin(90), sha: 'df1a123c9e4b5a6f7d8e9f0a1b2c3d4e5f6a7b8c', error: null, owner: null },
});
const chat = path.join(home, 'orchestrator', 'chat.jsonl');
for (const m of [
  { ts: ago(600), role: 'user', text: 'Bug: coupon field accepts spaces and then nothing happens. Kasia hit it yesterday.' },
  { ts: ago(599), role: 'lead', text: 'Ready · PA-008 · contract written and queued for tonight. I added a second line: unknown codes show a message.' },
  { ts: ago(240), role: 'event', text: `[event] The coder on ${g.id} asks Q1: "Should the second click get a 409 or a friendly message?"`, ticket: g.id },
  { ts: ago(239), role: 'lead', text: `Answered Q1 on ${g.id}: 409 from the API, friendly Polish message in the panel (D2).` },
  { ts: ago(54), role: 'lead', text: `Round 2 of ${booking.id} is ready: https://pages.example.com/p/pa-013-discussion.html. It adds a Requests list for trainers and offers the next free slot when one fills up. Answer decisions 3 and 4 on the board, or accept the round.` },
  { ts: ago(30), role: 'user', text: 'What is waiting for me?' },
  { ts: ago(29), role: 'lead', text: `Two things: ${c.id} has 2 questions (archived courses), and ${d.id} needs your OK on the plan. ${h.id} is ready to test; its preview is up on slot 1.` },
]) appendJsonl(chat, m);
console.log(`Fixtures written to ${home}: ${store.list().length} tickets`);
