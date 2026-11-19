#!/usr/bin/env node
// A stand-in for `codex exec --json` in tests. It plays the same roles as fake-claude.js (it runs it and
// turns its stream-json into Codex JSONL events), writes a rollout file with usage windows the way Codex
// does, and runs the Stop hook from `-c hooks.Stop=…`: a block makes it continue with the hook's reason.
// FAKE_* env vars steer it as they steer fake-claude; FAKE_CODEX_BREAK=1 leaves a syntax error behind
// once, so the coder's Stop-hook gate blocks it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAKE_CLAUDE = path.join(HERE, 'fake-claude.js');
const args = process.argv.slice(2);
const log = (m) => fs.appendFileSync(process.env.FAKE_LOG || '/dev/null', `${new Date().toISOString()} codex ${m}\n`);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const cwd = process.cwd();

if (args[0] !== 'exec') {
  console.error('fake codex: only `exec` is supported');
  process.exit(2);
}
const resume = args[1] === 'resume' ? args[2] : null;
const config = [];
for (let i = 0; i < args.length; i++) if (args[i] === '-c') config.push(args[++i]);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const setting = (key) => config.find((c) => c.startsWith(`${key}=`))?.slice(key.length + 1);
const hookToml = setting('hooks.Stop');
const hookCmd = hookToml ? JSON.parse(hookToml.match(/command = ("(?:[^"\\]|\\.)*")/)[1]) : null;
const schema = flag('--output-schema');
if (schema) {
  const s = JSON.parse(fs.readFileSync(schema, 'utf8'));
  if (s.additionalProperties !== false) throw new Error('fake codex: the output schema must be strict');
}
const id = resume || crypto.randomUUID();
const prompt = fs.readFileSync(0, 'utf8');
log(`id=${id} resume=${!!resume} sandbox=${setting('sandbox_mode')} dev=${setting('developer_instructions') ? 'yes' : 'no'} hook=${hookCmd ? 'yes' : 'no'} schema=${schema ? 'yes' : 'no'} prompt=${prompt.slice(0, 80).replace(/\n/g, ' ')}`);

const now = Math.floor(Date.now() / 1000);
function rollout({ used5h }) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).find((f) => f.endsWith(`-${id}.jsonl`));
  const file = path.join(dir, existing || `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  const ctx = Number(process.env.FAKE_CONTEXT || 1000);
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: ctx + 10, cached_input_tokens: ctx, output_tokens: 50 } },
      rate_limits: { primary: { used_percent: used5h, window_minutes: 300, resets_at: now + 3600 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: now + 5 * 86400 }, rate_limit_reached_type: used5h >= 100 ? 'primary' : null },
    },
  };
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
}

emit({ type: 'thread.started', thread_id: id });
emit({ type: 'turn.started' });
if (process.env.FAKE_LIMIT) {
  rollout({ used5h: 100 });
  emit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro, or try again in 1 hour 5 minutes." } });
  process.exit(1);
}

// One agent turn: fake-claude does the role's work; its replies become agent_message items.
function turn(text, resumeId) {
  const r = spawnSync(process.execPath, [FAKE_CLAUDE, '-p', ...(resumeId ? ['--resume', resumeId] : ['--session-id', id])], { input: text, cwd, env: process.env, encoding: 'utf8' });
  let last = '';
  let failed = r.status !== 0;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type === 'assistant') {
      for (const c of e.message?.content || []) {
        if (c.type === 'text') {
          last = c.text;
          emit({ type: 'item.completed', item: { id: `item_${crypto.randomUUID().slice(0, 8)}`, type: 'agent_message', text: c.text } });
        }
      }
    }
    if (e.type === 'result' && e.is_error) failed = true;
  }
  if (r.stderr) process.stderr.write(r.stderr);
  return { last, failed };
}

let res = turn(prompt, resume);
for (let loop = 0; hookCmd && !res.failed && loop < 4; loop++) {
  if (process.env.FAKE_CODEX_BREAK && !fs.existsSync(path.join(cwd, '.crew', 'broke-once'))) {
    fs.mkdirSync(path.join(cwd, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.crew', 'broke-once'), 'yes\n');
    fs.writeFileSync(path.join(cwd, 'thing.js'), 'export const thing = (;\n');
  }
  const input = JSON.stringify({ session_id: id, cwd, hook_event_name: 'Stop', stop_hook_active: loop > 0, last_assistant_message: res.last });
  const h = spawnSync('sh', ['-c', hookCmd], { input, cwd, env: process.env, encoding: 'utf8' });
  let out = null;
  try {
    out = h.stdout.trim() ? JSON.parse(h.stdout) : null;
  } catch {}
  if (h.status === 2 || out?.decision === 'block') {
    const reason = out?.reason || h.stderr;
    log(`stop hook blocked: ${reason.split('\n')[0]}`);
    res = turn(reason, id);
    continue;
  }
  break;
}
rollout({ used5h: Number(process.env.FAKE_UTIL || 0.2) * 100 });
if (res.failed) {
  emit({ type: 'turn.failed', error: { message: 'fake codex: the turn failed' } });
  process.exit(1);
}
emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80 } });
