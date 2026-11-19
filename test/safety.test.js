// The rules the code review asked for: who may change a contract, what Retry does, when holds
// expire, crash recovery limits, and Cloudflare Access token checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { verifyAccessJwt } from '../src/access.js';
import { readJson, writeJson } from '../src/util.js';
import { tmpHome, CONTRACT } from './helpers.js';

process.env.CREW_NO_SYSTEMD = '1';

test('only the lead or you can change a contract or story', () => {
  const store = new Store(tmpHome());
  const t = store.newTicket({ type: 'bug', title: 'x' });
  assert.throws(() => store.setContract(t.id, CONTRACT, { by: 'worker' }), /Only the lead or the user/);
  assert.throws(() => store.writeTicketFile(t.id, 'contract.md', CONTRACT, { by: 'worker' }), /Only the lead or the user/);
  assert.throws(() => store.writeTicketFile(t.id, 'story.md', 'new story', { by: 'verifier' }), /Only the lead or the user/);
  store.writeTicketFile(t.id, 'plan.md', '# plan', { by: 'worker' });
  store.setContract(t.id, CONTRACT, { by: 'user' });
});

test('retry after a block gives the coder another turn with the reason and fresh limits', () => {
  const store = new Store(tmpHome());
  const t = store.newTicket({ type: 'bug', title: 'x' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'lead' });
  store.update(t.id, (s) => {
    s.status = 'blocked';
    s.job = { run: 'r1', step: 'gate', rounds: { gate: 3, verify: 0, questions: 1, errors: 0 }, lastError: 'gate still failing: integration tests', coderSession: 'abc' };
    return null;
  });
  const s = store.transition(t.id, 'queued', { by: 'user', note: 'retry' });
  assert.equal(s.job.step, 'code');
  assert.equal(s.job.resumeWith, 'retry');
  assert.equal(s.job.rounds.gate, 0);
  assert.match(s.job.feedback, /integration tests/);
  assert.equal(s.job.coderSession, 'abc');
});

test('new tickets never overwrite existing ones; unknown projects are refused', () => {
  const home = tmpHome();
  const store = new Store(home);
  const a = store.newTicket({ type: 'bug', title: 'first' });
  fs.writeFileSync(path.join(home, 'projects', 'demo', 'next-id'), '1\n'); // lost counter
  const b = store.newTicket({ type: 'bug', title: 'second' });
  assert.notEqual(a.id, b.id);
  assert.equal(store.state(a.id).title, 'first');
  assert.throws(() => store.newTicket({ project: '../etc', type: 'bug', title: 'x' }), /Unknown project/);
});

test('the weekly hold lifts once the week has reset', () => {
  const home = tmpHome();
  const store = new Store(home);
  const runner = new Runner({ store });
  const past = new Date(Date.now() - 2 * 86400e3).toISOString();
  const future = new Date(Date.now() + 2 * 86400e3).toISOString();
  writeJson(path.join(home, 'runner.json'), { usage: { sevenDay: { utilization: 0.8, resetsAt: future } } });
  assert.match(runner.holdReason({ ticket: {} }), /weekly usage at 80%/);
  writeJson(path.join(home, 'runner.json'), { usage: { sevenDay: { utilization: 0.8, resetsAt: past } } });
  assert.equal(runner.holdReason({ ticket: {} }), null);
});

test('a job that keeps taking crew down is blocked, and run now survives a restart', () => {
  const home = tmpHome({ limits: { recoveries: 2 } });
  const store = new Store(home);
  const runner = new Runner({ store });
  const t = store.newTicket({ type: 'bug', title: 'x' });
  store.setContract(t.id, CONTRACT);
  store.transition(t.id, 'queued', { by: 'lead' });
  const crash = () =>
    store.update(t.id, (s) => {
      s.status = 'building';
      s.job = { ...(s.job || { run: 'r1', rounds: {} }), step: 'gate', runNow: true };
      return null;
    });
  crash();
  runner.recover();
  assert.equal(store.state(t.id).status, 'queued');
  assert.equal(store.state(t.id).runNow, true);
  crash();
  runner.recover();
  crash();
  runner.recover();
  assert.equal(store.state(t.id).status, 'blocked');
  assert.match(store.state(t.id).job.lastError, /stopped 3 times/);
});

test('recover leaves a job alone while the crew process that owns it is alive', () => {
  const home = tmpHome();
  const store = new Store(home);
  const runner = new Runner({ store });
  const t = store.newTicket({ type: 'bug', title: 'x' });
  store.update(t.id, (s) => {
    s.status = 'building';
    s.job = { run: 'r1', step: 'code', rounds: {} };
    return null;
  });
  // The parent of this test process stands in for another live crew process.
  writeJson(path.join(home, 'runner.json'), { current: { ticket: t.id, pid: process.ppid } });
  const r = runner.recover();
  assert.ok(r.skipped);
  assert.equal(store.state(t.id).status, 'building');
  assert.match(runner.holdReason(), /another crew process/);
  assert.equal(readJson(path.join(home, 'runner.json')).current.ticket, t.id);
});

test('Cloudflare Access tokens: signature, audience, expiry', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const sign = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const opts = { team: 'myteam', aud: 'aud123', keySet: [jwk] };
  const good = { aud: ['aud123'], email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 600, iss: 'https://myteam.cloudflareaccess.com' };
  assert.equal((await verifyAccessJwt(sign(good), opts)).email, 'me@example.com');
  await assert.rejects(verifyAccessJwt(sign({ ...good, aud: ['other'] }), opts), /audience/);
  await assert.rejects(verifyAccessJwt(sign({ ...good, exp: 1 }), opts), /expired/);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyAccessJwt(sign(good, other), opts), /signature/);
  await assert.rejects(verifyAccessJwt('not.a.jwt', opts));
});
