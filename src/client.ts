// Unified channel used by the MCP tools.
//
// Every session — leader or follower — talks to the bot through the leader's
// loopback control API. On first use we run leader election: whoever binds the
// port hosts the bot; everyone else is a follower. If the leader dies, the next
// request transparently re-elects and re-registers (the topic is persisted on
// disk, so the same project lands back in the same topic).

import { CONTROL_PORT } from "./config.ts";
import { projectKey, projectName } from "./project.ts";
import { tryBecomeLeader } from "./leader.ts";
import type { Inbound } from "./leader.ts";

const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
// Bound every request so a wedged-but-alive leader can't hang a tool forever;
// a timeout is treated like a connection failure and triggers re-election.
const CALL_TIMEOUT_MS = 15_000;

let sessionId: string | null = null;
let topicId: number | null = null;
let leaderStarted = false;

async function ensureLeaderExists(): Promise<void> {
  // Returns once *a* leader is reachable (this process or another). Binding the
  // port is the election; failing to bind means someone else already leads.
  await tryBecomeLeader();
  leaderStarted = true;
}

async function register(): Promise<void> {
  const resp = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: projectKey(), name: projectName() }),
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
  const data = (await resp.json()) as { sessionId?: string; topicId?: number };
  if (!data.sessionId) {
    throw new Error("telegram-topics: register response missing sessionId");
  }
  sessionId = data.sessionId;
  topicId = data.topicId ?? null;
}

export async function ensureRegistered(): Promise<void> {
  if (sessionId) return;
  if (!leaderStarted) await ensureLeaderExists();
  await register();
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
  const r = await call("/send", { text, options });
  return r.messageId;
}

export async function sendFile(path: string, caption = ""): Promise<number> {
  const r = await call("/sendFile", { path, caption });
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
