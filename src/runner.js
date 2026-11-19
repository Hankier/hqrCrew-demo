// The night shift. Picks the next queued ticket and walks it through:
//   prepare (worktree, deps, database) → code (coder) → gate (script) → verify (fresh verifier) → publish
// Every step is saved in the ticket, so a usage limit, a question or a restart resumes where it stopped.
// Design rounds (the Discuss stage) go first and don't wait for the night: you are waiting for them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, agentFor, engineName } from './agent.js';
import { runGate, gateSummary, failures } from './gate.js';
import { queueOrder, runnerLine } from './board.js';
import { openQuestions, CrewError } from './store.js';
import { ticketEnv, ticketVars, dbUrl, parseEnvFile } from './env.js';
import { pageCheck, findTools } from './pagetools.js';
import { ensureWorktree, ensureMirror, diffStat, headSha, dirtyFiles, discardChanges, removeWorktree } from './workspace.js';
import * as db from './db.js';
import { sh, freeDiskGb, killTree, stopScope, stopOrphanScopes } from './sysrun.js';
import { readJson, writeJson, readText, writeFileAtomic, nowIso, inWindow, nightKey, fill, uuid, sleep, fmtTime } from './util.js';
import { heavyLock } from './heavy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREW_BIN = path.join(ROOT, 'bin', 'crew.js');

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    summary: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          score: { type: 'integer', minimum: 1, maximum: 10 },
          evidence: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'score', 'evidence'],
      },
    },
    preexisting: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'lines'],
};

export class Runner {
  constructor({ store, log = () => {}, notify = async () => {}, lead = null, onChange = () => {} }) {
    this.store = store;
    this.log = log;
    this.notify = notify;
    this.lead = lead;
    this.onChange = onChange;
    this.file = path.join(store.home, 'runner.json');
    this.current = null;
    this.child = null;
    this.stopping = false;
  }

  // ---- runner state (runner.json) -------------------------------------------------------

  state() {
    const cfg = this.store.config();
    const s = readJson(this.file, {});
    return {
      mode: cfg.runner.mode,
      ...s,
      window: `${cfg.nightShift.start}–${cfg.nightShift.end}`,
      inWindow: inWindow(new Date(), cfg.nightShift.start, cfg.nightShift.end, cfg.timezone),
      current: this.current || s.current || null,
    };
  }

  // runner.json is written by the runner and the lead (usage); the store lock keeps the writes whole.
  save(patch) {
    const s = this.store.locked(() => {
      const next = { ...readJson(this.file, {}), ...patch, updated: nowIso() };
      writeJson(this.file, next);
      return next;
    });
    this.onChange(s);
    return s;
  }

  setMode(mode) {
    if (!['night', 'always', 'paused'].includes(mode)) throw new CrewError(`Mode must be night, always or paused, not "${mode}"`);
    return this.save({ mode });
  }

  // From a run's rate_limit_event: {five_hour: {utilization, resetsAt}, seven_day: {...}}
  recordUsage(res) {
    if (!res?.windows) return;
    const w = res.windows;
    this.save({
      usage: {
        at: nowIso(),
        fiveHour: w.five_hour ? { utilization: w.five_hour.utilization, resetsAt: toIso(w.five_hour.resetsAt) } : null,
        sevenDay: w.seven_day ? { utilization: w.seven_day.utilization, resetsAt: toIso(w.seven_day.resetsAt) } : null,
      },
    });
  }

  // ---- scheduling --------------------------------------------------------------------------

  // Why the runner would not start a job right now (null = it may start).
  holdReason({ ticket } = {}) {
    const cfg = this.store.config();
    const s = this.state();
    const now = new Date();
    if (this.current) return `busy with ${this.current.ticket}`;
    const other = s.current?.pid && s.current.pid !== process.pid && pidAlive(s.current.pid) ? s.current : null;
    if (other) return `another crew process (${other.pid}) is working on ${other.ticket}`;
    if (s.mode === 'paused') return 'paused';
    if (s.authProblem) return `${engineName(s.authEngine || 'claude')} login needed: ${s.authProblem}`;
    if (s.parkedUntil && new Date(s.parkedUntil) > now) return `usage limit, resets ${fmtTime(s.parkedUntil, cfg.timezone)}`;
    const u = s.usage;
    const budget = cfg.budget || { fiveHourMax: 0.9, sevenDayMax: 0.75 };
    if (u?.fiveHour && u.fiveHour.utilization >= budget.fiveHourMax && new Date(u.fiveHour.resetsAt) > now) {
      return `5-hour window at ${Math.round(u.fiveHour.utilization * 100)}%, resets ${fmtTime(u.fiveHour.resetsAt, cfg.timezone)}`;
    }
    if (u?.sevenDay && u.sevenDay.utilization >= budget.sevenDayMax && new Date(u.sevenDay.resetsAt) > now && !ticket?.runNow) {
      return `weekly usage at ${Math.round(u.sevenDay.utilization * 100)}%; the rest is kept for your daytime work`;
    }
    const safety = cfg.safety || {};
    if (safety.backupStatusFile) {
      let okAt = null;
      try {
        okAt = readJson(safety.backupStatusFile, {}).okAt;
      } catch {}
      if (!okAt || now - new Date(okAt) > safety.backupMaxAgeHours * 3600e3) return `no good database backup in the last ${safety.backupMaxAgeHours} h; the night shift waits for one`;
    }
    const gb = freeDiskGb(this.store.home);
    if (gb < cfg.limits.minFreeDiskGb) return `only ${gb.toFixed(1)} GB disk free (needs ${cfg.limits.minFreeDiskGb})`;
    return null;
  }

  nextTicket({ ignoreWindow = false } = {}) {
    const cfg = this.store.config();
    const s = this.state();
    const queue = queueOrder(this.store.list({ status: 'queued' }));
    const night = nightKey(new Date(), cfg.nightShift.start, cfg.timezone);
    const usedTonight = s.tonight?.key === night ? s.tonight.jobs : 0;
    for (const t of queue) {
      const allowed = ignoreWindow || t.runNow || s.mode === 'always' || (s.inWindow && usedTonight < cfg.nightShift.maxJobsPerNight);
      if (allowed) return t;
    }
    return null;
  }

  // Discussions waiting for their next design round, oldest request first.
  nextDesign() {
    return this.store
      .list({ status: ['discussing', 'waiting'] })
      .filter((t) => t.discussion?.state === 'queued' && t.discussion.pending)
      .sort((a, b) => a.discussion.pending.at.localeCompare(b.discussion.pending.at))[0] || null;
  }

  async tick() {
    if (this.current || this.stopping) return null;
    // A design round runs as soon as it may (you asked for it and wait for the page); builds wait for the night.
    const design = this.nextDesign();
    const next = design ? null : this.nextTicket();
    // lastHold says why the next job is not running; it is cleared as soon as nothing holds it back.
    const hold = design ? this.holdReason({ ticket: { ...design, runNow: true } }) : next ? this.holdReason({ ticket: next }) : null;
    if ((readJson(this.file, {}).lastHold || null) !== hold) this.save({ lastHold: hold });
    if (hold) return null;
    if (design) return this.runDesign(design.id);
    if (next) return this.runJob(next.id);
    return null;
  }

  async loop() {
    const cfg = this.store.config();
    this.recover();
    this.log(`runner: ${runnerLine(this.state(), cfg.timezone)}`);
    for (;;) {
      if (this.stopping) return;
      try {
        await this.tick();
      } catch (e) {
        this.log(`runner error: ${e.stack || e}`);
      }
      await sleep((this.store.config().runner.tickSeconds || 20) * 1000);
    }
  }

  async runOnce({ ticket, ignoreWindow = false } = {}) {
    const t = ticket ? this.store.state(ticket) : this.nextTicket({ ignoreWindow });
    if (!t) return { ran: false, reason: 'queue is empty' };
    if (t.status !== 'queued') return { ran: false, reason: `${t.id} is ${t.status}, not queued` };
    const hold = this.holdReason({ ticket: { ...t, runNow: t.runNow || ignoreWindow } });
    if (hold) return { ran: false, reason: hold };
    return this.runJob(t.id);
  }

  // After a crash or restart: tickets left "building" go back to the top of the queue, unless the
  // crew process that owns the job is still alive. Leftover agent processes are stopped first, and a
  // job that keeps taking crew down is blocked instead of looping all night.
  recover() {
    const saved = readJson(this.file, {}).current;
    if (saved?.pid && saved.pid !== process.pid && pidAlive(saved.pid)) return { skipped: `crew process ${saved.pid} still runs ${saved.ticket}` };
    const stopped = stopOrphanScopes();
    if (saved?.childPid && pidAlive(saved.childPid)) killTree(saved.childPid);
    const limit = this.store.config().limits.recoveries ?? 2;
    const moved = [];
    for (const t of this.store.list({ status: 'building' })) {
      this.store.update(t.id, (s) => {
        const recoveries = (s.job?.recoveries || 0) + 1;
        if (recoveries > limit) {
          s.status = 'blocked';
          s.job = { ...s.job, recoveries, lastError: `crew stopped ${recoveries} times during ${s.job?.step}; look at the logs before retrying` };
          return { type: 'status', by: 'runner', text: `building → blocked · ${s.job.lastError}`, data: { from: 'building', to: 'blocked' } };
        }
        s.status = 'queued';
        s.order = -Date.now();
        s.runNow = !!s.job?.runNow;
        s.job = { ...s.job, interrupted: true, recoveries, resumeWith: s.job?.step === 'code' ? 'restart' : s.job?.resumeWith };
        return { type: 'status', by: 'runner', text: 'building → queued · resumed after a restart', data: { from: 'building', to: 'queued' } };
      });
      moved.push(t.id);
    }
    for (const t of this.store.list().filter((x) => x.discussion?.state === 'designing')) {
      this.store.update(t.id, (s) => {
        const recoveries = (s.discussion.recoveries || 0) + 1;
        const failed = recoveries > limit;
        s.discussion = { ...s.discussion, state: failed ? 'failed' : 'queued', step: null, recoveries, lastError: failed ? `crew stopped ${recoveries} times during this round` : null };
        return { type: 'discussion', by: 'runner', text: failed ? `round ${s.discussion.pending?.round} failed: ${s.discussion.lastError}` : `round ${s.discussion.pending?.round} restarts after a crew restart` };
      });
      moved.push(t.id);
    }
    if (saved) this.save({ current: null });
    return { moved, stopped };
  }

  stop() {
    this.stopping = true;
    if (this.current?.childPid) killTree(this.current.childPid);
    if (this.current?.unit) stopScope(this.current.unit);
  }

  // Remember the agent process of the current step, so a restart can stop it.
  track({ pid, unit }) {
    if (!this.current) return;
    this.current = { ...this.current, childPid: pid, unit };
    this.save({ current: this.current });
  }

  // ---- one job -------------------------------------------------------------------------------

  async runJob(id) {
    const store = this.store;
    const cfg = store.config();
    let s = store.state(id);
    const project = store.project(s.project);
    // A new run starts fresh, or (after you asked for changes) keeps the coder's session and worktree.
    const newRun = !s.job || s.job.step === 'done' || !!s.job.newRun;
    const resuming = !newRun;
    const run = newRun ? `r${(s.runs?.length || 0) + 1}` : s.job.run;
    const runDir = path.join(store.dir(id), 'runs', run);
    fs.mkdirSync(runDir, { recursive: true });
    const deadline = Date.now() + cfg.nightShift.maxJobMinutes * 60e3;

    s = store.update(id, (st) => {
      const from = st.status;
      const runNow = st.runNow;
      st.status = 'building';
      st.runNow = false;
      const fresh = { run, step: 'prepare', startedAt: nowIso(), rounds: { gate: 0, verify: 0, questions: 0, errors: 0 }, resumeWith: null, feedback: null, coderSession: null };
      if (resuming) st.job = { ...st.job, interrupted: false, resumedAt: nowIso() };
      else if (st.job?.newRun) st.job = { ...fresh, resumeWith: st.job.resumeWith, coderSession: st.job.coderSession, base: st.job.base, worktree: st.job.worktree };
      else st.job = fresh;
      if (newRun) st.runs = [...(st.runs || []), { run, startedAt: st.job.startedAt, result: null }];
      st.job.runNow = runNow; // kept, so a restart or a usage park doesn't push a "run now" ticket to the night
      return { type: 'status', by: 'runner', text: `${from} → building · ${resuming ? `resuming ${run} at ${st.job.step}` : `run ${run}`}`, data: { from, to: 'building' } };
    });

    const night = nightKey(new Date(), cfg.nightShift.start, cfg.timezone);
    const rs = this.state();
    const tonight = rs.tonight?.key === night ? rs.tonight : { key: night, jobs: 0 };
    if (!resuming) tonight.jobs += 1;
    this.current = { ticket: id, run, step: s.job.step, startedAt: nowIso(), pid: process.pid };
    this.save({ current: this.current, tonight, lastHold: null });
    this.log(`${id}: ${resuming ? 'resume' : 'start'} ${run} at ${s.job.step}`);

    let outcome;
    try {
      outcome = await this.pipeline(id, project, runDir, deadline);
    } catch (e) {
      this.log(`${id}: ${e.stack || e}`);
      outcome = { block: `crew error: ${String(e.message || e).slice(0, 300)}` };
    } finally {
      this.current = null;
      this.save({ current: null });
    }
    return this.finish(id, run, outcome);
  }

  setStep(id, step, extra = {}) {
    this.store.update(id, (st) => {
      st.job = { ...st.job, step, ...extra };
      return { type: 'step', by: 'runner', text: step };
    });
    if (this.current) {
      this.current.step = step;
      this.save({ current: this.current });
    }
  }

  async pipeline(id, project, runDir, deadline) {
    const store = this.store;
    for (let guard = 0; guard < 20; guard++) {
      const s = store.state(id);
      const step = s.job.step;
      if (Date.now() > deadline) return { block: `ran out of the ${store.config().nightShift.maxJobMinutes}-minute job budget at step ${step}` };
      let r;
      if (step === 'prepare') r = await this.prepare(id, project, runDir);
      else if (step === 'code') r = await this.code(id, project, runDir, deadline);
      else if (step === 'gate') r = await this.gate(id, project, runDir);
      else if (step === 'verify') r = await this.verify(id, project, runDir);
      else if (step === 'publish') r = await this.publish(id, project, runDir);
      else return { block: `unknown step ${step}` };
      if (r.next) {
        this.setStep(id, r.next, r.extra || {});
        continue;
      }
      return r;
    }
    return { block: 'too many steps; something loops' };
  }

  async prepare(id, project, runDir) {
    const store = this.store;
    const s = store.state(id);
    const logFile = path.join(runDir, 'prepare.log');
    const ws = await ensureWorktree(store, project, s, { logFile });
    store.update(id, (st) => {
      st.branch = ws.branch;
      st.job = { ...st.job, base: st.job.base || ws.base, worktree: ws.dir };
      return { type: 'prepare', by: 'runner', text: `${ws.created ? 'worktree created' : 'worktree reused'} on ${ws.branch}` };
    });
    const st = store.state(id);
    const env = ticketEnv(store, project, st, { role: 'worker', cwd: ws.dir });
    this.writeBrief(st, ws.dir);
    writeEnvFile(ws.dir, env, project);
    if (project.db?.url) {
      const { vars } = ticketVars(store, project, st);
      await this.ensureGolden(project, { logFile });
      if (ws.created || !(await db.exists(project, env, vars.worktreeDb))) await db.cloneDb(project, env, vars.golden, vars.worktreeDb, { logFile });
    }
    for (const cmd of project.setup || []) {
      const r = await sh(cmd, { cwd: ws.dir, env, logFile, timeoutMs: 30 * 60e3, memoryMax: store.config().memory.jobMax, name: 'crew-setup' });
      if (r.code !== 0) return { block: `setup failed: ${cmd}\n${tailOf(r.out, 15)}` };
    }
    return { next: 'code', extra: { resumeWith: st.job.resumeWith } };
  }

  // Everything the coder should read, in the worktree's .crew folder (excluded from git).
  writeBrief(st, dir) {
    const store = this.store;
    const crewDir = path.join(dir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    writeFileAtomic(path.join(crewDir, 'contract.md'), store.readFile(st.id, 'contract.md'));
    const qa = st.questions.filter((q) => q.answer).map((q) => `- ${q.id} ${q.text.split('\n')[0]} → ${q.answer}`);
    const ticket = [
      store.readFile(st.id, 'story.md').trim(),
      '',
      store.readFile(st.id, 'decisions.md').trim(),
      qa.length ? `\n## Answers so far\n${qa.join('\n')}` : '',
      st.feedback?.length ? `\n## Your tester's notes (fix these)\n${st.feedback.map((f) => `- ${f.text}`).join('\n')}` : '',
    ].join('\n');
    writeFileAtomic(path.join(crewDir, 'ticket.md'), ticket + '\n');
    const project = store.project(st.project);
    const vision = readText(path.join(project.dir, 'vision.md'));
    if (vision) writeFileAtomic(path.join(crewDir, 'vision.md'), vision);
    // The design you accepted in the Discuss stage: what the screens and states should look like.
    const n = st.discussion?.acceptedRound;
    if (n) {
      for (const [from, to] of [[`round-${n}.md`, 'discussion.md'], [`round-${n}.html`, 'discussion.html']]) {
        const f = path.join(store.dir(st.id), 'discuss', from);
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(crewDir, to));
      }
    }
    fs.rmSync(path.join(crewDir, 'WAITING'), { force: true });
  }

  coderPrompt(st, project) {
    // The generic coder prompt plus the project's own notes (projects/<key>/coder.md), if any.
    const role = fill(readText(path.join(ROOT, 'prompts', 'coder.md')), { id: st.id, title: st.title, project: project.name || project.key, branch: st.branch, base: st.job.base, projectNotes: readText(path.join(project.dir, 'coder.md')).trim() });
    const why = st.job.resumeWith;
    if (!st.job.coderSession || !why) {
      return { fresh: true, system: role, prompt: `Build ${st.id}: ${st.title}.\nRead .crew/contract.md, .crew/ticket.md and .crew/vision.md first. Then write .crew/plan.md before you change any code.` };
    }
    let msg = 'Continue where you stopped and finish the ticket.';
    if (why === 'gate') msg = `The crew gate failed after you stopped. Fix every item, then finish:\n\n${st.job.feedback || ''}`;
    if (why === 'verify') msg = `A fresh verifier did not accept your work. Fix the unmet lines (tests first), then finish:\n\n${st.job.feedback || ''}`;
    if (why === 'answer') {
      const qs = (st.job.pendingQuestions || []).map((qid) => st.questions.find((q) => q.id === qid)).filter((q) => q?.answer);
      const text = qs.map((q) => `${q.id}: ${q.text.split('\n')[0]}\n→ ${q.answer} (${q.answeredBy === 'user' ? 'the user' : 'the lead'})`).join('\n\n');
      msg = `You have an answer to your question:\n\n${text || st.job.feedback || '(see .crew/ticket.md)'}\n\nIt is also in .crew/ticket.md. Continue.`;
    }
    if (why === 'feedback') msg = `The user tested your branch and asks for changes:\n\n${(st.feedback || []).map((f) => `- ${f.text}`).join('\n')}\n\nUpdate the code, the tests and .crew/check.md, then finish.`;
    if (why === 'limit' || why === 'restart') msg = 'You were paused (usage limit or restart). Check git status and .crew/plan.md, then continue and finish.';
    if (why === 'retry') msg = `The last attempt was blocked: ${st.job.feedback || 'see the timeline'}.\nThe user asked for another try. Look at the cause, re-read .crew/contract.md (it may have changed), fix it and finish.`;
    return { fresh: false, system: role, prompt: msg };
  }

  async code(id, project, runDir, deadline) {
    const store = this.store;
    const cfg = store.config();
    let st = store.state(id);
    this.writeBrief(st, st.job.worktree);
    const agent = agentFor(cfg, 'coder');
    // A session from the other CLI can't be resumed: start over in the same worktree.
    if (st.job.coderSession && (st.job.coderEngine || 'claude') !== agent.engine) {
      st = store.update(id, (x) => {
        x.job = { ...x.job, coderSession: null };
        return null;
      });
    }
    const { fresh, system, prompt } = this.coderPrompt(st, project);
    const sessionId = fresh ? uuid() : null;
    const env = ticketEnv(store, project, st, { role: 'worker', cwd: st.job.worktree });
    const n = fs.readdirSync(runDir).filter((f) => f.startsWith('coder-')).length + 1;
    const res = await runAgent({
      ...agent,
      cwd: st.job.worktree,
      prompt,
      sessionId,
      resume: fresh ? null : st.job.coderSession,
      appendSystemPrompt: system,
      permissionMode: cfg.permissionMode.coder,
      permissionPrompts: 'none',
      stopHook: { command: `${shellPath(process.execPath)} ${shellPath(CREW_BIN)} gate --hook`, timeout: 1800 },
      env,
      tz: cfg.timezone,
      logFile: path.join(runDir, `coder-${n}.jsonl`),
      timeoutMs: Math.max(60e3, deadline - Date.now()),
      memoryMax: cfg.memory.jobMax,
      swapMax: cfg.memory.swapMax,
      unitName: 'crew-coder',
      name: `${id} coder`,
      onSpawn: (c) => this.track(c),
    });
    this.recordUsage(res);
    st = store.update(id, (x) => {
      x.job = { ...x.job, coderSession: res.sessionId || x.job.coderSession, coderEngine: agent.engine, resumeWith: null, feedback: null, pendingQuestions: null };
      x.runs = (x.runs || []).map((r) => (r.run === x.job.run ? { ...r, costUsd: round((r.costUsd || 0) + (res.costUsd || 0)) } : r));
      return { type: 'coder', by: 'runner', text: `coder session ${n} (${engineName(agent.engine)}) ended${res.isError ? ` with an error: ${shortErr(res)}` : ''}${runNote(res)}` };
    });

    if (res.limit.hit) return this.park(id, res, 'code');
    if (res.auth) return this.authProblem(id, res);

    const waiting = fs.existsSync(path.join(st.job.worktree, '.crew', 'WAITING'));
    const asked = openQuestions(st).filter((q) => q.from === 'worker' && q.to === 'lead');
    if (waiting || asked.length) return this.handleWorkerQuestions(id, asked);

    if (res.timedOut) return { block: 'the coder ran out of time' };
    if (res.isError) {
      const errors = (st.job.rounds.errors || 0) + 1;
      store.update(id, (x) => {
        x.job.rounds.errors = errors;
        return null;
      });
      if (errors > 1) return { block: `the coder failed twice: ${shortErr(res)}` };
      return { next: 'code', extra: { resumeWith: 'restart' } };
    }
    return { next: 'gate' };
  }

  async handleWorkerQuestions(id, asked) {
    const store = this.store;
    const cfg = store.config();
    const st = store.state(id);
    const rounds = (st.job.rounds.questions || 0) + 1;
    store.update(id, (x) => {
      x.job.rounds.questions = rounds;
      return null;
    });
    if (!asked.length) return { block: 'the coder stopped to wait but asked no question' };
    // Whoever answers, the coder resumes its own session with these questions' answers.
    store.update(id, (x) => {
      x.job = { ...x.job, resumeWith: 'answer', pendingQuestions: asked.map((q) => q.id), feedback: null };
      return null;
    });
    if (rounds > cfg.limits.questionRounds || !this.lead) {
      for (const q of asked) store.escalate(id, q.id, { by: 'runner', text: rounds > cfg.limits.questionRounds ? '(Question limit reached; the runner passes it to you.)' : '' });
      return { wait: true };
    }
    for (const q of asked) {
      try {
        await this.lead.say(
          `[event] The coder on ${id} asks ${q.id}: "${q.text}". Answer it yourself from vision.md, the contract and the decisions if you can: crew answer ${id} ${q.id} "<answer>". If it is a product call only the user can make, run: crew escalate ${id} ${q.id}. Reply in one line saying which you did.`,
          { from: 'event', ticket: id, lockTimeoutMs: (cfg.limits.leadWaitMinutes ?? 20) * 60e3 },
        );
      } catch (e) {
        // The lead is busy for too long (an attached terminal session, say): the question goes to you.
        for (const x of asked) if (!store.state(id).questions.find((y) => y.id === x.id)?.answer) store.escalate(id, x.id, { by: 'runner', text: `(The lead was not available: ${String(e.message).slice(0, 120)})` });
        return { wait: true };
      }
    }
    const after = store.state(id);
    const stillOpen = openQuestions(after).filter((q) => asked.some((a) => a.id === q.id));
    if (stillOpen.some((q) => q.to === 'user') || after.status === 'waiting') return { wait: true };
    if (stillOpen.length) {
      for (const q of stillOpen) store.escalate(id, q.id, { by: 'runner', text: '(The lead did not answer; passed to you.)' });
      return { wait: true };
    }
    return { next: 'code', extra: { resumeWith: 'answer' } };
  }

  async gate(id, project, runDir) {
    const store = this.store;
    const cfg = store.config();
    const st = store.state(id);
    const env = ticketEnv(store, project, st, { role: 'worker', cwd: st.job.worktree });
    const n = fs.readdirSync(runDir).filter((f) => f.startsWith('gate-') && f.endsWith('.json')).length + 1;
    const result = await heavyLock(store.home, `gate ${id}`, () =>
      runGate({ cwd: st.job.worktree, project, stage: 'all', env, base: st.job.base, contract: store.readFile(id, 'contract.md'), logFile: path.join(runDir, `gate-${n}.log`), checkMax: cfg.memory.checkMax }),
    );
    writeJson(path.join(runDir, `gate-${n}.json`), result);
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
    store.update(id, (x) => {
      x.job.lastGate = { ok: result.ok, at: result.at, failed, checks: result.checks.map((c) => ({ name: c.name, ok: c.ok, ms: c.ms || 0 })) };
      return { type: 'gate', by: 'runner', text: result.ok ? `gate passed (${result.checks.length} checks)` : `gate failed: ${failed.join(', ')}` };
    });
    if (result.ok) return { next: 'verify' };
    const f = failures(result);
    if (!f.code.length) {
      // Only the box failed (a check killed at its memory cap, or timed out): sending this to the coder
      // would waste a round on something no code change fixes. Block with the reason; Retry resumes here.
      const what = f.infra.map((c) => `${c.name}${c.heavy ? ' (heavy)' : ''}`).join(', ');
      return { block: `infrastructure: ${what} was killed (out of memory at its cap, or timed out). Raise its memoryMax in project.json or free memory, then press Retry.`, infra: true };
    }
    const rounds = st.job.rounds.gate + 1;
    store.update(id, (x) => {
      x.job.rounds.gate = rounds;
      return null;
    });
    if (rounds > cfg.limits.gateRounds) return { block: `gate still failing after ${cfg.limits.gateRounds} fix rounds: ${failed.join(', ')}` };
    return { next: 'code', extra: { resumeWith: 'gate', feedback: gateSummary(result) } };
  }

  async verify(id, project, runDir) {
    const store = this.store;
    const cfg = store.config();
    const st = store.state(id);
    const dir = st.job.worktree;
    // Judge against the ticket's own contract, not a copy the coder could have edited.
    this.writeBrief(st, dir);
    const before = { head: await headSha(dir), branch: (await sh('git rev-parse --abbrev-ref HEAD', { cwd: dir })).out.trim() };
    const env = ticketEnv(store, project, st, { role: 'verifier', cwd: dir });
    const stat = await diffStat(dir, st.job.base);
    const system = fill(readText(path.join(ROOT, 'prompts', 'verifier.md')), { id, title: st.title, base: st.job.base, projectNotes: readText(path.join(project.dir, 'verifier.md')).trim() });
    const prompt = [
      `Verify ${id}: ${st.title}.`,
      `The contract is .crew/contract.md. Decisions and answers are in .crew/ticket.md. The coder's plan is .crew/plan.md and its steps for the user are .crew/check.md.`,
      `The change: git diff ${st.job.base}...HEAD (${stat || 'no stat'}).`,
      `The crew gate already passed: ${(st.job.lastGate?.checks || []).map((c) => c.name).join(', ')}. Run the tests yourself anyway.`,
      'Answer with the JSON verdict only.',
    ].join('\n');
    const n = fs.readdirSync(runDir).filter((f) => f.startsWith('verifier-')).length + 1;
    const res = await runAgent({
      ...agentFor(cfg, 'verifier'),
      cwd: dir,
      prompt,
      sessionId: uuid(),
      appendSystemPrompt: system,
      permissionMode: cfg.permissionMode.verifier,
      permissionPrompts: 'none',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      jsonSchema: VERDICT_SCHEMA,
      env,
      tz: cfg.timezone,
      logFile: path.join(runDir, `verifier-${n}.jsonl`),
      timeoutMs: 40 * 60e3,
      memoryMax: cfg.memory.jobMax,
      swapMax: cfg.memory.swapMax,
      unitName: 'crew-verifier',
      name: `${id} verifier`,
      onSpawn: (c) => this.track(c),
    });
    this.recordUsage(res);
    store.update(id, (x) => {
      x.runs = (x.runs || []).map((r) => (r.run === x.job.run ? { ...r, costUsd: round((r.costUsd || 0) + (res.costUsd || 0)) } : r));
      return null;
    });
    if (res.limit.hit) return this.park(id, res, 'verify');
    if (res.auth) return this.authProblem(id, res);
    const touched = await dirtyFiles(dir);
    if (touched.length) {
      await discardChanges(dir);
      store.note(id, `The verifier changed ${touched.length} file(s); the changes were discarded.`, { by: 'runner' });
    }
    const afterBranch = (await sh('git rev-parse --abbrev-ref HEAD', { cwd: dir })).out.trim();
    if ((await headSha(dir)) !== before.head || afterBranch !== before.branch) {
      await sh(`git checkout -q ${before.branch} && git reset -q --hard ${before.head}`, { cwd: dir });
      store.note(id, 'The verifier moved the branch (a commit or checkout); it was put back.', { by: 'runner' });
    }
    const v = normalizeVerdict(res.structured ?? parseJsonLoose(res.text));
    if (!v) {
      const errors = (st.job.rounds.errors || 0) + 1;
      store.update(id, (x) => {
        x.job.rounds.errors = errors;
        return null;
      });
      if (errors > 2) return { block: `the verifier gave no usable verdict: ${shortErr(res)}` };
      return { next: 'verify' };
    }
    const md = renderVerdict(id, v, n);
    writeFileAtomic(path.join(runDir, `verify-${n}.md`), md);
    store.writeTicketFile(id, 'verify.md', md, { by: 'verifier' });
    store.update(id, (x) => {
      x.verdict = { result: v.pass ? 'PASS' : 'FAIL', score: v.min, at: nowIso(), run: x.job.run, round: n };
      return { type: 'verdict', by: 'verifier', text: `${v.pass ? 'PASS' : 'FAIL'} · lowest line ${v.min}/10 · ${v.summary.slice(0, 200)}` };
    });
    if (v.pass) return { next: 'publish' };
    const rounds = st.job.rounds.verify + 1;
    store.update(id, (x) => {
      x.job.rounds.verify = rounds;
      return null;
    });
    if (rounds > cfg.limits.verifyRounds) return { block: `the verifier still says FAIL after ${cfg.limits.verifyRounds} fix rounds` };
    const unmet = v.lines.filter((l) => l.score < 7).map((l) => `- ${l.id} (${l.score}/10): ${l.note || l.evidence}`);
    return { next: 'code', extra: { resumeWith: 'verify', feedback: `${v.summary}\n\nUnmet:\n${unmet.join('\n') || '- (see verify.md)'}` } };
  }

  async publish(id, project, runDir) {
    const store = this.store;
    const cfg = store.config();
    const st = store.state(id);
    const dir = st.job.worktree;
    for (const f of ['plan.md', 'check.md']) {
      const text = readText(path.join(dir, '.crew', f));
      if (text.trim()) store.writeTicketFile(id, f, text, { by: 'worker' });
    }
    const sha = await headSha(dir);
    const stat = await diffStat(dir, st.job.base);
    let pr = st.pr;
    if (project.repo.push) {
      const r = await sh(`git push --force-with-lease -u ${project.repo.remote || 'origin'} HEAD:${st.branch}`, { cwd: dir, logFile: path.join(runDir, 'publish.log'), env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } });
      if (r.code !== 0) store.note(id, `Push failed; the branch stays on the box. ${tailOf(r.out, 3)}`, { by: 'runner' });
      else if (project.repo.compareUrl) pr = { url: fill(project.repo.compareUrl, { branch: st.branch, base: project.repo.base }) };
    }
    store.update(id, (x) => {
      x.status = 'review';
      x.pr = pr;
      x.job = { ...x.job, step: 'done', finishedAt: nowIso(), head: sha, diffStat: stat };
      x.runs = (x.runs || []).map((r) => (r.run === x.job.run ? { ...r, finishedAt: nowIso(), result: 'PASS', head: sha } : r));
      // The gate's build was made for one preview slot's address; starting that slot needs no rebuild.
      if (project.preview && fs.existsSync(path.join(dir, '.next'))) x.preview = { ...(x.preview || {}), state: 'built', builtFor: project.preview.buildFor || 1, builtAt: nowIso(), head: sha };
      return { type: 'status', by: 'runner', text: `building → review · ready to test · ${stat}`, data: { from: 'building', to: 'review' } };
    });
    return { done: true };
  }

  // ---- one design round (the Discuss stage) --------------------------------------------------
  // A designer (Opus) writes one self-contained page: the idea, how it works today (lab screenshots),
  // scenarios and options drawn with demo data (clickable), and numbered decisions. Nothing is built.

  async runDesign(id) {
    const store = this.store;
    const s = store.state(id);
    const project = store.project(s.project);
    const round = s.discussion.pending.round;
    const workDir = path.join(store.dir(id), 'discuss', `r${round}`);
    fs.mkdirSync(workDir, { recursive: true });
    store.update(id, (x) => {
      x.discussion = { ...x.discussion, state: 'designing', step: 'design', startedAt: nowIso() };
      return { type: 'discussion', by: 'runner', text: `round ${round}: the designer started` };
    });
    this.current = { ticket: id, kind: 'design', run: `design-r${round}`, step: 'design', startedAt: nowIso(), pid: process.pid };
    this.save({ current: this.current, lastHold: null });
    this.log(`${id}: design round ${round}`);
    let outcome;
    try {
      outcome = await this.designRound(id, project, round, workDir);
    } catch (e) {
      this.log(`${id}: ${e.stack || e}`);
      outcome = { failed: `crew error: ${String(e.message || e).slice(0, 300)}` };
    } finally {
      this.current = null;
      this.save({ current: null });
    }
    return this.finishDesign(id, round, outcome);
  }

  setDesignStep(id, step) {
    this.store.update(id, (x) => {
      x.discussion = { ...x.discussion, step };
      return { type: 'step', by: 'runner', text: `round ${x.discussion.pending?.round}: ${step}` };
    });
    if (this.current) {
      this.current.step = step;
      this.save({ current: this.current });
    }
  }

  async designRound(id, project, round, workDir) {
    const store = this.store;
    const cfg = store.config();
    const mirror = await ensureMirror(store, project, { logFile: path.join(workDir, 'prepare.log') });
    // The lab is started here, not by the designer: a first build takes minutes, longer than an agent's command may run.
    let labNote = null;
    if (project.lab) {
      this.setDesignStep(id, 'lab');
      try {
        const { Lab } = await import('./lab.js');
        const l = await new Lab({ store }).up(project.key, { by: 'runner' });
        labNote = `running at ${l.url} until ${fmtTime(l.expiresAt, cfg.timezone)}`;
      } catch (e) {
        labNote = `it did not start (${String(e.message || e).split('\n')[0].slice(0, 200)}); describe today's screens from the code`;
        store.note(id, `The lab did not start for this round: ${String(e.message || e).split('\n')[0].slice(0, 200)}`, { by: 'runner' });
      }
      this.setDesignStep(id, 'design');
    }
    this.writeDesignBrief(store.state(id), project, round, workDir, mirror, labNote);
    const st = store.state(id);
    const system = fill(readText(path.join(ROOT, 'prompts', 'designer.md')), { id, title: st.title, round, project: project.name || project.key, projectNotes: readText(path.join(project.dir, 'designer.md')).trim() });
    const env = { CREW_HOME: store.home, CREW_TICKET: id, CREW_ROLE: 'designer', CREW_PROJECT: project.key, CREW_CODE: mirror, CREW_TEMPLATE: path.join(ROOT, 'templates', 'page.html'), PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}` };
    const designer = agentFor(cfg, 'designer');
    const run = (n, prompt, session) =>
      runAgent({
        ...designer,
        cwd: workDir,
        prompt,
        sessionId: session ? null : uuid(),
        resume: session || null,
        appendSystemPrompt: system,
        permissionMode: cfg.permissionMode.designer,
        permissionPrompts: 'none',
        addDirs: [mirror],
        env,
        tz: cfg.timezone,
        logFile: path.join(workDir, `designer-${n}.jsonl`),
        timeoutMs: (cfg.discuss?.maxMinutes || 60) * 60e3,
        memoryMax: cfg.memory.jobMax,
        swapMax: cfg.memory.swapMax,
        unitName: 'crew-designer',
        name: `${id} designer`,
        onSpawn: (c) => this.track(c),
      });
    const after = async (res) => {
      this.recordUsage(res);
      store.update(id, (x) => {
        x.discussion = { ...x.discussion, designerSession: res.sessionId || x.discussion.designerSession, costUsd: round2((x.discussion.costUsd || 0) + (res.costUsd || 0)) };
        return { type: 'designer', by: 'runner', text: `designer session (${engineName(designer.engine)}) ended${res.isError ? ` with an error: ${shortErr(res)}` : ''}${runNote(res)}` };
      });
      // The designer reads the code; it must not leave changes in the shared clone.
      if ((await dirtyFiles(mirror)).length) {
        await discardChanges(mirror);
        store.note(id, 'The designer changed files in the code clone; the changes were discarded.', { by: 'runner' });
      }
      if (res.limit.hit) return this.parkDesign(id, res);
      if (res.auth) {
        this.save({ authProblem: shortErr(res) || 'login expired', authEngine: res.engine || 'claude' });
        this.requeueDesign(id, `${engineName(res.engine || 'claude')} login problem`);
        return { auth: true };
      }
      return null;
    };

    let res = await run(1, `Design round ${round} of ${id}: ${st.title}.\nRead brief.md first. Write page.html, summary.md and decisions.json in this folder, and check the page with crew page-check before you finish.`);
    let stop = await after(res);
    if (stop) return stop;
    const missing = () => ['page.html', 'summary.md'].filter((f) => !readText(path.join(workDir, f)).trim());
    if (missing().length && !res.timedOut) {
      res = await run(2, `You stopped without writing ${missing().join(' and ')}. Write ${missing().join(' and ')} now (see brief.md for what each holds), then finish.`, store.state(id).discussion.designerSession);
      if ((stop = await after(res))) return stop;
    }
    if (missing().length) return { failed: res.timedOut ? `the designer ran out of time without writing ${missing().join(' and ')}` : `the designer wrote no ${missing().join(' or ')}: ${shortErr(res) || 'see the transcript'}` };

    this.setDesignStep(id, 'check');
    const page = path.join(workDir, 'page.html');
    let check = await this.checkPage(page, workDir);
    if (!check.ok && !check.skipped) {
      res = await run(3, `crew checked page.html at 390 and 1280 px and found problems:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\nFix them in page.html, run crew page-check page.html until it passes, then finish.`, store.state(id).discussion.designerSession);
      if ((stop = await after(res))) return stop;
      check = await this.checkPage(page, workDir);
    }

    this.setDesignStep(id, 'publish');
    return this.publishRound(id, project, round, workDir, check);
  }

  async checkPage(page, workDir) {
    const cfg = this.store.config();
    const tools = findTools(cfg);
    if (!tools.playwright || !tools.chromium) return { ok: true, skipped: true, problems: ['not checked: no headless browser (tools.playwright, tools.chromium)'] };
    try {
      const r = await pageCheck(page, { cfg });
      return { ok: r.ok, problems: r.problems };
    } catch (e) {
      return { ok: false, problems: [`the check itself failed: ${String(e.message || e).split('\n')[0]}`] };
    }
  }

  // Everything the designer reads first: the user's words, what changed since the last round, and where things are.
  writeDesignBrief(st, project, round, workDir, mirror, labNote = null) {
    const store = this.store;
    const d = st.discussion;
    const tz = store.config().timezone;
    const lab = project.lab ? `${labNote ? `${labNote}. ` : ''}${labLine(project)}` : 'This project has no lab; read the code to see how it works today.';
    const earlier = (d.rounds || []).map((r) => {
      const answers = (r.questions || [])
        .map((qid) => st.questions.find((q) => q.id === qid))
        .filter(Boolean)
        .map((q) => `  - ${firstLine(q.text)} → ${q.superseded ? '(left open)' : q.answer || '(not answered yet)'}`);
      return [`### Round ${r.n} · ${fmtTime(r.at, tz)}`, `Page: ../r${r.n}/page.html (read it when you need the detail)`, '', r.summary, '', answers.length ? `The user's answers:\n${answers.join('\n')}` : ''].join('\n');
    });
    const since = d.rounds?.length ? d.rounds[d.rounds.length - 1].at : st.created;
    const notes = store
      .events(st.id)
      .filter((e) => ['note', 'feedback'].includes(e.type) && ['user', 'lead'].includes(e.by) && e.ts > since)
      .map((e) => `- (${e.by === 'user' ? 'the user' : 'the lead'}, ${fmtTime(e.ts, tz)}) ${e.text}`);
    const brief = [
      `# Design round ${round} · ${st.id} · ${st.title}`,
      '',
      "## The user's words",
      store.readFile(st.id, 'story.md').trim(),
      '',
      '## This round',
      `Asked for by ${d.pending.by === 'user' ? 'the user' : 'the lead'}. ${d.pending.note ? `Focus: ${d.pending.note}` : 'No special focus: explore the idea as the user described it.'}`,
      notes.length ? `\nNotes since the last round:\n${notes.join('\n')}` : '',
      '',
      '## Decisions so far',
      store.readFile(st.id, 'decisions.md').replace(/^# .*\n/, '').trim() || 'None yet.',
      '',
      '## Earlier rounds',
      earlier.length ? earlier.join('\n\n') : 'None: this is the first round.',
      '',
      '## Where things are',
      `- What the product is for, its users and demo accounts: ${path.join(project.dir, 'vision.md')}`,
      `- The code, read only (latest ${project.repo.base}): ${mirror}`,
      `- The page template (copy it, keep its style): ${path.join(ROOT, 'templates', 'page.html')}`,
      `- The lab: ${lab}`,
      '- Check your page: `crew page-check page.html --shots check` (script errors, sideways scrolling at 390 px, outside requests; it saves slices you can look at).',
      '',
      '## Write in this folder',
      '- `page.html`: the discussion page, one self-contained file.',
      '- `summary.md`: 10 to 25 lines for the lead: the recommendation, the options, and the decisions with their numbers and lettered options.',
      '- `decisions.json`: the decisions for the user, as `[{"n": 1, "question": "…", "why": "…", "options": [{"key": "a", "text": "…"}, {"key": "b", "text": "…"}], "pick": "b"}]`. Three to eight of them.',
    ].join('\n');
    writeFileAtomic(path.join(workDir, 'brief.md'), brief + '\n');
  }

  async publishRound(id, project, round, workDir, check) {
    const store = this.store;
    const cfg = store.config();
    const dDir = path.join(store.dir(id), 'discuss');
    // The designer links its screenshots (shots/…); the published page carries them inline, as one file.
    const pageText = inlineImages(readText(path.join(workDir, 'page.html')), workDir);
    writeFileAtomic(path.join(dDir, `round-${round}.html`), pageText);
    const summary = readText(path.join(workDir, 'summary.md')).trim();
    writeFileAtomic(path.join(dDir, `round-${round}.md`), summary + '\n');

    let decisions = [];
    try {
      decisions = JSON.parse(readText(path.join(workDir, 'decisions.json'), '[]'));
      if (!Array.isArray(decisions)) decisions = [];
    } catch {
      store.note(id, 'decisions.json was not valid JSON; the decisions are only on the page.', { by: 'runner' });
    }

    // Shared outside the board only if the page holds none of the project's sandbox values.
    let link = null;
    if (cfg.discuss?.publish) {
      const secrets = parseEnvFile(readText(path.join(project.dir, project.env?.file || 'agent.env')));
      const leaks = Object.entries(secrets).filter(([, v]) => String(v).length >= 8 && pageText.includes(v)).map(([k]) => k);
      if (leaks.length) store.note(id, `Round ${round} was not shared: the page contains values from agent.env (${leaks.join(', ')}). It is on the board only.`, { by: 'runner' });
      else {
        const share = path.join(dDir, `${id.toLowerCase()}-discussion.html`);
        writeFileAtomic(share, pageText);
        const r = await sh(fill(cfg.discuss.publish, { file: shellPath(share) }), { cwd: dDir, timeoutMs: 180e3, logFile: path.join(workDir, 'publish.log') });
        link = r.code === 0 ? r.out.match(/https:\/\/\S+/)?.[0] || null : null;
        if (!link) store.note(id, `Sharing round ${round} failed: ${tailOf(r.out, 2) || `exit ${r.code}`}`, { by: 'runner' });
      }
    }

    const qids = [];
    for (const [i, d] of decisions.slice(0, 12).entries()) {
      if (!d || !String(d.question || '').trim()) continue;
      const options = (Array.isArray(d.options) ? d.options : []).slice(0, 6).map((o) => (typeof o === 'string' ? o : `${o.key ? `${o.key}: ` : ''}${o.text || ''}${o.key && o.key === d.pick ? ' (recommended)' : ''}`));
      const { qid } = store.ask(id, { text: `Round ${round} · decision ${d.n || i + 1}: ${String(d.question).trim()}${d.why ? `\n${String(d.why).trim()}` : ''}`, to: 'user', from: 'designer', options });
      qids.push(qid);
    }
    const st = store.update(id, (x) => {
      const p = x.discussion.pending || { round, by: 'user', note: '' };
      x.discussion = {
        ...x.discussion,
        state: 'ready',
        step: null,
        pending: null,
        lastError: null,
        recoveries: 0,
        rounds: [...(x.discussion.rounds || []), { n: round, at: nowIso(), by: p.by, note: p.note, summary: summary.slice(0, 2000), page: `round-${round}.html`, link, questions: qids, check: { ok: check.ok, skipped: !!check.skipped, problems: check.problems || [] } }],
      };
      return { type: 'discussion', by: 'runner', text: `round ${round} is ready${link ? `: ${link}` : ''}${qids.length ? ` · decisions ${qids.join(', ')}` : ''}` };
    });
    return { done: true, round, link, qids, summary, state: st };
  }

  parkDesign(id, res) {
    const cfg = this.store.config();
    const until = res.limit.resetAt && res.limit.resetAt > new Date() ? res.limit.resetAt : new Date(Date.now() + 60 * 60e3);
    this.save({ parkedUntil: until.toISOString(), parkReason: res.limit.text || 'usage limit' });
    this.requeueDesign(id, `usage limit, resumes after ${fmtTime(until.toISOString(), cfg.timezone)}`);
    return { parked: true, until };
  }

  requeueDesign(id, why) {
    this.store.update(id, (x) => {
      x.discussion = { ...x.discussion, state: 'queued', step: null };
      return { type: 'discussion', by: 'runner', text: `round ${x.discussion.pending?.round} waits: ${why}` };
    });
  }

  async finishDesign(id, round, outcome) {
    const store = this.store;
    const cfg = store.config();
    const st = store.state(id);
    const board = cfg.publicUrl ? `${cfg.publicUrl.replace(/\/$/, '')}/#${id}` : '';
    if (outcome.done) {
      await this.notify({ title: `Discussion · ${id} · round ${round}`, text: `${st.title}\n${firstLine(outcome.summary)}${outcome.qids.length ? `\n${outcome.qids.length} decisions for you.` : ''}`, url: outcome.link || board, tags: 'thought_balloon' });
      this.lead
        ?.say(
          `[event] Design round ${round} of ${id} is ready${outcome.link ? ` (${outcome.link})` : ''}. Its summary:\n${outcome.summary}\n\nIts decisions are on the board as ${outcome.qids.join(', ') || '(none)'}. Tell the user in two or three lines what the page shows and what it recommends, with the link. Don't repeat the page.`,
          { from: 'event', ticket: id },
        )
        .catch(() => {});
      return { ran: true, ticket: id, result: 'round', round };
    }
    if (outcome.failed) {
      store.update(id, (x) => {
        x.discussion = { ...x.discussion, state: 'failed', step: null, lastError: outcome.failed.split('\n')[0].slice(0, 300) };
        return { type: 'discussion', by: 'runner', text: `round ${round} failed: ${outcome.failed.split('\n')[0]}` };
      });
      await this.notify({ title: `Round failed · ${id}`, text: `${st.title}\n${outcome.failed.split('\n')[0]}`, url: board, tags: 'no_entry' });
      return { ran: true, ticket: id, result: 'failed', reason: outcome.failed };
    }
    if (outcome.parked) {
      await this.notify({ title: 'Crew paused', text: `Usage limit reached during design round ${round} of ${id}. It resumes after ${fmtTime(outcome.until.toISOString(), cfg.timezone)}.`, url: board, tags: 'hourglass' });
      return { ran: true, ticket: id, result: 'parked', until: outcome.until };
    }
    if (outcome.auth) {
      const who = engineName(this.state().authEngine || 'claude');
      await this.notify({ title: `${who} login needed`, text: `${who} on the box is not logged in. Log in, then resume the runner.`, url: board, tags: 'warning', priority: 'high' });
      return { ran: true, ticket: id, result: 'auth' };
    }
    return { ran: true, ticket: id, result: 'unknown', outcome };
  }

  // ---- outcomes -------------------------------------------------------------------------------

  park(id, res, step) {
    const store = this.store;
    const cfg = store.config();
    const parks = (store.state(id).job?.parks || 0) + 1;
    if (parks > (cfg.limits.parks ?? 3)) return { block: `hit the usage limit ${parks} times on this ticket; it may be too big for one night` };
    const until = res.limit.resetAt && res.limit.resetAt > new Date() ? res.limit.resetAt : new Date(Date.now() + 60 * 60e3);
    this.save({ parkedUntil: until.toISOString(), parkReason: res.limit.text || 'usage limit' });
    store.update(id, (x) => {
      x.status = 'queued';
      x.order = -Date.now();
      x.runNow = !!x.job?.runNow;
      x.job = { ...x.job, step, parks, resumeWith: step === 'code' ? 'limit' : x.job.resumeWith };
      return { type: 'status', by: 'runner', text: `building → queued · usage limit, resumes after ${fmtTime(until.toISOString(), cfg.timezone)}`, data: { from: 'building', to: 'queued' } };
    });
    return { parked: true, until };
  }

  authProblem(id, res) {
    const store = this.store;
    this.save({ authProblem: shortErr(res) || 'login expired', authEngine: res.engine || 'claude' });
    store.update(id, (x) => {
      x.status = 'queued';
      x.order = -Date.now();
      x.job = { ...x.job, resumeWith: 'restart' };
      return { type: 'status', by: 'runner', text: `building → queued · ${engineName(res.engine || 'claude')} login problem`, data: { from: 'building', to: 'queued' } };
    });
    return { auth: true };
  }

  async finish(id, run, outcome) {
    const store = this.store;
    const cfg = store.config();
    const link = cfg.publicUrl ? `${cfg.publicUrl.replace(/\/$/, '')}/#${id}` : '';
    const st = store.state(id);
    if (outcome.done) {
      const preview = st.preview?.state === 'built' ? ' Preview is built; start it from the board.' : '';
      await this.notify({ title: `Ready to test · ${id}`, text: `${st.title}\nVerifier ${st.verdict?.result} (lowest line ${st.verdict?.score}/10).${preview}`, url: link, tags: 'white_check_mark' });
      return { ran: true, ticket: id, result: 'review' };
    }
    if (outcome.block) {
      store.update(id, (x) => {
        x.status = 'blocked';
        x.job = { ...x.job, lastError: outcome.block.split('\n')[0].slice(0, 300), infraFailure: !!outcome.infra };
        x.runs = (x.runs || []).map((r) => (r.run === run ? { ...r, finishedAt: nowIso(), result: 'BLOCKED' } : r));
        return { type: 'status', by: 'runner', text: `building → blocked · ${outcome.block.split('\n')[0]}`, data: { from: 'building', to: 'blocked', detail: outcome.block } };
      });
      await this.notify({ title: `Blocked · ${id}`, text: `${st.title}\n${outcome.block.split('\n')[0]}`, url: link, tags: 'no_entry' });
      return { ran: true, ticket: id, result: 'blocked', reason: outcome.block };
    }
    if (outcome.wait) {
      const q = openQuestions(st).filter((x) => x.to === 'user');
      await this.notify({ title: `Question · ${id}`, text: q.map((x) => `${x.id}: ${x.text.split('\n')[0]}`).join('\n') || 'The crew needs your answer.', url: link, tags: 'question' });
      return { ran: true, ticket: id, result: 'waiting' };
    }
    if (outcome.parked) {
      await this.notify({ title: 'Night shift paused', text: `Usage limit reached during ${id}. It resumes after ${fmtTime(outcome.until.toISOString(), cfg.timezone)}.`, url: link, tags: 'hourglass' });
      return { ran: true, ticket: id, result: 'parked', until: outcome.until };
    }
    if (outcome.auth) {
      const who = engineName(this.state().authEngine || 'claude');
      await this.notify({ title: `${who} login needed`, text: `The night shift stopped: ${who} on the box is not logged in. Log in as the crew user, then resume the runner.`, url: link, tags: 'warning', priority: 'high' });
      return { ran: true, ticket: id, result: 'auth' };
    }
    return { ran: true, ticket: id, result: 'unknown', outcome };
  }

  // Done or dropped for 48 h: remove the worktree (~3 GB) and the ticket's databases. The branch stays.
  async cleanup({ olderThanHours = 48 } = {}) {
    const store = this.store;
    const removed = [];
    for (const t of store.list({ status: ['done', 'dropped'] })) {
      if (!t.job?.worktree || t.job.cleanedAt || this.current?.ticket === t.id) continue;
      if (Date.now() - new Date(t.updated).getTime() < olderThanHours * 3600e3) continue;
      const project = store.project(t.project);
      const logFile = path.join(store.home, 'logs', 'cleanup.log');
      await removeWorktree(store, project, t.id, { logFile });
      if (project.db?.url) {
        const { vars } = ticketVars(store, project, t);
        const env = ticketEnv(store, project, t, { role: 'runner' });
        for (const name of [vars.worktreeDb, vars.testDb]) await db.dropDb(project, env, name, { logFile }).catch(() => {});
      }
      store.update(t.id, (x) => {
        x.job = { ...x.job, cleanedAt: nowIso() };
        return { type: 'cleanup', by: 'runner', text: 'worktree and databases removed; the branch is kept' };
      });
      removed.push(t.id);
    }
    return removed;
  }

  // ---- the golden demo database ------------------------------------------------------------

  async ensureGolden(project, { logFile, force = false } = {}) {
    const store = this.store;
    const fake = { id: `${project.prefix}-000`, title: 'golden', project: project.key, job: null, questions: [], decisions: [] };
    const { vars } = ticketVars(store, project, fake);
    const env = ticketEnv(store, project, fake, { role: 'runner' });
    if (!force && (await db.exists(project, env, vars.golden))) return false;
    if (!project.db?.goldenBuild?.length) throw new Error(`No ${vars.golden} database and no db.goldenBuild commands to create it`);
    const mirror = await ensureMirror(store, project, { logFile });
    const dir = path.join(store.home, 'worktrees', `_${project.key}-main`);
    if (!fs.existsSync(path.join(dir, '.git'))) await sh(`git worktree add --detach ${dir} ${project.repo.remote || 'origin'}/${project.repo.base}`, { cwd: mirror, logFile });
    else await sh(`git checkout -q --detach ${project.repo.remote || 'origin'}/${project.repo.base}`, { cwd: dir, logFile });
    const building = `${vars.golden}_new`;
    await db.createEmpty(project, env, building, { logFile });
    const buildEnv = { ...env, DATABASE_URI: dbUrl(project, vars, building) };
    for (const cmd of project.setup || []) await mustSh(cmd, { cwd: dir, env: buildEnv, logFile, memoryMax: store.config().memory.jobMax });
    for (const cmd of project.db.goldenBuild) await mustSh(cmd, { cwd: dir, env: buildEnv, logFile, memoryMax: store.config().memory.jobMax });
    await db.promote(project, env, building, vars.golden, { logFile });
    this.save({ golden: { ...(readJson(this.file, {}).golden || {}), [project.key]: nowIso() } });
    return true;
  }
}

async function mustSh(cmd, opts) {
  const r = await sh(cmd, { timeoutMs: 30 * 60e3, ...opts });
  if (r.code !== 0) throw new Error(`${cmd} failed:\n${tailOf(r.out, 20)}`);
  return r;
}

function writeEnvFile(dir, env, project) {
  if (project.env?.writeDotenv === false) return;
  const keys = Object.keys(env).filter((k) => !/^(PATH|CREW_)/.test(k));
  const text = `# Written by crew for this worktree. Sandbox values only; never production secrets.\n${keys.map((k) => `${k}=${JSON.stringify(String(env[k]))}`).join('\n')}\n`;
  writeFileAtomic(path.join(dir, project.env?.dotenvName || '.env'), text);
}

export function normalizeVerdict(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.lines)) return null;
  const lines = v.lines.filter((l) => l && l.id).map((l) => ({ ...l, score: Math.max(1, Math.min(10, Number(l.score) || 1)) }));
  if (!lines.length) return null;
  const min = Math.min(...lines.map((l) => l.score));
  const pass = String(v.verdict).toUpperCase() === 'PASS' && min >= 7;
  return { ...v, lines, min, pass, summary: String(v.summary || '') };
}

export function parseJsonLoose(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export function renderVerdict(id, v, round) {
  const rows = v.lines.map((l) => `| ${l.id} | ${l.score}/10 | ${oneLine(l.text || '')} | ${oneLine(l.evidence)} | ${oneLine(l.note || '')} |`);
  return [
    `# Verifier · ${id} · round ${round}`,
    '',
    `**${v.pass ? 'PASS' : 'FAIL'}** · lowest line ${v.min}/10`,
    '',
    v.summary,
    '',
    '| Line | Score | Acceptance | Evidence | Note |',
    '|---|---|---|---|---|',
    ...rows,
    v.preexisting?.length ? `\n## Pre-existing problems (not this ticket)\n${v.preexisting.map((p) => `- ${p}`).join('\n')}` : '',
    v.risks?.length ? `\n## Risks\n${v.risks.map((p) => `- ${p}`).join('\n')}` : '',
  ].join('\n');
}

const oneLine = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 300);
const tailOf = (s, n) => String(s || '').trim().split('\n').slice(-n).join('\n');
const round = (n) => Math.round(n * 100) / 100;
// "· 12 turns · $0.40 API-equivalent" (Claude Code), or "· 3 turns" when the CLI reports no price (Codex).
const runNote = (res) => ` · ${res.numTurns} turns${res.costUsd == null ? '' : ` · $${(res.costUsd || 0).toFixed(2)} API-equivalent`}`;
const shortErr = (res) => String((res.isError ? res.text : '') || res.stderr || '').trim().split('\n')[0].slice(0, 200);
const toIso = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : null);
const shellPath = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
const round2 = (n) => Math.round(n * 100) / 100;
const firstLine = (t) => String(t || '').split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() || '';

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

// src="shots/x.jpg" and url(shots/x.jpg) → data: URIs, for files inside the round folder only.
export function inlineImages(html, dir) {
  const root = path.resolve(dir);
  const data = (ref) => {
    const ext = ref.split('.').pop().toLowerCase();
    const file = path.resolve(root, decodeURIComponent(ref));
    if (!IMAGE_TYPES[ext] || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return null;
    return `data:${IMAGE_TYPES[ext]};base64,${fs.readFileSync(file).toString('base64')}`;
  };
  return String(html)
    .replace(/(\ssrc=)(["'])(?!data:|https?:|\/\/)([^"']+?)\2/gi, (m, attr, qt, ref) => {
      const d = data(ref);
      return d ? `${attr}${qt}${d}${qt}` : m;
    })
    .replace(/url\((["']?)(?!data:|https?:|\/\/)([^"')]+?)\1\)/gi, (m, qt, ref) => {
      const d = data(ref);
      return d ? `url(${qt}${d}${qt})` : m;
    });
}

function labLine(project) {
  const lab = project.lab || {};
  const roles = Object.keys(lab.logins || {});
  return `Take screenshots with \`crew lab shot <path> --as <role> --width 390 --out shots/<name>.jpg\` (also --width 1280). Roles: ${roles.join(', ') || 'none (guest only)'}. \`crew lab status\` shows whether it runs; if it stopped, \`crew lab up\` restarts it (quick once built).`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
