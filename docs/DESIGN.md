# crew design

## CREW_HOME layout
```
crew.json                      settings (night window, models, limits, notify, auth, safety)
projects/<key>/project.json    repo, setup, gate checks, env, databases, preview slots
projects/<key>/vision.md       product intent: the lead and coders answer questions from it
projects/<key>/agent.env       sandbox secrets only (chmod 600)
tickets/<ID>/                  one folder per ticket (below)
orchestrator/                  the lead: CLAUDE.md + AGENTS.md (same text), notes.md, session.json, chat.jsonl, logs/
mirrors/<key>/                 clean clone on origin/main (the lead reads code here)
worktrees/<ID>/                one git worktree per ticket; .crew/ inside holds the brief (git-excluded)
runner.json                    mode, current job, usage windows, park, tonight's count, golden date
previews.json                  slot → ticket, url, expiry
lab.json, lab/                 the lab per project: state, address, expiry; its log
tools/                         playwright-core for page checks and lab screenshots (npm, no browser download)
feed.jsonl                     every ticket event, for live updates
```

## Projects
Each project folder holds `project.json`, `vision.md` and `agent.env`, plus optional `coder.md` and `verifier.md`, which are appended to those role prompts. The prompts in `prompts/` stay generic. Anything specific to a stack (database migrations, a build's memory needs, the language of the UI) goes in the project notes or `vision.md`. Templates: `node`, `python` (`crew init --template …`).

## A ticket folder
| File | Written by | What |
|---|---|---|
| `state.json` | crew only | status, type, priority, approval, questions[], decisions[], job, runs[], verdict, preview, branch |
| `story.md` | intake, lead | the user's words, verbatim, and the lead's notes |
| `contract.md` | lead | Goal, Context, Acceptance (A1…), Out of scope, Files, Tests, Manual check, Risks, Allowed test changes |
| `questions.md`, `decisions.md` | crew (rendered) | Q1… with answers; D1… with who decided and why. An answer becomes a decision |
| `plan.md`, `check.md` | coder | approach, written before code; steps for the user on the preview |
| `verify.md` | verifier | per-line scores with file:line evidence, PASS or FAIL |
| `events.jsonl` | crew | the timeline |
| `runs/rN/` | runner | prepare.log, coder-N.jsonl, gate-N.log/json, verifier-N.jsonl, verify-N.md |
| `discuss/rN/` | designer | brief.md (from crew), page.html, summary.md, decisions.json, shots/, designer-N.jsonl |
| `discuss/round-N.html`, `round-N.md` | runner | the published round and its summary; `<id>-discussion.html` is the shared copy |

## The lead's memory
The lead is one long-running role, but not one endless conversation. It remembers on three layers:

| Layer | Where | Lives |
|---|---|---|
| Facts about each piece of work | the ticket: story, contract, questions, decisions, verdicts, events | forever; read on demand with `crew show` |
| Its working memory | `orchestrator/notes.md`: your preferences, decisions that span tickets, promises, threads in flight | across conversations; the lead edits it (`crew notes --stdin`), and so can you |
| The conversation | The Claude Code session or Codex thread, resumed turn by turn | until it reaches `lead.rotateAtTokens` (120k) or `rotateAfterTurns` (60) |

Every turn starts with the live board digest, so ticket state never depends on the conversation. When the conversation is full, crew first asks the lead to update its notes (one short turn), then starts a fresh conversation whose first message carries the notes, the board and the last 16 chat messages. There is no automatic compaction: nothing is summarised in a hurry, and you can read and correct what it remembers.

Workers never grow long: a coder keeps one session per ticket (resumed only for that ticket's answers, gate feedback and change requests), and every verify is a fresh session.

## Statuses
`inbox → shaping ⇄ waiting → ready → queued → building → review → done`, plus `blocked`, `parked` and `dropped`.
A discussion comes first when you want one: `inbox → discussing ⇄ waiting → (you accept a round) → shaping → …`.

| Rule | Enforced in |
|---|---|
| Queued needs a contract and no open questions | `Store.transition` |
| The lead may queue only `approval: auto` tickets (bugs and chores by default); you approve features and ideas | `checkTransition` |
| Only the runner moves to building or review; only you mark done or dropped; workers change no status | `checkTransition` |
| A question to you puts the ticket in `waiting` and remembers where it was; the last answer sends it back | `Store.ask` / `answer` |
| Requested changes keep the coder's session and start a new run | `Store.requestChanges` + `Runner.runJob` |

## Discussions (design rounds before a plan)
For an idea you can't specify yet. The lead or you ask for a round (`crew discuss <ID> --note …`); the runner starts it as soon as nothing else runs, without waiting for the night, within the same usage limits.
- **The designer** (Opus, a fresh session per round) reads `brief.md`: your words, the focus of this round, the decisions so far, earlier rounds with your answers, and your notes since. It reads the code (the clone, read only; changes to it are discarded), starts the lab and takes screenshots, and writes one page from `templates/page.html`: recommendation, how it works today, scenarios, options, a clickable prototype with dummy data, states and copy, a cut list, risks, and numbered decisions with lettered options and its pick. Project notes go in `projects/<key>/designer.md`.
- **Checks**: crew opens the page at 390 and 1280 px (script errors, sideways scrolling, requests to other sites). Problems go back to the designer once.
- **Publishing**: the page goes to `discuss/round-N.html`, served by the board in a sandbox (its scripts can't call the API). With `discuss.publish` (for example `pub {file}`) it is also shared, but only if it holds no value from agent.env. Its decisions become questions for you, with the pick marked "(recommended)".
- **Next round**: answers become decisions; decisions you left open are closed as replaced; your note and the earlier rounds go into the next brief.
- **Accept** (only you): open decisions take the pick, the ticket goes to `shaping`, and the lead writes the contract (or splits it into tickets). The coder of that ticket gets `.crew/discussion.html` and `.md`.
- Only you end a discussion: the lead can't move a `discussing` ticket to `shaping`.

## The lab
Today's app (the base branch) with a fresh copy of the demo data, on its own port (`project.json` "lab"; build, start, migrate and env come from "preview"). It lives in `worktrees/_<key>-lab`, builds only when main or its address changed, stops after 2 hours, and is used for "how it works today" screenshots: `crew lab shot <path> --as client|trainer|admin`. The login password comes from agent.env (`lab.passwordEnv`); the designer never sees it.

## The job
`prepare → code → gate → verify → publish`. The step is saved in `state.job`, so a usage limit, a question or a restart resumes there.

- **Round limits**: question rounds 3 (then it goes to you), gate fix rounds 2, verify fix rounds 2, two coder errors. Past a limit the ticket is **blocked** with the reason, and you get a push.
- **Gate**: structural checks (plan.md, check.md, a commit, a clean tree, no deleted test files, no test switched off, protected config untouched unless the contract allows it), then the project's commands. Test files and skip marks are recognised for JS/TS (`.only`, `.skip`, `xit`), Python (`@pytest.mark.skip`/`xfail`, `pytest.skip()`, `@unittest.skip`) and Go (`t.Skip`). A project can set its own `testFiles` globs and extra `skipPatterns`. Stage `fast` runs in the coder's Stop hook (three blocks at most), and stage `all` runs after it. Heavy checks hold the heavy lock and run in `crew-heavy.slice`.
- **Verifier**: a fresh session with no edit tools and JSON-schema output. PASS needs every line at 7 or more. If it changes files anyway, the changes are discarded and noted.

## When the runner starts a job (`Runner.holdReason`)
- The mode is `night` and it is inside the window, or the mode is `always`, or the ticket has "run now".
- Fewer than `maxJobsPerNight` jobs have started tonight.
- It is not parked for a usage limit and has no login problem.
- The last 5-hour utilization is below `budget.fiveHourMax` and the weekly one below `budget.sevenDayMax` ("run now" may use the weekly reserve).
- Disk free is at least `limits.minFreeDiskGb`.
- The last good database backup (`safety.backupStatusFile`) is younger than `backupMaxAgeHours`.

## Previews
Next.js bakes the site URL in at build time, so each preview slot has a fixed hostname, and a build belongs to one slot. The gate builds for slot 1, so starting slot 1 needs no build. "Test it" clones the golden database into `pv_<slot>`, runs the branch's migrations, and starts `next start` in `crew-preview.slice` with a TTL (2 h by default; +2 h on request). The sweeper stops expired previews.

## Safety summary
**Hard boundaries** (enforced by the OS, the network or the backups, whatever an agent tries):
- Agents run as the `crew` user: no sudo, no Docker group, no production keys, and `/home/ops` is unreadable (`chmod 750`).
- `deploy/root/crew-guard.nft` rejects crew's TCP connections to the live databases and apps on localhost. `crew doctor` checks it (`safety.forbiddenPorts`).
- Workers and previews use crew's own Postgres (role `crew`, CREATEDB only). Golden data comes from the seed scripts, or from a demo dump that was scrubbed before crew ever sees it.
- Backups are encrypted to a key only your PC holds and sent to an R2 bucket with a lock. Without a good backup in the last 36 h, the runner won't start.
- Memory caps: every agent, check, build and preview runs in its own scope inside `crew.slice` (4 GB), with a raised OOM score. A runaway job dies in its own cgroup.
- Board login: the signed Cloudflare Access token is verified (team keys and audience), not just a header. Requests that come through the tunnel get 503 until a login is set.
- The tunnel token belongs to your admin user, so no agent can read it.

**Guard rails** (they stop mistakes and confused agents, not a deliberately malicious one running as crew):
- Roles (`CREW_ROLE`): only the runner builds, only you approve, finish or drop. Only the lead or you write contracts and stories, and the verifier judges against the ticket's own contract, refreshed before every verify.
- On Claude Code the lead runs with `dontAsk` and an allowlist of specific `crew` subcommands. It has no `run`, `serve`, `approve` or `preview`, and no web tools by default. On Codex there is no such allowlist: the lead runs in the `workspace-write` sandbox (writes only in `CREW_HOME`, no network), which is only a guard rail.
- The gate is a script: protected test config, no deleted or renamed-away tests, no `.only` or new `.skip`, a commit, and plan and check files. The verifier can't edit files, and if it moves the branch it is put back.
- Round limits for questions, gate and verify, recoveries after crashes, and usage parks, so nothing loops all night.

An agent running as crew could still forge its own ticket's status with the CLI. The worst that does is move a card; it can't reach a database, production, the tunnel or the backups. Running coders as a second Unix user is the next step if that ever matters.
