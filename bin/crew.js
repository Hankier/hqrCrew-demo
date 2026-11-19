#!/usr/bin/env node
// crew: the one CLI that people, the lead and the workers all use to change tickets.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { crewHome, loadConfig } from '../src/config.js';
import { Store, CrewError, STATUSES, TYPES } from '../src/store.js';
import { boardModel, digest, COLUMNS } from '../src/board.js';
import { readJson, readJsonl, writeFileAtomic } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `crew — one orchestrator, a crew of agents, a night-shift queue.

Tickets
  crew new <bug|feature|idea|chore> <title> [--body TEXT | --stdin] [--project KEY] [--priority 1|2|3]
  crew list [--status S] [--json]          crew show <ID> [--json]
  crew board [--json]                      crew digest
  crew note <ID> <text>                    crew events <ID> [--limit N]
  crew set <ID> <priority|approval|title|type> <value>

Shaping (the lead)
  crew story <ID> (--file F | --stdin)     crew contract <ID> (--file F | --stdin)
  crew ask <ID> <question> [--to user|lead] [--options "a|b"]
  crew answer <ID> <Q#> <answer> [--quote "the user's words"]   crew escalate <ID> <Q#> [--note TEXT]
  crew decide <ID> <decision> [--why TEXT]
  crew notes [--stdin]       the lead's memory across conversations (show, or replace)

Flow
  crew approve <ID>          your OK on the plan: ready → queued
  crew queue <ID> [--now] [--top]           crew status <ID> <status> [--force]
  crew changes <ID> <what to change>        crew park|drop|done|reopen <ID>
  crew preview up|down|extend <ID>

Discuss first (design rounds before a plan)
  crew discuss <ID> [--note TEXT]   start the discussion, or ask for the next round
  crew accept <ID> [--round N]      you accept a round: open decisions take the pick, the lead plans
  crew lab up|down|status [--project KEY] [--reset]   today's app with the demo data
  crew lab shot <path> [--as ROLE] [--width 390|1280] [--out FILE] [--viewport]
  crew page-check <file> [--shots DIR]   script errors, sideways scrolling, outside requests

Workers
  crew worker-ask <question>     ask the lead, then stop (needs CREW_TICKET)
  crew gate [--stage fast|all] [--hook] [--json]
  crew write <ID> <plan.md|check.md|verify.md|notes.md> (--file F | --stdin)

Service
  crew init [--project KEY --prefix PA --name NAME --template node|python]   crew doctor
  crew golden [PROJECT] [--force]   build the demo database previews and workers copy
  crew serve                 board + runner + previews (http://127.0.0.1:20100)
  crew run [--once] [--ticket ID]                     crew lead <message>
  crew attach [--rc]         open the lead's conversation here (--rc: also in the Claude app; Claude Code only)

Env: CREW_HOME (default ~/crew), CREW_ROLE (user|lead|designer|worker|verifier|runner), CREW_TICKET.`;

const OPTIONS = {
  body: { type: 'string' },
  stdin: { type: 'boolean' },
  file: { type: 'string' },
  project: { type: 'string' },
  priority: { type: 'string' },
  status: { type: 'string' },
  json: { type: 'boolean' },
  to: { type: 'string' },
  options: { type: 'string' },
  why: { type: 'string' },
  note: { type: 'string' },
  force: { type: 'boolean' },
  now: { type: 'boolean' },
  top: { type: 'boolean' },
  limit: { type: 'string' },
  stage: { type: 'string' },
  hook: { type: 'boolean' },
  once: { type: 'boolean' },
  ticket: { type: 'string' },
  prefix: { type: 'string' },
  template: { type: 'string' },
  name: { type: 'string' },
  cwd: { type: 'string' },
  rc: { type: 'boolean' },
  round: { type: 'string' },
  reset: { type: 'boolean' },
  as: { type: 'string' },
  width: { type: 'string' },
  out: { type: 'string' },
  shots: { type: 'string' },
  viewport: { type: 'boolean' },
  quote: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const role = process.env.CREW_ROLE || 'user';
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

function readInput(values, required = true) {
  if (values.file) return fs.readFileSync(values.file, 'utf8');
  if (values.stdin) return fs.readFileSync(0, 'utf8');
  if (values.body !== undefined) return values.body;
  if (required) throw new CrewError('Give the text with --file F or --stdin');
  return '';
}

function need(args, n, usage) {
  if (args.length < n) throw new CrewError(`Usage: ${usage}`);
}

function showTicket(store, id, asJson) {
  const s = store.state(id);
  if (asJson) {
    const files = {};
    for (const f of ['story.md', 'contract.md', 'plan.md', 'check.md', 'verify.md', 'notes.md']) files[f] = store.readFile(id, f);
    return out(JSON.stringify({ state: s, files, events: store.events(id, { limit: 50 }) }, null, 2));
  }
  const lines = [
    `${s.id} · ${s.title}`,
    `${s.type} · ${s.status} · priority ${s.priority} · approval ${s.approval}${s.branch ? ` · branch ${s.branch}` : ''}`,
    '',
    store.readFile(id, 'story.md').trim(),
  ];
  const d = s.discussion;
  if (d) {
    lines.push('', `Discussion: ${d.state}${d.pending ? ` · round ${d.pending.round} ${d.state === 'designing' ? `(${d.step})` : 'queued'}` : ''}${d.acceptedRound ? ` · round ${d.acceptedRound} accepted` : ''}${d.lastError ? ` · ${d.lastError}` : ''}`);
    for (const r of d.rounds || []) {
      lines.push(`  Round ${r.n} · ${r.at.slice(0, 16).replace('T', ' ')} · ${path.join(store.dir(id), 'discuss', r.page)}${r.link ? ` · ${r.link}` : ''}${r.questions?.length ? ` · ${r.questions.join(', ')}` : ''}`);
      if (r.n === d.rounds.length) lines.push(...r.summary.split('\n').map((l) => `    ${l}`));
    }
  }
  const contract = store.readFile(id, 'contract.md').trim();
  lines.push('', contract ? contract : '(no contract yet)');
  if (s.questions.length) lines.push('', store.readFile(id, 'questions.md').trim());
  if (s.decisions.length) lines.push('', store.readFile(id, 'decisions.md').trim());
  if (s.verdict) lines.push('', `Verifier: ${s.verdict.result}${s.verdict.score ? ` ${s.verdict.score}/10` : ''}`);
  if (s.preview?.url) lines.push(`Preview: ${s.preview.state} ${s.preview.url}`);
  const ev = store.events(id, { limit: 8 });
  if (ev.length) lines.push('', 'Recent:', ...ev.map((e) => `  ${e.ts.slice(5, 16).replace('T', ' ')} ${e.by}: ${e.text}`));
  out(lines.join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help || cmd === 'help') return out(HELP);

  const home = crewHome();
  if (cmd === 'init') return (await import('../src/init.js')).init({ home, root: ROOT, project: values.project, prefix: values.prefix, name: values.name, template: values.template, out });

  const store = new Store(home);
  const ticketArg = () => {
    const id = (args[0] || '').toUpperCase();
    if (!id) throw new CrewError('Which ticket? Give an ID like PA-012');
    return id;
  };

  switch (cmd) {
    case 'new': {
      need(args, 2, 'crew new <type> <title>');
      const [type, ...title] = args;
      if (!TYPES.includes(type)) throw new CrewError(`Type must be one of ${TYPES.join(', ')}`);
      const s = store.newTicket({ project: values.project, type, title: title.join(' '), body: readInput(values, false), by: role, priority: values.priority });
      return out(values.json ? JSON.stringify(s) : `${s.id} created (${s.type}, approval: ${s.approval})`);
    }
    case 'list': {
      const ts = store.list({ status: values.status?.split(','), project: values.project });
      if (values.json) return out(JSON.stringify(ts, null, 2));
      if (!ts.length) return out('No tickets.');
      return out(ts.map((t) => `${t.id.padEnd(8)} ${t.status.padEnd(9)} ${t.type.padEnd(8)} P${t.priority} ${t.title}`).join('\n'));
    }
    case 'show':
      return showTicket(store, ticketArg(), values.json);
    case 'board': {
      const model = boardModel(store.list());
      if (values.json) return out(JSON.stringify(model, null, 2));
      const lines = [];
      for (const c of model.columns) {
        lines.push(`${c.title} (${c.tickets.length})`);
        for (const t of c.tickets) lines.push(`  ${t.id} ${t.type} ${t.title}${t.needs ? `  → ${t.needs}` : ''}`);
      }
      if (model.parked.length) lines.push(`Parked (${model.parked.length})`, ...model.parked.map((t) => `  ${t.id} ${t.title}`));
      return out(lines.join('\n'));
    }
    case 'digest': {
      const cfg = loadConfig(home);
      const runner = readJson(path.join(home, 'runner.json'), null);
      return out(digest(store.list(), { tz: cfg.timezone, runner, title: 'Board' }));
    }
    case 'events': {
      const ev = store.events(ticketArg(), { limit: Number(values.limit) || 30 });
      return out(values.json ? JSON.stringify(ev, null, 2) : ev.map((e) => `${e.ts} ${e.by} ${e.type}: ${e.text}`).join('\n'));
    }
    case 'feed': {
      const ev = store.feed({ limit: Number(values.limit) || 30 });
      return out(ev.map((e) => `${e.ts} ${e.ticket} ${e.by} ${e.type}: ${e.text}`).join('\n'));
    }
    case 'note': {
      need(args, 2, 'crew note <ID> <text>');
      store.note(ticketArg(), args.slice(1).join(' '), { by: role });
      return out('noted');
    }
    case 'set': {
      need(args, 3, 'crew set <ID> <field> <value>');
      store.setField(ticketArg(), args[1], args.slice(2).join(' '), { by: role });
      return out('set');
    }
    case 'story':
      store.writeTicketFile(ticketArg(), 'story.md', readInput(values), { by: role });
      return out('story saved');
    case 'contract': {
      const s = store.setContract(ticketArg(), readInput(values), { by: role });
      return out(`contract saved · ${s.id} is ${s.status}${s.status === 'ready' && s.approval === 'user' ? ' (waits for the user to approve)' : ''}`);
    }
    case 'write': {
      need(args, 2, 'crew write <ID> <file>');
      store.writeTicketFile(ticketArg(), args[1], readInput(values), { by: role });
      return out(`${args[1]} saved`);
    }
    case 'ask': {
      need(args, 2, 'crew ask <ID> <question>');
      const to = values.to || (role === 'worker' ? 'lead' : 'user');
      const { qid, state } = store.ask(ticketArg(), { text: args.slice(1).join(' '), to, from: role, options: values.options ? values.options.split('|').map((x) => x.trim()) : [] });
      return out(`${qid} asked (${state.id} is ${state.status})`);
    }
    case 'answer': {
      need(args, 3, 'crew answer <ID> <Q#> <answer> [--quote "the user\'s words"]');
      const id = ticketArg();
      const q = store.state(id).questions.find((x) => x.id.toLowerCase() === args[1].toLowerCase());
      let by = role;
      let text = args.slice(2).join(' ');
      // The lead may record your answer to your own question only by quoting what you wrote in the chat.
      if (role === 'lead' && q?.to === 'user') {
        if (!values.quote) throw new CrewError(`${q.id} is for the user. If they answered it in the chat, quote their words: --quote "…"`, 'forbidden');
        const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
        const recent = readJsonl(path.join(home, 'orchestrator', 'chat.jsonl'), { limit: 60 }).filter((m) => m.role === 'user').slice(-8);
        if (!recent.some((m) => norm(m.text).includes(norm(values.quote)))) throw new CrewError(`"${values.quote}" is not in the user's recent chat messages; ask them instead`, 'forbidden');
        by = 'user';
        text = `${text} (relayed by the lead from: "${values.quote}")`;
      }
      const { decision, state } = store.answer(id, args[1], { text, by });
      return out(`${args[1].toUpperCase()} answered, recorded as ${decision} (${state.id} is ${state.status})`);
    }
    case 'escalate': {
      need(args, 2, 'crew escalate <ID> <Q#>');
      const s = store.escalate(ticketArg(), args[1], { by: role, text: values.note });
      return out(`${args[1].toUpperCase()} passed to the user (${s.id} is ${s.status})`);
    }
    case 'decide': {
      need(args, 2, 'crew decide <ID> <decision>');
      const { decision } = store.decide(ticketArg(), { text: args.slice(1).join(' '), why: values.why || '', by: role });
      return out(`${decision} recorded`);
    }
    case 'approve': {
      const id = ticketArg();
      if (role !== 'user') throw new CrewError('Only the user approves plans', 'forbidden');
      const s = store.transition(id, 'queued', { by: 'user', note: values.note || 'approved' });
      return out(`${s.id} approved and queued`);
    }
    case 'queue': {
      const id = ticketArg();
      let s = store.state(id);
      if (s.status !== 'queued') s = store.transition(id, 'queued', { by: role, note: values.note || '', force: values.force });
      if (values.now || values.top) {
        s = store.update(id, (st) => {
          if (values.now) st.runNow = true;
          if (values.top) st.order = Math.min(0, ...store.list({ status: 'queued' }).map((t) => t.order)) - 1;
          return { type: 'queue', by: role, text: [values.now && 'run now', values.top && 'moved to the top'].filter(Boolean).join(', ') };
        });
      }
      return out(`${s.id} queued${s.runNow ? ' to run now' : ''}`);
    }
    case 'status': {
      need(args, 2, 'crew status <ID> <status>');
      if (!STATUSES.includes(args[1])) throw new CrewError(`Status must be one of ${STATUSES.join(', ')}`);
      const s = store.transition(ticketArg(), args[1], { by: role, note: values.note || '', force: values.force });
      return out(`${s.id} is ${s.status}`);
    }
    case 'park':
    case 'drop':
    case 'done': {
      const to = { park: 'parked', drop: 'dropped', done: 'done' }[cmd];
      const s = store.transition(ticketArg(), to, { by: role, note: values.note || '', force: values.force });
      return out(`${s.id} is ${s.status}`);
    }
    case 'reopen': {
      const s = store.transition(ticketArg(), 'shaping', { by: role, note: values.note || 'reopened', force: values.force });
      return out(`${s.id} is ${s.status}`);
    }
    case 'changes': {
      need(args, 2, 'crew changes <ID> <what to change>');
      const id = ticketArg();
      store.requestChanges(id, args.slice(1).join(' '), { by: role });
      return out(`${id} goes back to the queue with your notes`);
    }
    case 'worker-ask': {
      const id = (process.env.CREW_TICKET || values.ticket || '').toUpperCase();
      if (!id) throw new CrewError('CREW_TICKET is not set; only workers inside a crew job use worker-ask');
      need(args, 1, 'crew worker-ask <question>');
      const { qid } = store.ask(id, { text: args.join(' '), to: 'lead', from: 'worker' });
      const wt = process.env.CREW_WORKTREE || process.cwd();
      fs.mkdirSync(path.join(wt, '.crew'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.crew', 'WAITING'), `${qid}\n`);
      return out(`${qid} sent to the lead. Stop now; you will be resumed with the answer.`);
    }
    case 'gate': {
      const { runGateCli } = await import('../src/gate.js');
      return runGateCli({ store, values, out });
    }
    case 'discuss': {
      // Start a discussion, or ask for the next design round, with an optional focus for the designer.
      const id = ticketArg();
      const s = store.requestRound(id, { note: values.note || args.slice(1).join(' '), by: role });
      return out(`${id}: design round ${s.discussion.pending.round} is queued; it starts as soon as nothing else runs`);
    }
    case 'accept': {
      const s = store.acceptRound(ticketArg(), { round: values.round, by: role });
      return out(`${s.id}: round ${s.discussion.acceptedRound} accepted; the lead plans the build`);
    }
    case 'lab': {
      need(args, 1, 'crew lab up|down|status|shot');
      if (args[0] === 'up' && !['user', 'designer', 'runner'].includes(role)) throw new CrewError('Only you or a designer start the lab', 'forbidden');
      const { labCli } = await import('../src/lab.js');
      return labCli({ store, op: args[0], args: args.slice(1), values, out });
    }
    case 'page-check': {
      need(args, 1, 'crew page-check <file> [--shots DIR]');
      const { pageCheck } = await import('../src/pagetools.js');
      const r = await pageCheck(path.resolve(args[0]), { cfg: store.config(), shotsDir: values.shots ? path.resolve(values.shots) : null });
      if (values.json) return out(JSON.stringify(r, null, 2));
      out(r.ok ? 'page check passed (390 and 1280 px)' : `page check found ${r.problems.length} problem(s):\n${r.problems.map((p) => `- ${p}`).join('\n')}`);
      if (r.shots.length) out(`slices to look at:\n${r.shots.join('\n')}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'preview': {
      need(args, 2, 'crew preview up|down|extend <ID>');
      const { previewCli } = await import('../src/preview.js');
      return previewCli({ store, op: args[0], id: args[1].toUpperCase(), out, by: role });
    }
    case 'run': {
      const { Runner } = await import('../src/runner.js');
      const r = new Runner({ store, log: (m) => out(m) });
      if (values.once || values.ticket) return out(JSON.stringify(await r.runOnce({ ticket: values.ticket?.toUpperCase(), ignoreWindow: !!values.ticket }), null, 2));
      return r.loop();
    }
    case 'notes': {
      // The lead's working memory across conversations (orchestrator/notes.md). You may edit it too.
      const file = path.join(home, 'orchestrator', 'notes.md');
      if (!values.stdin && !values.file && values.body === undefined) return out(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no notes yet)');
      if (!['lead', 'user'].includes(role)) throw new CrewError('Only the lead or the user keeps the notes', 'forbidden');
      const text = readInput(values).trim();
      if (text.length > 12000) throw new CrewError('Notes are limited to about 12,000 characters; keep only what still matters');
      writeFileAtomic(file, text + '\n');
      return out(`notes saved (${text.split('\n').length} lines)`);
    }
    case 'golden': {
      const { Runner } = await import('../src/runner.js');
      const key = args[0] || store.projects()[0]?.key;
      if (!key) throw new CrewError('No project configured');
      const built = await new Runner({ store, log: out }).ensureGolden(store.project(key), { force: !!values.force, logFile: path.join(home, 'logs', `golden-${key}.log`) });
      return out(built ? `Golden database for ${key} built.` : `Golden database for ${key} already exists (use --force to rebuild).`);
    }
    case 'serve': {
      const { serve } = await import('../src/server.js');
      return serve({ store, root: ROOT });
    }
    case 'lead': {
      need(args, 1, 'crew lead <message>');
      const { Lead } = await import('../src/lead.js');
      const lead = new Lead({ store, root: ROOT });
      const reply = await lead.say(args.join(' '), { from: 'user' });
      return out(reply.text || '(no reply)');
    }
    case 'attach': {
      const { attachLead } = await import('../src/lead.js');
      process.exitCode = await attachLead({ store, rc: !!values.rc });
      return;
    }
    case 'doctor': {
      const { doctor } = await import('../src/doctor.js');
      return doctor({ store, out });
    }
    case 'columns':
      return out(COLUMNS.map((c) => `${c.key}: ${c.statuses.join(', ')}`).join('\n'));
    default:
      throw new CrewError(`Unknown command "${cmd}". Try: crew help`);
  }
}

main().catch((e) => {
  if (e instanceof CrewError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    process.stderr.write(`crew: ${e.message}\n`);
    process.exit(e.code === 'forbidden' ? 2 : 1);
  }
  process.stderr.write(`crew: ${e.stack || e}\n`);
  process.exit(1);
});
