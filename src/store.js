// Tickets are folders of plain files. state.json is the machine record; the .md files are
// what people and agents read. Every change goes through here, under one lock, and leaves an event.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadProject, listProjects, projectDir } from './config.js';
import {
  readJson,
  writeJson,
  readText,
  writeFileAtomic,
  appendJsonl,
  readJsonl,
  nowIso,
  withLock,
  zoned,
} from './util.js';

export const STATUSES = [
  'inbox', 'discussing', 'shaping', 'waiting', 'ready', 'queued', 'building', 'review', 'blocked', 'parked', 'done', 'dropped',
];
export const TYPES = ['bug', 'feature', 'idea', 'chore'];
export const ROLES = ['user', 'lead', 'designer', 'worker', 'verifier', 'runner'];

const TRANSITIONS = {
  inbox: ['discussing', 'shaping', 'waiting', 'ready', 'queued', 'parked', 'dropped'],
  // Design rounds before any plan: it leaves for shaping when you accept a round.
  discussing: ['shaping', 'waiting', 'parked', 'dropped'],
  shaping: ['inbox', 'discussing', 'waiting', 'ready', 'queued', 'parked', 'dropped'],
  waiting: ['discussing', 'shaping', 'ready', 'queued', 'parked', 'dropped', 'blocked'],
  ready: ['discussing', 'shaping', 'waiting', 'queued', 'parked', 'dropped'],
  queued: ['building', 'ready', 'shaping', 'waiting', 'parked', 'dropped'],
  building: ['review', 'blocked', 'queued', 'waiting', 'parked'],
  review: ['done', 'queued', 'shaping', 'parked', 'dropped'],
  blocked: ['queued', 'shaping', 'waiting', 'parked', 'dropped'],
  parked: ['inbox', 'discussing', 'shaping', 'ready', 'queued', 'dropped'],
  done: ['shaping'],
  dropped: ['inbox', 'shaping'],
};

// Files agents and people may write into a ticket folder by name.
export const TICKET_FILES = ['story.md', 'contract.md', 'plan.md', 'check.md', 'verify.md', 'notes.md'];

export class CrewError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export class Store {
  constructor(home) {
    this.home = home;
    this.ticketsDir = path.join(home, 'tickets');
    this.feedFile = path.join(home, 'feed.jsonl');
    this.lockDir = path.join(home, '.lock');
  }

  config() {
    return loadConfig(this.home);
  }

  project(key) {
    return loadProject(this.home, key);
  }

  projects() {
    return listProjects(this.home);
  }

  dir(id) {
    return path.join(this.ticketsDir, id);
  }

  exists(id) {
    return fs.existsSync(path.join(this.dir(id), 'state.json'));
  }

  state(id) {
    if (!this.exists(id)) throw new CrewError(`No ticket ${id}`, 'not_found');
    return readJson(path.join(this.dir(id), 'state.json'));
  }

  list({ status, project } = {}) {
    if (!fs.existsSync(this.ticketsDir)) return [];
    const out = [];
    for (const id of fs.readdirSync(this.ticketsDir)) {
      const f = path.join(this.ticketsDir, id, 'state.json');
      if (!fs.existsSync(f)) continue;
      const s = readJson(f);
      if (status && ![].concat(status).includes(s.status)) continue;
      if (project && s.project !== project) continue;
      out.push(s);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  }

  readFile(id, name) {
    return readText(path.join(this.dir(id), name));
  }

  events(id, { limit } = {}) {
    return readJsonl(path.join(this.dir(id), 'events.jsonl'), { limit });
  }

  feed({ limit } = {}) {
    return readJsonl(this.feedFile, { limit });
  }

  locked(fn) {
    return withLock(this.lockDir, fn);
  }

  // ---- writes -------------------------------------------------------------

  newTicket({ project, type = 'idea', title, body = '', by = 'user', priority = 2, approval }) {
    if (!TYPES.includes(type)) throw new CrewError(`Type must be one of ${TYPES.join(', ')}`);
    if (!title || !title.trim()) throw new CrewError('A ticket needs a title');
    const projects = this.projects();
    if (project && !projects.some((x) => x.key === project)) throw new CrewError(`Unknown project "${project}"`);
    const p = project ? projects.find((x) => x.key === project) : projects[0];
    if (!p) throw new CrewError('No project configured. Run `crew init` first.');
    const cfg = this.config();
    return this.locked(() => {
      const counter = path.join(projectDir(this.home, p.key), 'next-id');
      let n = Number(readText(counter, '1').trim()) || 1;
      // Never overwrite a ticket, even if next-id was lost or two projects share a prefix.
      while (fs.existsSync(this.dir(`${p.prefix}-${String(n).padStart(3, '0')}`))) n++;
      writeFileAtomic(counter, `${n + 1}\n`);
      const id = `${p.prefix}-${String(n).padStart(3, '0')}`;
      const at = nowIso();
      const state = {
        id,
        project: p.key,
        type,
        title: title.trim(),
        status: 'inbox',
        priority: Number(priority) || 2,
        approval: approval || (cfg.autoQueue[type] ? 'auto' : 'user'),
        by,
        created: at,
        updated: at,
        order: Date.now(),
        runNow: false,
        resumeStatus: null,
        questions: [],
        decisions: [],
        branch: null,
        job: null,
        runs: [],
        verdict: null,
        preview: null,
        pr: null,
      };
      fs.mkdirSync(this.dir(id), { recursive: true });
      const z = zoned(new Date(at), cfg.timezone);
      writeFileAtomic(
        path.join(this.dir(id), 'story.md'),
        `# ${id} · ${state.title}\n\nType: ${type} · Asked by: ${by === 'lead' ? 'you (written up by the lead)' : who(by)} · ${z.date} ${pad(z.hh)}:${pad(z.mm)}\n\n${body.trim()}\n`,
      );
      this._write(state);
      this._event(state, { type: 'created', by, text: `${type}: ${state.title}` });
      return state;
    });
  }

  // Read, change and save one ticket under the lock. The mutator may return an event.
  update(id, mutator) {
    return this.locked(() => {
      const state = this.state(id);
      const evt = mutator(state);
      state.updated = nowIso();
      this._write(state);
      for (const e of [].concat(evt || [])) this._event(state, e);
      return state;
    });
  }

  transition(id, to, { by = 'user', note = '', force = false } = {}) {
    if (!STATUSES.includes(to)) throw new CrewError(`Unknown status ${to}`);
    return this.update(id, (s) => {
      if (s.status === to) return null;
      checkTransition(s, to, by, force);
      if (to === 'queued') {
        if (!force && !this.readFile(id, 'contract.md').trim()) {
          throw new CrewError(`${id} has no contract yet. The lead writes one before it can be queued.`);
        }
        if (!force && openQuestions(s).length) {
          throw new CrewError(`${id} still has open questions: ${openQuestions(s).map((q) => q.id).join(', ')}`);
        }
      }
      const from = s.status;
      s.status = to;
      if (to !== 'queued') s.runNow = false;
      // Retry or reshape after a block: the coder gets another turn with the reason, and fresh round limits.
      if (from === 'blocked' && s.job && ['queued', 'shaping'].includes(to)) {
        // A box problem (killed for memory or time) resumes at the same step; a code problem goes back to the coder.
        const infra = !!s.job.infraFailure && to === 'queued';
        s.job = {
          ...s.job,
          step: infra ? s.job.step : s.job.step === 'prepare' ? 'prepare' : 'code',
          resumeWith: infra ? null : 'retry',
          infraFailure: false,
          feedback: s.job.lastError || '',
          rounds: { gate: 0, verify: 0, questions: 0, errors: 0 },
          recoveries: 0,
          parks: 0,
        };
      }
      if (to === 'queued' && from !== 'building') s.order = s.order || Date.now();
      return { type: 'status', by, text: `${from} → ${to}${note ? ` · ${note}` : ''}`, data: { from, to } };
    });
  }

  note(id, text, { by = 'user' } = {}) {
    return this.update(id, () => ({ type: 'note', by, text }));
  }

  setField(id, field, value, { by = 'user' } = {}) {
    const allowed = { priority: (v) => [1, 2, 3].includes(Number(v)), approval: (v) => ['user', 'auto'].includes(v), title: (v) => !!String(v).trim(), type: (v) => TYPES.includes(v) };
    if (!allowed[field]) throw new CrewError(`Field ${field} cannot be set this way`);
    if (!allowed[field](value)) throw new CrewError(`Bad value for ${field}: ${value}`);
    if (field === 'approval' && by !== 'user') throw new CrewError('Only you can change whether a ticket needs your approval', 'forbidden');
    return this.update(id, (s) => {
      s[field] = field === 'priority' ? Number(value) : value;
      return { type: 'field', by, text: `${field} = ${value}` };
    });
  }

  ask(id, { text, to = 'user', from = 'lead', options = [] }) {
    if (!text || !text.trim()) throw new CrewError('Empty question');
    let qid;
    const state = this.update(id, (s) => {
      qid = `Q${s.questions.length + 1}`;
      s.questions.push({ id: qid, text: text.trim(), to, from, options, at: nowIso(), answer: null, answeredBy: null, answeredAt: null, escalated: false });
      const evts = [{ type: 'question', by: from, text: `${qid} for ${who(to)}: ${text.trim()}`, data: { q: qid, to } }];
      if (to === 'user' && s.status !== 'waiting' && !['done', 'dropped'].includes(s.status)) {
        s.resumeStatus = s.status === 'building' ? 'queued' : s.status;
        evts.push({ type: 'status', by: from, text: `${s.status} → waiting`, data: { from: s.status, to: 'waiting' } });
        s.status = 'waiting';
      }
      return evts;
    });
    return { state, qid };
  }

  // The lead passes a worker's question on to you.
  escalate(id, qid, { by = 'lead', text } = {}) {
    return this.update(id, (s) => {
      const q = findQuestion(s, qid);
      if (q.answer) throw new CrewError(`${qid} is already answered`);
      q.to = 'user';
      q.escalated = true;
      if (text) q.text = `${q.text}\n\n${text.trim()}`;
      const evts = [{ type: 'escalate', by, text: `${qid} passed to you`, data: { q: qid } }];
      if (s.status !== 'waiting') {
        s.resumeStatus = s.status === 'building' ? 'queued' : s.status;
        evts.push({ type: 'status', by, text: `${s.status} → waiting`, data: { from: s.status, to: 'waiting' } });
        s.status = 'waiting';
      }
      return evts;
    });
  }

  answer(id, qid, { text, by = 'user' }) {
    if (!text || !text.trim()) throw new CrewError('Empty answer');
    let decision;
    const state = this.update(id, (s) => {
      const q = findQuestion(s, qid);
      if (q.answer) throw new CrewError(`${qid} is already answered`);
      if (q.to === 'user' && by !== 'user') throw new CrewError(`${qid} is for the user to answer`, 'forbidden');
      q.answer = text.trim();
      q.answeredBy = by;
      q.answeredAt = nowIso();
      decision = `D${s.decisions.length + 1}`;
      s.decisions.push({ id: decision, text: `${firstLine(q.text)} → ${q.answer}`, why: '', by, at: q.answeredAt, fromQ: qid });
      const evts = [
        { type: 'answer', by, text: `${qid}: ${q.answer}`, data: { q: qid, decision } },
        { type: 'decision', by, text: `${decision} from ${qid}`, data: { decision } },
      ];
      if (s.status === 'waiting' && !openQuestions(s).some((x) => x.to === 'user')) {
        const back = s.resumeStatus || 'shaping';
        evts.push({ type: 'status', by, text: `waiting → ${back}`, data: { from: 'waiting', to: back } });
        s.status = back;
        s.resumeStatus = null;
      }
      return evts;
    });
    return { state, decision };
  }

  decide(id, { text, why = '', by = 'lead' }) {
    if (!text || !text.trim()) throw new CrewError('Empty decision');
    let did;
    const state = this.update(id, (s) => {
      did = `D${s.decisions.length + 1}`;
      s.decisions.push({ id: did, text: text.trim(), why: why.trim(), by, at: nowIso(), fromQ: null });
      return { type: 'decision', by, text: `${did}: ${text.trim()}`, data: { decision: did } };
    });
    return { state, decision: did };
  }

  setContract(id, text, { by = 'lead' } = {}) {
    // The contract is what the work is judged against: only the lead and you may write it.
    if (!['lead', 'user'].includes(by)) throw new CrewError('Only the lead or the user can change a contract', 'forbidden');
    const problems = checkContract(text);
    if (problems.length) throw new CrewError(`Contract is missing: ${problems.join('; ')}`);
    return this.update(id, (s) => {
      if (by !== 'user' && (s.status === 'discussing' || (s.status === 'waiting' && s.resumeStatus === 'discussing'))) {
        throw new CrewError(`${id} is being discussed; its contract comes after the user accepts a round`, 'forbidden');
      }
      writeFileAtomic(path.join(this.dir(id), 'contract.md'), text.trimEnd() + '\n');
      const evts = [{ type: 'contract', by, text: 'contract written' }];
      if (['inbox', 'shaping'].includes(s.status)) {
        evts.push({ type: 'status', by, text: `${s.status} → ready`, data: { from: s.status, to: 'ready' } });
        s.status = 'ready';
      }
      return evts;
    });
  }

  // You tested a branch and want changes: notes go to the same coder, in a new run.
  requestChanges(id, text, { by = 'user' } = {}) {
    if (by !== 'user') throw new CrewError('Only the user requests changes after testing', 'forbidden');
    if (!text || !text.trim()) throw new CrewError('Say what to change');
    return this.update(id, (s) => {
      if (s.status !== 'review') throw new CrewError(`${id} is ${s.status}; changes are for tickets you are testing`);
      s.feedback = [...(s.feedback || []), { text: text.trim(), at: nowIso() }];
      s.status = 'queued';
      s.runNow = false;
      s.order = Date.now();
      if (s.job) s.job = { ...s.job, step: 'prepare', newRun: true, resumeWith: 'feedback', rounds: { gate: 0, verify: 0, questions: 0, errors: 0 } };
      return [
        { type: 'feedback', by, text: text.trim() },
        { type: 'status', by, text: 'review → queued · changes requested', data: { from: 'review', to: 'queued' } },
      ];
    });
  }

  // ---- discussion: design rounds before a plan ----------------------------------------------

  // Ask for the next design round (the first one starts the discussion). The runner picks it up
  // as soon as nothing else runs; you or the lead can add a note on what the round should explore.
  requestRound(id, { note = '', by = 'user' } = {}) {
    if (!['lead', 'user'].includes(by)) throw new CrewError('Only the lead or the user asks for a design round', 'forbidden');
    return this.update(id, (s) => {
      const d = s.discussion || newDiscussion();
      if (['queued', 'designing'].includes(d.state)) throw new CrewError(`${id} already has round ${d.pending?.round} ${d.state === 'queued' ? 'waiting to start' : 'in progress'}`);
      if (d.state === 'accepted') throw new CrewError(`${id}: round ${d.acceptedRound} is accepted; reopen the discussion first`);
      const evts = [];
      const inDiscussion = s.status === 'discussing' || (s.status === 'waiting' && s.resumeStatus === 'discussing');
      if (!inDiscussion) {
        if (!TRANSITIONS[s.status].includes('discussing')) throw new CrewError(`${id} is ${s.status}; it cannot go back to a discussion now`);
        evts.push({ type: 'status', by, text: `${s.status} → discussing`, data: { from: s.status, to: 'discussing' } });
        s.status = 'discussing';
      }
      const round = d.rounds.length + 1;
      // Decisions the last round asked and you left open are replaced by the next round's.
      const last = d.rounds[d.rounds.length - 1];
      for (const qid of last?.questions || []) {
        const q = s.questions.find((x) => x.id === qid);
        if (!q || q.answer) continue;
        Object.assign(q, { answer: `(left open; round ${round} replaces it)`, answeredBy: 'runner', answeredAt: nowIso(), superseded: true });
      }
      if (s.status === 'waiting' && !openQuestions(s).some((x) => x.to === 'user')) {
        evts.push({ type: 'status', by, text: 'waiting → discussing', data: { from: 'waiting', to: 'discussing' } });
        s.status = 'discussing';
        s.resumeStatus = null;
      }
      // Trying a failed round again keeps its focus unless you give a new one.
      const focus = String(note || '').trim() || (d.state === 'failed' ? d.pending?.note || '' : '');
      s.discussion = { ...d, state: 'queued', step: null, lastError: null, pending: { round, note: focus, by, at: nowIso() } };
      evts.push({ type: 'discussion', by, text: `round ${round} requested${note ? `: ${String(note).trim()}` : ''}`, data: { round } });
      return evts;
    });
  }

  // Open the discussion without a round yet (the lead frames round 1 first).
  startDiscussion(id, { by = 'user' } = {}) {
    if (!['lead', 'user'].includes(by)) throw new CrewError('Only the lead or the user starts a discussion', 'forbidden');
    return this.update(id, (s) => {
      if (s.discussion) return null;
      s.discussion = newDiscussion();
      if (s.status === 'discussing') return null;
      if (!TRANSITIONS[s.status].includes('discussing')) throw new CrewError(`${id} is ${s.status}; it cannot go to a discussion now`);
      const from = s.status;
      s.status = 'discussing';
      return { type: 'status', by, text: `${from} → discussing`, data: { from, to: 'discussing' } };
    });
  }

  // You accept a round: its open decisions take the recommended pick, and the lead plans the build.
  acceptRound(id, { round, by = 'user' } = {}) {
    if (by !== 'user') throw new CrewError('Only you accept a design round', 'forbidden');
    return this.update(id, (s) => {
      const d = s.discussion;
      if (!d?.rounds?.length) throw new CrewError(`${id} has no design round to accept yet`);
      if (['queued', 'designing'].includes(d.state)) throw new CrewError(`${id} has round ${d.pending?.round} in progress; wait for it, or accept after it`);
      const n = Number(round) || d.rounds.length;
      const r = d.rounds.find((x) => x.n === n);
      if (!r) throw new CrewError(`${id} has no round ${n}`);
      const at = nowIso();
      const evts = [];
      for (const qid of r.questions || []) {
        const q = s.questions.find((x) => x.id === qid);
        if (!q || q.answer) continue;
        const pick = (q.options || []).find((o) => /\(recommended\)/i.test(o)) || q.options?.[0] || 'as the page recommends';
        q.answer = `${pick.replace(/\s*\(recommended\)\s*/i, '').trim()} (accepted with round ${n})`;
        q.answeredBy = 'user';
        q.answeredAt = at;
        const did = `D${s.decisions.length + 1}`;
        s.decisions.push({ id: did, text: `${firstLine(q.text)} → ${q.answer}`, why: '', by: 'user', at, fromQ: qid });
        evts.push({ type: 'decision', by, text: `${did} from ${qid} (recommended pick)`, data: { decision: did } });
      }
      s.discussion = { ...d, state: 'accepted', acceptedRound: n, acceptedAt: at, pending: null, step: null };
      const from = s.status;
      s.status = 'shaping';
      s.resumeStatus = null;
      evts.push({ type: 'discussion', by, text: `round ${n} accepted`, data: { round: n } });
      evts.push({ type: 'status', by, text: `${from} → shaping · round ${n} accepted`, data: { from, to: 'shaping' } });
      return evts;
    });
  }

  writeTicketFile(id, name, text, { by = 'runner' } = {}) {
    if (!TICKET_FILES.includes(name)) throw new CrewError(`Cannot write ${name}`);
    if (name === 'contract.md') return this.setContract(id, text, { by });
    if (name === 'story.md' && !['lead', 'user'].includes(by)) throw new CrewError('Only the lead or the user can change a story', 'forbidden');
    return this.update(id, () => {
      writeFileAtomic(path.join(this.dir(id), name), text.trimEnd() + '\n');
      return { type: 'file', by, text: `${name} updated` };
    });
  }

  // ---- internals ------------------------------------------------------------

  _write(state) {
    writeJson(path.join(this.dir(state.id), 'state.json'), state);
    const tz = this.config().timezone;
    writeFileAtomic(path.join(this.dir(state.id), 'questions.md'), renderQuestions(state, tz));
    writeFileAtomic(path.join(this.dir(state.id), 'decisions.md'), renderDecisions(state, tz));
  }

  _event(state, evt) {
    const e = { ts: nowIso(), ...evt };
    appendJsonl(path.join(this.dir(state.id), 'events.jsonl'), e);
    appendJsonl(this.feedFile, { ticket: state.id, title: state.title, status: state.status, ...e });
  }
}

export function openQuestions(state) {
  return state.questions.filter((q) => !q.answer);
}

function findQuestion(s, qid) {
  const q = s.questions.find((x) => x.id.toLowerCase() === String(qid).toLowerCase());
  if (!q) throw new CrewError(`${s.id} has no question ${qid}`, 'not_found');
  return q;
}

export function newDiscussion() {
  return { state: 'new', pending: null, step: null, rounds: [], acceptedRound: null, acceptedAt: null, lastError: null };
}

function checkTransition(s, to, by, force) {
  if (!TRANSITIONS[s.status].includes(to) && !force) {
    throw new CrewError(`${s.id} cannot go from ${s.status} to ${to}`);
  }
  if (force && by !== 'user' && by !== 'runner') throw new CrewError('Only you can force a status change', 'forbidden');
  if (['worker', 'verifier', 'designer'].includes(by)) throw new CrewError('Workers do not change ticket status; the runner does', 'forbidden');
  // A discussion ends when you accept a round (acceptRound), not when someone moves the card.
  if (s.status === 'discussing' && to === 'shaping' && by !== 'user' && !force) {
    throw new CrewError(`${s.id} is being discussed; it goes to planning when the user accepts a round`, 'forbidden');
  }
  if (['building', 'review'].includes(to) && by !== 'runner' && !force) {
    throw new CrewError(`Only the runner moves tickets to ${to}`, 'forbidden');
  }
  if (['done', 'dropped'].includes(to) && by !== 'user') {
    throw new CrewError(`Only you can mark a ticket ${to}`, 'forbidden');
  }
  if (to === 'queued' && by === 'lead' && s.approval !== 'auto') {
    throw new CrewError(`${s.id} needs your approval before it is queued; the lead can only propose it`, 'forbidden');
  }
}

// A contract needs a goal and testable acceptance lines; the rest is advice.
export function checkContract(text) {
  const t = String(text || '');
  const problems = [];
  if (!/^##\s+Goal\b/im.test(t)) problems.push('a "## Goal" section');
  const acc = t.match(/^##\s+Acceptance\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im);
  if (!acc) problems.push('a "## Acceptance" section');
  else if (!/^\s*(?:[-*]|\d+[.)]|A\d+[.:)])\s+\S/m.test(acc[1])) problems.push('at least one acceptance line');
  return problems;
}

const pad = (n) => String(n).padStart(2, '0');
const firstLine = (t) => String(t).split('\n')[0].trim();
const who = (role) => ({ user: 'you', lead: 'the lead', designer: 'the designer', worker: 'the worker', verifier: 'the verifier', runner: 'the runner' })[role] || role;

function stamp(iso, tz) {
  if (!iso) return '';
  const z = zoned(new Date(iso), tz);
  return `${z.date} ${pad(z.hh)}:${pad(z.mm)}`;
}

function renderQuestions(s, tz) {
  const lines = [`# Questions · ${s.id}`, ''];
  if (!s.questions.length) lines.push('No questions yet.', '');
  for (const q of s.questions) {
    lines.push(`## ${q.id} · ${q.answer ? 'answered' : 'open'} · for ${who(q.to)} · from ${who(q.from)} · ${stamp(q.at, tz)}`);
    lines.push(q.text);
    if (q.options?.length) lines.push(`Options: ${q.options.join(' / ')}`);
    if (q.answer) lines.push('', `**Answer (${who(q.answeredBy)}, ${stamp(q.answeredAt, tz)}):** ${q.answer}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderDecisions(s, tz) {
  const lines = [`# Decisions · ${s.id}`, ''];
  if (!s.decisions.length) lines.push('No decisions yet.');
  for (const d of s.decisions) {
    const src = d.fromQ ? ` · from ${d.fromQ}` : '';
    lines.push(`- **${d.id}** (${who(d.by)}, ${stamp(d.at, tz)}${src}) ${d.text}${d.why ? ` — why: ${d.why}` : ''}`);
  }
  return lines.join('\n') + '\n';
}
