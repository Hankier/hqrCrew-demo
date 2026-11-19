# hqrCrew (demo)

One orchestrator you talk to, a crew of coding agents that build your tickets one by one at night, and a "test it" button that starts any finished ticket with the demo data. Every role can run on **Claude Code** or **OpenAI Codex CLI**, and you choose per role. Tickets are plain files. It needs Node 22 and has no dependencies.

This is a public demo copy of a personal tool. It has been run end to end on a dev machine, but it has not run unattended on a server yet. See [What doesn't work yet](#what-doesnt-work-yet).

```
you (phone or PC) ──► board: crew.example.com (Cloudflare Access)
                        │  chat ─► lead: turns messages into tickets, asks you only product calls,
                        │          writes contracts, answers coders' questions, records decisions
                        │  discuss ─► designer, one page per round: today's app (lab screenshots),
                        │             options, a clickable prototype with dummy data, numbered decisions.
                        │             You answer, ask for another round, or accept; then the lead plans
                        │  queue ─► runner, 23:00–07:00, one ticket at a time:
                        │             prepare: worktree, deps, a copy of the golden demo DB
                        │             code: coder, plan.md first, tests first; a Stop-hook gate blocks "done"
                        │             gate: lint, typecheck, unit, integration, migrations, build (a script, not a model)
                        │             verify: a fresh verifier scores every acceptance line, PASS or FAIL
                        │             publish: Ready to test, with check.md (steps and demo account) and a push to your phone
                        └─ Test it ─► preview slot 1 or 2: next start + a fresh copy of the demo DB, about 2 h
```

## Quick start (dev machine)

```sh
git clone https://github.com/Hankier/hqrCrew-demo && cd hqrCrew-demo
ln -s "$PWD/bin/crew" ~/.local/bin/crew          # `crew` on PATH (agents call it too)
npm test                                         # 55 tests; fake Claude and fake Codex, no usage
crew init --project app --template node          # CREW_HOME=~/crew; or --template python
$EDITOR ~/crew/projects/app/project.json         # repo url, setup commands, gate checks
$EDITOR ~/crew/crew.json                         # "engine": "codex" or "claude", per role if you like
crew doctor                                      # fix every ✗
crew serve                                       # board + lead + runner on http://127.0.0.1:20100
```

`docs/INSTALL.md` covers a server install: a separate user for the agents, a firewall rule, crew's own Postgres, backups, systemd and a Cloudflare tunnel.

## Claude Code or Codex

`crew.json` picks the CLI for each role:

```json
{ "engine": "codex" }
{ "engine": { "lead": "claude", "designer": "claude", "coder": "codex", "verifier": "claude" } }
```

| | Claude Code (`claude -p`) | Codex (`codex exec --json`) |
|---|---|---|
| Models | `models.<role>` (opus, sonnet…) | `codex.models.<role>`; null = your `~/.codex/config.toml` default |
| Effort | `effort.<role>` | the same, as `model_reasoning_effort` (max → xhigh) |
| Role prompt | `--append-system-prompt` | `-c developer_instructions=…` |
| Lead's instructions | `orchestrator/CLAUDE.md` | `orchestrator/AGENTS.md` (same text) |
| Coder's gate | Stop hook via `--settings` | Stop hook via `-c hooks.Stop=…` (same `crew gate --hook`) |
| Verifier's verdict | `--json-schema` | `--output-schema` (made strict) |
| Resume | `--resume <id>` | `codex exec resume <thread id>` |
| Usage windows | rate-limit events in the stream | the session's rollout file (`token_count`) |
| Coder, designer, verifier | `bypassPermissions` | `danger-full-access` sandbox |
| Lead | `dontAsk` + an allowlist of `crew` commands | `workspace-write` sandbox: writes only in `CREW_HOME`, no network |

Both report the same result to crew, so the night window, the budget stop (90% of the 5-hour window, 75% of the week), parking on a usage limit, the lead's notes handover and the board work the same way. A conversation started on one CLI is not resumed on the other: switching a role starts a fresh session, and the lead's notes carry over.

## Why it is shaped like this
- **One brain, kept in files.** Board, tickets, decisions, questions and evidence live in `CREW_HOME`. The lead is a resumable session, but nothing important exists only in its memory: at about 120k tokens it saves its notes (`crew notes`) and a fresh conversation starts from the notes, the board and the last messages.
- **A script decides "done".** A Stop hook blocks the coder until lint, typecheck and unit tests pass and the plan, steps and commit exist. The full gate runs after it stops. A fresh verifier then judges every acceptance line with file:line evidence.
- **Unsure? Discuss first.** For an idea you can't specify yet, a designer writes a page per round, nothing built: how it works today, scenarios, options, a prototype you can click through with dummy data, and decisions you answer as "1b, 2a". Accepting a round sends it to planning, and the coder gets the accepted page.
- **Product calls go to you, everything else doesn't.** The lead may queue bugs and chores. Features and ideas wait for your Approve. Coders ask the lead first; only real product questions reach you, as one-tap answers.
- **The night shift uses what you don't.** Every run reports the 5-hour and weekly usage. The runner stops at 90% of the 5-hour window and at 75% of the week, so your daytime work keeps its share. A usage limit parks the job; it resumes after the reset.
- **The databases are out of reach.** Agents run as a separate user without Docker or sudo, against crew's own Postgres, and a firewall rule stops them from connecting to the live databases at all. Without a fresh off-box backup there is no night shift. Every agent, check, build and preview runs in its own memory-capped cgroup, so it dies before a database does. `docs/DESIGN.md` lists what is a hard boundary and what is only a guard rail.

## Commands
`crew help` lists them all. The main ones:

```
crew init --project app --template node   create CREW_HOME (default ~/crew)
crew doctor                               check the box: CLI logins, repo, Postgres, disk, ports
crew golden app                           build the demo database (migrations + seed scripts)
crew serve                                board + lead + runner on 127.0.0.1:20100
crew attach [--rc]                        the lead's own conversation in your terminal (--rc: Claude Code only)
crew notes                                what the lead remembers across conversations
crew discuss AP-010 --note "…"            start a discussion, or ask for its next design round
crew accept AP-010                        accept the latest round; the lead plans the build
crew lab up · crew lab shot /account --as client   today's app with the demo data, and screenshots of it
crew new bug "Coupon field accepts spaces" --body "…"
crew approve AP-004 · crew queue AP-005 --now · crew preview up AP-008
```

## Any project
The engine knows nothing about Next.js or JavaScript. A project is a folder in `CREW_HOME/projects/<key>/`:
- `project.json`: the repo, setup commands, gate checks (any shell commands), optional database and preview settings, and optional `testFiles` / `skipPatterns`.
- `vision.md`: what the product is for; the lead answers questions from it.
- `agent.env`: sandbox values only.
- optional `coder.md` / `verifier.md` / `designer.md`: project notes appended to those prompts (migrations, memory limits, language…).

```
crew init --project bot --prefix KB --name "Discord bot" --template node   # TS/JS: pnpm lint, tsc, tests, build
crew init --project stats --prefix ST --name "Stats" --template python     # uv: ruff, mypy, pytest
```
Several projects share one board, one lead and one night queue. Tickets keep their own prefix (AP-…, KB-…), and the board can filter by project. Previews are optional, so a Discord bot or a worker has none. The gate knows JS/TS, Python and Go test files and skip marks out of the box.

## What doesn't work yet
- Tested end to end on one dev machine (WSL), on both CLIs. The server install in `docs/INSTALL.md` has not run unattended for a night yet.
- Night shifts, previews and memory caps need Linux with systemd (`systemd-run --user`) and cgroups v2. Without them, `CREW_NO_SYSTEMD=1` runs everything uncapped.
- On Codex the lead has no per-command allowlist. It runs in Codex's workspace-write sandbox and can write anywhere in `CREW_HOME`, `crew.json` included. Keep the lead on Claude Code if ticket text can come from people you don't trust.
- On Codex the verifier can still edit files (Codex has no "no edits" switch). crew discards its changes and resets the branch after each verify.
- Codex reports no price, so the board shows Codex runs without the API-equivalent cost.
- The Stop hook on Codex is passed with `--dangerously-bypass-hook-trust`, because crew writes that hook itself. It needs Codex's `hooks` feature, which is on by default in 0.160. `crew doctor` checks it.

## Files
- `src/`: store (tickets), board, runner (pipeline), gate, lead, agent (picks the CLI), claude and codex (headless runs), preview, server (API and SSE), sysrun (cgroups), db, workspace (git).
- `prompts/`: the lead's instructions, and the designer's, coder's and verifier's role prompts.
- `templates/`: crew.json, node and python project configs, vision.md, agent.env.
- `deploy/`: systemd slices and units, Cloudflare Tunnel, crew's Postgres, nightly backup, the firewall guard.
- `docs/INSTALL.md`: a server install, step by step. `docs/DESIGN.md`: formats and rules.
- `test/`: `node --test test/*.test.js`. A fake Claude and a fake Codex play lead, designer, coder and verifier, so tests use no usage.
