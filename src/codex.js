// Run OpenAI Codex CLI headless (`codex exec --json`) and report the result in the same shape as
// runClaude, so the lead, designers, coders and verifiers can run on either CLI (see agent.js).
// Codex prints JSONL events (thread.started, item.*, turn.completed). Its usage windows
// (5-hour and weekly) and the conversation's size are read afterwards from the session's rollout file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { capped, killTree, openLog, stopScope } from './sysrun.js';

const LIMIT_RE = /(usage limit|rate limit|hit your limit|limit reached|out of credits|try again (?:at|in)\b)/i;
const AUTH_RE = /(codex login|not logged in|please log ?in|unauthori[sz]ed|\b401\b|refresh token|token (?:has )?expired|invalid api key)/i;

// Claude Code's permission modes, mapped to the nearest Codex sandbox. crew's coders run in bypass mode
// inside a separate OS user; Codex's equivalent is no sandbox. The lead's dontAsk + allowlist becomes
// the workspace-write sandbox (writes only in its folders, no network): Codex has no per-command allowlist.
const SANDBOX = { bypassPermissions: 'danger-full-access', dontAsk: 'workspace-write', acceptEdits: 'workspace-write', default: 'workspace-write', plan: 'read-only' };
const EFFORT = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };
// Past this size the role prompt goes into the message instead of one command-line argument.
const MAX_ARG = 100_000;

export function sandboxFor(o) {
  return o.sandbox || SANDBOX[o.permissionMode] || 'workspace-write';
}

// `-c key=value` takes TOML. JSON strings are valid TOML basic strings (bar DEL); objects need inline tables.
export function tomlValue(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'string') return JSON.stringify(v).replace(/\x7f/g, '\\u007f');
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return `{ ${Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlValue(x)}`)
    .join(', ')} }`;
}

export function buildCodexArgs(o, { schemaFile = null } = {}) {
  // `codex exec resume <id>` takes fewer flags than `codex exec`, so everything that matters goes
  // through -c and both forms get the same settings.
  const a = ['exec'];
  if (o.resume) a.push('resume', o.resume);
  a.push('--json', '--skip-git-repo-check');
  const c = (k, v) => a.push('-c', `${k}=${tomlValue(v)}`);
  c('approval_policy', 'never');
  const sandbox = sandboxFor(o);
  c('sandbox_mode', sandbox);
  if (sandbox === 'workspace-write') {
    if (o.addDirs?.length) c('sandbox_workspace_write.writable_roots', o.addDirs.map((d) => path.resolve(d)));
    c('sandbox_workspace_write.network_access', !!o.network);
  }
  // crew already chose the agent's environment (ticket env, sandbox values): let commands see all of it.
  // Codex would otherwise drop every variable whose name holds KEY, SECRET or TOKEN.
  c('shell_environment_policy.inherit', 'all');
  c('shell_environment_policy.ignore_default_excludes', true);
  if (o.effort && EFFORT[o.effort]) c('model_reasoning_effort', EFFORT[o.effort]);
  if (o.appendSystemPrompt && o.appendSystemPrompt.length <= MAX_ARG) c('developer_instructions', o.appendSystemPrompt);
  if (o.stopHook) {
    c('hooks.Stop', [{ hooks: [{ type: 'command', command: o.stopHook.command, timeout: o.stopHook.timeout || 600 }] }]);
    // crew writes this hook itself; without the flag Codex waits for someone to trust it.
    a.push('--dangerously-bypass-hook-trust');
  }
  for (const [k, v] of Object.entries(o.codexConfig || {})) c(k, v);
  if (o.model) a.push('-m', o.model);
  if (schemaFile) a.push('--output-schema', schemaFile);
  a.push('-'); // the prompt comes on stdin
  return a;
}

// OpenAI structured output wants every object closed and every property required.
export function strictSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strictSchema);
  const out = { ...s };
  if (out.type === 'object' && out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, strictSchema(v)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  return out;
}

// "try again at 9:41 PM", "try again at Nov 20th, 2026 9:41 AM" or "try again in 2 days 3 hours 4 minutes".
export function parseCodexReset(text, { now = new Date() } = {}) {
  const s = String(text || '');
  const rel = s.match(/try again in\s+((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[\s,and]*)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*(day|hour|min|sec)/gi)) ms += Number(n) * { day: 864e5, hour: 36e5, min: 6e4, sec: 1e3 }[unit.toLowerCase()];
    return ms ? new Date(now.getTime() + ms) : null;
  }
  const at = s.match(/try again at\s+([^.\n]+?)(?:\.|$|\n)/i);
  if (!at) return null;
  const when = at[1].replace(/(\d+)(st|nd|rd|th)/g, '$1').trim();
  const full = new Date(when);
  if (!Number.isNaN(full.getTime())) return full;
  const t = when.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!t) return null;
  let h = Number(t[1]) % 12;
  if (!t[3]) h = Number(t[1]);
  else if (t[3].toLowerCase() === 'pm') h += 12;
  const d = new Date(now);
  d.setHours(h, Number(t[2]), 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// The rollout file of a thread: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl (newest days first).
export function findRollout(id, { home = codexHome(), maxDays = 400 } = {}) {
  if (!id) return null;
  const root = path.join(home, 'sessions');
  const desc = (d) => {
    try {
      return fs.readdirSync(d).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const f = desc(dir).find((n) => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
        if (f) return path.join(dir, f);
        if (++days >= maxDays) return null;
      }
    }
  }
  return null;
}

// The last token_count event in a rollout: usage windows, and the size of the last model call.
export function readRolloutUsage(file, { tailBytes = 1 << 20 } = {}) {
  if (!file) return null;
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const p = e.payload || {};
    if (p.type !== 'token_count') continue;
    const rl = p.rate_limits || null;
    const last = p.info?.last_token_usage || null;
    const windows = {};
    for (const w of [rl?.primary, rl?.secondary]) {
      if (!w) continue;
      const slot = w.window_minutes <= 300 ? 'five_hour' : 'seven_day';
      windows[slot] = { utilization: (Number(w.used_percent) || 0) / 100, resetsAt: w.resets_at ?? null };
    }
    return {
      windows: Object.keys(windows).length ? windows : null,
      reached: rl?.rate_limit_reached_type || null,
      contextTokens: last ? (last.input_tokens || 0) + (last.output_tokens || 0) : 0,
    };
  }
  return null;
}

// Codex events, shown to crew's callers as the Claude-shaped events they already read
// (assistant text and tool_use blocks), so the lead's live chat works on both.
function toClaudeEvent(e) {
  const it = e.item || {};
  if (e.type === 'item.completed' && it.type === 'agent_message' && it.text) return { type: 'assistant', message: { content: [{ type: 'text', text: it.text }] } };
  if (e.type === 'item.started' && it.type === 'command_execution') return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: it.command || '' } }] } };
  if (e.type === 'item.completed' && it.type === 'file_change') return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: it.changes?.[0]?.path || '' } }] } };
  if (e.type === 'item.started' && it.type === 'mcp_tool_call') return { type: 'assistant', message: { content: [{ type: 'tool_use', name: `${it.server || 'mcp'}.${it.tool || ''}`, input: {} }] } };
  if (e.type === 'item.started' && it.type === 'web_search') return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { pattern: it.query || '' } }] } };
  return null;
}

export function runCodex(o) {
  const bin = o.bin || process.env.CREW_CODEX_BIN || 'codex';
  let schemaFile = null;
  if (o.jsonSchema) {
    schemaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-schema-')), 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(o.jsonSchema)));
  }
  const args = buildCodexArgs(o, { schemaFile });
  const { cmd, args: fullArgs, unit } = capped(bin, args, { memoryMax: o.memoryMax, swapMax: o.swapMax, name: o.unitName });
  const log = openLog(o.logFile);
  log?.write(JSON.stringify({ crew: 'start', engine: 'codex', at: new Date().toISOString(), cwd: o.cwd, args: args.map((x) => (x.startsWith('developer_instructions=') ? 'developer_instructions=…' : x)) }) + '\n');

  // Without these, a key in the service's environment could bill an API account instead of the plan.
  const env = { ...process.env, ...o.env };
  if (!o.allowApiKey) for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY']) if (!(o.env && k in o.env)) delete env[k];
  let prompt = o.prompt || '';
  if (o.appendSystemPrompt && o.appendSystemPrompt.length > MAX_ARG) prompt = `<role>\n${o.appendSystemPrompt}\n</role>\n\n${prompt}`;

  return new Promise((resolve) => {
    const child = spawn(cmd, fullArgs, { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    o.onSpawn?.({ pid: child.pid, unit });
    const stop = () => {
      killTree(child.pid);
      stopScope(unit);
    };
    const res = {
      engine: 'codex',
      code: null,
      sessionId: o.resume || null,
      text: '',
      assistantText: [],
      isError: false,
      subtype: null,
      costUsd: null, // Codex runs on the plan; it reports no price.
      usage: null,
      numTurns: 0,
      durationMs: 0,
      structured: null,
      toolUses: 0,
      limit: { hit: false, resetAt: null, text: '' },
      auth: false,
      timedOut: false,
      rateLimits: [],
      windows: null,
      contextTokens: 0,
      stderr: '',
      warnings: [],
      errorText: '',
      apiErrorStatus: null,
    };
    const started = Date.now();
    let turnDone = false;
    let turnFailed = false;
    let lastError = '';
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      log?.write(line + '\n');
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        res.stderr += line + '\n';
        return;
      }
      if (e.type === 'thread.started' && e.thread_id) res.sessionId = e.thread_id;
      const it = e.item || {};
      if (e.type === 'item.completed' && it.type === 'agent_message' && it.text) res.assistantText.push(it.text);
      if (e.type === 'item.started' && ['command_execution', 'mcp_tool_call', 'web_search'].includes(it.type)) res.toolUses++;
      if (e.type === 'item.completed' && it.type === 'file_change') res.toolUses++;
      // Item errors are notices (e.g. "hook trust is bypassed"), not a failed run.
      if (e.type === 'item.completed' && it.type === 'error') res.warnings.push(String(it.message || ''));
      if (e.type === 'turn.completed') {
        turnDone = true;
        res.numTurns++;
        res.usage = e.usage || res.usage;
      }
      if (e.type === 'turn.failed') {
        turnFailed = true;
        lastError = String(e.error?.message || 'turn failed');
      }
      if (e.type === 'error') lastError = String(e.message || 'error');
      const ce = toClaudeEvent(e);
      if (ce) o.onEvent?.(ce);
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      res.stderr += s;
      log?.write(JSON.stringify({ crew: 'stderr', text: s }) + '\n');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = o.timeoutMs
      ? setTimeout(() => {
          res.timedOut = true;
          stop();
        }, o.timeoutMs)
      : null;
    let finished = false;
    let grace = null;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      clearTimeout(grace);
      if (buf.trim()) handle(buf);
      res.code = code;
      res.durationMs = Date.now() - started;
      res.text = res.assistantText.at(-1) || '';
      res.isError = turnFailed || code !== 0 || (!turnDone && !!lastError);
      res.subtype = res.isError ? 'error' : 'success';
      if (res.isError) res.errorText = lastError || res.stderr.trim().split('\n').at(-1) || '';
      if (o.jsonSchema && !res.isError) {
        try {
          res.structured = JSON.parse(res.text);
        } catch {}
      }
      const usage = readRolloutUsage(findRollout(res.sessionId, { home: codexHome(env) }));
      if (usage) {
        res.windows = usage.windows;
        res.contextTokens = usage.contextTokens;
        if (usage.windows) res.rateLimits.push({ source: 'rollout', ...usage.windows, reached: usage.reached });
      }
      const errText = `${res.errorText}\n${res.stderr}`;
      const full = Object.values(res.windows || {}).find((w) => w.utilization >= 1);
      if (res.isError && (LIMIT_RE.test(errText) || usage?.reached || full)) {
        res.limit.hit = true;
        res.limit.text = ((errText.match(/.*limit.*/i) || [''])[0].trim() || `Codex ${usage?.reached || 'usage'} limit`).slice(0, 300);
        res.limit.resetAt = parseCodexReset(errText) || (full?.resetsAt ? new Date(full.resetsAt < 1e12 ? full.resetsAt * 1000 : full.resetsAt) : null);
      }
      if (!res.limit.hit && res.isError && AUTH_RE.test(errText)) res.auth = true;
      if (schemaFile) fs.rmSync(path.dirname(schemaFile), { recursive: true, force: true });
      log?.end(JSON.stringify({ crew: 'end', code, isError: res.isError, limit: res.limit, auth: res.auth, timedOut: res.timedOut }) + '\n');
      resolve(res);
    };
    child.on('close', (code) => finish(code ?? 1));
    // If a child the agent started keeps the output pipe open, finish anyway shortly after exit.
    child.on('exit', (code) => {
      grace = setTimeout(() => finish(code ?? 1), 15000);
    });
    child.on('error', (err) => {
      res.stderr += String(err.message);
      finish(127);
    });
  });
}
