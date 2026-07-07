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
 * Pick a session's display name (its `/rename` value) out of the per-pid session
 * records Claude Code writes to ~/.claude/sessions/*.json. Matches on sessionId
 * and, if a stale duplicate exists, prefers the most recently updated record.
 * Pure so it can be unit-tested without touching the filesystem.
 */
export function pickSessionName(
  entries: Array<{ sessionId?: string; name?: string; updatedAt?: number }>,
  sessionId: string,
): string {
  let best = "";
  let bestAt = -1;
  for (const e of entries) {
    if (e.sessionId === sessionId && typeof e.name === "string" && e.name.trim()) {
      const at = typeof e.updatedAt === "number" ? e.updatedAt : 0;
      if (at >= bestAt) {
        bestAt = at;
        best = e.name.trim();
      }
    }
  }
  return best;
}
