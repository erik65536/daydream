/** Thin REST client. */
import type { BuildActivity, BuildRates, PlayerSettings, ReviewView, WorldInput } from '@daydream/shared';

declare const __DAYDREAM_VERSION__: string | undefined;
/** The game's version (the root package.json's, set when the client is built: vite.config.ts). */
export const VERSION = typeof __DAYDREAM_VERSION__ === 'string' ? __DAYDREAM_VERSION__ : 'dev';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let signedOut: (() => void) | null = null;
/** Called when the server answers that nobody is signed in: the session ended somewhere else, or ran out. */
export function onSignedOut(fn: (() => void) | null) {
  signedOut = fn;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  // Something in front of the server (a proxy while it restarts) may answer with a page instead of JSON.
  let data: { error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON: told by its status below */
  }
  if (res.status === 401) signedOut?.();
  if (!res.ok || !data) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

interface PasskeyInfo { id: string; name: string; createdAt: number; lastUsedAt: number | null }

export interface Me {
  id: string;
  /** The sign-in name (fixed). */
  username: string;
  /** What other players see. */
  displayName: string;
  isAdmin: boolean;
  hasPassword: boolean;
  passkeys: PasskeyInfo[];
  /** This month's spending on paid AI models against the monthly budget (null budget: unlimited). */
  ai: { spentMonth: number; budget: number | null };
  /** The player's own preferences. */
  settings: PlayerSettings;
}

export type UserStatus = 'invited' | 'active' | 'disabled';

export interface UserRow extends Omit<Me, 'username'> {
  /** Chosen by the user when setting the account up (null until then). */
  username: string | null;
  status: UserStatus;
  createdAt: number;
  monthlyBudgetUsd: number;
  /** While invited: the code for the invite link (#/invite/<code>) and when it stops working. */
  inviteCode: string | null;
  inviteExpires: number | null;
  /** Wrong passwords in a row; while lockedUntil, password sign-in waits; blocked, it needs an unlock (or a passkey). */
  failedPasswords: number;
  lockedUntil: number | null;
  blocked: boolean;
}

/** That it is you, before changing how you sign in: your current password, or a passkey you just used. */
export type Proof = { password: string } | { passkey: { flow: string; response: unknown } };

/** A passkey ceremony the server started: its id and the options for the browser. */
interface Ceremony<O> { flow: string; options: O }

/** What deleting a world takes with it (administrators). */
export interface DeletionPreview { title: string; ownerName: string; adventures: number; players: number; online: number; jobs: { kind: string; status: string }[] }
/** A deleted world waiting in the trash. */
export interface TrashEntry { id: string; title: string; ownerId: string; ownerName: string; deletedAt: number; deletedBy: string; adventures: number }

/** One kind of error from the server, the worker, or a player's browser, counted (see the server's log.ts). */
export interface ErrorEntry {
  fingerprint: string;
  source: 'server' | 'worker' | 'client' | 'tool';
  message: string;
  stack: string;
  context: Record<string, unknown>;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** The server's numbers for one hour (the current hour so far, or a finished one). */
export interface HourStats { at: number; requests: number; failed: number; slow: number; signIns: number; joins: number; errors: number; playersOnline: number; adventuresRunning: number; rssMb: number }

export interface ErrorsView { errors: ErrorEntry[]; stats: { startedAt: number; current: HourStats; hours: HourStats[] } }

export interface SpendingSummary { today: number; dailyTotalUsd: number | null; adminsUnlimited: boolean; systemMonth: number }

/** The admin GPU page: everything that uses the GPU, across the server, the worker, and CLI runs. */
export interface GpuJob {
  id: string;
  kind: 'world' | 'rules' | 'art' | 'animate';
  worldId: string;
  world: string;
  owner: string;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  priority: number;
  step: string;
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  cancelRequested: boolean;
  position?: number;
  worker?: string;
}
export interface GpuTag { jobId?: string; worldId?: string; kind?: string }
interface GpuProcess {
  holder: string;
  role: 'server' | 'worker' | 'cli';
  label: string;
  pid: number;
  host: string;
  startedAt: number;
  seen: number;
  stale: boolean;
  isThis: boolean;
  state: {
    builds: { tag?: GpuTag; running?: { model: string; priority: number; since: number }; pending: { model: string; priority: number }[] }[];
    tasks: { tag: GpuTag; step: string; progress: number; since: number }[];
  };
}
export interface ComfyPromptView {
  id: string;
  number: number;
  workflow: string;
  origin: { kind: 'server' | 'worker' | 'cli' | 'untagged' | 'external'; label: string; holder?: string; jobId?: string; worldId?: string; jobKind?: string };
}
interface BrokerWork { id: string; adapter: string; model: string; rank: number; client: string; tag?: GpuTag & { label?: string }; state: string; submittedAt: number; startedAt?: number; progress?: number }
export interface GpuView {
  now: number;
  thisProcess: string;
  control: { paused: { by: string; at: number } | null; animationPaused: { by: string; at: number } | null };
  /** Voices: the GPU switch, each engine's state (the GPU's as the broker says), and lines since the server started. */
  speech: {
    gpuOff: { by: string; at: number } | null;
    engines: { name: 'cpu' | 'gpu'; ready: boolean; slots: number; free: number; waiting: number }[];
    counts: { spoken: { cpu: number; gpu: number; file: number }; expired: number; failed: number; cancelled: number };
    lines: number;
  };
  device: { name: string; vramUsedMb: number; vramTotalMb: number; utilization?: number; source: string } | null;
  /** The GPU broker's queue: every installation's work (production, development, CLI runs). */
  broker: { up: boolean; error?: string; resident?: { adapter: string; model: string } | null; running?: BrokerWork | null; queued?: BrokerWork[]; down?: string[] };
  processes: GpuProcess[];
  jobs: { running: GpuJob[]; queued: GpuJob[]; recent: GpuJob[] };
  comfy: { url: string; up: boolean; error?: string; running: ComfyPromptView[]; pending: ComfyPromptView[]; failures: { id: string; at: number; message: string; origin: ComfyPromptView['origin']; workflow: string }[] };
  animation: { worldId: string; title: string; waiting: number; failed: { key: string; error?: string }[] }[];
  throughput: { comfyPromptsLastHour: number | null; imagesLastHour: number | null; actorsPerHour: number; jobsDone24h: number; jobsFailed24h: number; jobsCancelled24h: number };
  audit: { at: number; adminId: string; adminName: string; action: string; target: string; detail: string }[];
}

export interface WorldSummary {
  id: string;
  title: string;
  pitch: string;
  ownerId: string;
  ownerName: string;
  /** Ready to play; being dreamed (a build is working on it); or failed: its build stopped and can be resumed. */
  status: 'generating' | 'ready' | 'failed';
  input: { size: string; length: string };
  /** Its rules' name, and when they were last balanced (the page reloads the rules when that changes). */
  rules?: { name: string; balance?: { at: number } };
  palette: { primary: string; secondary: string; accent: string; ui: string };
  /** The world's own art for its card. */
  coverArt?: { scene?: string; figures: string[] };
  artProgress: { ok: number; total: number };
  /** Some of its characters have painted animations (a player may turn them off). */
  animated: boolean;
  /** Its characters animated, still being animated, and given up on (in a single world's summary only). */
  animation?: { done: number; waiting: number; failed: number };
  /** Its theme, once its music is made (docs/sound.md). */
  theme?: import('@daydream/shared').SoundDef;
  job?: { status: string; progress: number; step: string; error?: string; queuePosition?: number };
  /** Your own adventures in it (in the world list only): how many, and the one you played last. */
  played?: { count: number; last?: import('@daydream/shared').AdventureSummary & { where?: string } };
}

/** A job is active while queued, running, or waiting for a model. */
export const jobActive = (status?: string) => status === 'queued' || status === 'running' || status === 'waiting';

export interface JobStatus {
  /** What the job does: building the world, its rules, its art, or animation. */
  kind?: 'world' | 'rules' | 'art' | 'animate';
  /** A job's own state; for a world that never had a job, `done` when it is ready, else the world's state. */
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'unknown' | 'generating';
  /** Jobs ahead of this one in the queue. */
  queuePosition?: number;
  progress: number;
  step: string;
  error?: string;
  log: { t: number; msg: string; kind: 'step' | 'info' | 'warn' | 'error' }[];
  /** A build's counts of what it has made (nothing of the world itself). */
  preview: { activity?: BuildActivity };
  /** The job's stages: what is done, what is happening now, and what comes next. */
  phases?: JobPhase[];
}

export interface JobPhase {
  id: string;
  label: string;
  detail: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  done?: number;
  total?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface WorldSetup {
  id: string;
  concept: { title: string; pitch: string; tone: string; genre: string; palette: WorldSummary['palette'] };
  ruleset: import('@daydream/shared').Ruleset;
  /** Look of each class (id = class id), and its heroes' sprites by kin id. */
  origins: { id: string; name: string; description: string; appearance: string; assets?: Record<string, string> }[];
  assets: Record<string, string>;
}

/** A job's tallies (server: genai/meter.ts): dollars, calls, tokens, pictures, GPU and step time, tries. */
export interface Tally {
  usd?: number;
  calls?: number;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  imageInput?: number;
  images?: number;
  prompts?: number;
  gpuMs?: number;
  queueMs?: number;
  spans?: number;
  ms?: number;
  tries?: number;
  failed?: number;
  gaveUp?: number;
}

/** What one job on a world took (server: worldgen/metrics.ts). */
export interface BuildRecord {
  job: string;
  kind: string;
  started: number;
  updated: number;
  activeMs: number;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'paused';
  total: Tally;
  steps: Record<string, Tally>;
  purposes: Record<string, Tally>;
  models: Record<string, Tally>;
  counts?: Record<string, number>;
}

/** Everything a world holds, for the world viewer (server: worldview.ts). */
export interface WorldView {
  world: import('@daydream/shared').WorldDefinition;
  records: BuildRecord[];
  estimate: import('@daydream/shared').BuildEstimate | null;
  motion: Record<string, { state: 'animated' | 'waiting' | 'failed' | 'off'; error?: string }>;
  /** Speakers with a reference clip (assets/voices/<id>.wav). */
  voiceClips: string[];
  /** Each line spoken at build time, by speaker, and its file. */
  spoken: { speakerId: string; text: string; file: string }[];
  adventures: { count: number; players: number };
  job: { kind: string; status: string; step: string; progress: number } | null;
}

export type CharSpec = Omit<import('@daydream/shared').CharacterSpec, 'sprite'>;

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/auth/login', { username, password }),
  passkeySignInStart: () => call<Ceremony<unknown>>('POST', '/api/auth/passkey/start', {}),
  passkeySignInFinish: (flow: string, response: unknown) => call<Me>('POST', '/api/auth/passkey/finish', { flow, response }),
  /** An invite: the user name it already has (an account reset keeps it) or null to choose one, and the name it was made for. */
  invite: (code: string) => call<{ username: string | null; displayName: string }>('GET', `/api/join/${encodeURIComponent(code)}`),
  /** Why a user name cannot be chosen (badly formed, or taken), or null when it can. */
  usernameProblem: (code: string, name: string) => call<{ problem: string | null }>('GET', `/api/join/${encodeURIComponent(code)}/username?name=${encodeURIComponent(name)}`),
  joinWithPassword: (code: string, o: { username?: string; displayName: string; password: string }) => call<Me>('POST', `/api/join/${encodeURIComponent(code)}/password`, o),
  joinPasskeyStart: (code: string, username?: string) => call<Ceremony<unknown>>('POST', `/api/join/${encodeURIComponent(code)}/passkey/start`, { username }),
  joinPasskeyFinish: (code: string, o: { flow: string; response: unknown; name: string; username?: string; displayName: string }) => call<Me>('POST', `/api/join/${encodeURIComponent(code)}/passkey/finish`, o),
  setDisplayName: (displayName: string) => call<Me>('PATCH', '/api/account', { displayName }),
  saveSettings: (settings: PlayerSettings) => call<PlayerSettings>('PUT', '/api/account/settings', settings),
  proofStart: () => call<Ceremony<unknown>>('POST', '/api/account/proof/start', {}),
  setPassword: (proof: Proof, next: string) => call<Me>('POST', '/api/account/password', { proof, next }),
  clearPassword: (proof: Proof) => call<Me>('DELETE', '/api/account/password', { proof }),
  passkeyAddStart: (proof: Proof) => call<Ceremony<unknown>>('POST', '/api/account/passkeys/start', { proof }),
  passkeyAddFinish: (flow: string, response: unknown, name: string) => call<Me>('POST', '/api/account/passkeys/finish', { flow, response, name }),
  removePasskey: (id: string, proof: Proof) => call<Me>('DELETE', `/api/account/passkeys/${encodeURIComponent(id)}`, { proof }),
  users: () => call<UserRow[]>('GET', '/api/admin/users'),
  createUser: (o: { displayName: string; monthlyBudgetUsd: number }) => call<UserRow>('POST', '/api/admin/users', o),
  updateUser: (id: string, patch: { displayName?: string; monthlyBudgetUsd?: number; isAdmin?: boolean; enabled?: boolean }) => call<UserRow>('PATCH', `/api/admin/users/${id}`, patch),
  unlockUser: (id: string) => call<UserRow>('POST', `/api/admin/users/${id}/unlock`, {}),
  resetUser: (id: string) => call<UserRow>('POST', `/api/admin/users/${id}/reset`, {}),
  removeUserPasskey: (id: string, passkeyId: string) => call<UserRow>('DELETE', `/api/admin/users/${id}/passkeys/${encodeURIComponent(passkeyId)}`),
  spending: () => call<SpendingSummary>('GET', '/api/admin/spending'),
  trash: () => call<{ days: number; entries: TrashEntry[] }>('GET', '/api/admin/trash'),
  restoreWorld: (id: string) => call<{ ok: true; id: string }>('POST', `/api/admin/trash/${id}/restore`, {}),
  purgeWorld: (id: string) => call<{ ok: true }>('DELETE', `/api/admin/trash/${id}`),
  gpu: (fresh = false) => call<GpuView>('GET', `/api/admin/gpu${fresh ? '?fresh=1' : ''}`),
  errors: () => call<ErrorsView>('GET', '/api/admin/errors'),
  clearErrors: () => call<{ ok: true }>('DELETE', '/api/admin/errors'),
  gpuPause: (scope: 'all' | 'animation', on: boolean) => call<GpuView['control']>('POST', '/api/admin/gpu/pause', { scope, on }),
  gpuSpeech: (on: boolean) => call<{ gpuOff: GpuView['speech']['gpuOff'] }>('POST', '/api/admin/gpu/speech', { on }),
  gpuPriority: (id: string, change: { priority: number } | { move: 'up' | 'down' }) => call<{ ok: true }>('POST', `/api/admin/gpu/jobs/${id}/priority`, change),
  gpuCancel: (id: string) => call<{ ok: true; stopped: boolean; promptsCleared: number }>('POST', `/api/admin/gpu/jobs/${id}/cancel`, { confirm: true }),
  gpuClearPrompt: (id: string) => call<{ ok: true; outcome: string }>('POST', `/api/admin/gpu/comfy/${id}/clear`, { confirm: true }),
  gpuRetryActor: (worldId: string, key: string) => call<{ ok: true }>('POST', '/api/admin/gpu/actors/retry', { worldId, key }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  worlds: () => call<WorldSummary[]>('GET', '/api/worlds'),
  world: (id: string) => call<WorldSummary>('GET', `/api/worlds/${id}`),
  /** Write (or write again, given the review) the concept and rule systems of a world to be, to review. */
  review: (input: WorldInput, review?: string) => call<ReviewView>('POST', '/api/worlds/review', { input, ...(review && { review }) }),
  /** Create the world reviewed, and start building it. */
  createWorld: (input: WorldInput, review: string) => call<{ worldId: string }>('POST', '/api/worlds', { input, review }),
  buildRates: () => call<{ rates: BuildRates; builds: number }>('GET', '/api/build-rates'),
  deleteWorld: (id: string) => call<{ ok: true }>('DELETE', `/api/worlds/${id}`),
  deletionPreview: (id: string) => call<DeletionPreview>('GET', `/api/admin/worlds/${id}/deletion`),
  job: (id: string, since = 0) => call<JobStatus>('GET', `/api/worlds/${id}/job?since=${since}`),
  cancelJob: (id: string) => call<{ ok: true }>('POST', `/api/worlds/${id}/cancel`, {}),
  resumeWorld: (id: string) => call<{ ok: true }>('POST', `/api/worlds/${id}/resume`),
  regenArt: (id: string, retryFailed = false) => call<{ ok: true }>('POST', `/api/worlds/${id}/art`, { retryFailed }),
  setup: (id: string) => call<WorldSetup>('GET', `/api/worlds/${id}/setup`),
  /** Your adventures in a world, or (others, administrators only) everyone else's. */
  adventures: (worldId: string, others = false) => call<import('@daydream/shared').AdventureSummary[]>('GET', `/api/worlds/${worldId}/adventures${others ? '?admin=1' : ''}`),
  createAdventure: (worldId: string, name: string, party: CharSpec[], difficulty?: import('@daydream/shared').DifficultyId, members?: string[]) => call<{ adventureId: string }>('POST', `/api/worlds/${worldId}/adventures`, { name, party, difficulty, members }),
  adventure: (id: string) => call<AdventureDetail>('GET', `/api/adventures/${id}`),
  /** Make heroes for an adventure (outside the game). */
  addHeroes: (id: string, heroes: CharSpec[]) => call<{ ok: true }>('POST', `/api/adventures/${id}/heroes`, { heroes }),
  /** Which of your heroes come along, the leader first; the rest wait. */
  setParty: (id: string, party: string[]) => call<{ ok: true }>('PUT', `/api/adventures/${id}/party`, { party }),
  deleteHero: (id: string, heroId: string) => call<{ ok: true }>('DELETE', `/api/adventures/${id}/heroes/${heroId}`),
  players: () => call<PlayerEntry[]>('GET', '/api/players'),
  /** Give a player a place (`asAdmin`: an administrator giving themselves one in someone else's adventure). */
  addMember: (id: string, userId: string, asAdmin = false) => call<{ ok: true }>('POST', `/api/adventures/${id}/members${asAdmin ? '?admin=1' : ''}`, { userId }),
  removeMember: (id: string, userId: string) => call<{ ok: true }>('DELETE', `/api/adventures/${id}/members/${userId}`),
  rules: (id: string) => call<{ ruleset: import('@daydream/shared').Ruleset | null }>('GET', `/api/worlds/${id}/rules`),
  /** Delete an adventure: your own, or (asAdmin) someone else's. */
  deleteAdventure: (id: string, asAdmin = false) => call<{ ok: true }>('DELETE', `/api/adventures/${id}${asAdmin ? '?admin=1' : ''}`),
  /** Everything a world holds (administrators only): the world viewer. */
  worldView: (id: string) => call<WorldView>('GET', `/api/admin/worlds/${id}/view`),
  genai: () => call<{ purposes: { purpose: string; provider: string; type: string; model?: string }[]; recent: { at: number; purpose: string; provider: string; ms: number; ok: boolean; error?: string; attempt: number; preview?: string }[]; configFile: string | null }>('GET', '/api/admin/models'),
  genaiReload: () => call<unknown>('POST', '/api/admin/models/reload', {}),
  genaiTest: (purpose: string) => call<{ ok: boolean; ms: number; text?: string; json?: unknown; image?: string; error?: string }>('POST', '/api/admin/models/test', { purpose }),
};

/** A hero on an adventure's page. */
export interface HeroCard { id: string; name: string; level: number; classId: string; className: string; kinId: string; figure?: string; ai: boolean }

/** An adventure's page: your heroes, the other players, who may join, and the room in the game. */
export type AdventureDetail = import('@daydream/shared').AdventureSummary & {
  isCreator: boolean;
  canManage: boolean;
  party: HeroCard[];
  bench: HeroCard[];
  others: { userId: string; name: string; online: boolean; heroes: HeroCard[] }[];
  /** Other players' heroes in the game now (your own come back to you on joining). */
  inGame: number;
  maxHeroes: number;
  newHeroLevel: number;
};

export interface PlayerEntry { id: string; name: string; username: string | null }

export const assetUrl = (worldId: string, file: string) => `/api/worlds/${worldId}/assets/${file}`;
