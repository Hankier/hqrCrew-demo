// Runs against real systemd user scopes when the machine has them (skipped otherwise).
// The other test files turn systemd off, which is how a broken scope property once slipped through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canScope, sh } from '../src/sysrun.js';

delete process.env.CREW_NO_SYSTEMD;
const scopes = canScope();

test('a capped command runs in its own scope with a raised kill priority', { skip: !scopes && 'no systemd user scopes here' }, async () => {
  const r = await sh('cat /proc/self/oom_score_adj; cat /proc/self/cgroup', { memoryMax: '256M', name: 'crew-test' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /crew-test-\d+-\d+\.scope/);
  assert.match(r.out, /^500$/m);
});

test('a runaway command dies at its own cap', { skip: !scopes && 'no systemd user scopes here' }, async () => {
  const r = await sh(`node -e "const a=[];for(;;)a.push(Buffer.alloc(16e6,1))"`, { memoryMax: '200M', swapMax: '0', name: 'crew-test', timeoutMs: 60000 });
  assert.notEqual(r.code, 0);
  assert.equal(r.timedOut, false);
});

test('a background child holding the output pipe does not hang the job', async () => {
  const t0 = Date.now();
  const r = await sh('sleep 60 & echo started', { timeoutMs: 90000 });
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
});
