#!/usr/bin/env node
// A stand-in for `claude -p` in tests: speaks the same stream-json and plays the role it is given
// (lead, coder or verifier) with canned, deterministic behaviour. FAKE_* env vars steer it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = fs.readFileSync(0, 'utf8');
const session = arg('--resume') || arg('--session-id') || crypto.randomUUID();
const cwd = process.cwd();
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: session }) + '\n');
const crew = (...a) => execFileSync(process.execPath, [path.join(process.env.CREW_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'bin', 'crew.js'), ...a], { encoding: 'utf8', env: process.env });
const log = (m) => fs.appendFileSync(process.env.FAKE_LOG || '/dev/null', `${new Date().toISOString()} ${m}\n`);

emit({ type: 'system', subtype: 'init', cwd, model: arg('--model') || 'fake', tools: [] });
const util5h = Number(process.env.FAKE_UTIL || 0.2);
emit({ type: 'rate_limit_event', rate_limit_info: { status: process.env.FAKE_LIMIT ? 'rejected' : 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: util5h, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86400 } } } });

function result(text, extra = {}) {
  // FAKE_CONTEXT: report a conversation of this many tokens, as a real model call does.
  const ctx = Number(process.env.FAKE_CONTEXT || 0);
  const usage = ctx ? { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 50 } } : {};
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }], ...usage } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, duration_ms: 1200, total_cost_usd: 0.01, usage: {}, ...extra });
}

if (process.env.FAKE_LIMIT) {
  emit({ type: 'result', subtype: 'success', is_error: true, result: `Claude usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, num_turns: 0, total_cost_usd: 0 });
  process.exit(1);
}

const role = process.env.CREW_ROLE || (cwd.endsWith('orchestrator') ? 'lead' : 'worker');
log(`role=${role} cwd=${cwd} prompt=${prompt.slice(0, 120).replace(/\n/g, ' ')}`);

// Designer: one round's page, summary and decisions in the round folder.
if (role === 'designer') {
  const round = (prompt.match(/Design round (\d+)/) || [])[1] || '1';
  if (process.env.FAKE_DESIGN_SKIP_PAGE && !/stopped without writing/.test(prompt)) {
    result('I looked around and stopped.');
    process.exit(0);
  }
  fs.writeFileSync(path.join(cwd, 'page.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Round ${round}</title></head><body><h1>Round ${round}</h1><p>A weekly check-in. ${process.env.FAKE_DESIGN_LEAK || ''}</p></body></html>`);
  fs.writeFileSync(path.join(cwd, 'summary.md'), `Recommend option b: a weekly check-in form.\n1. Who fills it in? a: the client, b: the trainer. Pick a.\n2. A chart? a: yes, b: not yet. Pick b.\n`);
  fs.writeFileSync(
    path.join(cwd, 'decisions.json'),
    JSON.stringify([
      { n: 1, question: 'Who fills in the weekly check-in?', why: 'Clients know how the week went.', options: [{ key: 'a', text: 'The client' }, { key: 'b', text: 'The trainer' }], pick: 'a' },
      { n: 2, question: 'Show progress as a chart?', options: [{ key: 'a', text: 'Yes' }, { key: 'b', text: 'Not yet' }], pick: 'b' },
    ]),
  );
  result(`Round ${round} page written.`);
  process.exit(0);
}

if (role === 'lead') {
  const added = prompt.match(/The user added (\w+) ([A-Z]+-\d+)/);
  const asks = prompt.match(/The coder on ([A-Z]+-\d+) asks (Q\d+)/);
  const answered = prompt.match(/The user answered (Q\d+) on ([A-Z]+-\d+)/);
  const remembered = prompt.match(/Your notes, orchestrator\/notes\.md:\)\n(.*)/);
  if (added && /wants to discuss it first/.test(prompt)) {
    // As the real lead may: one framing question before round 1 (the user then starts it, or answers).
    result(`Waiting · ${added[2]} · Before round 1: should it cover the trainer's side too, or only the client's?`);
  } else if (/Your conversation restarts after this message/.test(prompt)) {
    crew('notes', '--body', 'The user prefers short answers.\nNext: the lighter build.');
    result('done');
  } else if (added) {
    const id = added[2];
    crew('status', id, 'shaping');
    if (process.env.FAKE_LEAD_ASKS) {
      crew('ask', id, 'Should this also show on the mobile layout?', '--options', 'yes|no');
      result(`Waiting · ${id} · one question for you on the board.`);
    } else {
      crew('contract', id, '--body', `# ${id}\n\n## Goal\nDo the thing the user asked.\n\n## Acceptance\n- A1. The thing works for a normal input.\n- A2. An empty input shows a friendly message.\n`);
      if (added[1] === 'bug') crew('queue', id);
      result(`Ready · ${id} · contract written${added[1] === 'bug' ? ' and queued for tonight' : '; approve it on the board'}.`);
    }
  } else if (asks && process.env.FAKE_LEAD_ESCALATES) {
    crew('escalate', asks[1], asks[2]);
    result(`Waiting · ${asks[1]} · ${asks[2]} is a product call; passed to you.`);
  } else if (asks) {
    crew('answer', asks[1], asks[2], 'Use the existing date format (DD.MM.YYYY), as the rest of the admin does.');
    result(`Answered ${asks[2]} on ${asks[1]} from the decisions.`);
  } else if (answered) {
    const id = answered[2];
    crew('contract', id, '--body', `# ${id}\n\n## Goal\nAs agreed.\n\n## Acceptance\n- A1. Works as the user answered.\n`);
    result(`Ready · ${id} · contract updated with your answer.`);
  } else if (remembered) {
    result(`(fake lead) From my notes: ${remembered[1]}`);
  } else {
    result(`(fake lead) Noted: ${prompt.split('\n').filter(Boolean).pop().slice(0, 120)}`);
  }
  process.exit(0);
}

if (role === 'verifier' || /Verify [A-Z]+-\d+/.test(prompt)) {
  const fail = process.env.FAKE_VERIFY === 'fail' && !fs.existsSync(path.join(cwd, '.crew', 'fixed-after-verify'));
  const verdict = {
    verdict: fail ? 'FAIL' : 'PASS',
    summary: fail ? 'A2 is not covered by a test.' : 'Both lines are met and tested.',
    lines: [
      { id: 'A1', text: 'works', score: 9, evidence: 'src/thing.js:1, tests/thing.spec.js:3' },
      { id: 'A2', text: 'empty input', score: fail ? 4 : 8, evidence: fail ? 'no test' : 'tests/thing.spec.js:9' },
    ],
  };
  result(JSON.stringify(verdict), { structured_output: verdict });
  process.exit(0);
}

// Coder: plan, change, check steps, commit. Optionally ask the lead first.
fs.mkdirSync(path.join(cwd, '.crew'), { recursive: true });
if (process.env.FAKE_CODER_ASKS && !/answer to your question/i.test(prompt)) {
  crew('worker-ask', 'Which date format should the export use?');
  result('I asked the lead and will stop now.');
  process.exit(0);
}
if (/verifier did not accept/i.test(prompt)) fs.writeFileSync(path.join(cwd, '.crew', 'fixed-after-verify'), 'yes\n');
fs.writeFileSync(path.join(cwd, '.crew', 'plan.md'), '# Plan\n\nApproach: add thing.js with a small function and a test for each acceptance line. Files: thing.js, thing.test.js. Risks: none.\n');
fs.writeFileSync(path.join(cwd, 'thing.js'), `export const thing = (x) => (x ? 'ok:' + x : 'Nothing to show yet');\n// run ${Date.now()}\n`);
fs.writeFileSync(path.join(cwd, '.crew', 'check.md'), '# Try it\n\n1. Log in as demo.trainer.\n2. Open the dashboard.\n3. You should see the new thing. An empty one says "Nothing to show yet".\n');
execFileSync('git', ['add', 'thing.js'], { cwd });
execFileSync('git', ['-c', 'user.name=crew', '-c', 'user.email=crew@example.invalid', 'commit', '-qm', `${process.env.CREW_TICKET}: add thing`], { cwd });
result('Done: thing.js with tests, plan and check steps written, committed.');
