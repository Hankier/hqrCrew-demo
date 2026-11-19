// `crew serve`: the one entry point. Serves the board, a JSON API, live updates (SSE),
// the chat with the lead, and runs the night-shift runner and the preview sweeper in the same process.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Runner } from './runner.js';
import { Lead } from './lead.js';
import { Previews } from './preview.js';
import { Lab, labConfig } from './lab.js';
import { notify as sendNotify } from './notify.js';
import { boardModel, digest, runnerLine } from './board.js';
import { CrewError, TICKET_FILES } from './store.js';
import { heavyHolder } from './heavy.js';
import { verifyAccessJwt } from './access.js';
import { readJson, readText, zoned, readJsonl } from './util.js';

const MAX_BODY = 256 * 1024;

export async function serve({ store, root, port: portOverride, quiet = false }) {
  const cfg = store.config();
  const log = (m) => quiet || process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  const notify = (m) => sendNotify(store.config(), m).catch(() => {});
  // The lead's usage numbers go through the runner, so runner.json has one writer path and the board hears about it.
  let runner;
  const lead = new Lead({ store, onChat: (m) => broadcast('chat', m), notify, onUsage: (w) => runner.recordUsage({ windows: w }) });
  const previews = new Previews({ store, notify, onChange: () => broadcast('previews', previews.list()) });
  runner = new Runner({ store, log, notify, lead, onChange: () => broadcast('runner', runnerView()) });
  const lab = new Lab({ store, log, onChange: () => broadcast('lab', lab.list()) });

  function runnerView() {
    const c = store.config();
    const s = runner.state();
    return { ...s, line: runnerLine(s, c.timezone) };
  }

  function stateView() {
    const c = store.config();
    const sess = lead.session();
    return {
      now: new Date().toISOString(),
      tz: c.timezone,
      publicUrl: c.publicUrl,
      board: boardModel(store.list()),
      runner: runnerView(),
      previews: previews.list(),
      lab: lab.list(),
      heavy: heavyHolder(store.home),
      lead: { busy: lead.busy, turns: sess.turns || 0, startedAt: sess.startedAt || null, costUsd: sess.costUsd || 0 },
      projects: store.projects().map((p) => ({
        key: p.key,
        prefix: p.prefix,
        name: p.name,
        slots: (p.preview?.slots || []).map((s) => ({ n: s.n, host: s.host, url: previews.slotUrl(p, s) })),
        logins: p.preview?.logins || '',
        preview: p.preview ? { buildFor: p.preview.buildFor || 1, ttlMinutes: p.preview.ttlMinutes || 120 } : null,
        lab: p.lab ? { url: labConfig(p).url, logins: Object.entries(labConfig(p).logins).map(([role, email]) => ({ role, email })) } : null,
      })),
    };
  }

  function ticketView(id) {
    const s = store.state(id);
    const files = {};
    for (const f of TICKET_FILES) files[f] = store.readFile(id, f);
    const runsDir = path.join(store.dir(id), 'runs');
    const runs = (s.runs || []).map((r) => ({
      ...r,
      logs: fs.existsSync(path.join(runsDir, r.run)) ? fs.readdirSync(path.join(runsDir, r.run)).sort() : [],
    }));
    return { state: s, files, events: store.events(id, { limit: 200 }), runs, actions: actionsFor(s) };
  }

  // ---- background work ---------------------------------------------------------------------

  // CREW_DEMO=1: show the board as it is on disk (for building the UI); no runner, no sweeps.
  const demo = !!process.env.CREW_DEMO;
  if (!demo) runner.recover();
  let feedSize = fs.existsSync(store.feedFile) ? fs.statSync(store.feedFile).size : 0;
  const feedTimer = setInterval(() => {
    try {
      const size = fs.existsSync(store.feedFile) ? fs.statSync(store.feedFile).size : 0;
      if (size === feedSize) return;
      if (size < feedSize) feedSize = 0;
      const fd = fs.openSync(store.feedFile, 'r');
      const buf = Buffer.alloc(size - feedSize);
      fs.readSync(fd, buf, 0, buf.length, feedSize);
      fs.closeSync(fd);
      feedSize = size;
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          broadcast('feed', JSON.parse(line));
        } catch {}
      }
    } catch (e) {
      log(`feed: ${e.message}`);
    }
  }, 1000);

  let ticking = false;
  let lastCleanup = 0;
  const tick = async () => {
    if (ticking || demo) return;
    ticking = true;
    try {
      previews.sweep();
      lab.sweep();
      await morningDigest();
      if (Date.now() - lastCleanup > 3600e3) {
        lastCleanup = Date.now();
        runner.cleanup().catch((e) => log(`cleanup: ${e.message}`));
      }
      runner.tick().catch((e) => log(`runner: ${e.stack || e}`));
    } catch (e) {
      log(`tick: ${e.stack || e}`);
    } finally {
      ticking = false;
    }
  };
  const tickTimer = setInterval(tick, (cfg.runner.tickSeconds || 20) * 1000);
  setTimeout(tick, 1500);

  async function morningDigest() {
    const c = store.config();
    if (!c.digest?.at) return;
    const z = zoned(new Date(), c.timezone);
    const [h, m] = c.digest.at.split(':').map(Number);
    if (z.hh * 60 + z.mm < h * 60 + m) return;
    const rs = readJson(runner.file, {});
    if (rs.lastDigest === z.date) return;
    runner.save({ lastDigest: z.date });
    const text = digest(store.list(), { tz: c.timezone, runner: runner.state(), title: 'Morning' });
    await notify({ title: 'Crew · morning', text, url: c.publicUrl || '', tags: 'sunrise' });
  }

  // ---- http ----------------------------------------------------------------------------------

  const uiFile = path.join(root, 'ui', 'index.html');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
      if (!(await authorized(req, url, res, store.config(), { demo }))) return;
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, readText(uiFile, '<h1>crew</h1><p>ui/index.html is missing</p>'), 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.method === 'POST' && req.headers['x-crew'] !== '1') return send(res, 403, { error: 'missing X-Crew header' });
      return await route(req, res, url);
    } catch (e) {
      if (e instanceof CrewError) return send(res, e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400, { error: e.message });
      log(`http: ${e.stack || e}`);
      return send(res, 500, { error: String(e.message || e) });
    }
  });

  async function route(req, res, url) {
    const p = url.pathname;
    const m = (re) => p.match(re);
    let mm;

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, stateView());

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/chat') return send(res, 200, lead.history(Number(url.searchParams.get('limit')) || 120));

    if (req.method === 'POST' && p === '/api/chat') {
      const { text } = await body(req);
      if (!text || !String(text).trim()) throw new CrewError('Empty message');
      lead.say(String(text).trim(), { from: 'user' }).catch((e) => lead.post('lead', `Error: ${e.message}`, { error: 'error' }));
      return send(res, 202, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/runner') {
      const b = await body(req);
      if (b.mode) runner.setMode(b.mode);
      if (b.clearPark) runner.save({ parkedUntil: null, parkReason: null });
      if (b.clearAuth) runner.save({ authProblem: null });
      if (b.wake) setTimeout(tick, 10);
      return send(res, 200, runnerView());
    }

    if (req.method === 'POST' && p === '/api/tickets') {
      const b = await body(req);
      const s = store.newTicket({ project: b.project, type: b.type || 'idea', title: b.title, body: b.body || '', by: 'user', priority: b.priority || 2 });
      if (b.discuss) {
        store.startDiscussion(s.id, { by: 'user' });
        lead
          .say(`[event] The user added ${s.type} ${s.id}: "${s.title}" and wants to discuss it first (design rounds, no plan yet).${b.body ? `\n\n${b.body}` : ''}\n\nIf it is clear enough, start round 1 now with a focus for the designer: crew discuss ${s.id} --note "<what to explore>". If one thing is unclear, ask the user that one question first.`, { from: 'event', ticket: s.id })
          .catch(() => {});
        return send(res, 201, { id: s.id, state: store.state(s.id) });
      }
      if (b.shape !== false) {
        lead
          .say(`[event] The user added ${s.type} ${s.id}: "${s.title}"${b.body ? `\n\n${b.body}` : ''}\n\nShape it: read the code, ask only what the user must decide, or write the contract.`, { from: 'event', ticket: s.id })
          .catch(() => {});
      }
      return send(res, 201, { id: s.id, state: s });
    }

    if (req.method === 'GET' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)$/))) return send(res, 200, ticketView(mm[1].toUpperCase()));

    if (req.method === 'GET' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/log\/(r\d+)\/([\w.-]+)$/))) {
      const id = mm[1].toUpperCase();
      if (mm[3].startsWith('.')) throw new CrewError('No such log', 'not_found');
      const file = path.join(store.dir(id), 'runs', mm[2], mm[3]);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new CrewError('No such log', 'not_found');
      const tail = Number(url.searchParams.get('tail')) || 400;
      const text = url.searchParams.get('readable') && file.endsWith('.jsonl') ? readableTranscript(file) : readText(file);
      return send(res, 200, text.split('\n').slice(-tail).join('\n'), 'text/plain; charset=utf-8');
    }

    if (req.method === 'GET' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/preview-log\/(\d+)$/))) {
      const file = path.join(store.dir(mm[1].toUpperCase()), `preview-${mm[2]}.log`);
      if (!fs.existsSync(file)) throw new CrewError('No preview log for this slot yet', 'not_found');
      const tail = Number(url.searchParams.get('tail')) || 300;
      return send(res, 200, readText(file).split('\n').slice(-tail).join('\n'), 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/action$/))) {
      const id = mm[1].toUpperCase();
      const b = await body(req);
      return send(res, 200, { ok: true, state: doAction(id, b) });
    }

    if (req.method === 'POST' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/answer$/))) {
      const id = mm[1].toUpperCase();
      const b = await body(req);
      const before = store.state(id);
      const { decision, state } = store.answer(id, b.q, { text: b.text, by: 'user' });
      if (state.status === 'shaping' || (before.status === 'waiting' && state.status !== 'queued' && state.status !== 'waiting')) {
        lead.say(`[event] The user answered ${String(b.q).toUpperCase()} on ${id}: "${b.text}" (recorded as ${decision}). Continue with ${id}.`, { from: 'event', ticket: id }).catch(() => {});
      }
      if (state.status === 'queued') setTimeout(tick, 10);
      return send(res, 200, { ok: true, decision, status: state.status });
    }

    // A design round's page. Agents wrote it, so it runs sandboxed: its scripts can't call this API.
    if (req.method === 'GET' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/discuss\/(round-\d+\.(?:html|md))$/))) {
      const file = path.join(store.dir(mm[1].toUpperCase()), 'discuss', mm[2]);
      if (!fs.existsSync(file)) throw new CrewError('No such round', 'not_found');
      if (mm[2].endsWith('.md')) return send(res, 200, readText(file), 'text/plain; charset=utf-8');
      return send(res, 200, readText(file), 'text/html; charset=utf-8', {
        'content-security-policy': "sandbox allow-scripts allow-popups; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; script-src 'unsafe-inline'",
        'cache-control': 'no-store',
      });
    }

    if (req.method === 'POST' && p === '/api/lab') {
      const b = await body(req);
      if (b.op === 'up') {
        const cur = lab.list().find((x) => x.project === (b.project || lab.list()[0]?.project));
        if (!cur) throw new CrewError('No project has lab settings');
        lab.up(cur.project, { by: 'user', reset: !!b.reset }).catch((e) => log(`lab ${cur.project}: ${e.message}`));
        return send(res, 202, { ok: true });
      }
      if (b.op === 'down') return send(res, 200, { ok: true, lab: lab.down(b.project) });
      if (b.op === 'extend') return send(res, 200, { ok: true, lab: lab.extend(b.project) });
      throw new CrewError('op must be up, down or extend');
    }

    if (req.method === 'POST' && (mm = m(/^\/api\/tickets\/([A-Za-z]+-\d+)\/preview$/))) {
      const id = mm[1].toUpperCase();
      const { op } = await body(req);
      if (op === 'up') {
        previews.plan(id); // fails fast: no worktree, already starting, all slots busy
        previews.up(id, { by: 'user' }).catch((e) => log(`preview ${id}: ${e.message}`));
        return send(res, 202, { ok: true });
      }
      if (op === 'down') return send(res, 200, { ok: true, preview: previews.down(id, { by: 'user' }) });
      if (op === 'extend') return send(res, 200, { ok: true, preview: previews.extend(id, { by: 'user' }) });
      throw new CrewError('op must be up, down or extend');
    }

    return send(res, 404, { error: 'not found' });
  }

  function doAction(id, b) {
    const a = b.action;
    const note = (b.note || '').trim();
    switch (a) {
      case 'approve':
      case 'queue':
        return store.transition(id, 'queued', { by: 'user', note: note || (a === 'approve' ? 'approved' : '') });
      case 'runNow': {
        let s = store.state(id);
        if (s.status !== 'queued') s = store.transition(id, 'queued', { by: 'user', note: 'run now' });
        s = store.update(id, (x) => {
          x.runNow = true;
          return { type: 'queue', by: 'user', text: 'run now' };
        });
        setTimeout(tick, 10);
        return s;
      }
      case 'top':
        return store.update(id, (x) => {
          x.order = Math.min(0, ...store.list({ status: 'queued' }).map((t) => t.order)) - 1;
          return { type: 'queue', by: 'user', text: 'moved to the top' };
        });
      case 'park':
        return store.transition(id, 'parked', { by: 'user', note });
      case 'drop':
        return store.transition(id, 'dropped', { by: 'user', note });
      case 'done':
        if (store.state(id).preview?.state === 'up') previews.down(id, { by: 'user', reason: 'stopped (ticket done)' });
        return store.transition(id, 'done', { by: 'user', note });
      case 'reopen':
        return store.transition(id, 'shaping', { by: 'user', note: note || 'reopened', force: true });
      case 'retry':
        return store.transition(id, 'queued', { by: 'user', note: note || 'retry' });
      case 'changes':
        if (store.state(id).preview?.state === 'up') previews.down(id, { by: 'user', reason: 'stopped (changes requested)' });
        return store.requestChanges(id, note, { by: 'user' });
      case 'priority':
        return store.setField(id, 'priority', b.value, { by: 'user' });
      case 'approval':
        return store.setField(id, 'approval', b.value, { by: 'user' });
      case 'note':
        if (!note) throw new CrewError('Empty note');
        return store.note(id, note, { by: 'user' });
      case 'discuss': {
        const s = store.requestRound(id, { note, by: 'user' });
        setTimeout(tick, 10);
        return s;
      }
      case 'accept': {
        const s = store.acceptRound(id, { round: b.round, by: 'user' });
        const n = s.discussion.acceptedRound;
        const r = s.discussion.rounds.find((x) => x.n === n);
        const picked = s.decisions.filter((d) => (r?.questions || []).includes(d.fromQ)).map((d) => `- ${d.id}: ${d.text}`);
        lead
          .say(
            `[event] The user accepted design round ${n} of ${id}${r?.link ? ` (${r.link})` : ''}. Its decisions:\n${picked.join('\n') || '(none)'}\n\nPlan the build now. If it is one change, write the contract on ${id}. If the page describes several independent changes, create one ticket per change (crew new feature "<title>" --body "<what, from ${id} round ${n}>") and write each contract. Every contract's Context names the accepted page (tickets/${id}/discuss/round-${n}.html), and its Acceptance covers the screens and states the user accepted.`,
            { from: 'event', ticket: id },
          )
          .catch(() => {});
        return s;
      }
      default:
        throw new CrewError(`Unknown action ${a}`);
    }
  }

  const port = portOverride ?? cfg.listen.port;
  await new Promise((resolve) => server.listen(port, cfg.listen.host, resolve));
  const addr = server.address();
  log(`crew board on http://${cfg.listen.host}:${addr.port} · CREW_HOME=${store.home}`);
  if (!cfg.auth?.token && !(cfg.auth?.cfAccess?.team && cfg.auth?.cfAccess?.aud)) {
    log(cfg.publicUrl ? 'WARNING: publicUrl is set but no login is configured; the board answers 503 until auth is set in crew.json.' : 'No login configured: keep the board on localhost.');
  }

  const shutdown = () => {
    clearInterval(feedTimer);
    clearInterval(tickTimer);
    runner.stop();
    for (const c of clients) c.end();
    server.close();
  };
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  return { server, port: addr.port, runner, lead, previews, shutdown };
}

// What you can do with a ticket right now, for the board's buttons.
export function actionsFor(s) {
  const a = ['note', 'priority'];
  const st = s.status;
  if (st === 'ready') a.push('approve', 'park', 'drop');
  if (['inbox', 'shaping', 'waiting'].includes(st)) a.push('park', 'drop');
  if (st === 'queued') a.push('runNow', 'top', 'park', 'drop');
  if (st === 'blocked') a.push('retry', 'reopen', 'park', 'drop');
  if (st === 'review') a.push('done', 'changes', 'drop');
  if (['parked', 'done', 'dropped'].includes(st)) a.push('reopen');
  const d = s.discussion;
  const inDiscussion = st === 'discussing' || (st === 'waiting' && s.resumeStatus === 'discussing');
  const roundBusy = !!d && ['queued', 'designing'].includes(d.state);
  if (inDiscussion) {
    if (!roundBusy) a.push('discuss');
    if (d?.rounds?.length && !roundBusy) a.push('accept');
    if (st === 'discussing') a.push('park', 'drop');
  } else if (['inbox', 'shaping', 'ready', 'parked'].includes(st) && !d?.acceptedRound) a.push('discuss');
  if (s.job?.worktree && ['review', 'blocked', 'done'].includes(st)) {
    a.push(s.preview?.state === 'up' ? 'previewDown' : 'previewUp');
    if (s.preview?.state === 'up') a.push('previewExtend');
  }
  a.push('approval');
  return a;
}

// Who may use the board. On a public address (publicUrl set) some login is required:
//   auth.cfAccess {team, aud} (+ auth.emails): the signed Access JWT is verified, or
//   auth.token: a long random token, set once with ?token=… and kept in a cookie.
async function authorized(req, url, res, cfg, { demo = false } = {}) {
  const auth = cfg.auth || {};
  const access = auth.cfAccess?.team && auth.cfAccess?.aud ? auth.cfAccess : null;
  if (!access && !auth.token) {
    // Through the tunnel (any proxy header) a login is required; directly on localhost it is not.
    const proxied = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray'];
    if (proxied && !demo) {
      send(res, 503, { error: 'This board is reachable from outside but has no login. Set auth.cfAccess (team, aud) or auth.token in crew.json.' });
      return false;
    }
    return true;
  }
  if (access) {
    const token = req.headers['cf-access-jwt-assertion'] || String(req.headers.cookie || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
    try {
      const claims = await verifyAccessJwt(token, access);
      const emails = (auth.emails || []).map((e) => e.toLowerCase());
      if (emails.length && !emails.includes(String(claims.email || '').toLowerCase())) throw new Error('email not allowed');
      return true;
    } catch (e) {
      if (!auth.token) {
        send(res, 401, { error: `Not signed in through Cloudflare Access (${e.message})` });
        return false;
      }
    }
  }
  const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)crew_token=([^;]+)/)?.[1];
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token');
  if (q && q === auth.token) {
    const secure = String(cfg.publicUrl || '').startsWith('https:') ? '; Secure' : '';
    res.setHeader('set-cookie', `crew_token=${auth.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
    return true;
  }
  if (cookie !== auth.token && bearer !== auth.token) {
    send(res, 401, { error: 'Missing or wrong token. Open the board once with ?token=…' });
    return false;
  }
  return true;
}

function send(res, status, data, type = 'application/json; charset=utf-8', headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new CrewError('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new CrewError('Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

// A coder or verifier transcript (stream-json) as lines a person can skim.
export function readableTranscript(file) {
  const out = [];
  for (const e of readJsonl(file)) {
    if (e.crew === 'start') out.push(`── start ${e.at} in ${e.cwd}`);
    else if (e.crew === 'end') out.push(`── end: exit ${e.code}${e.isError ? ', error' : ''}${e.limit?.hit ? ', usage limit' : ''}${e.timedOut ? ', timed out' : ''}`);
    else if (e.type === 'assistant') {
      for (const c of e.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) out.push(`» ${c.text.trim()}`);
        if (c.type === 'tool_use') {
          const i = c.input || {};
          const what = c.name === 'Bash' ? `$ ${String(i.command || '').split('\n')[0]}` : `${c.name} ${i.file_path || i.pattern || i.description || ''}`;
          out.push(`  · ${what.slice(0, 200)}`);
        }
      }
    } else if (e.type === 'result') out.push(`── result: ${e.subtype} · ${e.num_turns} turns · $${(e.total_cost_usd || 0).toFixed(2)}`);
  }
  return out.join('\n');
}
