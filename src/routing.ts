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
  pid?: number;
  startedAt?: number;
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

/**
 * Decide what happens to a dead/departing session's undelivered messages.
 * Fan-out copies already sit in the siblings' queues, but a SOLO message
 * (drained from the held inbox, rescued earlier, or moved on re-register) was
 * delivered to that one session only — with live siblings it must be rerouted
 * to one of them, and with none everything is re-held for the next session.
 * Dropping solo messages on the "siblings have copies" assumption loses user
 * input the Bot API cannot recover (live incident: two held messages drained
 * into a session that died before its first poll were discarded because a
 * sibling registered 0.4 s after the drain).
 */
export function planRescue<M>(
  orphans: M[],
  hasSiblings: boolean,
  isSolo: (m: M) => boolean,
): { hold: M[]; reroute: M[] } {
  if (!hasSiblings) return { hold: orphans, reroute: [] };
  return { hold: [], reroute: orphans.filter(isSolo) };
}

/**
 * Which session owns a mirrored answer, so a reply to it routes back to that
 * session instead of fanning out to every console on the topic. Prefer the
 * member whose Claude conversation id matches the mirror's; else a lone member
 * owns its mirror unambiguously; two-plus members with no id match yield
 * undefined — the reply fans out, exactly the pre-0.20.3 behaviour. Pure.
 */
export function pickMirrorOwner(
  members: { sid: string; claudeSessionId?: string }[],
  claudeSessionId?: string,
): string | undefined {
  if (members.length === 0) return undefined;
  if (claudeSessionId) {
    const m = members.find((x) => x.claudeSessionId === claudeSessionId);
    if (m) return m.sid;
  }
  return members.length === 1 ? members[0]!.sid : undefined;
}

/**
 * Split alive consoles into BOOTING (young — still starting up, about to
 * register: a spawn would duplicate the conversation, so autostart waits) and
 * ZOMBIES (old and still unregistered — deaf/wedged, not recovering: must be
 * cleared so a stuck console can't strand the topic). A console with no known
 * start time is treated as a zombie (can't prove it's booting). Pure.
 */
// Telegram service messages arrive on the same "message" update as user text
// but carry NO user content — a pin, a forum-topic event, a member change, a
// video-chat event. Forwarding one to the session spuriously wakes it (live:
// a pinned message reached telebot as "[non-text message]" and triggered a
// turn). These are the service fields whose mere presence marks such a message.
const SERVICE_MESSAGE_KEYS = [
  "pinned_message",
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "write_access_allowed",
  "users_shared",
  "chat_shared",
  "boost_added",
  "proximity_alert_triggered",
] as const;

/** True for a Telegram service message (a pin, a forum-topic event, a member
 * or chat change) — carries no user prompt, so the bridge must not forward it
 * to the session. Pure. */
export function isServiceMessage(msg: Record<string, unknown> | null | undefined): boolean {
  if (!msg) return false;
  return SERVICE_MESSAGE_KEYS.some((k) => msg[k] !== undefined && msg[k] !== null);
}

export function partitionConsoles<C extends { startedAt: number | null }>(
  alive: C[],
  now: number,
  bootMs: number,
): { booting: C[]; zombies: C[] } {
  const booting: C[] = [];
  const zombies: C[] = [];
  for (const c of alive) {
    if (c.startedAt !== null && now - c.startedAt < bootMs) booting.push(c);
    else zombies.push(c);
  }
  return { booting, zombies };
}

// --- Inbound attachments ---

/** A media duration, compact: `12s`, `3m05s`, `1h02m03s`. Anything that is
 * not a number reads as 0. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h${pad(m)}m${pad(s)}s`;
  if (m > 0) return `${m}m${pad(s)}s`;
  return `${s}s`;
}

// Extension for a downloaded media file, from the MIME type Telegram reports
// (a voice note is `audio/ogg`; music and video carry whatever was uploaded).
// Unknown or absent → the kind's default.
const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};
function mediaExt(mime: string | undefined, fallback: string): string {
  const key = (mime ?? "").replace(/;.*$/, "").trim().toLowerCase();
  return MIME_EXT[key] ?? fallback;
}

/** The message fields the attachment picker reads — a structural subset of
 * grammy's `Message`, so tests can pass plain objects. */
export type AttachmentMessage = {
  caption?: string;
  document?: { file_id: string; file_name?: string };
  photo?: { file_id: string }[];
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: {
    file_id: string;
    duration: number;
    file_name?: string;
    title?: string;
    mime_type?: string;
  };
  video?: { file_id: string; duration: number; file_name?: string; mime_type?: string };
  video_note?: { file_id: string; duration: number };
};

export type InboundAttachment = {
  kind: "document" | "photo" | "voice" | "audio" | "video" | "video_note";
  /** Telegram file id to download. */
  fileId: string;
  /** Name to save the download under (the downloader sanitizes and prefixes it). */
  filename: string;
  /** What the session reads: a bracketed label plus the caption, e.g.
   * `[voice 12s] call me back`. The leader appends ` saved:<path>` once the
   * download succeeds (withSavedPath). */
  text: string;
};

/**
 * The one downloadable attachment of a Telegram message (a message carries at
 * most one), or null for plain text and for media the bridge does not download
 * (a sticker, a contact, a poll…) — those keep the `[non-text message]`
 * placeholder. Documents and photos keep their labels verbatim; a voice note,
 * an audio file, a video or a video note gets a label with its duration, since
 * the session cannot tell a 5 s note from a 40 min recording by the path.
 * Pure.
 */
export function inboundAttachment(m: AttachmentMessage): InboundAttachment | null {
  const caption = m.caption ?? "";
  if (m.document) {
    const name = m.document.file_name ?? "file";
    return {
      kind: "document",
      fileId: m.document.file_id,
      filename: name,
      text: `[file: ${name}]${caption ? " " + caption : ""}`,
    };
  }
  if (m.photo?.length) {
    // Telegram lists sizes ascending — the last one is the largest.
    const largest = m.photo[m.photo.length - 1]!;
    return {
      kind: "photo",
      fileId: largest.file_id,
      filename: "photo.jpg",
      text: `[photo]${caption ? ": " + caption : ""}`,
    };
  }
  const tail = caption ? " " + caption : "";
  if (m.voice) {
    return {
      kind: "voice",
      fileId: m.voice.file_id,
      filename: `voice.${mediaExt(m.voice.mime_type, "ogg")}`,
      text: `[voice ${formatDuration(m.voice.duration)}]${tail}`,
    };
  }
  if (m.audio) {
    const name = m.audio.file_name ?? m.audio.title;
    const dur = formatDuration(m.audio.duration);
    return {
      kind: "audio",
      fileId: m.audio.file_id,
      filename: m.audio.file_name ?? `audio.${mediaExt(m.audio.mime_type, "mp3")}`,
      text: `[audio${name ? `: ${name}, ` : " "}${dur}]${tail}`,
    };
  }
  if (m.video) {
    const name = m.video.file_name;
    const dur = formatDuration(m.video.duration);
    return {
      kind: "video",
      fileId: m.video.file_id,
      filename: name ?? `video.${mediaExt(m.video.mime_type, "mp4")}`,
      text: `[video${name ? `: ${name}, ` : " "}${dur}]${tail}`,
    };
  }
  if (m.video_note) {
    return {
      kind: "video_note",
      fileId: m.video_note.file_id,
      filename: "video_note.mp4",
      text: `[video note ${formatDuration(m.video_note.duration)}]${tail}`,
    };
  }
  return null;
}

/** Appends the local path the session should open. A failed, oversized or
 * slow download (downloadFile → null) leaves the label alone, so the message
 * still says what arrived — the contract documents and photos already had. */
export function withSavedPath(text: string, path: string | null): string {
  return path ? `${text} saved:${path}` : text;
}
