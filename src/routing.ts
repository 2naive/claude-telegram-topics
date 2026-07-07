// Pure helpers for the leader's inbound routing and callback parsing — extracted
// from leader.ts so they can be unit-tested without a live bot or control server.

// Long-poll ceiling the control API grants /poll, and the Bun.serve socket
// idle timeout that MUST outlive it. Bun kills a response that writes no bytes
// for idleTimeout seconds — with the 10s default every 25s long-poll died
// mid-wait, each client re-registered in a loop, and button taps routed into
// orphaned queues (live incident). The invariant test pins the relationship.
export const POLL_MAX_SEC = 30;
export const LEADER_IDLE_TIMEOUT_SEC = 40;

// Every control API response closes its connection. A pooled keep-alive
// connection outlives both a graceful stop and the delayed force-close
// (reproduced live on Bun 1.3.12): a back-to-back /poll loop never idles, so a
// demoted leader keeps serving it forever and inbound black-holes until some
// other call happens to open a fresh socket. Per-response close makes every
// request a fresh connect, so leader death surfaces as ECONNREFUSED within one
// poll cycle and the client re-elects. Loopback reconnects at this call rate
// cost nothing. The invariant test pins the header.
export const CONTROL_RESPONSE_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  connection: "close",
};

export type Callback =
  | {
      kind: "permission";
      behavior: "allow" | "deny" | "more";
      sessionId: string;
      requestId: string;
    }
  | { kind: "choice"; index: number }
  | { kind: "raw"; data: string };

const PERM_RE = /^perm:(allow|deny|more):([^:]+):(.+)$/;

/** Classify an inline-button callback_data payload. */
export function parseCallback(data: string): Callback {
  const perm = PERM_RE.exec(data);
  if (perm) {
    return {
      kind: "permission",
      behavior: perm[1] as "allow" | "deny" | "more",
      sessionId: perm[2]!,
      requestId: perm[3]!,
    };
  }
  if (/^\d+$/.test(data)) return { kind: "choice", index: Number(data) };
  return { kind: "raw", data };
}

/** Build the callback_data for a permission button (index-free, always short). */
export function permCallbackData(
  behavior: "allow" | "deny" | "more",
  sessionId: string,
  requestId: string,
): string {
  return `perm:${behavior}:${sessionId}:${requestId}`;
}

/**
 * Prefix that tags WHICH session sent a message, so a user with two sessions on
 * one project can tell them apart. Empty unless the topic has more than one
 * session — a lone session needs no tag.
 */
export function sessionPrefix(label: string, sessionCount: number): string {
  return sessionCount > 1 && label ? `«${label}» ` : "";
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * A per-pid session record Claude Code writes to <config>/sessions/*.json — the
 * only place the harness exposes a session's `/rename` name and its real cwd.
 */
export type SessionRecord = {
  sessionId?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
};

/**
 * Pick one string field out of the session records: the record must match on
 * sessionId and, if a stale duplicate exists, the most recently updated one
 * with a non-empty value wins. Pure so it can be unit-tested without touching
 * the filesystem.
 */
export function pickSessionField(
  entries: SessionRecord[],
  sessionId: string,
  field: "name" | "cwd",
): string {
  let best = "";
  let bestAt = -1;
  for (const e of entries) {
    const v = e[field];
    if (e.sessionId === sessionId && typeof v === "string" && v.trim()) {
      const at = typeof e.updatedAt === "number" ? e.updatedAt : 0;
      if (at >= bestAt) {
        bestAt = at;
        best = v.trim();
      }
    }
  }
  return best;
}

/** A session's display name — its `/rename` value (see pickSessionField). */
export function pickSessionName(
  entries: SessionRecord[],
  sessionId: string,
): string {
  return pickSessionField(entries, sessionId, "name");
}

/**
 * Rewrite every map value equal to `from` to `to`. Used when a client
 * re-registers: message ownership recorded under its previous session id must
 * follow it, or replies and button taps on older messages route to a dead queue.
 */
export function remapValues<K, V>(map: Map<K, V>, from: V, to: V): void {
  for (const [k, v] of map) {
    if (v === from) map.set(k, to);
  }
}

/**
 * True when semver `a` is strictly newer than `b`. Non-numeric or missing
 * segments count as 0, so an absent client version ("") can never outrank a
 * real one. Drives the leader hand-off: strictness means equal versions never
 * trade leadership back and forth.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
