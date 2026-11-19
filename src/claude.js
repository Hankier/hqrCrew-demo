// Run Claude Code headless (`claude -p`) and read its stream-json output.
// Everything crew's agents do goes through here: the lead, coders and verifiers.
import { spawn } from 'node:child_process';
import { capped, killTree, openLog, stopScope } from './sysrun.js';
import { zoned } from './util.js';

const LIMIT_RE = /(usage limit|rate limit|hit your limit|limit reached|out of (?:extra )?usage|weekly limit|session limit)/i;
const AUTH_RE = /(oauth|\/login|please log ?in|not logged in|authenticat|invalid api key|invalid.*credential|401\b|token (?:has )?expired)/i;

export function buildArgs(o) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.model) a.push('--model', o.model);
  if (o.effort) a.push('--effort', o.effort);
  if (o.resume) a.push('--resume', o.resume);
  else if (o.sessionId) a.push('--session-id', o.sessionId);
  if (o.resume && o.forkSession) a.push('--fork-session');
  if (o.appendSystemPrompt) a.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.permissionMode) a.push('--permission-mode', o.permissionMode);
  if (o.permissionPrompts) a.push('--permission-prompts', o.permissionPrompts);
  if (o.allowedTools?.length) a.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools?.length) a.push('--disallowedTools', ...o.disallowedTools);
  if (o.tools) a.push('--tools', o.tools);
  if (o.settings) a.push('--settings', typeof o.settings === 'string' ? o.settings : JSON.stringify(o.settings));
  if (o.addDirs?.length) a.push('--add-dir', ...o.addDirs);
  if (o.jsonSchema) a.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.maxBudgetUsd) a.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.name) a.push('--name', o.name);
  if (o.strictMcp) a.push('--strict-mcp-config');
  return a;
}

// Turn "resets 3am (Europe/Warsaw)", "…|1729526400" or an epoch into a Date in the future.
export function parseReset(text, { tz = 'Europe/Warsaw', now = new Date() } = {}) {
  if (text == null) return null;
  if (typeof text === 'number') return new Date(text < 1e12 ? text * 1000 : text);
  const s = String(text);
  const epoch = s.match(/\|(\d{10,13})\b/) || s.match(/"resetsAt"\s*:\s*(\d{10,13})/);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const m = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (!m[3]) h = Number(m[1]);
  else if (m[3].toLowerCase() === 'pm') h += 12;
  const min = Number(m[2] || 0);
  const zone = m[4] && /\//.test(m[4]) ? m[4] : tz;
  // Walk forward minute by minute (max 48 h) until the wall clock in `zone` matches.
  const start = new Date(Math.ceil(now.getTime() / 60000) * 60000);
  for (let i = 0; i <= 48 * 60; i++) {
    const d = new Date(start.getTime() + i * 60000);
    const z = zoned(d, zone);
    if (z.hh === h && z.mm === min) return d;
  }
  return null;
}

export function runClaude(o) {
  const bin = o.bin || process.env.CREW_CLAUDE_BIN || 'claude';
  const args = buildArgs(o);
  const { cmd, args: fullArgs, unit } = capped(bin, args, { memoryMax: o.memoryMax, swapMax: o.swapMax, name: o.unitName });
  const log = openLog(o.logFile);
  log?.write(JSON.stringify({ crew: 'start', at: new Date().toISOString(), cwd: o.cwd, args: args.filter((x, i) => args[i - 1] !== '--append-system-prompt') }) + '\n');

  // With ANTHROPIC_API_KEY set, `claude -p` bills the API key instead of the Max subscription.
  const env = { ...process.env, ...o.env };
  if (!o.allowApiKey) delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve) => {
    const child = spawn(cmd, fullArgs, { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    o.onSpawn?.({ pid: child.pid, unit });
    const stop = () => {
      killTree(child.pid);
      stopScope(unit);
    };
    const res = {
      code: null,
      sessionId: o.resume || o.sessionId || null,
      text: '',
      assistantText: [],
      isError: false,
      subtype: null,
      costUsd: 0,
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
      stderr: '',
      // The CLI's own error message (result.result of an error result) and HTTP status, never the
      // model's prose: an agent writing "/login returns 401" must not look like a login problem.
      errorText: '',
      apiErrorStatus: null,
      sawResult: false,
    };
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
      if (e.session_id) res.sessionId = e.session_id;
      const kind = `${e.type || ''}:${e.subtype || ''}`;
      if (/rate_limit/.test(kind)) {
        const info = e.rate_limit_info || e;
        res.rateLimits.push(info);
        // e.g. {five_hour: {utilization: 0.4, resetsAt: 1792601400}, seven_day: {...}}
        if (info.unifiedWindows) res.windows = info.unifiedWindows;
        if (/reject|exceeded|blocked/i.test(String(info.status || ''))) {
          res.limit.hit = true;
          res.limit.resetAt = parseReset(info.resetsAt ?? info.resets_at ?? null, { tz: o.tz }) || res.limit.resetAt;
          res.limit.text = `rate limit ${info.rateLimitType || ''} ${info.status}`.trim();
        }
        // Extra (paid) usage: the night shift never spends it. Stop now and park like a limit.
        if ((info.isUsingOverage === true || info.overageInUse === true) && o.stopOnOverage !== false && !res.limit.hit) {
          res.limit.hit = true;
          res.limit.overage = true;
          res.limit.resetAt = parseReset(info.resetsAt ?? null, { tz: o.tz });
          res.limit.text = 'the next step would use paid extra usage';
          stop();
        }
      }
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c.type === 'text' && c.text) res.assistantText.push(c.text);
          if (c.type === 'tool_use') res.toolUses++;
        }
      }
      if (e.type === 'result') {
        res.sawResult = true;
        res.subtype = e.subtype || null;
        res.isError = !!e.is_error || (e.subtype && e.subtype !== 'success');
        res.text = typeof e.result === 'string' ? e.result : res.assistantText.at(-1) || '';
        res.errorText = res.isError && typeof e.result === 'string' ? e.result : '';
        res.apiErrorStatus = e.api_error_status ?? null;
        res.costUsd = e.total_cost_usd || 0;
        res.usage = e.usage || null;
        res.numTurns = e.num_turns || 0;
        res.durationMs = e.duration_ms || 0;
        res.structured = e.structured_output ?? null;
      }
      o.onEvent?.(e);
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
    child.stdin.end(o.prompt || '');
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
      const failed = res.isError || code !== 0;
      const errText = `${res.errorText}\n${res.stderr}`;
      if (!res.limit.hit && failed && (res.apiErrorStatus === 429 || LIMIT_RE.test(errText))) {
        res.limit.hit = true;
        res.limit.text = ((errText.match(/.*(?:limit).*/i) || [''])[0].trim() || 'HTTP 429').slice(0, 300);
        res.limit.resetAt = parseReset(errText, { tz: o.tz });
      }
      if (!res.limit.hit && failed && ([401, 403].includes(res.apiErrorStatus) || AUTH_RE.test(errText))) res.auth = true;
      if (!res.sawResult && code !== 0) res.isError = true;
      log?.end(JSON.stringify({ crew: 'end', code, isError: res.isError, limit: res.limit, auth: res.auth, timedOut: res.timedOut }) + '\n');
      delete res.sawResult;
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
