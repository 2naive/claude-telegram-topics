// Unified channel used by the MCP tools.
//
// Every session — leader or follower — talks to the bot through the leader's
// loopback control API. On first use we run leader election: whoever binds the
// port hosts the bot; everyone else is a follower. If the leader dies, the next
// request transparently re-elects and re-registers (the topic is persisted on
// disk, so the same project lands back in the same topic).

import { CONTROL_PORT, VERSION, isRealProjectKey } from "./config.ts";
import {
  claudePid,
  identityResolved,
  projectKey,
  projectName,
  sessionLabel,
  waitForIdentity,
} from "./project.ts";
import { tryBecomeLeader } from "./leader.ts";
import type { Inbound } from "./leader.ts";

const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
// Bound every request so a wedged-but-alive leader can't hang a tool forever;
// a timeout is treated like a connection failure and triggers re-election.
const CALL_TIMEOUT_MS = 15_000;

let sessionId: string | null = null;
// Survives the resets that force a re-register, so the leader can migrate the
// previous session's queue and message ownership instead of orphaning them.
let lastSessionId: string | null = null;
let topicId: number | null = null;
let leaderStarted = false;

// What is actually listening on the control port after a lost election:
// a real leader (/health answers with our shape), a foreign program squatting
// the port (8787 is also wrangler dev's default — without this check the
// client would happily POST /register to it and surface only a baffling
// "registration failed: HTTP 404"), or nothing (leader died mid-probe). A 200
// with a non-JSON/unexpected body is still a foreign server, not "dead" — only
// a failed request (connection refused / abort) means nothing is listening.
async function probeLeader(): Promise<"leader" | "foreign" | "dead"> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return "dead";
  }
  if (!resp.ok) return "foreign";
  try {
    const body = (await resp.json()) as { ok?: boolean; version?: string };
    return body?.ok === true && typeof body.version === "string" ? "leader" : "foreign";
  } catch {
    return "foreign";
  }
}

async function ensureLeaderExists(): Promise<void> {
  // Returns once *a* leader is reachable (this process or another). Binding the
  // port is the election; failing to bind means someone else already leads —
  // unless the port is held by an unrelated program, which must be named
  // instead of silently failing every later call. leaderStarted is set ONLY on
  // a confirmed leader (ours or another's): latching it after a give-up would
  // stop the retry loop from ever re-running the election, so a solo session
  // whose poller died (409/401) could never recover (it sits in its own
  // re-election cooldown; the loop must keep re-entering here until the
  // cooldown lapses and the bind succeeds).
  for (let i = 0; i < 3; i++) {
    if (await tryBecomeLeader()) {
      leaderStarted = true;
      return;
    }
    const holder = await probeLeader();
    if (holder === "leader") {
      leaderStarted = true;
      return;
    }
    if (holder === "foreign") {
      throw new Error(
        `telegram-topics: port ${CONTROL_PORT} is held by another program — ` +
          `set TG_TOPICS_PORT to a free port (for ALL sessions) in the channel .env`,
      );
    }
    // "dead": nobody is leading right now (previous leader releasing the port,
    // or this process is in its own post-poller-death cooldown). Pause and let
    // the caller retry — do NOT latch leaderStarted.
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("telegram-topics: no leader could be elected (retrying)");
}

// The startup identity wait runs at most once per process: re-registrations
// (leader death, 404, hand-off) must not re-pay the timeout in environments
// where identity never resolves.
let identityWaited = false;

async function register(honorHandoff = true): Promise<void> {
  // Give the session record a bounded chance to appear before the FIRST
  // registration — registering the provisional process.cwd() identity would
  // create a garbage topic named after the config dir (live incident after
  // /reload-plugins). If it still hasn't resolved we register anyway (the
  // channel must not stay dead) and the heal loop below fixes it up later.
  if (!identityResolved() && !identityWaited) {
    identityWaited = true;
    await waitForIdentity();
  }
  // Snapshot the key BEFORE the round-trip: identity can resolve during the
  // awaits below, and registeredKey must reflect what the leader was actually
  // told, or the heal comparison would silently pass on a mismatch.
  const key = projectKey();
  // Never register the config-dir fallback of an unresolved identity — that key
  // (~/.claude or the plugin cache dir beneath it) is not a real project and
  // would mint a garbage topic. Defer: the inbound loop retries, and identity
  // keeps recomputing until a session record answers. (The leader refuses this
  // key too — this just avoids the wasted round-trip and retry noise.)
  if (!isRealProjectKey(key)) {
    throw new Error(
      "telegram-topics: project identity not resolved yet — deferring registration",
    );
  }
  const resp = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: key,
      name: projectName(),
      label: sessionLabel(),
      prev: lastSessionId ?? undefined,
      version: VERSION,
      // The claude process pid — lets /stop and /new end this session from
      // Telegram by killing the process tree. null when unresolvable (the
      // leader then reports the session as not remotely stoppable).
      pid: claudePid() ?? undefined,
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    // The leader could not create/resolve the topic — almost always a setup
    // fault: the bot is not a group admin, the group is not a forum, or the
    // chat id is wrong. Surface it instead of leaving sessionId undefined,
    // which would make every later call 404, spin a re-register loop, and
    // mask the real Telegram error as a fake "sent" success.
    let detail = `HTTP ${resp.status}`;
    try {
      const b = (await resp.json()) as { error?: string };
      if (b?.error) detail = b.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(`telegram-topics: registration failed: ${detail}`);
  }
  const data = (await resp.json()) as {
    sessionId?: string;
    topicId?: number;
    handoff?: boolean;
  };
  if (data.handoff && honorHandoff) {
    // Version hand-off: the leader runs older code and is stepping down for
    // us. Bind-loop hard — the port frees in ~250ms and we must claim it
    // before followers stuck in long-polls against the dying leader (up to
    // ~30s away) notice and race us. Losing is still safe: whoever won is
    // either newer code, or will hand off to us on the register below.
    for (let i = 0; i < 100; i++) {
      if (await tryBecomeLeader()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    leaderStarted = true;
    return register(false);
  }
  if (!data.sessionId) {
    throw new Error("telegram-topics: register response missing sessionId");
  }
  sessionId = data.sessionId;
  lastSessionId = sessionId;
  topicId = data.topicId ?? null;
  registeredKey = key;
  // Provisional identity — or one that resolved to something else while the
  // request was in flight — arms the self-heal.
  if (!identityResolved() || key !== projectKey()) startHealLoop();
}

// Self-heal for a provisional registration: once the real project key is known
// and differs from the one the leader was told, drop the session and
// re-register — the leader's prev-migration moves the queue and message
// ownership, and the session lands in its real topic. The loop only disarms
// after VERIFYING the registered key matches (or on the give-up cap): clearing
// it optimistically while a re-registration is in flight would strand the
// session under the stale key forever.
let registeredKey: string | null = null;
let healTimer: ReturnType<typeof setInterval> | null = null;
let healTicks = 0;
const HEAL_TICK_MS = 15_000;
const HEAL_MAX_TICKS = 40; // ~10 min: identity is never coming — stop burning cycles

function stopHealLoop(): void {
  if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

function startHealLoop(): void {
  if (healTimer) return;
  healTicks = 0;
  healTimer = setInterval(() => {
    projectKey(); // recompute — caches as soon as the record answers
    if (!identityResolved()) {
      if (++healTicks >= HEAL_MAX_TICKS) stopHealLoop();
      return;
    }
    if (projectKey() === registeredKey && sessionId) {
      stopHealLoop(); // verified: leader holds the real key (or a legit match)
      return;
    }
    // Not registered right now: either a re-registration is in flight
    // (single-flight returns that promise) or the last attempt failed — in
    // both cases ensureRegistered() is the correct move, and the next tick
    // verifies the outcome. Only drop a LIVE session registered on a stale key.
    if (sessionId) sessionId = null; // lastSessionId keeps the id for prev-migration
    void ensureRegistered().catch(() => {
      // leader mid-election or busy — the loop stays armed and retries.
    });
  }, HEAL_TICK_MS);
  (healTimer as { unref?: () => void }).unref?.();
}

// Single-flight: the background inbound loop and a first tool call can race
// here; two concurrent registrations would strand one session id.
let registering: Promise<void> | null = null;

export async function ensureRegistered(): Promise<void> {
  if (sessionId) return;
  if (registering) return registering;
  registering = (async () => {
    if (!leaderStarted) await ensureLeaderExists();
    try {
      await register();
    } catch (e) {
      // A register that fails at the connection level means the leader we
      // elected is already gone (it died between the election and this call —
      // e.g. its poller hit 409 and it relinquished). Drop the latch so the
      // next retry re-runs the election instead of hammering a dead port
      // forever — the bug that left a solo session's inbound permanently dead
      // after a poller death.
      leaderStarted = false;
      throw e;
    }
  })().finally(() => {
    registering = null;
  });
  return registering;
}

async function call(
  path: string,
  body: Record<string, unknown>,
  retried = false,
): Promise<any> {
  await ensureRegistered();

  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...body }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (retried) throw e;
    // Leader unreachable or wedged (timeout) — re-elect and retry once.
    sessionId = null;
    leaderStarted = false;
    await ensureLeaderExists();
    return call(path, body, true);
  }

  if (resp.status === 404 && !retried) {
    // Session vanished (leader restarted) — re-register and retry once.
    sessionId = null;
    return call(path, body, true);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // The leader wraps real failures (Telegram 4xx/5xx, unknown session) as
    // { error } with a non-2xx status. Returning it would make send() read
    // messageId === undefined and report success on a hard failure, so throw:
    // the MCP tool then surfaces a real error to the model.
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `telegram-topics: control API ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function send(text: string, options?: string[]): Promise<number> {
  // Carry the current session label so a mid-session /rename is reflected.
  const r = await call("/send", { text, options, label: sessionLabel() });
  return r.messageId;
}

export async function sendFile(path: string, caption = ""): Promise<number> {
  const r = await call("/sendFile", { path, caption, label: sessionLabel() });
  return r.messageId;
}

export async function react(messageId: number, emoji: string): Promise<void> {
  await call("/react", { messageId, emoji });
}

export async function edit(messageId: number, text: string): Promise<void> {
  await call("/edit", { messageId, text });
}

export async function askPermission(p: {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}): Promise<void> {
  await call("/permissionAsk", {
    requestId: p.requestId,
    toolName: p.toolName,
    description: p.description,
    inputPreview: p.inputPreview,
  });
}

export async function poll(timeoutSec = 25): Promise<Inbound[]> {
  await ensureRegistered();
  try {
    const resp = await fetch(
      `${BASE}/poll?sessionId=${sessionId}&timeout=${timeoutSec}`,
      // Allow headroom over the server-side long-poll window before aborting.
      { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) },
    );
    if (resp.status === 404) {
      sessionId = null;
      return [];
    }
    const data = (await resp.json()) as { messages?: Inbound[] };
    return data.messages ?? [];
  } catch {
    // Timeout or leader gone — drop registration so the next call re-elects.
    sessionId = null;
    leaderStarted = false;
    return [];
  }
}

// Local buffer so messages that arrive together are never dropped between an
// ask_user / wait_for_message and the next check_messages.
const localBuffer: Inbound[] = [];

/**
 * Wait for the next inbound message, buffering any that arrive alongside it.
 * When consumeBuffer is false (used by ask_user), messages buffered BEFORE this
 * call are ignored — they cannot be a reply to a question not yet asked — but
 * are left in the buffer so a later check_messages/wait_for_message still sees
 * them.
 */
export async function nextMessage(
  overallSec: number,
  consumeBuffer = true,
): Promise<Inbound | null> {
  if (consumeBuffer && localBuffer.length) return localBuffer.shift()!;
  const deadline = Date.now() + overallSec * 1000;
  while (Date.now() < deadline) {
    const remain = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    const msgs = await poll(remain);
    if (msgs.length) {
      const [first, ...rest] = msgs;
      localBuffer.push(...rest);
      return first!;
    }
  }
  return null;
}

/** Return everything pending right now (buffered + a quick poll). */
export async function drainMessages(): Promise<Inbound[]> {
  const buffered = localBuffer.splice(0, localBuffer.length);
  const fresh = await poll(1);
  return [...buffered, ...fresh];
}

export function currentTopic(): number | null {
  return topicId;
}

/**
 * Best-effort goodbye on shutdown, so the leader frees this session at once.
 * Without it a closed console left a dead registry entry that kept "owning"
 * the topic — inbound was quietly queued to a corpse and autostart never
 * fired (live incident; the idle reaper is only a slow backstop).
 */
export function unregister(): void {
  if (!sessionId) return;
  void fetch(`${BASE}/unregister`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {});
  sessionId = null;
}
