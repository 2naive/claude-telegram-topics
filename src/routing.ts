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
  | { kind: "start"; topicId: number }
  | { kind: "raw"; data: string };

const PERM_RE = /^perm:(allow|deny|more):([^:]+):(.+)$/;
const START_RE = /^start:(\d+)$/;

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
  const start = START_RE.exec(data);
  if (start) return { kind: "start", topicId: Number(start[1]) };
  if (/^\d+$/.test(data)) return { kind: "choice", index: Number(data) };
  return { kind: "raw", data };
}

/** callback_data for a "launch a session for this project" button. */
export function startCallbackData(topicId: number): string {
  return `start:${topicId}`;
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

// Per-topic status, rendered as a glyph prefixed to the topic NAME. The name is
// the only signal the Bot API surfaces in the topic *list* (chat actions show
// only inside an open topic; icon_color is create-only), so this is the one way
// to see at a glance, per project, whether Claude is WORKING, merely READY, or
// the CLI is off. Glyphs are shape-distinct (not same-shape colored circles) so
// they read at a glance in a tiny mobile topic list.
export type TopicStatus = "offline" | "queued" | "ready" | "working" | "attention";
const STATUS_GLYPH: Record<TopicStatus, string> = {
  working: "⏳", // Claude is actively processing a turn right now
  ready: "🟢", // session alive, turn finished, awaiting your input
  attention: "🔔", // session alive but blocked on YOU (permission prompt)
  queued: "📥", // messages waiting, no session to process them
  offline: "💤", // no session — the CLI is not running for this project
};
// Every glyph stripStatusGlyph must peel off before re-tagging — the current
// set PLUS the legacy 0.8.x glyphs (🟡 queued, ⚪ idle), so upgrading cleans old
// badges idempotently instead of stacking a second glyph.
const STRIP_GLYPHS = [...Object.values(STATUS_GLYPH), "🟡", "⚪"];

export function statusGlyph(status: TopicStatus): string {
  return STATUS_GLYPH[status];
}

/** Remove a leading status glyph (and following spaces) so re-tagging is idempotent. */
export function stripStatusGlyph(name: string): string {
  for (const g of STRIP_GLYPHS) {
    if (name.startsWith(g)) return name.slice(g.length).replace(/^\s+/, "");
  }
  return name;
}

/** Prefix a topic name with the glyph for `status`, replacing any existing one. */
export function withStatusGlyph(name: string, status: TopicStatus): string {
  return `${STATUS_GLYPH[status]} ${stripStatusGlyph(name)}`;
}

/**
 * Fold the raw per-topic signals into one status, applying precedence:
 * attention > working > ready > queued > offline. `working` and `attention`
 * require a live session (they describe what a session is doing); without one
 * the topic is queued (messages held) or offline.
 */
export function computeTopicStatus(x: {
  hasSession: boolean;
  working: boolean;
  queued: boolean;
  attention: boolean;
}): TopicStatus {
  if (x.hasSession && x.attention) return "attention";
  if (x.hasSession && x.working) return "working";
  if (x.hasSession) return "ready";
  if (x.queued) return "queued";
  return "offline";
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

/**
 * Deep link to a forum topic — tap-to-jump navigation from General (the
 * `/list` command). Private supergroup ids look like `-100<internal>`; the
 * `t.me/c/` form drops that prefix. Returns null when the id has no such
 * prefix (then there is no linkable form — callers fall back to plain text).
 */
export function topicLink(groupChatId: string, topicId: number): string | null {
  const m = /^-100(\d+)$/.exec(groupChatId.trim());
  return m ? `https://t.me/c/${m[1]}/${topicId}` : null;
}
