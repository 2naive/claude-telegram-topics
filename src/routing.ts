// Pure helpers for the leader's inbound routing and callback parsing — extracted
// from leader.ts so they can be unit-tested without a live bot or control server.

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
