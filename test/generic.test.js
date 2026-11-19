// crew is not tied to one project or language: templates, several projects, project notes, and gate
// rules that understand Python and Go tests as well as JS/TS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { Lab } from '../src/lab.js';
import { structuralChecks } from '../src/gate.js';
import { readJson, writeJson } from '../src/util.js';
import { ROOT, crew, CONTRACT, tmpHome } from './helpers.js';

process.env.CREW_NO_SYSTEMD = '1';

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gen-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  g('add', '.');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  return { dir, base, g };
}

const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test('a lab that fails to start says why on the board', async () => {
  const home = tmpHome({}, { lab: { port: 20198 } });
  const store = new Store(home);
  const lab = new Lab({ store });
  await assert.rejects(() => lab.up('demo'), /no repo\.url/);
  const s = lab.list().find((x) => x.project === 'demo');
  assert.equal(s.state, 'failed');
  assert.match(s.error, /no repo\.url/);
});

test('the gate sees a skipped pytest test and a deleted Python test file', () => {
  const { dir, base, g } = repo({ 'app/core.py': 'def f():\n    return 1\n', 'tests/test_core.py': 'def test_f():\n    assert True\n', 'tests/test_old.py': 'def test_old():\n    assert True\n' });
  fs.writeFileSync(path.join(dir, 'tests/test_core.py'), 'import pytest\n\n@pytest.mark.skip(reason="later")\ndef test_f():\n    assert True\n');
  fs.rmSync(path.join(dir, 'tests/test_old.py'));
  g('add', '-A');
  g('commit', '-qm', 'change');
  const f = failed(structuralChecks({ cwd: dir, base }));
  assert.ok(f.includes('no test files deleted'), f.join(', '));
  assert.ok(f.includes('no test switched off (.only, skip marks)'), f.join(', '));
});

test('the gate sees t.Skip in Go and .only in TS, but not skip words in app code', () => {
  const { dir, base, g } = repo({ 'pkg/a_test.go': 'package a\n', 'src/a.spec.ts': "it('x', () => {})\n", 'src/app.py': 'x = 1\n' });
  fs.appendFileSync(path.join(dir, 'pkg/a_test.go'), 'func TestA(t *testing.T) { t.Skip("later") }\n');
  fs.appendFileSync(path.join(dir, 'src/a.spec.ts'), "it.only('y', () => {})\n");
  fs.appendFileSync(path.join(dir, 'src/app.py'), 'def skip(x):\n    return pytest.skip(x)  # app code, not a test\n');
  g('add', '-A');
  g('commit', '-qm', 'change');
  const c = structuralChecks({ cwd: dir, base }).find((x) => x.name.startsWith('no test switched off'));
  assert.equal(c.ok, false);
  assert.match(c.detail, /a_test\.go/);
  assert.match(c.detail, /a\.spec\.ts/);
  assert.doesNotMatch(c.detail, /app\.py/);
});

test('crew init has Node and Python templates', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-init-'));
  let r = crew(home, ['init', '--project', 'discbot', '--prefix', 'KB', '--name', 'Discord bot', '--template', 'node']);
  assert.equal(r.code, 0, r.err);
  r = crew(home, ['init', '--project', 'stats', '--prefix', 'ST', '--template', 'python']);
  assert.equal(r.code, 0, r.err);
  r = crew(home, ['init', '--project', 'shop', '--prefix', 'SH']);
  assert.equal(r.code, 0, r.err);
  const py = readJson(path.join(home, 'projects', 'stats', 'project.json'));
  assert.equal(py.prefix, 'ST');
  assert.ok(py.gate.some((g) => /pytest/.test(g.run)));
  assert.equal(readJson(path.join(home, 'projects', 'discbot', 'project.json')).name, 'Discord bot');
  assert.equal(readJson(path.join(home, 'projects', 'shop', 'project.json')).prefix, 'SH');
  assert.ok(!fs.existsSync(path.join(home, 'projects', 'stats', 'coder.md')));
  assert.equal(crew(home, ['init', '--project', 'x', '--template', 'cobol']).code, 1);
});

test('one crew, several projects: own prefixes, and each coder gets its project notes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-multi-'));
  writeJson(path.join(home, 'crew.json'), { timezone: 'Europe/Warsaw' });
  writeJson(path.join(home, 'projects', 'shop', 'project.json'), { prefix: 'PA', name: 'Shop' });
  writeJson(path.join(home, 'projects', 'bot', 'project.json'), { prefix: 'KB', name: 'Bot' });
  fs.writeFileSync(path.join(home, 'projects', 'bot', 'coder.md'), '## Project notes: Bot\n- Never ping @everyone.\n');
  const store = new Store(home);
  const a = store.newTicket({ project: 'shop', type: 'bug', title: 'a' });
  const b = store.newTicket({ project: 'bot', type: 'bug', title: 'b' });
  assert.equal(a.id, 'PA-001');
  assert.equal(b.id, 'KB-001');
  const runner = new Runner({ store });
  const st = { ...store.state(b.id), branch: 'crew/kb-001-b', job: { base: 'abc', resumeWith: null, coderSession: null } };
  const { system } = runner.coderPrompt(st, store.project('bot'));
  assert.match(system, /Never ping @everyone/);
  assert.doesNotMatch(system, /\{projectNotes\}/);
  const shop = runner.coderPrompt({ ...store.state(a.id), branch: 'x', job: { base: 'abc' } }, store.project('shop')).system;
  assert.doesNotMatch(shop, /Never ping/);
  store.setContract(a.id, CONTRACT);
  store.setContract(b.id, CONTRACT);
  store.transition(a.id, 'queued', { by: 'lead' });
  store.transition(b.id, 'queued', { by: 'lead', note: 'other project' });
  store.update(b.id, (s) => {
    s.priority = 1;
    return null;
  });
  writeJson(path.join(home, 'runner.json'), { mode: 'always' });
  assert.equal(new Runner({ store }).nextTicket().id, 'KB-001');
});
