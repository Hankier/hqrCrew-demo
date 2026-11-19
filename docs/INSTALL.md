# Installing crew on a server

About two evenings. Parts 0 and 1 protect what already runs on the box. Do them first, even if you stop after that.

Placeholders used below: `ops` is your normal admin user (has Docker), `crew.example.com` is the board's address, `preview-1/2.example.com` are the preview slots. Replace them with your own.

Who does what:
- **root**: you, with sudo, in one maintenance window.
- **ops**: your normal user (has Docker).
- **crew**: a new user for the agents, without sudo or Docker.

Agents run as crew. They can't reach Docker, so they can't touch the containers or the web server. A firewall rule (step 1) also stops crew from opening a connection to the live databases, even over localhost.

## 0. Protect the databases (ops, ~1 h)

1. **Make an age key pair on your PC**: `age-keygen -o ~/crew-backup-key.txt`. Keep the file off the server. Copy the `age1…` public key.
2. **Create a bucket** for backups (for example Cloudflare R2 `crew-backups`). Then:
   - Add a **bucket lock** on `daily/` for 30 days and a **lifecycle rule** that deletes `daily/` after 35 days.
   - Create a **token** with Object Read & Write on this bucket only.
3. **Install the tools** as ops, into `~/.local/bin` (static binaries, no root): `age` and `rclone`. Configure the remote with `rclone config` (for R2: provider Cloudflare, region `auto`, `no_check_bucket = true`).
4. **Configure and test the backup**:
   - `cp deploy/backup/backup.env.example ~/.config/crew-backup/backup.env`, then fill in your containers and paths (`docker inspect` shows them). Run `chmod 600` on it.
   - The backup runs Docker as ops. It never shares a raw demo dump with crew; the optional demo copy is restored, scrubbed and dumped again first.
   - Run `deploy/backup/backup.sh --dry-run`, then for real.
5. **Restore test on your PC.** Download one backup, decrypt it with your private key and restore it into a scratch database. Do it once now, then monthly.
6. **Enable the timer**: copy `crew-backup.service` and `crew-backup.timer` to `~/.config/systemd/user/`, then `systemctl --user enable --now crew-backup.timer` and `loginctl enable-linger`.

> While a database container is stopped, its volume counts as unused. Never run `docker system prune --volumes` or `docker volume prune`. `docker builder prune` is the safe one.

## 1. Root steps (one maintenance window, ~30 min)

```sh
sudo adduser --disabled-password --gecos "" --uid 2001 crew      # UID ≥ 2000: no container uses it
sudo loginctl enable-linger crew
sudo apt-get install -y postgresql-client-16                       # psql/pg_restore for crew
sudo groupadd crewshare && sudo usermod -aG crewshare ops && sudo usermod -aG crewshare crew
sudo install -d -o ops -g crewshare -m 2750 /srv/crew-share        # backup status (+ optional scrubbed demo dump)
sudo chmod 750 /home/ops                                           # crew must not read ops's .env files or apps
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-crew.conf && sudo sysctl --system
# Keep crew away from the live databases and apps, even over localhost. Edit the ports first.
sudo cp deploy/root/crew-guard.nft /etc/crew-guard.nft
echo 'include "/etc/crew-guard.nft"' | sudo tee -a /etc/nftables.conf && sudo systemctl enable --now nftables && sudo nft -f /etc/crew-guard.nft
# Docker: publish to localhost by default, rotate logs. Restarting Docker restarts the apps.
# First check `docker ps`: any container that must be reachable from outside needs an explicit 0.0.0.0 bind.
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "ip": "127.0.0.1", "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
EOF
sudo systemctl restart docker
```

Leave crew out of the `sudo` and `docker` groups. Check the guard as crew: `sudo -u crew bash -c '</dev/tcp/127.0.0.1/5432'` must fail. `crew doctor` checks it too.

## 2. crew's Postgres (ops, ~10 min)

```sh
cp -r deploy/crew-pg ~/crew-pg && cd ~/crew-pg
cp .env.example .env && $EDITOR .env          # two random passwords
docker compose up -d                           # 127.0.0.1:20150, 512 MB cap, role "crew" with CREATEDB
```

## 3. The crew user (crew, ~40 min)

```sh
sudo -iu crew
# Node 22 + pnpm into ~/.local (no root)
curl -fsSLO https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-x64.tar.xz && mkdir -p ~/.local/node && tar -xJf node-*.tar.xz -C ~/.local/node --strip-components=1
export PATH=~/.local/node/bin:~/.local/bin:$PATH && npm i -g pnpm@10
# The agent CLIs: install the ones crew.json uses ("engine").
curl -fsSL https://claude.ai/install.sh | bash             # Claude Code, native install in ~/.local/bin
claude setup-token                                         # long-lived login for unattended runs; copy the token
mkdir -p ~/.claude && echo '{ "skipDangerousModePermissionPrompt": true }' > ~/.claude/settings.json   # coders run in bypass mode inside this sandbox user
npm i -g @openai/codex                                     # Codex CLI
codex login --device-auth                                  # log in from your phone or PC; stored in ~/.codex/auth.json
# GitHub: a read-only deploy key for your project repo (read-write only if crew should push branches)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" && cat ~/.ssh/id_ed25519.pub   # add as deploy key on GitHub
ssh-keyscan github.com >> ~/.ssh/known_hosts                # so unattended git never waits on a host-key prompt
# crew itself
git clone https://github.com/Hankier/hqrCrew-demo ~/hqrCrew-demo
mkdir -p ~/.config/crew ~/.config/systemd/user
cp ~/hqrCrew-demo/deploy/systemd/env.example ~/.config/crew/env && chmod 600 ~/.config/crew/env && $EDITOR ~/.config/crew/env
CREW_HOME=~/crew ~/hqrCrew-demo/bin/crew init --project app --template node
$EDITOR ~/crew/crew.json                                    # "engine", publicUrl, safety, notify
$EDITOR ~/crew/projects/app/project.json                    # repo, setup, gate, preview
$EDITOR ~/crew/projects/app/agent.env                       # PGPASSWORD from step 2, sandbox values only
$EDITOR ~/crew/projects/app/vision.md                       # read it; it is the lead's source of truth
cp ~/hqrCrew-demo/deploy/systemd/*.slice ~/hqrCrew-demo/deploy/systemd/crew.service ~/.config/systemd/user/
systemctl --user daemon-reload
CREW_HOME=~/crew ~/hqrCrew-demo/bin/crew doctor             # fix every ✗
CREW_HOME=~/crew ~/hqrCrew-demo/bin/crew golden app         # builds the golden demo DB from main's seed scripts
systemctl --user enable --now crew
```

## 4. Reach it from the phone (Cloudflare, ~20 min)

Create the login first, so the board is never reachable without it.

1. **Access.** In Zero Trust, go to Access → Applications → Self-hosted, name it `crew`, and add three hostnames: `crew.example.com`, `preview-1.example.com` and `preview-2.example.com`.
   - Policy: Allow, emails = yours. Login: one-time PIN. Session: 30 days.
   - Copy the application's **Audience (AUD) tag** and your team name (`<team>.cloudflareaccess.com`).
   - In `~/crew/crew.json` set `"auth": { "cfAccess": { "team": "<team>", "aud": "<AUD tag>" }, "emails": ["<you>"] }`. The board then checks the signed token Access adds to every request, which no process on the box can fake. Until auth is set, the board answers 503 on its public address.
2. **Tunnel.** Go to Networks → Tunnels → Create (cloudflared), name it `crew`. Add these public hostnames:
   - `crew.example.com` → `http://127.0.0.1:20100`
   - `preview-1.example.com` → `http://127.0.0.1:20111`
   - `preview-2.example.com` → `http://127.0.0.1:20112`
3. **Connector, as ops (not crew).** An agent that could read the tunnel token could join the tunnel from elsewhere.
   - Download `cloudflared` into ops's `~/.local/bin`.
   - Put `TUNNEL_TOKEN=…` in `~/.config/cloudflared/crew.env` (chmod 600).
   - Copy `deploy/systemd/cloudflared.service` to ops's `~/.config/systemd/user/`, then `systemctl --user enable --now cloudflared`.
4. **Notifications.**
   - Pick a random ntfy topic, subscribe to it in the ntfy app, and set `notify.ntfy.url` in `crew.json`.
   - Or set a private Discord channel webhook in `notify.discordWebhook`.

## 5. First night

1. On the board, add a bug or chore. Watch the lead shape it, and approve it if it's a feature.
2. Press **Run now** once while you watch. In the morning, check the timeline, `verify.md` and `check.md`, then press **Test it**.
3. When one ticket goes through cleanly, leave the runner in `night` mode.

## Trying it on a dev machine (as yourself)
For a test run on your own PC (Linux or WSL), where you have Docker and your own Claude Code or Codex login, skip steps 0, 1, 3 and 4:
- `loginctl enable-linger $USER` (no sudo needed with the default polkit rules), so the user systemd runs. Or set `CREW_NO_SYSTEMD=1` to run without memory caps.
- crew's Postgres as in step 2, in `~/crew-pg`, if your project needs a database.
- `crew init --project app --template node`, then in `crew.json`: `engine`, `publicUrl` `http://localhost:20100`, `safety.backupStatusFile` null, empty `forbiddenPorts` and `privateDirs`, `auth.cfAccess` null.
- In `project.json`: `preview.url` `http://localhost:{port}`; `db.psql` `docker exec -i crew-pg psql -U crew` if there is no psql on the machine.
- `agent.env`: crew's Postgres (`127.0.0.1`, `20150`, `crew` and its password) and dummies.
- `~/.config/crew/env` with a PATH that includes your Node and `~/.local/bin`; no token, because the CLIs use your normal login.
- The slices and `crew.service` from `deploy/systemd/` into `~/.config/systemd/user/`, with ExecStart pointing at your Node and your checkout.
- For design rounds: `npm install --prefix ~/crew/tools playwright-core@1.55.0` (no browser download; crew uses a Chromium in `~/.cache/ms-playwright`, or set `tools.chromium`). In `project.json` a `lab` block, and in agent.env `DEMO_PASSWORD` (the demo accounts' password from the seed script). To share round pages: `"discuss": { "publish": "<your publish command> {file}" }` in crew.json. `crew doctor` checks all of it under "Discuss first".

The agents then run as you, with your files and Docker in reach: the guard rails are the prompts, the gate and the round limits, not the OS. Keep the first tickets small. The PC must stay on for a night run.

## Memory
A Next.js production build can peak at about 4.5 GB (Next 15.5, 4 CPUs, with Next's own type check). On an 8 GB box with live apps at about 1.5 GB, a build fits only when nothing else of crew's runs. That is why `crew.slice` allows 5.5 GB and the build check 5 GB. With 12 GB or more, a build, a coder and two previews fit side by side; then raise `crew.slice` to `MemoryMax=8G`.
