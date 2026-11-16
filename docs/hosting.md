# Hosting at home

The game runs on a small always-on Linux box, and the GPU work runs on a separate GPU PC. The box serves the
game, the API and sockets, SQLite, the art, and the OpenAI-backed play-time calls. Its job worker builds worlds
and sends painting, reading, and upscaling to ComfyUI on the GPU PC over the home network. Development also stays
on the GPU PC.

```
players ──https 443──▶ router ──▶ game box (Ubuntu 26.04 LTS)
                                   Caddy :443 ──▶ daydream-server 127.0.0.1:3000 ─┐
                                                  daydream-worker ────────────────┼──▶ OpenAI (hosted)
                                                  /var/lib/daydream (data)        └──▶ GPU broker on the GPU PC :8190 (LAN) ──▶ ComfyUI
```

Files in `deploy/`: the systemd units, the `Caddyfile`, `ddns-namecheap.sh` and `deploy.sh`.

## What runs where

- **Game box:** the game server and the job worker, both from this repository, plus Caddy.
  - The worker must run beside the server. The job queue, job leases, the GPU page's switches, and the spending
    ledger live in the one SQLite database, and world folders sit next to it. SQLite does not work over a network share.
- **Speech** (`docs/voices.md`): the game server speaks every line with Pocket TTS on the box's CPU while the GPU
  is busy or away, on ONNX Runtime inside its own process. The models, exported once from Kyutai's release, sit
  in the checkout's git-ignored `models/pocket/`.
- **GPU PC:** ComfyUI behind the GPU broker (`docs/gpu-broker.md`), which takes turns on the GPU for production
  and development alike. The worker speaks ComfyUI's HTTP API to the broker. The broker also runs speech: voices on
  the GPU while it is idle, and a build's voice step (designing voices, speaking the lines known before play).
  - Start the broker by hand with `npm run broker`. While it is not running, GPU work waits.
- **When the GPU PC is off:** a model that does not answer is retried, and the job shows as *waiting*. Builds
  resume when ComfyUI comes back. Play never needs the GPU PC: voices come from Pocket TTS on the box.
- **Animation** is painted by OpenAI (GPT Image, through the Batch API): nothing runs on the box or the GPU PC.
  Give the box's config an `openai-image` provider and the `image.animation` purpose to turn it on, and the
  `image.walk` purpose (model `gpt-image-2.6-sunburst`) for walk GIFs; without them characters stay still images.

## Game box setup (once)

1. **Node 24.12 or newer, an LTS line.** The services run the TypeScript sources with `/usr/bin/node` itself,
   which strips the types; there is no build step for the server. Use the Ubuntu archive if `apt policy nodejs`
   shows 24.12 or newer. Otherwise use NodeSource. Also install git, Caddy, and unattended-upgrades:
   `sudo apt install git caddy unattended-upgrades`. Automatic security updates are on by default; check
   `/etc/apt/apt.conf.d/20auto-upgrades`.
2. **A service user and folders.** The checkout belongs to you, the services run as `daydream`, and the data lives
   outside the checkout:
   ```bash
   sudo useradd --system --home /var/lib/daydream --shell /usr/sbin/nologin daydream
   sudo mkdir -p /opt/daydream /etc/daydream && sudo chown "$USER" /opt/daydream
   git clone https://github.com/<account>/<repository>.git /opt/daydream   # a read-only deploy key if the repo is private
   cd /opt/daydream && npm ci && npm run build
   ```
3. **Model config.** Make `/etc/daydream/genai.json` from your own `config/genai.json`, with these changes:
   - Every OpenAI provider uses `"apiKey": "credential:openai"`.
   - The `comfy` provider has `"baseUrl": "http://<GPU PC LAN address>:8190"` and
     `"apiKey": "credential:gpu-broker"`.
   - The broker token is a long random string (`openssl rand -hex 32`). It is stored as the `gpu-broker`
     credential on the box, and under the client `prod` in the GPU PC's `config/broker.json`.
   - Keep `spending.dailyTotalUsd`, the whole server's daily ceiling. Each player's budget is monthly and is set
     on the Users page, not in this file.
   - Speech (`docs/voices.md`) has three purposes:
     - `speech.cpu` names a `pocket-tts` provider, `"pocket": { "type": "pocket-tts", "lines": 2, "threads": 1 }`,
       which speaks with the models step 4a exports to `models/pocket/`. The game box here has four threads shared with the
       server and the worker, so keep two lines at once.
     - `"speech.gpu": { "provider": "comfy" }` sends voices to the GPU broker while its GPU is idle (the broker's
       address and token are the comfy provider's). Leave it out to speak on the CPU alone.
     - `speech.input` names an `openai-transcribe` provider, which turns what players say into text.
   - Only the provider types `openai-responses`, `openai-decision`, `openai-transcribe`, `openai-image` (animation),
     `comfyui` and `pocket-tts` exist. The server refuses to start if the file names another.

   Make it readable by `daydream` only:
   ```bash
   sudo chown root:daydream /etc/daydream/genai.json
   sudo chmod 640 /etc/daydream/genai.json
   ```
4. **Secrets as encrypted systemd credentials.** No `.env` on the box. Each command reads the secret from
   standard input, so type it and press Ctrl+D:
   ```bash
   sudo mkdir -p /etc/credstore.encrypted
   sudo systemd-creds encrypt --name=openai - /etc/credstore.encrypted/openai
   sudo systemd-creds encrypt --name=namecheap-ddns - /etc/credstore.encrypted/namecheap-ddns
   sudo systemd-creds encrypt --name=gpu-broker - /etc/credstore.encrypted/gpu-broker
   ```
   - The files are encrypted with the machine's TPM if it has one, else with a host key in `/var/lib/systemd`.
   - systemd decrypts a credential only for the services that list it. Each service sees it as a file in its
     own `$CREDENTIALS_DIRECTORY`.
   - `"credential:NAME"` in the config reads that file. Unlike an environment variable, it is not inherited by
     child processes.
   - Use a key from an OpenAI project of its own, with a monthly budget limit set at OpenAI.
4a. **Speech: Pocket TTS.** The game server speaks with Pocket TTS exported to ONNX, so the box needs no Python to
   play. The export is made once, with a Python environment that can be deleted afterwards. The voice-cloning weights
   are gated on Hugging Face: accept Kyutai's terms on the model's page with your account (they forbid cloning a real
   person's voice without consent; the game's voices are designed, not real people), and make a read token.
   The weights are `kyutai/pocket-tts`; run this as yourself, the owner of the checkout:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh && . "$HOME/.local/bin/env"   # uv, which brings its own Python
   cd /opt/daydream/packages/server/speech && uv venv --python 3.14 .venv
   uv pip install --python .venv/bin/python -r requirements.txt --index-strategy unsafe-best-match
   .venv/bin/hf auth login                                   # paste the token
   .venv/bin/python pocket_export.py --model english_2026-10
   .venv/bin/python pocket_export.py --model english_18m_2026-10
   .venv/bin/hf auth logout
   rm -rf .venv ~/.cache/huggingface                         # the environment is needed only to export
   cd .. && taskset -c 0,1 node src/cli/pocketcheck.ts --bench
   ```
   - The export writes each model to `/opt/daydream/models/pocket/<model>/` (git-ignored, so deploys leave it):
     its ONNX graphs, tables, tokenizer, and a check made with PyTorch from `speech/check-voice.wav`, about 550 MB
     for the large model and 120 MB for the small one. The services read it as `daydream`; nothing there is secret.
   - `pocketcheck` must report the text identical and the audio below -60 dB from PyTorch; with `--bench` it also
     measures the speed on two of the box's cores.
   - Export again after an upgrade of pocket-tts. Voice states made with the old export are not reused.
   - ONNX Runtime (`onnxruntime-node`) comes with `npm ci` and carries its CPU binaries for Linux and Windows; its
     install script, which would fetch CUDA libraries, is not run (`allowScripts` in `package.json`).
   - The server's Opus encoder (`@discordjs/opus`) is a native module: `npm ci` fetches its prebuilt binary for the
     box's Node, or builds it if none matches (`sudo apt install build-essential python3`).
   - Each voice's state is kept on disk in `/var/lib/daydream/cache/pocket/`. `journalctl -u daydream-server | grep
     speech` shows Pocket TTS's lines; "Pocket TTS ready" means it has loaded.
5. **Services:**
   ```bash
   sudo cp /opt/daydream/deploy/systemd/daydream-*.service /opt/daydream/deploy/systemd/daydream-*.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now daydream-server daydream-worker daydream-ddns.timer daydream-backup.timer
   journalctl -u daydream-server -n 50        # the first start prints the administrator's invite link
   ```
   - The first start of an empty server prints an invite link (`<site>/#/invite/<code>`). It works for 5 days.
     Open it on the real address, `https://daydream.example.com` (your own host name), after the DNS and HTTPS steps below, and pick
     a user name and a password, a passkey, or both. The first account set up becomes the administrator.
   - Passkeys are tied to the site's host name, so set them up on the real address rather than a LAN IP. A
     passkey made on one machine's `localhost` does not work on another site.
   - If the link runs out, make a new one with the console tools (below): `list`, then `reset <id>`.
6. **DNS (Namecheap).**
   - In *Domain List → example.com → Advanced DNS*, turn on **Dynamic DNS**. Its password is the
     `namecheap-ddns` credential.
   - Add an **A + Dynamic DNS** record for host `daydream`.
   - The timer checks the public address every 5 minutes and updates the record only when the address changes.
     See `journalctl -u daydream-ddns`.
7. **HTTPS.**
   ```bash
   sudo cp /opt/daydream/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
   - The router forwards 443 to the box. Caddy gets a Let's Encrypt certificate through the TLS-ALPN challenge,
     so port 80 is not needed.
   - Each future site on the domains is another block in the Caddyfile, for example `blog.example.com`.
     Several sites can share 443 this way.
8. **Log retention.** journald keeps the services' lines (see Logs below). Cap it in
   `/etc/systemd/journald.conf.d/daydream.conf`, then `sudo systemctl restart systemd-journald`:
   ```ini
   [Journal]
   SystemMaxUse=20G
   MaxRetentionSec=1year
   ```
   The oldest lines are deleted first when either limit is reached. 20 GB is years of the game's lines.
9. **Firewall:** allow only SSH from the LAN and 443 from anywhere.
   ```bash
   sudo ufw default deny incoming
   sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Adjust the LAN range to yours. Port 3000 needs no rule: the server listens on 127.0.0.1 only (`DAYDREAM_HOST`).

## GPU PC setup

- **ComfyUI listens on 127.0.0.1** (its default, without `--listen`), so only the broker reaches it.
- **Daydream's ComfyUI nodes** are installed as a copy of `config/comfyui/daydream-nodes/` in ComfyUI's
  `custom_nodes` folder, and installed again whenever that folder changes (`docs/gpu-broker.md`, "Daydream's ComfyUI
  nodes").
- **The broker:** `config/broker.json` from `config/broker.example.json`, with the `prod` token, then
  `npm run broker`. It listens on port 8190.
- **Sound and music** (`docs/sound.md`): Stable Audio 3 Small SFX and Medium and their text encoder in ComfyUI's
  model folders. The weights are gated: accept Stability AI's license on
  [stabilityai/stable-audio-3-small-sfx](https://huggingface.co/stabilityai/stable-audio-3-small-sfx) once, then
  download Comfy-Org's packaging into the folders ComfyUI reads (`extra_model_paths.yaml`):
  ```powershell
  hf download Comfy-Org/stable-audio-3 checkpoints/stable_audio_3_small_sfx.safetensors checkpoints/stable_audio_3_medium.safetensors text_encoders/t5gemma_b_b_ul2.safetensors --local-dir <ComfyUI models folder>
  ```
- **Speech on the GPU** (`docs/voices.md`, `docs/gpu-broker.md` "Speech"): the service's Python environment in the
  checkout's git-ignored `packages/gpu-broker/speech/.venv`, made once from your own terminal, and its two models'
  weights in the Hugging Face download cache:
  ```powershell
  cd packages/gpu-broker/speech
  uv venv --python 3.14 .venv
  uv pip install --python .venv/Scripts/python.exe -r requirements.txt --index-strategy unsafe-best-match
  .venv/Scripts/hf download openbmb/VoxCPM2
  .venv/Scripts/hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
  ```
  Then add `"speech": {}` to the adapters in `config/broker.json`. The broker
  starts the service and keeps the runner loaded while the GPU is idle; the game box's config sends voices to it with
  the purpose `"speech.gpu": { "provider": "comfy" }` (the broker's address and token are the comfy provider's).
- **Firewall:** allow the broker's port from the game box only:
  ```powershell
  New-NetFirewallRule -DisplayName "GPU broker from game box" -Direction Inbound -Protocol TCP -LocalPort 8190 -RemoteAddress <game box LAN address> -Action Allow
  ```
- Check that no older "allow" rule for `python.exe` or `node.exe` opens ports to the whole network:
  ```powershell
  Get-NetFirewallApplicationFilter | ? Program -match 'python|node'
  ```
- **Development** points its `comfy` provider at `http://127.0.0.1:8190`.

## Deploying

From your account on the box, run `/opt/daydream/deploy/deploy.sh`. It checks that Node can run TypeScript, fast-forwards to `origin/main`, reinstalls
packages, builds the client, then restarts the worker and the server.

Restarting is safe:
- The server saves running games when it stops.
- The worker pauses jobs at a safe point, and they resume from their checkpoints.
- `/var/lib/daydream` and `/etc/daydream` are never touched by a deploy.

A deploy does not install systemd units. When a change adds or edits one in `deploy/systemd/`, copy them as in
step 5 of the setup, run `sudo systemctl daemon-reload`, and enable any new timer. A deploy does not export Pocket
TTS again either: do step 4a again when `packages/server/speech/requirements.txt` changes its pocket-tts.

### Console tools on the box

The tools in `packages/server/src/cli/` work on the box's data when run as `daydream`, with the same settings as the
services. Run them from `/opt/daydream/packages/server`:

```bash
cd /opt/daydream/packages/server
sudo -u daydream env DAYDREAM_DATA_DIR=/var/lib/daydream DAYDREAM_GENAI_CONFIG=/etc/daydream/genai.json node src/cli/users.ts list
```

- `users.ts list`: every account with its id, user name, name, role, and status (and its invite code while it is
  invited).
- `users.ts invite <name>`: a new invite, printing its code.
- `users.ts reset <user name or id>`: the account becomes an invite again with a new code. Use the id for an
  account that has not chosen a user name yet.
- `users.ts admin <user name or id> on|off`: make an account an administrator, or a player again.
- `users.ts unlock <user name or id>`: an account blocked after too many wrong passwords takes passwords again
  (also on the Users page).
- `users.ts ips [<user name or id>]`: the addresses an account signed in and played from, with how often and
  when. Without a name: every address more than one account used, which is where a shared account shows.
- `users.ts activity [<user name or id>] [days]`: per account over the last days (30), sign-ins, worlds started
  and built, adventures started, play sessions and hours played, and how many worlds they played. With a name:
  that account's latest events.
- `backup.ts list`: the backup snapshots and what each one added (see Backups below).
- `worldpack.ts` moves worlds in and out (see below).

## Logs

```bash
journalctl -u daydream-server -f
journalctl -u daydream-worker -f
journalctl -u daydream-server -o cat --since today | jq 'select(.level != "info")'    # warnings and errors
journalctl -u daydream-server -o cat | jq 'select(.event == "played")'                # play sessions
journalctl -u caddy
```

- **What is logged.** In production each line is one JSON object: `level`, `src` (server or worker), `event`, and
  the event's fields. The game logs what matters, not every request: sign-ins and failed sign-ins (with the
  address), worlds started, built, failed, and deleted, adventures started and deleted, each play session when it
  ends (minutes, party levels, the place), requests that failed or took over 3 seconds, errors, and an hourly
  `stats` line (requests, sign-ins, games joined, errors, players online, memory). Request bodies and what players
  type are never logged, and values that look like keys or tokens are hidden.
- **The Errors page** (administrators, beside GPU) groups the errors of the server, the worker, and players'
  browsers, the same error counted once, with where each happened: the request or game message, the place,
  the party, the job step, the code version, and for a browser the page, the screen, and the player's last
  actions. A built client's stack is mapped back to the source with its hidden source maps. The page also shows
  the server's numbers by the hour for the last day.
- **What stays, and for how long.** Nothing grows without limit:
  - journald: the limits set in step 8 of the setup.
  - Errors: forgotten 30 days after they were last seen, and at most 1,000 kinds.
  - Account addresses: a year after last use. Account activity (`users.ts activity`): two years.
  - Job logs: dropped a week after their job ended, checked whenever a worker starts (`jobs/queue.ts`). The job
    rows themselves stay as history (one small row per build or painting), as does the GPU page's admin log.
  - `data/logs/*.jsonl` (every model call, build costs): rolled over at 100 MB, three old files kept.
  - Backups: see below.

The admin pages (Users, GPU, Errors) work as in development. The GPU page reads VRAM from ComfyUI's own report,
because `nvidia-smi` is not on the box.

## Backups

`daydream-backup.timer` takes a snapshot every night at about 04:30 (and at the next boot if the box was off),
while the game runs. It writes to `/var/lib/daydream-backups/<date>/`, on the same disk: this protects against a
bad deploy, a mistake, or a corrupted file, not against the disk dying.

- **What a snapshot holds:** a consistent copy of `daydream.sqlite` (accounts, the catalog of worlds and
  adventures, jobs, errors, activity) and of every adventure in `adventures/`, made by SQLite while the server
  writes; and `worlds/` and `trash/`. Files unchanged since the night before (most of a world's art) are hard links
  to the previous snapshot, so a night costs only what changed. Not kept: `cache/` and `logs/`.
- **Retention:** every snapshot of the last 14 days, and the first snapshot of each month for a year. Older ones
  are deleted after each night's snapshot. A snapshot interrupted midway is left as `<date>.partial` and removed.
- **Check it:** `systemctl list-timers daydream-backup.timer`, `journalctl -u daydream-backup -n 20`, and
  `backup.ts list` (console tools, above). Take one now with `sudo systemctl start daydream-backup`.

### Restoring

Everything, from one night:
```bash
sudo systemctl stop daydream-server daydream-worker
sudo mv /var/lib/daydream /var/lib/daydream.before-restore          # keep what was there until the restore is checked
sudo cp -a /var/lib/daydream-backups/<date> /var/lib/daydream       # a copy, so the snapshot itself stays as it was
sudo chown -R daydream:daydream /var/lib/daydream
sudo systemctl start daydream-server daydream-worker
```
`cp -a` makes real copies of the hard-linked files. When the game looks right, delete
`/var/lib/daydream.before-restore`.

One adventure (a player's save), with the server stopped so it does not write the live copy back:
```bash
sudo systemctl stop daydream-server
sudo cp /var/lib/daydream-backups/<date>/adventures/<adventureId>.sqlite /var/lib/daydream/adventures/
sudo rm -f /var/lib/daydream/adventures/<adventureId>.sqlite-wal /var/lib/daydream/adventures/<adventureId>.sqlite-shm
sudo chown daydream:daydream /var/lib/daydream/adventures/<adventureId>.sqlite
sudo systemctl start daydream-server
```
One world: copy `worlds/<worldId>/` back the same way, with both services stopped. A world deleted by mistake is
easier: it waits in the trash (below).

## Moving worlds between machines

A world takes hours of GPU to build, so build it once and carry it: from development to the game box, or from the
game box home to reproduce a bug. On the machine that has it (in `packages/server`):

```
npm run worldpack -- export <worldId> thimble.worldpack --adventures
```

Copy the file over, then on the other machine (the server can be running):

```
npm run worldpack -- import thimble.worldpack --owner <username>
```

On the game box, copy the pack somewhere `daydream` can read it (`/tmp` works) and run the tool as `daydream` (see *Console
tools on the box*):

```bash
scp thimble.worldpack <box>:/tmp/
cd /opt/daydream/packages/server
sudo -u daydream env DAYDREAM_DATA_DIR=/var/lib/daydream DAYDREAM_GENAI_CONFIG=/etc/daydream/genai.json node src/cli/worldpack.ts import /tmp/thimble.worldpack --owner <username>
```

The `--owner` account must already be set up there.

The world belongs to `--owner`; with `--adventures` its adventures come along, each player given to the account of the same
name there (or the owner). Something already there is kept unless `--replace`. `--rigs` adds the animation's painting steps (to
animate again without painting what is done) and `--draft` the build's intermediate steps (to lay places out again); neither is needed to play.
A pack is a gzipped tar read with the system's `tar`, and is checked before anything is copied in.

## Deleted worlds

Only administrators delete worlds, from the world's page (docs/server-architecture.md says everything a delete
stops and removes). Deleting a world moves it to `/var/lib/daydream/trash/<id>/`:
- the world folder (`world/`);
- its adventures (`adventures/`);
- a record of what was deleted (`trash.json`).

Administrators restore one, or remove it at once, under **Deleted worlds** on the Users page. The server
removes entries older than 30 days when it starts and twice a day after that. A world removed from the trash can
still come back from a nightly snapshot taken before it was deleted (the snapshots keep it). Its folder alone is
easy: copy `worlds/<worldId>/` back as under *Restoring* above, and the server lists it again when it starts. Its
adventures are listed from the catalog in `daydream.sqlite`, so they come back only with a full restore of that night.

## Security notes

- **Accounts:** invite only (links that run out after 5 days), scrypt-hashed passwords and/or passkeys (WebAuthn,
  checked against the site's own origin), sessions kept by the hash of their token (a backup signs nobody in), passwords of at least 12 characters, and lockouts after repeated
  failures: per address for sign-ins and invite guesses, and per account for wrong passwords, which ends in a
  block an administrator lifts (`docs/server-architecture.md`, Accounts).
- **Behind Caddy:**
  - The server trusts `X-Forwarded-*` from loopback only. The lockout therefore sees each player's real address,
    and on https the session cookie is marked `Secure`.
  - Caddy adds HSTS, `nosniff`, `X-Frame-Options` and `Referrer-Policy`.
- **Adventures:** each is played by its creator and the players they gave a place in it, and by nobody else. An
  administrator reaches someone else's only by asking for it explicitly (see `docs/server-architecture.md`).
- **Requests from other sites:** every request that changes something must come from the site's own pages (its
  `Origin` is checked, as for game connections), besides the session cookie being `SameSite=Lax`.
- **Spending:** a monthly budget per account (set on the Users page), a daily ceiling for the whole server in
  `genai.json`, plus the project limit at OpenAI.
- **Service sandbox:** the services run as `daydream` with `ProtectSystem=strict`. They can write only `/var/lib/daydream`
  (the backup also `/var/lib/daydream-backups`) and a private `/tmp`, and they cannot read home folders.
