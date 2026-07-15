// Leader: the single process that owns the Telegram bot.
//
// Exactly one getUpdates consumer is allowed per bot token, so exactly one
// session may poll. That session becomes the leader; every other session is a
// follower that reaches the bot through this loopback HTTP control API. The
// leader holds the bot, the poller, the session registry, and does all topic
// routing.

import { Bot, InputFile, GrammyError, type Context } from "grammy";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  BOT_TOKEN,
  GROUP_CHAT_ID,
  CONTROL_PORT,
  STATE_DIR,
  CONFIG_DIR,
  VERSION,
} from "./config.ts";
import { isAllowedUser, assertSendable } from "./access.ts";
import {
  knownProjects,
  projectForTopic,
  projectTopicId,
  recreateTopic,
  resolveTopic,
  topicName,
} from "./topics.ts";
import { normalizePath } from "./paths.ts";
import {
  isNewerVersion,
  parseCallback,
  permCallbackData,
  sessionPrefix,
  startCallbackData,
  truncate,
  withStatusGlyph,
  statusGlyph,
  computeTopicStatus,
  type TopicStatus,
  CONTROL_RESPONSE_HEADERS,
  LEADER_IDLE_TIMEOUT_SEC,
  POLL_MAX_SEC,
} from "./routing.ts";
import {
  flushSent,
  loadSent,
  peekOptions,
  remapSentSessions,
  sessionForSentMessage,
  takeOptions,
  topicForSentMessage,
  trackSent,
} from "./sent.ts";
import { mdToTelegram, splitTelegram } from "./format.ts";
import { mirrorChunks, type MirrorIO } from "./mirror.ts";
import { apiRetry } from "./tgretry.ts";
import {
  autostartEnabled,
  spawnSession,
  isPathAllowed,
  launchRoots,
  projectNameFromPath,
} from "./spawn.ts";
import { existsSync } from "node:fs";
import { log } from "./log.ts";

export type Inbound =
  | { type: "message"; from: string; text: string; messageId: number; ts: number }
  | { type: "callback"; from: string; data: string; messageId: number; ts: number }
  | { type: "reaction"; from: string; emoji: string; messageId: number; ts: number }
  | { type: "permission"; requestId: string; behavior: "allow" | "deny"; messageId: number; ts: number };

type Session = {
  id: string;
  project: string;
  topicId: number;
  label: string;
  queue: Inbound[];
  waiter: ((v: void) => void) | null;
  waiterTimer: ReturnType<typeof setTimeout> | null;
  lastActive: number;
};

const INBOX_DIR = join(STATE_DIR, "inbox");
mkdirSync(INBOX_DIR, { recursive: true });

const sessions = new Map<string, Session>();
const topicSessions = new Map<number, Set<string>>(); // topicId -> sessionIds

function bindTopic(sid: string, topicId: number): void {
  let set = topicSessions.get(topicId);
  if (!set) topicSessions.set(topicId, (set = new Set()));
  set.add(sid);
}

function unbindTopic(sid: string, topicId: number): void {
  const set = topicSessions.get(topicId);
  if (set) {
    set.delete(sid);
    if (set.size === 0) topicSessions.delete(topicId);
  }
}

function wake(s: Session): void {
  if (s.waiter) {
    const w = s.waiter;
    s.waiter = null;
    // Cancel the long-poll timer we're satisfying early, or it would fire
    // later and clobber a *newer* poll's waiter.
    if (s.waiterTimer) {
      clearTimeout(s.waiterTimer);
      s.waiterTimer = null;
    }
    w();
  }
}

function deliverToSession(sid: string, msg: Inbound): void {
  const s = sessions.get(sid);
  if (!s) {
    log("deliver.drop", { sid, type: msg.type });
    return;
  }
  s.queue.push(msg);
  wake(s);
}

// Messages that arrived for a project with no live session, held until one
// registers. Without this a user messaging a dead topic loses the message
// outright — the Bot API has no history, so it is unrecoverable.
const HELD_MAX = 20;
const HELD_TTL_MS = 30 * 60_000;
const heldInbox = new Map<string, { msgs: Inbound[]; at: number }>(); // projectKey ->

// Rate limit for the "no active session" in-topic notice (and autostart).
const NOTICE_COOLDOWN_MS = 5 * 60_000;
const lastNotice = new Map<number, number>(); // topicId -> ts

function holdInbound(project: string, msg: Inbound): void {
  let held = heldInbox.get(project);
  if (!held) heldInbox.set(project, (held = { msgs: [], at: Date.now() }));
  held.at = Date.now();
  held.msgs.push(msg);
  if (held.msgs.length > HELD_MAX) held.msgs.splice(0, held.msgs.length - HELD_MAX);
}

async function postNoSessionNotice(topicId: number, project: string): Promise<void> {
  const now = Date.now();
  if (now - (lastNotice.get(topicId) ?? 0) < NOTICE_COOLDOWN_MS) return;
  lastNotice.set(topicId, now);
  let note = "📴 No active session for this project — message queued.";
  if (autostartEnabled()) {
    // Known project waking up (reboot/crash recovery) — resume its conversation.
    const err = spawnSession(project, topicName(project), true);
    note = err
      ? `📴 No active session — message queued. Autostart failed: ${err}`
      : "📴 No active session — message queued. 🚀 Starting one…";
  }
  await bot.api
    .sendMessage(GROUP_CHAT_ID, note, {
      message_thread_id: topicId,
      reply_markup: autostartEnabled()
        ? undefined
        : {
            inline_keyboard: [
              [{ text: "▶️ Start session", callback_data: startCallbackData(topicId) }],
            ],
          },
    })
    .catch(() => {});
}

function deliver(topicId: number, msg: Inbound): void {
  const set = topicSessions.get(topicId);
  if (!set || set.size === 0) {
    // Hold real messages for the next session; taps/reactions belong to
    // whatever session posted the message and are meaningless later.
    const project = projectForTopic(topicId);
    log("deliver.none", { topic: topicId, type: msg.type, held: !!project && msg.type === "message" });
    if (project && msg.type === "message") {
      holdInbound(project, msg);
      refreshTopicStatus(project); // 📥 queued, no session
      void postNoSessionNotice(topicId, project);
    }
    return;
  }
  for (const sid of set) deliverToSession(sid, msg);
}

// "typing…" tells the phone a routed message reached a live session AND that
// Claude is still working. Telegram's chat action expires in ~5s and never
// shows in the topic LIST, so it is re-asserted every ~4.5s for the duration of
// a turn (cleared the moment the session emits output — sending a message
// already clears the indicator, so leaving the pump on would re-raise a phantom
// "typing"). List-level liveness is carried separately by the topic-name badge.
const TYPING_REFRESH_MS = 4500;
const TYPING_MAX_MS = 5 * 60_000; // safety cap: a turn that never replies stops here
const typingUntil = new Map<number, number>(); // topicId -> deadline
let typingTimer: ReturnType<typeof setInterval> | null = null;

function emitTyping(topicId: number): void {
  void bot.api
    .sendChatAction(GROUP_CHAT_ID, "typing", { message_thread_id: topicId })
    .catch(() => {});
}

function pumpTyping(): void {
  const now = Date.now();
  for (const [topicId, until] of typingUntil) {
    if (now >= until || (topicSessions.get(topicId)?.size ?? 0) === 0) {
      typingUntil.delete(topicId);
      continue;
    }
    emitTyping(topicId);
  }
  if (typingUntil.size === 0 && typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
}

function startTyping(topicId: number): void {
  const fresh = !typingUntil.has(topicId);
  typingUntil.set(topicId, Date.now() + TYPING_MAX_MS);
  if (fresh) emitTyping(topicId); // show immediately, don't wait for a refresh tick
  if (!typingTimer) {
    typingTimer = setInterval(pumpTyping, TYPING_REFRESH_MS);
    typingTimer.unref?.();
  }
}

function stopTyping(topicId: number): void {
  typingUntil.delete(topicId);
}

// Topic-name status badge (⏳ working / 🟢 ready / 🔔 needs-you / 📥 queued /
// 💤 no-session) — the only per-topic signal Telegram renders in the topic
// LIST. Opt out with TG_TOPICS_STATUS_ICONS=0.
const STATUS_ICONS = process.env.TG_TOPICS_STATUS_ICONS !== "0";
const topicStatusNow = new Map<number, TopicStatus>();

// Per-project working/idle, fed by the activity hook (UserPromptSubmit +
// PreToolUse -> working, Stop -> idle) and by the leader itself for Telegram
// turns. The channel protocol carries no such signal, so this is the only way
// to tell "Claude is working" from "session idle". A working entry carries a
// TTL re-armed by every PreToolUse heartbeat: if a Stop is ever missed (crash),
// the badge falls back to 🟢 ready rather than a stuck ⏳ that lies.
// Working-state backstop, NOT the primary idle signal. Stop/StopFailure hooks
// return the badge to idle at turn end reliably (verified live), so this only
// catches turns that fire no terminal hook at all — an Esc-interrupt, a hang, a
// hard crash. It must therefore exceed the longest hook-less stretch of a real
// turn (a long final generation after the last tool call fires no PreToolUse
// heartbeat); 2 min tripped mid-turn and flipped a busy topic to 🟢 before its
// reply landed. 15 min never trips on real work; a genuine hang clears within it.
const ACTIVITY_TTL_MS = 900_000;
const activity = new Map<string, { state: "working" | "idle"; until: number }>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function activeWorking(project: string): boolean {
  const a = activity.get(project);
  return !!a && a.state === "working" && Date.now() < a.until;
}

function setActivity(project: string, state: "working" | "idle"): void {
  const t = activityTimers.get(project);
  if (t) {
    clearTimeout(t);
    activityTimers.delete(project);
  }
  if (state === "working") {
    activity.set(project, { state: "working", until: Date.now() + ACTIVITY_TTL_MS });
    // One-shot fallback: if no Stop and no further heartbeat arrives, expire to
    // idle so the badge stops claiming "working".
    const timer = setTimeout(() => {
      activityTimers.delete(project);
      if (activity.get(project)?.state === "working" && !activeWorking(project)) {
        activity.set(project, { state: "idle", until: 0 });
        refreshTopicStatus(project);
      }
    }, ACTIVITY_TTL_MS + 500);
    timer.unref?.();
    activityTimers.set(project, timer);
  } else {
    activity.set(project, { state: "idle", until: 0 });
  }
  refreshTopicStatus(project);
}

// A turn aborted with an API/model error (StopFailure hook, mutually exclusive
// with Stop). The session returns to idle/ready — but a silent 🟢 would HIDE
// the failure, so post an alert (short cooldown against error storms). This is
// the only reliable failure signal: the channel protocol carries none, Stop
// fires only on success, and interrupts/hangs/crashes fire no hook at all.
const FAILURE_NOTICE_COOLDOWN_MS = 20_000;
const lastFailureNotice = new Map<number, number>();
function notifyTurnFailed(project: string): void {
  setActivity(project, "idle"); // the turn is over; the session now awaits a retry
  const topicId = projectTopicId(project);
  if (topicId === undefined) return;
  const now = Date.now();
  if (now - (lastFailureNotice.get(topicId) ?? 0) < FAILURE_NOTICE_COOLDOWN_MS) return;
  lastFailureNotice.set(topicId, now);
  void bot.api
    .sendMessage(
      GROUP_CHAT_ID,
      "⚠️ The last turn ended with an API/model error — the session is idle. Resend the message or retry in the terminal.",
      { message_thread_id: topicId },
    )
    .catch(() => {});
}

// A permission relay pending for any session on this project's topic → 🔔.
function hasPendingPermission(project: string): boolean {
  for (const p of pendingPermissions.values()) {
    if (sessions.get(p.sessionId)?.project === project) return true;
  }
  return false;
}

function topicStatusOf(project: string): TopicStatus {
  const tid = projectTopicId(project);
  const hasSession = tid !== undefined && (topicSessions.get(tid)?.size ?? 0) > 0;
  return computeTopicStatus({
    hasSession,
    working: activeWorking(project),
    queued: (heldInbox.get(project)?.msgs.length ?? 0) > 0,
    attention: hasPendingPermission(project),
  });
}

// editForumTopic is rate-limited, and a working↔ready flip happens every turn.
// Debounce+coalesce per topic so a burst of transitions (or a quick micro-turn)
// costs one edit carrying the LATEST state, never a flood.
const STATUS_DEBOUNCE_MS = 600;
const statusTimers = new Map<number, ReturnType<typeof setTimeout>>();
const statusTarget = new Map<number, TopicStatus>();

function refreshTopicStatus(project: string): void {
  if (!STATUS_ICONS) return;
  const topicId = projectTopicId(project);
  if (topicId === undefined) return;
  const status = topicStatusOf(project);
  statusTarget.set(topicId, status);
  if (topicStatusNow.get(topicId) === status && !statusTimers.has(topicId)) return;
  if (statusTimers.has(topicId)) return; // a debounced edit is pending; it reads the latest target
  const timer = setTimeout(() => {
    statusTimers.delete(topicId);
    const want = statusTarget.get(topicId);
    if (want === undefined || topicStatusNow.get(topicId) === want) return;
    topicStatusNow.set(topicId, want);
    log("badge", { topicId, status: want });
    void bot.api
      .editForumTopic(GROUP_CHAT_ID, topicId, {
        name: withStatusGlyph(topicName(project), want),
      })
      .catch((e) => {
        // TOPIC_NOT_MODIFIED just means the name already carries this glyph — our
        // in-memory cache resets on a leader hand-off, so the first edit per topic
        // can no-op. That is success, not a failure worth logging.
        if (!String(e).includes("TOPIC_NOT_MODIFIED"))
          log("badge.fail", { topicId, error: String(e) });
      });
  }, STATUS_DEBOUNCE_MS);
  timer.unref?.();
  statusTimers.set(topicId, timer);
}

// Recent inbound (user-sent) message ids per topic, so /react can acknowledge
// the user's own messages — the natural "seen 👍" gesture. Bounded ring.
const INBOUND_TRACK_MAX = 500;
const inboundTopic = new Map<number, number>(); // messageId -> topicId
function trackInbound(messageId: number, topicId: number): void {
  inboundTopic.set(messageId, topicId);
  if (inboundTopic.size > INBOUND_TRACK_MAX) {
    const oldest = inboundTopic.keys().next().value;
    if (oldest !== undefined) inboundTopic.delete(oldest);
  }
}

// --- Telegram bot ---

// Constructed lazily by the leader only (grammy throws on an empty token, and
// followers never touch Telegram directly).
let bot!: Bot;
let botRunning = false;

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Telegram bot download limit
const DOWNLOAD_TIMEOUT_MS = 15_000;

function inGroup(chatId: unknown): boolean {
  return String(chatId) === String(GROUP_CHAT_ID);
}

async function downloadFile(fileId: string, filename: string): Promise<string | null> {
  // Bounded: an unbounded fetch here blocks the single poller for ALL topics,
  // since grammy awaits each update's middleware sequentially.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const f = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`;
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) return null;
    if (Number(resp.headers.get("content-length") ?? "0") > MAX_DOWNLOAD_BYTES) {
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // Unicode-aware: \w would collapse any non-ASCII (e.g. Cyrillic) name to "_".
    const safe = filename.replace(/[^\p{L}\p{N}.\-]+/gu, "_");
    const path = join(INBOX_DIR, `${fileId}_${safe}`);
    writeFileSync(path, buf);
    return path;
  } catch {
    return null; // includes AbortError on timeout
  } finally {
    clearTimeout(timer);
  }
}

// Uptime for /status; reset each time this process wins the port.
let leaderSince = Date.now();

function statusText(): string {
  const up = Math.round((Date.now() - leaderSince) / 60_000);
  const lines = [
    `🤖 telegram-topics v${VERSION} — leader pid ${process.pid}, up ${up} min`,
    `sessions: ${sessions.size}`,
  ];
  const projects = knownProjects();
  if (projects.length === 0) {
    lines.push("(no bridged projects yet)");
    return lines.join("\n");
  }
  // Every bridged project with its status, so the overview answers "which
  // projects is Claude working on, which are idle, which are off".
  for (const project of projects) {
    const tid = projectTopicId(project);
    const status = topicStatusOf(project);
    const live = tid !== undefined ? topicSessions.get(tid)?.size ?? 0 : 0;
    const queued = heldInbox.get(project)?.msgs.length ?? 0;
    let detail: string;
    if (status === "queued") {
      detail = `${queued} queued, no session`;
    } else if (live > 0) {
      const labels = [...(topicSessions.get(tid!) ?? [])]
        .map((sid) => sessions.get(sid)?.label ?? sid)
        .join(", ");
      detail = `${live} session(s)${labels ? ": " + labels : ""}`;
    } else {
      detail = "no session";
    }
    lines.push(`${statusGlyph(status)} ${topicName(project)} — ${detail}`);
  }
  lines.push("");
  lines.push("⏳ working · 🟢 ready · 🔔 needs you · 📥 queued · 💤 no session");
  return lines.join("\n");
}

function startKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const seen = new Set<number>();
  for (const project of knownProjects()) {
    const tid = projectTopicId(project);
    if (tid === undefined || seen.has(tid)) continue;
    seen.add(tid);
    const live = topicSessions.get(tid)?.size ?? 0;
    rows.push([
      {
        text: live > 0 ? `${topicName(project)} (${live} live)` : topicName(project),
        callback_data: startCallbackData(tid),
      },
    ]);
    if (rows.length >= 20) break;
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// The leader answers /status and /start itself — they must work precisely when
// no session is alive to answer. Both work from any topic AND from the General
// topic (which carries no thread id and is otherwise ignored).
// Launch a brand-new project (not yet in topics.json) by path — the /start
// <path> form. Gated by isPathAllowed (default-deny; opt in with
// TG_TOPICS_LAUNCH_ROOTS) because launching an arbitrary directory from a chat
// message is remote code-exec.
async function startByPath(
  rawPath: string,
  thread: { message_thread_id?: number },
): Promise<void> {
  const say = (text: string): Promise<unknown> =>
    bot.api.sendMessage(GROUP_CHAT_ID, text, thread).catch(() => {});
  if (!isPathAllowed(rawPath)) {
    log("session.startpath.deny", { path: rawPath, roots: launchRoots().length });
    await say(
      launchRoots().length
        ? `⛔ "${truncate(rawPath, 120)}" is outside the allowed launch roots.`
        : "⛔ Launch-by-path is disabled. Set TG_TOPICS_LAUNCH_ROOTS on the machine to the trusted root(s) to enable it.",
    );
    return;
  }
  let isDir = false;
  try {
    isDir = existsSync(rawPath) && statSync(rawPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    await say(`⛔ Not an existing directory: ${truncate(rawPath, 120)}`);
    return;
  }
  const key = normalizePath(rawPath);
  const name = projectNameFromPath(rawPath);
  let topicId: number;
  try {
    topicId = await resolveTopic(bot.api, key, name);
  } catch (e) {
    await say(`⚠️ Could not create a topic: ${truncate(String(e), 150)}`);
    return;
  }
  const live = topicSessions.get(topicId)?.size ?? 0;
  if (live > 0) {
    await say(`"${name}" already has ${live} live session(s).`);
    return;
  }
  const err = spawnSession(rawPath, name);
  log("session.startpath", { path: rawPath, key, topicId, error: err ?? "" });
  await say(
    err ? `⚠️ ${truncate(err, 180)}` : `🚀 Launching "${name}" — it registers within ~30 s.`,
  );
}

async function handleCommand(text: string, topicId: number | undefined): Promise<boolean> {
  const sp = text.search(/\s/);
  const head = (sp === -1 ? text : text.slice(0, sp)).split("@")[0]!.trim();
  const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
  const thread = topicId === undefined ? {} : { message_thread_id: topicId };
  if (head === "/status") {
    await bot.api.sendMessage(GROUP_CHAT_ID, statusText(), thread).catch(() => {});
    return true;
  }
  if (head === "/start") {
    // `/start <path>` launches a new project; bare `/start` shows the picker of
    // projects already bridged.
    if (arg) {
      await startByPath(arg, thread);
      return true;
    }
    const kb = startKeyboard();
    await bot.api
      .sendMessage(
        GROUP_CHAT_ID,
        kb
          ? "Pick a project to launch a Claude Code session for (or send `/start <path>` for a new one):"
          : "No known projects yet — send `/start <path>` (a directory under TG_TOPICS_LAUNCH_ROOTS) to launch one.",
        { ...thread, reply_markup: kb },
      )
      .catch(() => {});
    return true;
  }
  return false;
}

function initBot(): void {
  bot = new Bot(BOT_TOKEN);
  // Flood control (429 + retry_after) and transient 5xx/network failures are
  // retried inside the API layer — see tgretry.ts.
  bot.api.config.use(apiRetry());
  botRunning = true;

  bot.on("message", async (ctx) => {
    const m = ctx.message;
    if (!inGroup(m.chat.id)) return;
    if (m.from?.is_bot) return;
    if (!isAllowedUser(m.from?.id)) return;
    const topicId = m.message_thread_id;
    // Leader-answered commands work everywhere, including the General topic.
    // `/status` is intercepted only bare ("/status of the deploy" falls through
    // to normal delivery); `/start` is intercepted bare OR with a path arg.
    const t = m.text?.trim();
    if (t && (/^\/status(@\w+)?$/.test(t) || /^\/start(@\w+)?(\s+\S.*)?$/.test(t))) {
      if (await handleCommand(t, topicId)) return;
    }
    if (topicId === undefined) return; // General topic / non-topic messages ignored
    trackInbound(m.message_id, topicId);

    const from = m.from?.username ?? String(m.from?.id ?? "user");
    let text = m.text ?? m.caption ?? "";

    if (m.document) {
      const p = await downloadFile(m.document.file_id, m.document.file_name ?? "file");
      text = `[file: ${m.document.file_name ?? "file"}]${text ? " " + text : ""}`;
      if (p) text += ` saved:${p}`;
    } else if (m.photo?.length) {
      const largest = m.photo[m.photo.length - 1]!;
      const p = await downloadFile(largest.file_id, "photo.jpg");
      text = `[photo]${text ? ": " + text : ""}`;
      if (p) text += ` saved:${p}`;
    } else if (!text) {
      text = "[non-text message]";
    }

    const inbound: Inbound = {
      type: "message",
      from,
      text,
      messageId: m.message_id,
      ts: Date.now(),
    };
    // A reply to a specific session's message routes only to that session; a
    // fresh (non-reply) message still fans to every session on the topic.
    const owner = m.reply_to_message
      ? ownerSession(m.reply_to_message.message_id)
      : undefined;
    log("inbound.message", { mid: m.message_id, topic: topicId, owner: owner ?? "fan" });
    if (owner) deliverToSession(owner, inbound);
    else deliver(topicId, inbound);
    // Acknowledge routed delivery; the no-session case posts its own notice.
    if (owner || (topicSessions.get(topicId)?.size ?? 0) > 0) {
      startTyping(topicId);
      // A Telegram-driven turn is now working — set it here rather than relying
      // on the activity hook, which may not fire for channel-injected prompts
      // (the Stop hook still returns it to ready). No-op if the topic is unmapped.
      const proj = projectForTopic(topicId);
      if (proj) {
        spokeThisTurn.delete(proj); // new turn — the session hasn't spoken yet
        lastMirrored.delete(proj);
        setActivity(proj, "working");
        checkHookless(proj, topicId); // warn if this session has no auto-mirror
      }
    }
  });

  bot.on("callback_query", async (ctx) => {
    const cb = ctx.callbackQuery;
    const msg = cb.message;
    const parsed = parseCallback(cb.data ?? "");

    // Permission-relay buttons are handled entirely here — never delivered as a
    // normal button choice.
    if (parsed.kind === "permission") {
      await handlePermissionCallback(
        ctx,
        parsed.behavior,
        parsed.sessionId,
        parsed.requestId,
      );
      return;
    }

    // "Start a session" buttons (the /start picker and no-session notices) are
    // leader-handled: there may be no session to deliver to by definition.
    if (parsed.kind === "start") {
      if (!msg || !inGroup(msg.chat.id) || !isAllowedUser(cb.from?.id)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
        return;
      }
      const project = projectForTopic(parsed.topicId);
      if (!project) {
        await ctx.answerCallbackQuery({ text: "Unknown project." }).catch(() => {});
        return;
      }
      const live = topicSessions.get(parsed.topicId)?.size ?? 0;
      if (live > 0) {
        await ctx
          .answerCallbackQuery({ text: `Already running (${live} session(s) live).` })
          .catch(() => {});
        return;
      }
      // A known project (already bridged) — resume its most recent conversation.
      const err = spawnSession(project, topicName(project), true);
      log("session.start.tap", { project, error: err ?? "" });
      await ctx
        .answerCallbackQuery({
          text: err ? `⚠️ ${truncate(err, 180)}` : "🚀 Launching — it registers within ~30 s.",
        })
        .catch(() => {});
      return;
    }

    if (!msg || !inGroup(msg.chat.id)) {
      await ctx.answerCallbackQuery().catch(() => {});
      log("callback.drop", { reason: "chat" });
      return;
    }
    if (!isAllowedUser(cb.from?.id)) {
      await ctx.answerCallbackQuery().catch(() => {});
      log("callback.drop", { reason: "user", from: String(cb.from?.id ?? "") });
      return;
    }
    if (msg.message_thread_id === undefined) {
      await ctx.answerCallbackQuery().catch(() => {});
      log("callback.drop", { reason: "no-thread", mid: msg.message_id });
      return;
    }
    // A choice button's callback_data is the option index; map it back to the
    // label we sent so the session sees the human-readable choice.
    let data: string;
    if (parsed.kind === "choice") {
      // takeOptions consumes the labels, so the keyboard stays consumed even
      // across a later leader hand-off.
      const opts = takeOptions(msg.message_id);
      data = opts?.[parsed.index] ?? String(parsed.index);
      // A tap must be visibly acknowledged: toast the choice, stamp it into the
      // message, and drop the keyboard so the buttons read as consumed. Passing
      // the original entities keeps the message's formatting intact.
      await ctx
        .answerCallbackQuery({ text: truncate(`✅ ${data}`, 200) })
        .catch(() => {});
      if ("text" in msg && msg.text) {
        await ctx
          .editMessageText(`${msg.text}\n\n➡️ ${data}`, { entities: msg.entities })
          .catch(() => ctx.editMessageReplyMarkup(undefined).catch(() => {}));
      } else {
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      }
    } else {
      data = parsed.data;
      await ctx.answerCallbackQuery().catch(() => {});
    }
    const inbound: Inbound = {
      type: "callback",
      from: cb.from?.username ?? String(cb.from?.id ?? "user"),
      data,
      messageId: msg.message_id,
      ts: Date.now(),
    };
    // Route the tap to the session that posted the buttons; else fan to topic.
    const owner = ownerSession(msg.message_id);
    log("inbound.callback", { mid: msg.message_id, data, owner: owner ?? "fan" });
    if (owner) deliverToSession(owner, inbound);
    else deliver(msg.message_thread_id, inbound);
  });

  bot.on("message_reaction", (ctx) => {
    const r = ctx.messageReaction;
    if (!inGroup(r.chat.id)) return;
    if (!isAllowedUser(r.user?.id)) return;
    const topicId = topicForSentMessage(r.message_id);
    if (topicId === undefined) return;
    const emoji = r.new_reaction.find((x) => x.type === "emoji")?.emoji ?? "";
    if (!emoji) return;
    const inbound: Inbound = {
      type: "reaction",
      from: r.user?.username ?? String(r.user?.id ?? "user"),
      emoji,
      messageId: r.message_id,
      ts: Date.now(),
    };
    // Route to the session that sent the reacted message; else fan to topic.
    const owner = ownerSession(r.message_id);
    log("inbound.reaction", { mid: r.message_id, owner: owner ?? "fan" });
    if (owner) deliverToSession(owner, inbound);
    else deliver(topicId, inbound);
  });
}

// Bot-sent message bookkeeping (topic for reaction routing, owning session for
// reply/tap routing, button labels) lives in sent.ts — one record per message,
// persisted so it survives leader hand-offs.

// The live session that owns a message, if it still exists. After a hand-off
// the persisted owner id is stale until that client re-registers (with prev,
// which remaps ownership) — the sessions.has() guard degrades to topic fan-out
// in that window instead of routing into a dead queue.
function ownerSession(messageId: number): string | undefined {
  const sid = sessionForSentMessage(messageId);
  return sid && sessions.has(sid) ? sid : undefined;
}

// --- Permission relay (opt-in `claude/channel/permission`) ---
//
// Claude Code sends notifications/claude/channel/permission_request to the
// requesting session's MCP server when a tool call needs approval; that server
// calls /permissionAsk here. We post Allow/Deny buttons into the session's
// topic and, on tap, hand the decision back to that same session — which emits
// notifications/claude/channel/permission to Claude Code. Keyed by
// sessionId:requestId so a request id can't collide across concurrent projects.
type PendingPermission = {
  sessionId: string;
  requestId: string;
  messageId: number; // the Telegram message carrying the buttons
  toolName: string;
  description: string;
  inputPreview: string;
  createdAt: number;
};
const pendingPermissions = new Map<string, PendingPermission>();
const permKey = (sessionId: string, requestId: string): string =>
  `${sessionId}:${requestId}`;

// The posted buttons embed the ASK-TIME session id; if the session
// re-registered meanwhile (any poll hiccup), the exact key misses. Fall back
// to the tapped message's id — unique per prompt — NOT a bare requestId scan,
// which could match a same-id request in a different project's topic and
// approve the wrong tool call.
function findPendingPermission(
  sessionId: string,
  requestId: string,
  messageId: number,
): { key: string; pending: PendingPermission } | undefined {
  const exact = permKey(sessionId, requestId);
  const hit = pendingPermissions.get(exact);
  if (hit) return { key: exact, pending: hit };
  for (const [key, pending] of pendingPermissions) {
    if (pending.messageId === messageId) return { key, pending };
  }
  return undefined;
}

async function handlePermissionCallback(
  ctx: Context,
  behavior: "allow" | "deny" | "more",
  sessionId: string,
  requestId: string,
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg || !inGroup(msg.chat.id) || !isAllowedUser(ctx.from?.id)) {
    await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    return;
  }
  const found = findPendingPermission(sessionId, requestId, msg.message_id);
  if (!found) {
    await ctx
      .answerCallbackQuery({ text: "Request no longer available." })
      .catch(() => {});
    return;
  }
  const { key, pending } = found;
  // Route by the entry's CURRENT owner (prev-migration keeps it live), not the
  // stale sid baked into the tapped button.
  const owner = pending.sessionId;

  if (behavior === "more") {
    let prettyInput: string;
    try {
      prettyInput = JSON.stringify(JSON.parse(pending.inputPreview), null, 2);
    } catch {
      prettyInput = pending.inputPreview;
    }
    const expanded =
      `🔐 Permission: ${pending.toolName}\n\n` +
      `tool: ${pending.toolName}\n` +
      `description: ${pending.description}\n` +
      `input:\n${prettyInput}`;
    await ctx
      .editMessageText(truncate(expanded, 3500), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Allow", callback_data: permCallbackData("allow", owner, pending.requestId) },
              { text: "❌ Deny", callback_data: permCallbackData("deny", owner, pending.requestId) },
            ],
          ],
        },
      })
      .catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  // allow / deny → delete first so a double-tap can't fire twice, then hand the
  // decision to the owning session — its CURRENT id (prev-migration keeps the
  // pending entry pointed at the live session), not the ask-time id baked into
  // the button.
  pendingPermissions.delete(key);
  // The prompt is answered — drop 🔔 (back to ⏳/🟢 per the session's activity).
  const ownerProj = sessions.get(owner)?.project;
  if (ownerProj) refreshTopicStatus(ownerProj);
  if (!sessions.has(owner)) {
    // Never confirm a decision that went nowhere: the old code answered
    // "✅ Allowed" while deliverToSession dropped it and the terminal prompt
    // sat unanswered — a silent false success.
    log("permission.orphan", { sid: owner, behavior, requestId: pending.requestId });
    await ctx
      .answerCallbackQuery({ text: "⚠️ Session is gone — answer the prompt in the terminal." })
      .catch(() => {});
    if ("text" in msg && msg.text) {
      await ctx
        .editMessageText(`${msg.text}\n\n⚠️ Session gone — not delivered`)
        .catch(() => {});
    }
    return;
  }
  log("permission.decision", { sid: owner, behavior, requestId: pending.requestId });
  deliverToSession(owner, {
    type: "permission",
    requestId: pending.requestId,
    behavior,
    messageId: msg.message_id,
    ts: Date.now(),
  });
  const label = behavior === "allow" ? "✅ Allowed" : "❌ Denied";
  await ctx.answerCallbackQuery({ text: label }).catch(() => {});
  if ("text" in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {});
  }
}

// --- Sending with topic-recovery ---

function isThreadGone(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    e.error_code === 400 &&
    /thread not found/i.test(e.description)
  );
}

async function withRecovery<T>(
  s: Session,
  send: (topicId: number) => Promise<T>,
): Promise<T> {
  try {
    return await send(s.topicId);
  } catch (e) {
    if (!isThreadGone(e)) throw e;
    const old = s.topicId;
    const fresh = await recreateTopic(bot.api, s.project);
    // Migrate every session bound to the dead topic onto the fresh one.
    const set = topicSessions.get(old);
    if (set) {
      for (const sid of set) {
        const other = sessions.get(sid);
        if (other) other.topicId = fresh;
        bindTopic(sid, fresh);
      }
      topicSessions.delete(old);
    } else {
      // This session may have already been migrated by a concurrent recovery;
      // make sure it points at (and is bound to) the fresh topic regardless.
      s.topicId = fresh;
      bindTopic(s.id, fresh);
    }
    return await send(fresh);
  }
}

// A session that sent its own outbound this turn (a send_message with buttons, a
// file, an edit) has "spoken" — the Stop auto-mirror then skips, so an
// interactive turn is not double-posted. Reset at each turn start: the
// UserPromptSubmit "start" ping for a console turn, inbound routing for a
// Telegram turn. Keyed by project (the mirror arrives keyed the same way).
const spokeThisTurn = new Set<string>();

// Above this many chunks the mirror stops push-flooding the topic: it sends one
// preview message and attaches the full answer as a .md file (one notification).
const MIRROR_MAX_CHUNKS = 4;
// Last text mirrored per project, so a re-fired Stop (stop_hook_active) does not
// double-post identical text. Cleared at each turn start.
const lastMirrored = new Map<string, string>();
// Cooldown for the "mirror incomplete" notice, so a persistent outage does not
// itself flood the topic.
const lastMirrorNotice = new Map<number, number>();

// Projects whose session has ever reported an activity ping or a mirror POST —
// i.e. its plugin is new enough to carry the working/idle + auto-mirror hooks.
// A long-running session started before those hooks existed never appears here,
// so with manual duplication turned off its answers would silently never reach
// the topic. We detect that and warn (once, per topic) instead of losing them.
const hookedProjects = new Set<string>();
const HOOKLESS_GRACE_MS = 60_000; // a real hook fires well within this
const HOOKLESS_WARN_COOLDOWN_MS = 60 * 60_000;
const hooklessTimers = new Map<string, ReturnType<typeof setTimeout>>();
const hooklessWarned = new Map<number, number>();

// Any hook POST (activity or mirror) proves the session carries the hooks.
function markHooked(project: string): void {
  hookedProjects.add(project);
  const t = hooklessTimers.get(project);
  if (t) {
    clearTimeout(t);
    hooklessTimers.delete(project);
  }
}

// A Telegram turn was routed to a live session on this project. If no hook POST
// arrives within a grace window, its plugin predates auto-mirror — the answer
// will never appear in the topic, so warn the user to restart the session.
// (Only Telegram-driven turns are observable to the leader; a console-driven
// hookless turn is invisible here — restarting the session is the real fix.)
function checkHookless(project: string, topicId: number): void {
  if (hookedProjects.has(project) || hooklessTimers.has(project)) return;
  const timer = setTimeout(() => {
    hooklessTimers.delete(project);
    if (hookedProjects.has(project)) return;
    const now = Date.now();
    if (now - (hooklessWarned.get(topicId) ?? 0) < HOOKLESS_WARN_COOLDOWN_MS) return;
    hooklessWarned.set(topicId, now);
    void bot.api
      .sendMessage(
        GROUP_CHAT_ID,
        "⚠️ This session is running a plugin version without auto-mirror — Claude's answers are NOT mirrored to this topic. Restart the project in a new session to enable auto-mirror.",
        { message_thread_id: topicId },
      )
      .catch(() => {});
  }, HOOKLESS_GRACE_MS);
  timer.unref?.();
  hooklessTimers.set(project, timer);
}

// Recreate a deleted/closed topic for a project (the mirror path has no Session
// to hand to withRecovery), migrating every session bound to the dead topic.
async function recoverMirrorTopic(project: string, old: number): Promise<number> {
  const fresh = await recreateTopic(bot.api, project);
  const set = topicSessions.get(old);
  if (set) {
    for (const sid of set) {
      const other = sessions.get(sid);
      if (other) other.topicId = fresh;
      bindTopic(sid, fresh);
    }
    topicSessions.delete(old);
  }
  return fresh;
}

function notifyMirrorGap(topicId: number, sent: number, total: number): void {
  const now = Date.now();
  if (now - (lastMirrorNotice.get(topicId) ?? 0) < FAILURE_NOTICE_COOLDOWN_MS) return;
  lastMirrorNotice.set(topicId, now);
  void bot.api
    .sendMessage(
      GROUP_CHAT_ID,
      `⚠️ Answer only partially mirrored (${sent}/${total} parts) — the full text is in the console.`,
      { message_thread_id: topicId },
    )
    .catch(() => {});
}

// Auto-mirror: post a session's final answer to its topic verbatim — the Stop
// hook (mirror.ts) extracts the transcript's last assistant message and sends it
// here. No session-label prefix: this is the console text 1:1. Because manual
// duplication is OFF, this is the ONLY phone copy, so a failure must be VISIBLE
// (a cooldown-guarded ⚠️ notice), the tail must not be dropped on a mid-stream
// error, and a deleted topic is recovered like sendText's withRecovery.
async function mirrorToTopic(project: string, text: string): Promise<void> {
  let topicId = projectTopicId(project);
  if (topicId === undefined) return;
  // Idempotent against a re-fired Stop delivering byte-identical text.
  if (lastMirrored.get(project) === text) return;
  lastMirrored.set(project, text);
  stopTyping(topicId); // the reply is arriving — drop the "typing" keepalive

  const formatted = mdToTelegram(text);
  const chunks = splitTelegram(formatted.text, formatted.entities).filter((c) => c.text.trim());
  if (chunks.length === 0) return;

  const io: MirrorIO = {
    send: (t, entities, notify) =>
      bot.api
        .sendMessage(GROUP_CHAT_ID, t, {
          message_thread_id: topicId,
          entities,
          disable_notification: !notify,
        })
        .then(() => {}),
    attach: (full, n) =>
      bot.api
        .sendDocument(GROUP_CHAT_ID, new InputFile(new TextEncoder().encode(full), "answer.md"), {
          message_thread_id: topicId,
          caption: `… full answer attached (${n} parts)`,
          disable_notification: true,
        })
        .then(() => {}),
    recover: async () => {
      topicId = await recoverMirrorTopic(project, topicId!);
    },
    classify: (e) =>
      isThreadGone(e)
        ? "thread-gone"
        : e instanceof GrammyError && e.error_code === 400
          ? "retry-plain"
          : "fatal",
    onFail: (e) => log("mirror.fail", { project, error: String(e) }),
    notifyGap: (sent, total) => {
      if (topicId !== undefined) notifyMirrorGap(topicId, sent, total);
    },
  };
  await mirrorChunks(chunks, text, MIRROR_MAX_CHUNKS, io);
}

async function sendText(s: Session, text: string, options?: string[]): Promise<number> {
  stopTyping(s.topicId); // the reply is arriving — drop the "typing" keepalive
  const outText =
    sessionPrefix(s.label, topicSessions.get(s.topicId)?.size ?? 1) + text;
  // Markdown is converted to explicit entities (never parse_mode): intra-word
  // underscores stay literal (`aaa_bbb_ccc` no longer renders "aaabbbccc" with
  // an italic middle) and malformed markup degrades to plain text instead of a
  // Telegram 400. Oversized messages are split at line boundaries — Telegram
  // rejects >4096 outright.
  const formatted = mdToTelegram(outText);
  const chunks = splitTelegram(formatted.text, formatted.entities);
  const ids: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const last = i === chunks.length - 1;
    const reply_markup =
      last && options?.length
        ? { inline_keyboard: options.map((o, j) => [{ text: o, callback_data: String(j) }]) }
        : undefined;
    const msgId = await withRecovery(s, async (topicId) => {
      try {
        const sent = await bot.api.sendMessage(GROUP_CHAT_ID, chunk.text, {
          message_thread_id: topicId,
          entities: chunk.entities,
          reply_markup,
        });
        return sent.message_id;
      } catch (e) {
        // Entities Telegram rejects (defensive) — deliver unformatted.
        if (e instanceof GrammyError && e.error_code === 400 && chunk.entities) {
          const sent = await bot.api.sendMessage(GROUP_CHAT_ID, chunk.text, {
            message_thread_id: topicId,
            reply_markup,
          });
          return sent.message_id;
        }
        throw e;
      }
    });
    trackSent(msgId, {
      topicId: s.topicId,
      sessionId: s.id,
      options: last && options?.length ? options : undefined,
    });
    ids.push(msgId);
  }
  return ids[ids.length - 1]!;
}

const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

async function sendFile(s: Session, path: string, caption: string): Promise<number> {
  stopTyping(s.topicId);
  const isPhoto = PHOTO_EXT.has(path.slice(path.lastIndexOf(".")).toLowerCase());
  const cap =
    sessionPrefix(s.label, topicSessions.get(s.topicId)?.size ?? 1) + caption;
  const msgId = await withRecovery(s, async (topicId) => {
    const opts = { message_thread_id: topicId, caption: cap || undefined };
    const sent = isPhoto
      ? await bot.api.sendPhoto(GROUP_CHAT_ID, new InputFile(path), opts)
      : await bot.api.sendDocument(GROUP_CHAT_ID, new InputFile(path), opts);
    return sent.message_id;
  });
  trackSent(msgId, { topicId: s.topicId, sessionId: s.id });
  return msgId;
}

// --- Control API (loopback only) ---

function json(data: unknown, status = 200): Response {
  // Closes the connection per response — see CONTROL_RESPONSE_HEADERS for why
  // a pooled keep-alive socket must never survive a served request here.
  return new Response(JSON.stringify(data), {
    status,
    headers: CONTROL_RESPONSE_HEADERS,
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return json({ ok: true, sessions: sessions.size, version: VERSION, pid: process.pid });
  }

  // Activity ping from the session's UserPromptSubmit/PreToolUse/Stop hooks —
  // the ONLY way the leader learns a console-driven turn is working vs idle
  // (the channel protocol carries no such signal). Keyed by project string with
  // no sessionId, so it MUST sit above the sid guard, alongside /health and
  // /register. Loopback-only and unauthenticated, exactly like the rest.
  if (path === "/activity" && req.method === "POST") {
    const { project, state } = (await req.json().catch(() => ({}))) as {
      project?: string;
      state?: string;
    };
    log("activity", { project: project ?? "", state: state ?? "" });
    if (project) {
      markHooked(project); // this session carries the hooks
      if (state === "failed") notifyTurnFailed(project);
      else if (state === "start") {
        // Turn boundary (UserPromptSubmit) — the session hasn't spoken yet, and
        // a fresh answer may legitimately repeat the previous one.
        spokeThisTurn.delete(project);
        lastMirrored.delete(project);
        setActivity(project, "working");
      } else setActivity(project, state === "idle" ? "idle" : "working");
    }
    return json({ ok: true });
  }

  // Auto-mirror the turn's final answer, sent by the Stop hook (mirror.ts) with
  // the transcript's last assistant message. Skipped when the session already
  // spoke this turn (buttons/file/edit) so interactive turns aren't doubled.
  // Keyed by project, no sessionId — sits above the sid guard like /activity.
  if (path === "/mirror" && req.method === "POST") {
    const { project, text } = (await req.json().catch(() => ({}))) as {
      project?: string;
      text?: string;
    };
    if (project) markHooked(project); // a mirror POST proves the hook is present
    const skipped = !project || !text || !text.trim() || spokeThisTurn.has(project);
    log("mirror", { project: project ?? "", chars: (text ?? "").length, skipped });
    if (!skipped) void mirrorToTopic(project!, text!);
    return json({ ok: true });
  }

  if (path === "/register" && req.method === "POST") {
    const { project, name, label, prev, version } = (await req.json()) as {
      project: string;
      name: string;
      label?: string;
      prev?: string;
      version?: string;
    };
    // Version handshake: a session running newer code must lead, or every
    // plugin update silently keeps the old leader's bugs alive until the user
    // hunts down and kills the process. Step down and tell the caller to take
    // over — checked before any registration so no state is built on a leader
    // that is about to die.
    if (isNewerVersion(String(version ?? ""), VERSION)) {
      scheduleStepDown(String(version));
      return json({ handoff: true, version: VERSION });
    }
    let topicId: number;
    try {
      topicId = await resolveTopic(bot.api, project, name);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
    const id = randomUUID().slice(0, 8);
    const fresh: Session = {
      id,
      project,
      topicId,
      // A branch name (from the follower) or a short id slice — used only to tag
      // outbound messages when the topic has more than one session.
      label: (label ?? "").trim() || id.slice(0, 4),
      queue: [],
      waiter: null,
      waiterTimer: null,
      lastActive: Date.now(),
    };
    sessions.set(id, fresh);
    bindTopic(id, topicId);
    // The same client re-registering (it saw its previous poll fail): move the
    // old session's undrained queue and message ownership onto the new id, so
    // replies and button taps on already-sent messages keep routing here
    // instead of rotting in a queue nobody polls.
    if (prev && prev !== id) {
      const old = sessions.get(prev);
      if (old) {
        fresh.queue.push(...old.queue);
        unbindTopic(prev, old.topicId);
        sessions.delete(prev);
      }
      remapSentSessions(prev, id);
      // Pending permission prompts follow the re-registered session too — the
      // posted buttons carry the old sid, but the entry now names the live one
      // (findPendingPermission bridges the old callback_data to it).
      for (const [key, pending] of [...pendingPermissions]) {
        if (pending.sessionId === prev) {
          pendingPermissions.delete(key);
          pending.sessionId = id;
          pendingPermissions.set(permKey(id, pending.requestId), pending);
        }
      }
    }
    // Messages that arrived while this project had no session at all.
    const held = heldInbox.get(project);
    if (held) {
      heldInbox.delete(project);
      fresh.queue.push(...held.msgs);
      log("held.drained", { sid: id, project, count: held.msgs.length });
      // The new session is about to process the drained queue — show ⏳ (the
      // Stop hook / TTL returns it to 🟢). Covers the case where the activity
      // hook may not fire for queued channel messages.
      if (held.msgs.length > 0) setActivity(project, "working");
    }
    // A registration keyed to the config dir is almost always the process.cwd()
    // fallback (identity race), not a real project — the client self-heals by
    // re-registering once its identity resolves, but the tell belongs in the log.
    if (project === normalizePath(CONFIG_DIR)) {
      log("register.configdir", { sid: id });
      process.stderr.write(
        "telegram-topics leader: session registered as the config dir — likely a fallback identity; it should re-register itself shortly\n",
      );
    }
    log("register", { sid: id, project, prev: prev ?? "", sessions: sessions.size });
    refreshTopicStatus(project); // 🟢 live now
    return json({ sessionId: id, topicId });
  }

  const body =
    req.method === "POST"
      ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      : {};
  const sid = (body.sessionId as string) ?? url.searchParams.get("sessionId") ?? "";
  const s = sessions.get(sid);
  if (!s) return json({ error: "unknown session" }, 404);
  s.lastActive = Date.now();
  // Refresh the session label if the caller carried one (reflects a mid-session
  // /rename); a no-op on requests that don't send it.
  if (typeof body.label === "string" && body.label.trim()) s.label = body.label.trim();

  try {
    if (path === "/send") {
      spokeThisTurn.add(s.project); // the session spoke — the auto-mirror stands down
      const id = await sendText(s, String(body.text ?? ""), body.options as string[] | undefined);
      return json({ messageId: id });
    }
    if (path === "/sendFile") {
      spokeThisTurn.add(s.project);
      const filePath = String(body.path);
      // Never upload channel state (the .env holds the token) even if asked —
      // the client-side guard alone would not protect a rogue local caller.
      assertSendable(filePath);
      const id = await sendFile(s, filePath, String(body.caption ?? ""));
      return json({ messageId: id });
    }
    if (path === "/react") {
      // Reactable: a message we sent into this topic, or a recent inbound
      // (user) message here — the natural "seen 👍" acknowledgement.
      const messageId = Number(body.messageId);
      const topic = topicForSentMessage(messageId) ?? inboundTopic.get(messageId);
      if (topic !== s.topicId) {
        return json(
          { error: "can only react to a recent message in this session's topic" },
          403,
        );
      }
      await bot.api.setMessageReaction(GROUP_CHAT_ID, messageId, [
        { type: "emoji", emoji: String(body.emoji) as never },
      ]);
      return json({ ok: true });
    }
    if (path === "/edit") {
      spokeThisTurn.add(s.project); // managing its own Telegram message — mirror stands down
      const messageId = Number(body.messageId);
      if (topicForSentMessage(messageId) !== s.topicId) {
        return json({ error: "message not in this session's topic" }, 403);
      }
      // Same formatting pipeline as /send. An edit is a single message, so
      // text over the 4096 limit is truncated to the first chunk (the rest
      // would need new messages, defeating "edit in place"); the split keeps
      // entity offsets valid at the cut. Telegram drops an existing inline
      // keyboard on editMessageText unless re-sent — re-attach unconsumed
      // options so editing a pending question keeps its buttons.
      const formatted = mdToTelegram(String(body.text));
      const [head] = splitTelegram(formatted.text, formatted.entities);
      const opts = peekOptions(messageId);
      const reply_markup = opts?.length
        ? { inline_keyboard: opts.map((o, i) => [{ text: o, callback_data: String(i) }]) }
        : undefined;
      try {
        await bot.api.editMessageText(GROUP_CHAT_ID, messageId, head!.text, {
          entities: head!.entities,
          reply_markup,
        });
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 400 && /not modified/i.test(e.description)) {
          // Editing to identical content is a no-op, not a failure.
        } else if (e instanceof GrammyError && e.error_code === 400 && head!.entities) {
          // Entities Telegram rejects — retry unformatted.
          await bot.api.editMessageText(GROUP_CHAT_ID, messageId, head!.text, { reply_markup });
        } else {
          throw e;
        }
      }
      return json({ ok: true });
    }
    if (path === "/permissionAsk") {
      const requestId = String(body.requestId ?? "");
      if (!requestId) return json({ error: "requestId required" }, 400);
      const toolName = String(body.toolName ?? "tool");
      const description = String(body.description ?? "");
      const inputPreview = String(body.inputPreview ?? "");
      const preview = inputPreview ? `\n\n${truncate(inputPreview, 350)}` : "";
      // Every relay attempt is logged: "did the permission_request ever reach
      // the leader" was undiagnosable without this during a live incident.
      log("permission.ask", { sid: s.id, tool: toolName, requestId });
      let sentId: number;
      try {
        const sent = await bot.api.sendMessage(
          GROUP_CHAT_ID,
          `🔐 Permission: ${toolName}${preview}`,
          {
            message_thread_id: s.topicId,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔎 See more", callback_data: permCallbackData("more", s.id, requestId) }],
                [
                  { text: "✅ Allow", callback_data: permCallbackData("allow", s.id, requestId) },
                  { text: "❌ Deny", callback_data: permCallbackData("deny", s.id, requestId) },
                ],
              ],
            },
          },
        );
        sentId = sent.message_id;
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
      pendingPermissions.set(permKey(s.id, requestId), {
        sessionId: s.id,
        requestId,
        messageId: sentId,
        toolName,
        description,
        inputPreview,
        createdAt: Date.now(),
      });
      refreshTopicStatus(s.project); // 🔔 blocked on the user

      if (pendingPermissions.size > 200) {
        const cutoff = Date.now() - 3600_000;
        for (const [k, v] of pendingPermissions) {
          if (v.createdAt < cutoff) pendingPermissions.delete(k);
        }
      }
      return json({ ok: true, messageId: sentId });
    }
    if (path === "/poll") {
      // Clamped below the server's idleTimeout — a longer wait would be cut
      // mid-poll by the socket, not resolved by the timer.
      const timeout =
        Math.min(Number(url.searchParams.get("timeout") ?? "25"), POLL_MAX_SEC) * 1000;
      if (s.queue.length === 0) {
        await new Promise<void>((resolve) => {
          s.waiter = resolve;
          // Identity guard: a stale timer from an earlier poll must not resolve
          // a newer poll's waiter (which would orphan the newer one forever).
          s.waiterTimer = setTimeout(() => {
            if (s.waiter === resolve) {
              s.waiter = null;
              s.waiterTimer = null;
              resolve();
            }
          }, timeout);
        });
      }
      const messages = s.queue.splice(0, s.queue.length);
      return json({ messages });
    }
    if (path === "/unregister") {
      const proj = s.project;
      unbindTopic(s.id, s.topicId);
      sessions.delete(s.id);
      log("unregister", { sid: s.id });
      refreshTopicStatus(proj); // 💤 no session (or 📥 if messages are queued)
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "not found" }, 404);
}

let bunServer: { stop: (closeActiveConnections?: boolean) => void } | null = null;
let reaperTimer: ReturnType<typeof setInterval> | null = null;
let steppingDown = false;

/**
 * Graceful step-down for the version hand-off: a newer session announced
 * itself, so this leader retires and lets it take the port. The short delay
 * lets the handoff response flush; the bot stops BEFORE the port is released,
 * or the new leader's first getUpdates would hit a 409 against our still-open
 * poll and immediately relinquish the leadership it just won.
 */
function scheduleStepDown(newerVersion: string): void {
  if (steppingDown) return;
  steppingDown = true;
  log("leader.handoff", { version: VERSION, newer: newerVersion });
  process.stderr.write(
    `telegram-topics leader: newer session v${newerVersion} > v${VERSION}, stepping down\n`,
  );
  setTimeout(async () => {
    if (botRunning) {
      botRunning = false;
      // A wedged getUpdates abort must not hold the port hostage forever —
      // the successor is bind-looping for only ~10s.
      await Promise.race([
        bot.stop().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
    stopLeader();
  }, 250);
}

// After the poller dies (409: another consumer on the token; 401: token
// revoked) an immediate re-election in the same process just re-runs the same
// failure — an endless elect→die cycle burning CPU, disk flushes and API
// quota. The cooldown spaces the attempts; a DIFFERENT healthy process is
// unaffected and can still take the port at once.
let electionCooldownUntil = 0;

function pollerDeathCooldownMs(error: string): number {
  return /\b(409|401)\b/.test(error) ? 60_000 : 10_000;
}

/**
 * Try to become the leader by binding the control port. Returns true if this
 * process is now the leader (bot + API running), false if the port is taken
 * (another leader already exists — caller should act as a follower).
 */
export async function tryBecomeLeader(): Promise<boolean> {
  if (Date.now() < electionCooldownUntil) return false;
  try {
    bunServer = Bun.serve({
      hostname: "127.0.0.1",
      port: CONTROL_PORT,
      fetch: handle,
      // Bun's default idleTimeout is 10s, counted while a response writes no
      // bytes — which is exactly what /poll's long-poll does for up to 30s.
      // Without this every long-poll dies mid-wait with an empty reply; the
      // client reads that as a dead leader and re-registers in an endless
      // loop, orphaning its queue (and every button tap routed to it).
      idleTimeout: LEADER_IDLE_TIMEOUT_SEC,
    });
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || /in use|address already/i.test(String(e))) {
      return false;
    }
    throw e;
  }

  // Synchronous, same tick as winning the port and before the bot starts: no
  // control request or Telegram update can ever observe an empty store, and
  // the previous leader flushed before releasing the port.
  loadSent();

  // We own the port -> own the bot. Do NOT drop pending updates: across a
  // leadership hand-off we still want to deliver messages the user sent while
  // there was briefly no poller. Reactions require the bot to be a group admin.
  initBot();
  bot
    .start({
      allowed_updates: ["message", "callback_query", "message_reaction"],
    })
    .catch((e) => {
      // The long-poll loop terminated (e.g. Telegram 409 Conflict from an
      // overlapping getUpdates during hand-off, or 401 after a token rotation —
      // grammY treats both as fatal). bot.api (outbound) still works, which
      // would mask the failure: followers keep seeing the port bound and never
      // re-elect, so inbound would be dead forever. Relinquish leadership so the
      // next control request re-elects a fresh leader (this process or another).
      botRunning = false;
      const cooldownMs = pollerDeathCooldownMs(String(e));
      electionCooldownUntil = Date.now() + cooldownMs;
      log("poller.died", { error: String(e), cooldownMs });
      process.stderr.write(
        `telegram-topics leader: poller died, relinquishing leadership (re-election cooldown ${cooldownMs}ms): ${e}\n`,
      );
      stopLeader();
    });

  // Idle-session reaper + inbox disk reclaim.
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActive > 3 * 3600 * 1000) {
        const proj = s.project;
        unbindTopic(id, s.topicId);
        sessions.delete(id);
        log("session.reaped", { sid: id });
        refreshTopicStatus(proj);
      }
    }
    for (const [project, held] of heldInbox) {
      if (now - held.at > HELD_TTL_MS) {
        heldInbox.delete(project);
        log("held.expired", { project, count: held.msgs.length });
        refreshTopicStatus(project); // 💤 no session — the queue is gone
        // Tell the user their queued messages timed out — a broken "queued"
        // promise is worse than an honest "please resend".
        const tid = projectTopicId(project);
        if (tid !== undefined) {
          void bot.api
            .sendMessage(
              GROUP_CHAT_ID,
              `⌛ ${held.msgs.length} queued message(s) expired without a session — resend when one is running.`,
              { message_thread_id: tid },
            )
            .catch(() => {});
        }
      }
    }
    try {
      for (const name of readdirSync(INBOX_DIR)) {
        const fp = join(INBOX_DIR, name);
        if (now - statSync(fp).mtimeMs > 24 * 3600 * 1000) unlinkSync(fp);
      }
    } catch {
      // best-effort cleanup
    }
  }, 300_000);

  steppingDown = false;
  leaderSince = Date.now();
  log("leader.up", { pid: process.pid, port: CONTROL_PORT, version: VERSION });
  process.stderr.write(`telegram-topics: leader up on 127.0.0.1:${CONTROL_PORT}\n`);
  return true;
}

export function stopLeader(): void {
  if (bunServer) {
    log("leader.stopped", { pid: process.pid });
    // The successor can only bind after we release the port — flush first so
    // it always loads the final routing state.
    flushSent();
  }
  try {
    // Two-phase close. Graceful first: the listener closes immediately (port
    // frees for re-election) while in-flight requests complete — force-closing
    // here would sever an in-flight /send AFTER its Telegram call was issued,
    // and the client's retry against the new leader posts the message twice.
    // But graceful alone is a trap (reproduced live on Bun 1.3.12): pooled
    // keep-alive connections keep being served by THIS demoted process even
    // after a new leader binds the port — followers' back-to-back long-polls
    // never idle out, so they'd ride the dead leader forever, an error-free
    // inbound black hole. The delayed force-close severs those stragglers;
    // their clients then re-elect and re-register (the designed recovery).
    const server = bunServer;
    server?.stop();
    if (server) {
      const t = setTimeout(() => {
        try {
          server.stop(true);
        } catch {
          // already fully closed
        }
      }, 3000);
      (t as { unref?: () => void }).unref?.();
    }
  } catch {
    // already stopped
  }
  bunServer = null;
  // Drop the typing keepalive — a demoted leader must not keep poking the bot.
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  typingUntil.clear();
  // Drop pending status-badge and activity-TTL timers too.
  for (const t of statusTimers.values()) clearTimeout(t);
  statusTimers.clear();
  for (const t of activityTimers.values()) clearTimeout(t);
  activityTimers.clear();
  for (const t of hooklessTimers.values()) clearTimeout(t);
  hooklessTimers.clear();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  // `bot` is only constructed by a process that won the port; a follower never
  // has one, so guard before stopping.
  if (botRunning) {
    botRunning = false;
    bot.stop().catch(() => {});
  }
}
