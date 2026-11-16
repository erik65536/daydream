# GPU broker

The broker (`packages/gpu-broker`, `npm run broker`) runs on the GPU PC and is the only way to reach the GPU. Every
installation of the game sends its ComfyUI work and its GPU speech through it, and it runs one piece of work at a
time, unloading one model before the next is loaded.

## Why it exists

There is one GPU (16 GB, on the GPU PC) and more than one installation of the game using it: production on the game
box, development on the GPU PC itself, and now and then a second checkout or a console tool.

The models do not fit in memory together: FLUX 3 Image Klein paints, Qwen reads and marks maps, Stable Audio 3 makes
sounds, and the speech runner speaks. Installations that each decided their own GPU turns could not see each other.
Their prompts interleaved, every switch reloaded a model, and at worst a model was loaded on top of another and the
GPU ran out of memory.

So one process owns the GPU:
- Each GPU program sits behind an **adapter** that knows how to run its work and how to free its memory.
- Callers send work with a rank, and the broker runs it one piece at a time across all adapters.
- ComfyUI listens on 127.0.0.1 only, so nothing reaches it except through the broker.
- Another GPU program means one more adapter. The callers do not change.

```
game box (prod) ──┐                       ┌─ ComfyUI 127.0.0.1:8188   (Klein, Qwen, Stable Audio 3)
                  ├─▶ broker :8190 (LAN) ─┤
GPU PC (dev) ─────┘   one queue, one      └─ the speech service       (VoxCPM2 runner, VoiceDesign designer)
                      model on the GPU
```

## Running it

The broker is a long-lived process of its own on the GPU PC, started by hand like ComfyUI (`npm run broker`), with
no service or scheduled task. It does not start or stop with `npm run dev`, so restarting development never drops
production's work. While it is not running, every installation's GPU work waits, and its jobs say they are waiting
for the GPU broker.

Its config is `config/broker.json` (git-ignored; copy `config/broker.example.json`), or the file
`DAYDREAM_BROKER_CONFIG` names:

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 8190 },
  "clients": { "prod": "env:DAYDREAM_BROKER_TOKEN_PROD" },   // one bearer token per installation
  "adapters": {
    "comfyui": { "url": "http://127.0.0.1:8188", "freeBetweenModels": true },
    "speech": { "slots": 16 }                                // leave out for a broker without speech
  },
  "holdMs": 180000,   // how long one caller's model may keep the GPU while another of the same rank waits
  "graceMs": 1500,    // after a piece of work ends, how long to wait for that caller's next piece on the same model
  "settleMs": 60000   // how long the GPU stays idle, its last model kept, before speech may load its runner
}
```

`listen`, `clients`, `adapters.speech` and the three times may be left out: the broker then listens on every address
at port 8190, knows only the local client, does no speech, and uses the times shown.

### Who may call it

- A request with `Authorization: Bearer <token>` is the client whose token that is. A token is written in the config
  as it is, or as `"env:NAME"` for an environment variable (the repository's `.env` is read too). A client whose
  token is empty cannot connect.
- A request without a token is the client `local`, but only from this PC (a loopback address) and only when it asks
  for this PC by its own name (`127.0.0.1`, `localhost` or `[::1]` in its `Host` header). Development on the GPU PC
  therefore needs no token.
- A request from a web page is refused (one that carries an `Origin` or `Sec-Fetch-Site` header): a page open on the
  GPU PC must not reach the GPU as the local client.
- The Windows firewall allows port 8190 from the game box only.
- The game sends its token as the `comfyui` provider's `apiKey` (production: `"credential:gpu-broker"`, a systemd
  credential, `docs/hosting.md`).

The names in `clients` are what the queue and the admin GPU page show. Every client sees the whole queue, and stops
only its own work: see "The HTTP front" below.

## The adapter interface

```ts
/** One GPU program behind the broker (src/scheduler.ts). */
interface GpuAdapter<W = any> {
  readonly name: string;
  /** Changing models inside this program needs an unload first (ComfyUI: they do not fit together). */
  readonly freeBetweenModels?: boolean;
  /** Answering at all. Work for a program that does not answer waits; other programs' work goes ahead. */
  alive(): Promise<boolean>;
  /** Do the work. `signal` aborts it (canceled). Throw AdapterDown when the program stopped answering. */
  run(work: W, ctx: { id: string; signal: AbortSignal; progress(p: number, step?: string): void }): Promise<unknown>;
  /** Give back every byte of GPU memory this program holds. */
  unload(): Promise<void>;
}
```

The model a piece of work loads is given when it is queued, not by the adapter: work for the same adapter and model
runs back to back without unloading.

| Adapter | Work | `run` | `unload` |
|---|---|---|---|
| `comfyui` (`adapters/comfyui.ts`) | a ComfyUI prompt; its model is the `workflow` named in the prompt's `extra_data.daydream` tag, else the model files its loader nodes name | `POST /prompt` with `prompt_id` set to the broker's own id, then `/history/<id>` is read until it is done or failed. A cancel removes the prompt from ComfyUI's queue, or interrupts it if it is running. | `POST /free {unload_models, free_memory}`, sent again a second apart until a repeat frees nothing more. ComfyUI's worker reads that flag only after a prompt, so one sent just as a prompt ends can sit unread. |
| `speech` (`adapters/speech.ts`) | a build's session with the speech service (below) | lasts until the caller releases the session or its connection closes | finishes the lines speaking, then asks the service to unload |

## The scheduler

There is one queue for the whole GPU, and only one piece of work runs at a time across all adapters. When the broker
picks the next piece:

1. **Rank first.** The caller's rank: 0 means a player is waiting, 1 an owner is waiting, 2 a world build (also the
   rank of work that names none). Work a player is waiting on goes before a build.
2. **Stay on the loaded model.** Among equal ranks, work for the loaded adapter and model goes first. After a piece
   finishes, the broker waits `graceMs` for the same caller's next piece before it switches models. Callers submit
   one piece, wait for it, then submit the next; without the grace, every gap would hand the GPU to the other
   installation and force a model switch.
3. **Fairness.** A caller keeps the loaded model for at most `holdMs` while another caller of the same rank waits,
   counted from when that other caller began to wait. After that the turn passes to the other caller's oldest work.
   Development cannot starve production, and production cannot starve development.
4. **Switching.** Before work for a different adapter, the broker unloads the loaded one. For the same adapter with
   another model, it unloads only if the adapter is `freeBetweenModels`. While the broker does not know what is
   loaded (just started, a program came back, or an unload failed), it unloads every adapter first.
5. **A program that fails to unload.** When another program's unload fails, that is not the waiting work's failure:
   everything is unloaded again and the work runs. What is loaded stays unknown, so the program is asked again before
   the next piece. A program that stopped answering altogether took its memory with it.
6. **Down adapters.** Work for an adapter that does not answer goes back in the queue, its caller is told it is
   waiting, and other adapters' work goes ahead. The adapter is asked again every few seconds.

The queue is kept in memory, and finished work is remembered for an hour so its caller can read the outcome. If the
broker restarts, a caller polling an id it no longer knows gets a 404; the game treats that as a reason to submit the
prompt again.

Pausing GPU work is not the broker's: an administrator's pause lives in each installation (the admin GPU page), which
then holds back its own prompts before they are sent.

## The HTTP front

The broker speaks ComfyUI's own HTTP API (`src/http.ts`), so a caller's ComfyUI code only changes its address:

| Request | What the broker does |
|---|---|
| `POST /prompt` | Queues the prompt under the caller's `prompt_id` (a UUID) or one of its own, with the rank and tag from `extra_data.daydream`. Answers at once with `{prompt_id}`. |
| `GET /history/<id>` | **Queued:** `{}`, the same "not yet" ComfyUI gives, plus the header `X-Broker-State: queued; position=3`. **Running or finished:** ComfyUI's own answer for that id, with `X-Broker-State: running` or `done`. **Failed or canceled before ComfyUI saw it:** an error entry in ComfyUI's form. **Unknown id:** 404. |
| `GET /queue` | ComfyUI's queue, with the prompts held here added as pending. |
| `POST /queue {delete: [id]}` | Cancels those of the ids that are the caller's own work, queued or running. Another client's are left alone; ids the broker never saw (prompts sent to ComfyUI directly) go on to ComfyUI. |
| `POST /queue {clear: true}` | Cancels the caller's own queued prompts. |
| `POST /interrupt` | Cancels the prompt named by `prompt_id`, or without one the prompt running now, when it is the caller's own. |
| `POST /free` | Ignored and answered OK. Only the broker unloads. |
| `GET /system_stats` | ComfyUI's answer, with the broker's queue added as `broker`. |
| `GET /broker/queue` | Every client's work, queued and running, the model loaded, the adapters not answering, and who holds the GPU. This is what the admin GPU page reads. |
| `GET /broker/speech`, `POST /broker/speech/sessions`, `GET` and `DELETE /broker/speech/sessions/<id>`, the WebSocket `/broker/speech` | Speech, below. 404 on a broker without the speech adapter. |
| anything else under `/broker/` | 404. |
| everything else (`POST /upload/image`, `GET /view`, `/object_info`, …) | Passed straight to ComfyUI, without the caller's token. Uploads and downloads use no GPU, so they are not queued. |

A body that is not a JSON object is answered 400.

**Timeouts.** Time spent waiting behind another installation does not count against a caller's deadline. While
`X-Broker-State` says `queued`, the game's client does not count time, and tells its job "Waiting for the GPU" with
its place in the queue. Plain ComfyUI never sends the header, so the same client works without a broker.

## Speech

The broker's `speech` adapter (`src/adapters/speech.ts`) runs the game's voices on the GPU (`docs/voices.md`): one
Python service, `packages/gpu-broker/speech/speech_service.py`, holding either the VoxCPM2 runner (`runner.py`,
6.6 GB) or the Qwen3-TTS VoiceDesign designer (`designer.py`, up to 9 GB), never both. The broker starts it, restarts
it if it dies, and stops it with itself. It runs on the Python environment in `speech/.venv` (made from
`speech/requirements.txt`, `docs/hosting.md`), and `"adapters": { "speech": {} }` turns it on (`python` names another
environment; `slots`, lines at once, is 16; `clips` is where voices' clips are kept).

Speech does not wait in the queue: a line that cannot start at once is spoken on the game server's CPU instead.
- **While the GPU is idle** (nothing queued or running), the broker keeps the runner loaded (`claim` in the
  scheduler: it counts as the loaded model), once the GPU has stayed idle for `settleMs` (a minute) after its last
  piece of work. A caller does work of its own between pieces (a sound's take made game-ready on its CPU, a Luna
  check of a painting), and without that wait every such gap unloaded its model for the runner and loaded it again
  after. Game servers send lines over a WebSocket, `/broker/speech`, authenticated like every other request, and
  every connection's lines share the runner's 16 slots.
- **When work is queued** for anything else, new lines are refused at once, the lines speaking finish (up to 15 s),
  and the runner is unloaded like any other model before the work starts. When the queue has been empty for
  `settleMs`, the runner is loaded again, in about 8 s.
- **Every load and unload is answered**, by its `reqId`, once the service has done it. It does requests in order, so
  work queued while the runner is still loading waits for that load to finish and be unloaded; a load that fails
  gives back what it took and answers with the error. A service that does not answer in time (3 minutes for a load,
  1 for an unload) is stopped with its whole process tree, which frees its memory, and started again.
- **A build's voice work** (designing a world's voices, speaking its fixed lines) is queued like any GPU work: `POST
  /broker/speech/sessions` returns an id and a key, the caller polls `GET /broker/speech/sessions/<id>` until it
  runs, sends `{op: "session", key}` on its WebSocket to take the service, and `DELETE`s the session when done. A
  session is its client's own, and it ends when the connection that took it closes.
- `GET /broker/speech` says whether lines are taken now, which model is loaded, and the slots free.

The WebSocket carries the engines' protocol (`shared/speech.ts`): requests `speak`, `voice`, `cancel`, `design`,
`session` and `status`; events `status` (pushed whenever it changes and every 2 s), `need`, `started`, `done`,
`failed`, `expired`, `designed`, and each line's audio as 16-bit PCM at 48 kHz.

A voice is named by its reference clip: `speak` gives the SHA-256 of the clip's WAV file as its `voiceId`. The
service keeps every clip it is given on disk (`adapters.speech.clips`, by default the repository's
`data/broker/speech-clips`; a clip unused for half a year is removed when it starts). When a line names a clip it
does not have, it holds the line and sends `need`; the caller answers with `voice` (the clip, which must hash to its
name), and the line goes ahead. So a clip crosses the network once, ever: not again after a restart of the broker or
the service, a reconnect, or for another caller, and a voice designed again is a new voice by itself.

## Daydream's ComfyUI nodes

`config/comfyui/daydream-nodes/` is a ComfyUI custom-node package of the game's own. It is the source; ComfyUI runs
an installed copy in its own `custom_nodes` folder, never the checkout, so switching branches or editing the
repository cannot change what the GPU PC runs. To install it, or to update it after the folder changes, run this
from the checkout and restart ComfyUI:

```powershell
Copy-Item -Recurse -Force config/comfyui/daydream-nodes <ComfyUI folder>/custom_nodes/
```

It holds `DaydreamQwenEncode`, which the map reader's Qwen workflow (`qwen21_edit.json`) uses in place of ComfyUI's
`TextEncodeQwenImage21`. The stock node runs the 8B encoder over the whole map twice, once for an empty negative
prompt that is never used at cfg 1. Daydream's node encodes the prompt alone and keeps each picture's vision encoding
for the next plan of the same map. The plans are identical pixel for pixel, and a map's four plans take about a
quarter less GPU time (`docs/experiments/gpu-runner/README.md`).

**Versions.** The package's `VERSION` and the `version` the workflows send go up together with every change to it.
A ComfyUI with no copy, or an older one, refuses the reading, and the build's step fails with "ComfyUI's copy of
Daydream's nodes is missing or out of date" until the copy is installed again.

## The game's side

- **One ComfyUI client** (`packages/server/src/genai/comfyclient.ts`) queues a workflow and waits for it. It sends
  the bearer token, follows `X-Broker-State` for its deadline and its job's waiting message, submits again when the
  broker answers 404 for its own id, and cancels through `POST /queue {delete}`.
- **Where the broker is.** The `comfyui` provider in `config/genai.json` has the broker's address as `baseUrl`
  (development `http://127.0.0.1:8190`, production `http://<GPU PC LAN address>:8190`) and its token as `apiKey`.
  `COMFY_URL` overrides the address. Speech on the GPU (`speech.gpu`) uses the same address and token.
- **A rank and a tag on every prompt.** Each prompt carries `extra_data.daydream`: the process that sent it, its job
  and world, the workflow's name (the model, for the broker), and the rank from the call's priority (a player's call
  0, an owner's 1, a build's 2).
- **A build's own order.** `worldgen/gpu.ts` (`GpuQueue`) orders one build's GPU work, so its places, art, voices
  (the build's speech session is one task in it) and sounds are not interleaved. The broker orders between callers,
  and the build orders within itself.
- **The admin GPU page** (`gpu/admin.ts`) reads `/broker/queue` for every installation's work and the model loaded,
  ComfyUI's queue and history through the broker, and the GPU's memory from `nvidia-smi` when the game runs on the
  GPU PC, else from ComfyUI's `/system_stats`. Its pause and its job controls act in the game; removing or
  interrupting a prompt goes to the broker.

## Tests

- The scheduler with fake programs: `packages/gpu-broker/test/scheduler.test.ts`.
- The HTTP front against a fake ComfyUI: `packages/gpu-broker/test/front.test.ts`.
- ComfyUI's `/free` repeated until it takes effect: `packages/gpu-broker/test/comfyui.test.ts`.
- The game's client waiting in the broker's queue: `packages/server/test/comfyclient.test.ts`.
