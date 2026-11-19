// The board: which column each ticket sits in, and a short text digest for the lead and for pushes.
import { openQuestions } from './store.js';
import { fmtAgo, fmtTime } from './util.js';

export const COLUMNS = [
  { key: 'inbox', title: 'Inbox', hint: 'New. The lead is shaping them.', statuses: ['inbox', 'shaping'] },
  { key: 'discuss', title: 'Discussing', hint: 'Design rounds: read the page, answer, accept.', statuses: ['discussing'] },
  { key: 'you', title: 'Needs you', hint: 'Questions, plans to approve, blocked work.', statuses: ['waiting', 'ready', 'blocked'] },
  { key: 'queue', title: 'Queue', hint: 'Runs tonight, top first.', statuses: ['queued'] },
  { key: 'building', title: 'Building', hint: 'Coder, gate, verifier.', statuses: ['building'] },
  { key: 'test', title: 'Test it', hint: 'Verified. Spin up a preview and click around.', statuses: ['review'] },
  { key: 'done', title: 'Done', hint: 'Accepted.', statuses: ['done'] },
];

export function columnOf(state) {
  const c = COLUMNS.find((col) => col.statuses.includes(state.status));
  return c ? c.key : 'parked';
}

// Queue order: "run now" first, then priority (1 high), then the order they were queued.
export function queueOrder(tickets) {
  return tickets
    .filter((t) => t.status === 'queued')
    .sort((a, b) => Number(b.runNow) - Number(a.runNow) || a.priority - b.priority || a.order - b.order);
}

// What a card needs from you, in a few words. Empty when nothing is needed.
export function needsYou(t) {
  if (t.status === 'waiting') {
    const qs = openQuestions(t).filter((q) => q.to === 'user');
    return qs.length ? `${qs.length === 1 ? 'Answer' : `Answer ${qs.length}`}: ${qs[0].text.split('\n')[0]}` : 'Waiting';
  }
  if (t.status === 'ready') return t.approval === 'user' ? 'Approve the plan' : 'Ready to queue';
  if (t.status === 'blocked') return `Blocked: ${t.job?.lastError || 'see timeline'}`;
  if (t.status === 'review') return t.preview?.state === 'up' ? 'Preview is up' : 'Test it';
  if (t.status === 'discussing') {
    const d = t.discussion || {};
    if (d.state === 'ready') return `Read round ${d.rounds.length}: answer, ask for another round, or accept`;
    if (d.state === 'failed') return `Round ${d.pending?.round || ''} failed: ${d.lastError || 'see timeline'}`;
  }
  return '';
}

// The few discussion facts a card shows; the ticket view has the rest.
export function discussionCard(t) {
  const d = t.discussion;
  if (!d) return null;
  const last = d.rounds?.[d.rounds.length - 1];
  return { state: d.state, round: d.rounds?.length || 0, pending: d.pending?.round || null, step: d.step || null, accepted: d.acceptedRound || null, link: last?.link || null };
}

export function boardModel(tickets, { now = Date.now() } = {}) {
  const cols = COLUMNS.map((c) => ({ ...c, tickets: [] }));
  const parked = [];
  const dropped = [];
  for (const t of tickets) {
    const key = columnOf(t);
    const card = cardOf(t, now);
    if (key === 'parked') {
      if (t.status === 'parked') parked.push(card);
      if (t.status === 'dropped') dropped.push(card);
      continue;
    }
    cols.find((c) => c.key === key).tickets.push(card);
  }
  const queue = cols.find((c) => c.key === 'queue');
  const ordered = queueOrder(tickets).map((t) => t.id);
  queue.tickets.sort((a, b) => ordered.indexOf(a.id) - ordered.indexOf(b.id));
  const done = cols.find((c) => c.key === 'done');
  done.tickets.sort((a, b) => b.updated.localeCompare(a.updated));
  done.tickets = done.tickets.slice(0, 20);
  for (const c of cols) if (c.key !== 'queue' && c.key !== 'done') c.tickets.sort((a, b) => b.updated.localeCompare(a.updated));
  dropped.sort((a, b) => b.updated.localeCompare(a.updated));
  return { columns: cols, parked, dropped: dropped.slice(0, 20) };
}

function cardOf(t, now) {
  return {
    id: t.id,
    project: t.project,
    type: t.type,
    title: t.title,
    status: t.status,
    priority: t.priority,
    approval: t.approval,
    runNow: t.runNow,
    updated: t.updated,
    ago: fmtAgo(t.updated, now),
    needs: needsYou(t),
    openQuestions: openQuestions(t).length,
    step: t.status === 'building' ? t.job?.step || null : null,
    verdict: t.verdict,
    preview: t.preview,
    branch: t.branch,
    discussion: discussionCard(t),
  };
}

export function digest(tickets, { tz = 'Europe/Warsaw', runner = null, title = 'Board' } = {}) {
  const b = boardModel(tickets);
  const lines = [`${title} · ${fmtTime(new Date().toISOString(), tz)}`];
  if (runner) lines.push(`Runner: ${runnerLine(runner, tz)}`);
  for (const c of b.columns) {
    if (!c.tickets.length || c.key === 'done') continue;
    const items = c.tickets.slice(0, 8).map((t) => {
      const bits = [t.id, t.type];
      if (c.key === 'building' && t.step) bits.push(t.step);
      if (t.discussion) bits.push(t.discussion.state === 'designing' ? `round ${t.discussion.pending} being designed` : t.discussion.state === 'queued' ? `round ${t.discussion.pending} queued` : `${t.discussion.round} round(s)`);
      if (t.needs) bits.push(`— ${t.needs}`);
      else bits.push(`— ${t.title}`);
      return bits.join(' ');
    });
    lines.push(`${c.title} (${c.tickets.length}): ${items.join(' · ')}`);
  }
  if (b.parked.length) lines.push(`Parked (${b.parked.length}): ${b.parked.map((t) => t.id).join(', ')}`);
  return lines.join('\n');
}

export function runnerLine(r, tz) {
  if (!r) return 'unknown';
  if (r.parkedUntil && new Date(r.parkedUntil) > new Date()) return `waiting for the usage limit to reset at ${fmtTime(r.parkedUntil, tz)}`;
  if (r.current) return `${r.current.ticket} · ${r.current.step} · ${fmtAgo(r.current.startedAt)}`;
  if (r.mode === 'paused') return 'paused';
  return r.inWindow || r.mode === 'always' ? 'idle, ready for the queue' : `idle until the night shift (${r.window || ''})`;
}
