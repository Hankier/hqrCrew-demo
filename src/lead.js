// The lead (orchestrator): one Claude Code or Codex conversation that lives in CREW_HOME/orchestrator and
// is resumed turn by turn. Your chat messages and runner events reach it one at a time, in order.
// It changes tickets only through the crew CLI; its own CLAUDE.md (AGENTS.md for Codex) says how it works.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, agentFor, engineName } from './agent.js';
import { digest } from './board.js';
import { readJson, writeJson, appendJsonl, readJsonl, readText, writeFileAtomic, nowIso, uuid, zoned, fmtTime, sleep, fill } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only the crew commands the lead needs: no run, serve, golden, attach, approve, done, drop or preview.
// Web tools are off by default: the lead reads tickets and code written by others (prompt injection).
const LEAD_COMMANDS = ['new', 'status', 'ask', 'answer', 'escalate', 'decide', 'contract', 'story', 'queue', 'discuss', 'note', 'notes', 'set', 'park', 'show', 'list', 'board', 'digest', 'events', 'help'];
export const LEAD_TOOLS = [...LEAD_COMMANDS.flatMap((c) => [`Bash(crew ${c} *)`, `Bash(crew ${c})`]), 'Read', 'Grep', 'Glob'];

export function leadTools(cfg) {
  return cfg.lead?.web ? [...LEAD_TOOLS, 'WebFetch', 'WebSearch'] : LEAD_TOOLS;
}

// The lead's CLAUDE.md (Claude Code) and AGENTS.md (Codex) are made from prompts/lead.md and kept current,
// so a crew update reaches the lead. Remove the first line (the marker) to keep your own edited version instead.
export const LEAD_MARK = '<!-- crew: made from prompts/lead.md and refreshed on every turn; delete this line to keep your own edits -->\n';

export function leadInstructions(home) {
  return LEAD_MARK + fill(readText(path.join(ROOT, 'prompts', 'lead.md')), { home });
}

export const LEAD_FILES = ['CLAUDE.md', 'AGENTS.md'];

export function syncLeadPrompt(home) {
  const want = leadInstructions(home);
  for (const name of LEAD_FILES) {
    const file = path.join(home, 'orchestrator', name);
    const cur = readText(file);
    if ((!cur || cur.startsWith(LEAD_MARK)) && cur !== want) writeFileAtomic(file, want);
  }
}

export class Lead {
  constructor({ store, onChat = () => {}, notify = async () => {}, onUsage = null }) {
    this.store = store;
    this.dir = path.join(store.home, 'orchestrator');
    this.chatFile = path.join(this.dir, 'chat.jsonl');
    this.sessionFile = path.join(this.dir, 'session.json');
    this.onChat = onChat;
    this.notify = notify;
    this.chain = Promise.resolve();
    this.busy = false;
    this.waiting = 0;
    this.onUsage = onUsage;
  }

  history(limit = 120) {
    return readJsonl(this.chatFile, { limit });
  }

  session() {
    return readJson(this.sessionFile, {});
  }

  // Queue a message; turns run strictly one after another (also across processes).
  // It is written to the chat right away, so every device sees it, marked queued if the lead is busy.
  say(text, { from = 'user', ticket = null, lockTimeoutMs = 0 } = {}) {
    const queued = this.busy || this.waiting > 0;
    const msg = this.post(from === 'user' ? 'user' : 'event', text, { ...(ticket ? { ticket } : {}), ...(queued ? { queued: true } : {}) });
    this.waiting++;
    const p = this.chain.then(() => {
      this.waiting--;
      return this.turn(text, { from, ticket, msg, lockTimeoutMs });
    });
    this.chain = p.catch(() => {});
    return p;
  }

  post(role, text, extra = {}) {
    const m = { ts: nowIso(), role, text, ...extra };
    appendJsonl(this.chatFile, m);
    this.onChat(m);
    return m;
  }

  async turn(text, { from, msg, lockTimeoutMs }) {
    const release = await lockDir(path.join(this.store.home, '.lead'), { timeoutMs: lockTimeoutMs });
    this.busy = true;
    this.onChat({ role: 'status', busy: true, started: msg?.ts || null });
    try {
      return await this.ask(text, { from });
    } finally {
      this.busy = false;
      this.onChat({ role: 'status', busy: false });
      release();
    }
  }

  // The lead's memory has three layers: the files (tickets, decisions, chat log) are the truth; notes.md
  // is its own working memory; the conversation is short-lived. When the conversation gets big, the lead
  // first saves what matters to its notes, then a fresh conversation starts from notes + board + recent chat.
  async ask(text, { from, retried = false }) {
    const store = this.store;
    const cfg = store.config();
    syncLeadPrompt(store.home);
    const agent = agentFor(cfg, 'lead');
    let sess = this.session();
    // A conversation from the other CLI can't be resumed: start fresh (the notes carry over).
    if (sess.id && (sess.engine || 'claude') !== agent.engine) sess = {};
    const tooBig = (sess.contextTokens || 0) >= (cfg.lead.rotateAtTokens || 120000) || (sess.turns || 0) >= cfg.lead.rotateAfterTurns;
    if (sess.id && tooBig) await this.handover(sess);
    const fresh = !sess.id || tooBig;
    if (fresh) sess = { id: uuid(), engine: agent.engine, turns: 0, startedAt: nowIso() };
    const z = zoned(new Date(), cfg.timezone);
    const runner = readJson(path.join(store.home, 'runner.json'), null);
    const header = [
      `[${z.weekday} ${z.date} ${String(z.hh).padStart(2, '0')}:${String(z.mm).padStart(2, '0')} ${cfg.timezone}]`,
      `Projects: ${store.projects().map((p) => `${p.key} (${p.prefix}, ${p.name || p.key})`).join(', ') || 'none'}`,
      digest(store.list(), { tz: cfg.timezone, runner, title: 'Board now' }),
    ];
    if (fresh) {
      const notes = readText(this.notesFile).trim();
      if (notes) header.push(`(New conversation. Your notes, orchestrator/notes.md:)\n${notes}`);
      const recent = this.history(16).filter((m) => ['user', 'lead'].includes(m.role)).map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text.slice(0, 400)}`);
      if (recent.length) header.push(`(The last messages, for context:)\n${recent.join('\n')}`);
    }
    const prompt = `${header.join('\n')}\n\n${from === 'user' ? 'Message from the user:' : 'Event:'}\n${text}`;
    const logDir = path.join(this.dir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    let partial = '';
    let contextTokens = 0;
    const res = await runAgent({
      ...agent,
      network: agent.network || !!cfg.lead?.web,
      cwd: this.dir,
      prompt,
      sessionId: fresh ? sess.id : null,
      resume: fresh ? null : sess.id,
      permissionMode: cfg.permissionMode.lead,
      permissionPrompts: 'none',
      allowedTools: leadTools(cfg),
      addDirs: [store.home],
      memoryMax: cfg.memory.leadMax || '1500M',
      swapMax: '256M',
      unitName: 'crew-lead',
      env: { CREW_HOME: store.home, CREW_ROLE: 'lead', PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}` },
      tz: cfg.timezone,
      logFile: path.join(logDir, `${z.date}.jsonl`),
      timeoutMs: 20 * 60e3,
      name: 'crew lead',
      onEvent: (e) => {
        if (e.type === 'assistant') {
          // Each model call reports its full prompt size: the conversation's current size.
          const u = e.message?.usage;
          if (u) contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
          for (const c of e.message?.content || []) {
            if (c.type === 'text' && c.text) {
              partial = c.text;
              this.onChat({ role: 'lead-partial', text: partial });
            }
            if (c.type === 'tool_use') this.onChat({ role: 'lead-tool', text: toolLine(c) });
          }
        }
      },
    });
    if (res.windows) (this.onUsage || ((w) => this.recordUsage(w)))(res.windows);
    if (res.limit.hit) {
      const until = res.limit.resetAt ? fmtTime(res.limit.resetAt.toISOString(), cfg.timezone) : 'the limit resets';
      return this.post('lead', `I'm out of ${engineName(agent.engine)} usage until ${until}. Your message is saved; send it again then, or it waits in the chat.`, { error: 'limit' });
    }
    if (res.auth) return this.post('lead', `${engineName(agent.engine)} on the box is not logged in. Log in as the crew user, then try again.`, { error: 'auth' });
    if (res.isError && !fresh && !retried && /no conversation|not found|no rollout|session|thread\/resume/i.test(`${res.text} ${res.stderr}`)) {
      writeJson(this.sessionFile, {});
      return this.ask(text, { from, retried: true });
    }
    // Codex names its own thread; Claude Code keeps the id crew chose.
    writeJson(this.sessionFile, { ...sess, id: res.sessionId || sess.id, engine: agent.engine, turns: (sess.turns || 0) + 1, lastAt: nowIso(), costUsd: round((sess.costUsd || 0) + (res.costUsd || 0)), contextTokens: contextTokens || res.contextTokens || sess.contextTokens || 0 });
    const reply = (res.text || partial || '').trim() || (res.isError ? `The lead hit an error: ${(res.stderr || '').split('\n')[0].slice(0, 200)}` : '(no reply)');
    return this.post('lead', reply, res.isError ? { error: 'error' } : {});
  }

  get notesFile() {
    return path.join(this.dir, 'notes.md');
  }

  // Before the conversation restarts: one last turn in which the lead saves what a fresh lead needs.
  async handover(sess) {
    const cfg = this.store.config();
    this.post('event', `[crew] The lead's conversation reached ${Math.round((sess.contextTokens || 0) / 1000)}k tokens after ${sess.turns || 0} turns. It saves its notes and starts a fresh conversation.`);
    await runAgent({
      ...agentFor(cfg, 'lead'),
      cwd: this.dir,
      prompt: "Your conversation restarts after this message. Update your notes now with `crew notes --stdin <<'EOF' … EOF` (it replaces the whole file, so keep what still matters): the user's preferences, decisions that span tickets, promises you made, threads in flight. At most 60 lines. Reply: done.",
      effort: 'low',
      resume: sess.id,
      permissionMode: cfg.permissionMode.lead,
      permissionPrompts: 'none',
      allowedTools: leadTools(cfg),
      addDirs: [this.store.home],
      memoryMax: cfg.memory.leadMax || '1500M',
      swapMax: '256M',
      unitName: 'crew-lead',
      env: { CREW_HOME: this.store.home, CREW_ROLE: 'lead', PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}` },
      tz: cfg.timezone,
      logFile: path.join(this.dir, 'logs', 'handover.jsonl'),
      timeoutMs: 10 * 60e3,
    }).catch(() => null);
    writeJson(this.sessionFile, {});
  }

  // Without a runner in this process (crew lead from a terminal): update runner.json under the store lock.
  recordUsage(w) {
    const file = path.join(this.store.home, 'runner.json');
    const iso = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : null);
    this.store.locked(() => {
      const s = readJson(file, {});
      s.usage = {
        at: nowIso(),
        fiveHour: w.five_hour ? { utilization: w.five_hour.utilization, resetsAt: iso(w.five_hour.resetsAt) } : null,
        sevenDay: w.seven_day ? { utilization: w.seven_day.utilization, resetsAt: iso(w.seven_day.resetsAt) } : null,
      };
      writeJson(file, s);
    });
  }
}

// `crew attach`: open the lead's own conversation in your terminal (Claude Code optionally with Remote
// Control, so the Claude app can join; Codex with `codex resume`). Holds the lead lock, so board messages wait instead of splitting the transcript.
export async function attachLead({ store, rc = false }) {
  const { spawnSync } = await import('node:child_process');
  const cfg = store.config();
  const dir = path.join(store.home, 'orchestrator');
  const agent = agentFor(cfg, 'lead');
  if (rc && agent.engine !== 'claude') throw new Error('--rc (Remote Control) needs Claude Code; the lead runs on Codex');
  let sess = readJson(path.join(dir, 'session.json'), {});
  if ((sess.engine || 'claude') !== agent.engine) sess = {};
  syncLeadPrompt(store.home);
  const release = await lockDir(path.join(store.home, '.lead'));
  try {
    let args;
    if (agent.engine === 'codex') {
      args = sess.id ? ['resume', sess.id] : [];
      args.push('--sandbox', 'workspace-write', '--add-dir', store.home);
    } else {
      args = sess.id ? ['--resume', sess.id] : [];
      args.push('--allowedTools', ...leadTools(cfg), '--add-dir', store.home);
      if (rc) args.push('--remote-control', 'crew lead');
    }
    const env = { ...process.env, CREW_HOME: store.home, CREW_ROLE: 'lead', PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}` };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const r = spawnSync(agent.bin, args, { cwd: dir, stdio: 'inherit', env });
    return r.status ?? 0;
  } finally {
    release();
  }
}

function toolLine(c) {
  const i = c.input || {};
  if (c.name === 'Bash') return `$ ${String(i.command || '').split('\n')[0].slice(0, 160)}`;
  if (i.file_path) return `${c.name} ${i.file_path}`;
  if (i.pattern) return `${c.name} ${i.pattern}`;
  return c.name;
}

export async function lockDir(dir, { timeoutMs = 0 } = {}) {
  const start = Date.now();
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), String(process.pid));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.existsSync(path.join(dir, 'owner')) ? fs.readFileSync(path.join(dir, 'owner'), 'utf8') : 0);
      let alive = false;
      try {
        if (pid) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      if (!alive) fs.rmSync(dir, { recursive: true, force: true });
      else if (timeoutMs && Date.now() - start > timeoutMs) throw new Error('the lead is busy (another turn, or an attached session)');
      else await sleep(500);
    }
  }
}

const round = (n) => Math.round(n * 100) / 100;
