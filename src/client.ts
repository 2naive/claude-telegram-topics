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
  });
  const data = (await resp.json()) as { sessionId: string; topicId: number };
  sessionId = data.sessionId;
  topicId = data.topicId;
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
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...body }),
    });
    if (resp.status === 404 && !retried) {
      // Session vanished (leader restarted) — re-register and retry once.
      sessionId = null;
      return call(path, body, true);
    }
    return await resp.json();
  } catch (e) {
    if (retried) throw e;
    // Leader unreachable — re-elect and retry once.
    sessionId = null;
    leaderStarted = false;
    await ensureLeaderExists();
    return call(path, body, true);
  }
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

export async function poll(timeoutSec = 25): Promise<Inbound[]> {
  await ensureRegistered();
  try {
    const resp = await fetch(
      `${BASE}/poll?sessionId=${sessionId}&timeout=${timeoutSec}`,
    );
    if (resp.status === 404) {
      sessionId = null;
      return [];
    }
    const data = (await resp.json()) as { messages: Inbound[] };
    return data.messages ?? [];
  } catch {
    sessionId = null;
    leaderStarted = false;
    return [];
  }
}

// Local buffer so messages that arrive together are never dropped between an
// ask_user / wait_for_message and the next check_messages.
const localBuffer: Inbound[] = [];

/** Wait for the next inbound message, buffering any that arrive alongside it. */
export async function nextMessage(overallSec: number): Promise<Inbound | null> {
  if (localBuffer.length) return localBuffer.shift()!;
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

/** Return everything pending right now (buffered + a quick poll), non-blocking-ish. */
export async function drainMessages(): Promise<Inbound[]> {
  const buffered = localBuffer.splice(0, localBuffer.length);
  const fresh = await poll(1);
  return [...buffered, ...fresh];
}

export function currentTopic(): number | null {
  return topicId;
}
