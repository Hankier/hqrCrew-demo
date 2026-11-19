import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { serve } from '../src/server.js';
import { ROOT } from './helpers.js';

process.env.CREW_NO_SYSTEMD = '1';

test('board API: state, guard header, actions, answers and logs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-srv-'));
  execFileSync(process.execPath, [path.join(ROOT, 'test', 'fixtures.js')], { env: { ...process.env, CREW_HOME: home } });
  process.env.CREW_DEMO = '1';
  process.env.CREW_HOME = home;
  process.env.CREW_ROOT = ROOT;
  const store = new Store(home);
  const app = await serve({ store, root: ROOT, port: 0, quiet: true });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (p, body, headers = { 'x-crew': '1' }) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.board.columns.map((c) => c.key), ['inbox', 'discuss', 'you', 'queue', 'building', 'test', 'done']);
    assert.equal(state.projects[0].slots.length, 2);

    assert.equal((await post('/api/tickets/PA-004/action', { action: 'approve' }, {})).status, 403);
    const approved = await (await post('/api/tickets/PA-004/action', { action: 'approve' })).json();
    assert.equal(approved.state.status, 'queued');

    const a1 = await (await post('/api/tickets/PA-003/answer', { q: 'Q1', text: 'yes, greyed out' })).json();
    assert.equal(a1.status, 'waiting');
    const a2 = await (await post('/api/tickets/PA-003/answer', { q: 'Q2', text: 'yes until their access ends' })).json();
    assert.equal(a2.status, 'shaping');
    await app.lead.chain;
    assert.equal(store.state('PA-003').status, 'ready');

    const bad = await post('/api/tickets/PA-008/action', { action: 'changes', note: '' });
    assert.equal(bad.status, 400);
    const log = await (await fetch(`${base}/api/tickets/PA-008/log/r1/gate-1.log`)).text();
    assert.match(log, /pnpm lint/);

    const created = await (await post('/api/tickets', { type: 'bug', title: 'Typo on checkout', shape: false })).json();
    assert.match(created.id, /^PA-\d{3}$/);
    const view = await (await fetch(`${base}/api/tickets/${created.id}`)).json();
    assert.ok(view.actions.includes('park'));
    assert.equal((await fetch(`${base}/api/tickets/PA-999`)).status, 404);

    // Fails fast with a clear message instead of a silent background error.
    const pv = await post('/api/tickets/PA-001/preview', { op: 'up' });
    assert.equal(pv.status, 400);
    assert.match((await pv.json()).error, /no worktree/);
    assert.equal((await post('/api/runner', { mode: 'sometimes' })).status, 400);
    await post('/api/tickets/PA-012/action', { action: 'drop' });
    const after = await (await fetch(`${base}/api/state`)).json();
    assert.ok(after.board.dropped.some((t) => t.id === 'PA-012'));
    assert.equal(after.projects[0].preview.ttlMinutes, 120);
    // The fixtures have no login: fine on localhost, refused once a request comes through a proxy.
    delete process.env.CREW_DEMO;
    const live = await serve({ store, root: ROOT, port: 0, quiet: true });
    try {
      const liveBase = `http://127.0.0.1:${live.port}`;
      assert.equal((await fetch(`${liveBase}/api/state`, { headers: { 'cf-connecting-ip': '203.0.113.7' } })).status, 503);
      assert.equal((await fetch(`${liveBase}/api/state`)).status, 200);
    } finally {
      live.shutdown();
    }
  } finally {
    app.shutdown();
    delete process.env.CREW_DEMO;
  }
});
