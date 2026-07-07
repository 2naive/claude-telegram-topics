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
} from "./config.ts";
import { isAllowedUser, assertSendable } from "./access.ts";
import { resolveTopic, recreateTopic } from "./topics.ts";
import {
  parseCallback,
  permCallbackData,
  remapValues,
  sessionPrefix,
  truncate,
} from "./routing.ts";
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

function deliver(topicId: number, msg: Inbound): void {
  const set = topicSessions.get(topicId);
  if (!set || set.size === 0) return;
  for (const sid of set) deliverToSession(sid, msg);
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

function initBot(): void {
  bot = new Bot(BOT_TOKEN);
  botRunning = true;

  bot.on("message", async (ctx) => {
    const m = ctx.message;
    if (!inGroup(m.chat.id)) return;
    if (m.from?.is_bot) return;
    if (!isAllowedUser(m.from?.id)) return;
    const topicId = m.message_thread_id;
    if (topicId === undefined) return; // General topic / non-topic messages ignored

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

    await ctx.answerCallbackQuery().catch(() => {});
    if (!msg || !inGroup(msg.chat.id)) {
      log("callback.drop", { reason: "chat" });
      return;
    }
    if (!isAllowedUser(cb.from?.id)) {
      log("callback.drop", { reason: "user", from: String(cb.from?.id ?? "") });
      return;
    }
    if (msg.message_thread_id === undefined) {
      log("callback.drop", { reason: "no-thread", mid: msg.message_id });
      return;
    }
    // A choice button's callback_data is the option index; map it back to the
    // label we sent so the session sees the human-readable choice.
    let data: string;
    if (parsed.kind === "choice") {
      const opts = sentMessageOptions.get(msg.message_id);
      data = opts?.[parsed.index] ?? String(parsed.index);
    } else {
      data = parsed.data;
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

// Reactions carry a message_id but no thread id, so we route them via a map of
// bot-sent message -> topic. In-memory only: reaction routing for messages sent
// before a leader hand-off is lost (a known v0.1 limitation).
const sentMessageTopic = new Map<number, number>();
const SENT_LIMIT = 2000;
function trackSent(messageId: number, topicId: number): void {
  sentMessageTopic.set(messageId, topicId);
  if (sentMessageTopic.size > SENT_LIMIT) {
    const drop = sentMessageTopic.size - SENT_LIMIT / 2;
    let i = 0;
    for (const k of sentMessageTopic.keys()) {
      if (i++ >= drop) break;
      sentMessageTopic.delete(k);
    }
  }
}
function topicForSentMessage(messageId: number): number | undefined {
  return sentMessageTopic.get(messageId);
}

// Choice labels attached to a sent message. Button callback_data is the option
// index (bounded, avoids Telegram's 64-byte callback_data cap on long labels);
// this maps the tapped index back to its label. Bounded like sentMessageTopic.
const sentMessageOptions = new Map<number, string[]>();
function trackOptions(messageId: number, options: string[]): void {
  sentMessageOptions.set(messageId, options);
  if (sentMessageOptions.size > SENT_LIMIT) {
    const drop = sentMessageOptions.size - SENT_LIMIT / 2;
    let i = 0;
    for (const k of sentMessageOptions.keys()) {
      if (i++ >= drop) break;
      sentMessageOptions.delete(k);
    }
  }
}

// Which session sent a given message, so a reply / button tap / reaction on it
// routes back to that specific session instead of fanning to every session on
// the topic — the difference that matters when a project has two sessions.
const sentMessageSession = new Map<number, string>();
function trackSession(messageId: number, sessionId: string): void {
  sentMessageSession.set(messageId, sessionId);
  if (sentMessageSession.size > SENT_LIMIT) {
    const drop = sentMessageSession.size - SENT_LIMIT / 2;
    let i = 0;
    for (const k of sentMessageSession.keys()) {
      if (i++ >= drop) break;
      sentMessageSession.delete(k);
    }
  }
}
// The live session that owns a message, if it still exists.
function ownerSession(messageId: number): string | undefined {
  const sid = sentMessageSession.get(messageId);
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
  toolName: string;
  description: string;
  inputPreview: string;
  createdAt: number;
};
const pendingPermissions = new Map<string, PendingPermission>();
const permKey = (sessionId: string, requestId: string): string =>
  `${sessionId}:${requestId}`;

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
  const key = permKey(sessionId, requestId);
  const pending = pendingPermissions.get(key);
  if (!pending) {
    await ctx
      .answerCallbackQuery({ text: "Request no longer available." })
      .catch(() => {});
    return;
  }

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
              { text: "✅ Allow", callback_data: permCallbackData("allow", sessionId, requestId) },
              { text: "❌ Deny", callback_data: permCallbackData("deny", sessionId, requestId) },
            ],
          ],
        },
      })
      .catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  // allow / deny → delete first so a double-tap can't fire twice, then hand the
  // decision to the owning session.
  pendingPermissions.delete(key);
  deliverToSession(sessionId, {
    type: "permission",
    requestId,
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

async function sendText(s: Session, text: string, options?: string[]): Promise<number> {
  const outText =
    sessionPrefix(s.label, topicSessions.get(s.topicId)?.size ?? 1) + text;
  const msgId = await withRecovery(s, async (topicId) => {
    const reply_markup = options?.length
      ? { inline_keyboard: options.map((o, i) => [{ text: o, callback_data: String(i) }]) }
      : undefined;
    try {
      const sent = await bot.api.sendMessage(GROUP_CHAT_ID, outText, {
        message_thread_id: topicId,
        parse_mode: "Markdown",
        reply_markup,
      });
      return sent.message_id;
    } catch (e) {
      // Markdown that Telegram can't parse — retry as plain text.
      if (
        e instanceof GrammyError &&
        e.error_code === 400 &&
        /can't parse/i.test(e.description)
      ) {
        const sent = await bot.api.sendMessage(GROUP_CHAT_ID, outText, {
          message_thread_id: topicId,
          reply_markup,
        });
        return sent.message_id;
      }
      throw e;
    }
  });
  trackSent(msgId, s.topicId);
  trackSession(msgId, s.id);
  if (options?.length) trackOptions(msgId, options);
  return msgId;
}

const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

async function sendFile(s: Session, path: string, caption: string): Promise<number> {
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
  trackSent(msgId, s.topicId);
  trackSession(msgId, s.id);
  return msgId;
}

// --- Control API (loopback only) ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return json({ ok: true, sessions: sessions.size });
  }

  if (path === "/register" && req.method === "POST") {
    const { project, name, label, prev } = (await req.json()) as {
      project: string;
      name: string;
      label?: string;
      prev?: string;
    };
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
      remapValues(sentMessageSession, prev, id);
    }
    log("register", { sid: id, project, prev: prev ?? "", sessions: sessions.size });
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
      const id = await sendText(s, String(body.text ?? ""), body.options as string[] | undefined);
      return json({ messageId: id });
    }
    if (path === "/sendFile") {
      const filePath = String(body.path);
      // Never upload channel state (the .env holds the token) even if asked —
      // the client-side guard alone would not protect a rogue local caller.
      assertSendable(filePath);
      const id = await sendFile(s, filePath, String(body.caption ?? ""));
      return json({ messageId: id });
    }
    if (path === "/react") {
      // Only react to a message we sent into this session's topic.
      const messageId = Number(body.messageId);
      if (topicForSentMessage(messageId) !== s.topicId) {
        return json({ error: "message not in this session's topic" }, 403);
      }
      await bot.api.setMessageReaction(GROUP_CHAT_ID, messageId, [
        { type: "emoji", emoji: String(body.emoji) as never },
      ]);
      return json({ ok: true });
    }
    if (path === "/edit") {
      const messageId = Number(body.messageId);
      if (topicForSentMessage(messageId) !== s.topicId) {
        return json({ error: "message not in this session's topic" }, 403);
      }
      await bot.api.editMessageText(GROUP_CHAT_ID, messageId, String(body.text));
      return json({ ok: true });
    }
    if (path === "/permissionAsk") {
      const requestId = String(body.requestId ?? "");
      if (!requestId) return json({ error: "requestId required" }, 400);
      const toolName = String(body.toolName ?? "tool");
      const description = String(body.description ?? "");
      const inputPreview = String(body.inputPreview ?? "");
      const preview = inputPreview ? `\n\n${truncate(inputPreview, 350)}` : "";
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
        toolName,
        description,
        inputPreview,
        createdAt: Date.now(),
      });
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
        Math.min(Number(url.searchParams.get("timeout") ?? "25"), 30) * 1000;
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
      unbindTopic(s.id, s.topicId);
      sessions.delete(s.id);
      log("unregister", { sid: s.id });
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "not found" }, 404);
}

let bunServer: { stop: () => void } | null = null;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Try to become the leader by binding the control port. Returns true if this
 * process is now the leader (bot + API running), false if the port is taken
 * (another leader already exists — caller should act as a follower).
 */
export async function tryBecomeLeader(): Promise<boolean> {
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
      idleTimeout: 40,
    });
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || /in use|address already/i.test(String(e))) {
      return false;
    }
    throw e;
  }

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
      log("poller.died", { error: String(e) });
      process.stderr.write(
        `telegram-topics leader: poller died, relinquishing leadership: ${e}\n`,
      );
      stopLeader();
    });

  // Idle-session reaper + inbox disk reclaim.
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActive > 3 * 3600 * 1000) {
        unbindTopic(id, s.topicId);
        sessions.delete(id);
        log("session.reaped", { sid: id });
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

  log("leader.up", { pid: process.pid, port: CONTROL_PORT });
  process.stderr.write(`telegram-topics: leader up on 127.0.0.1:${CONTROL_PORT}\n`);
  return true;
}

export function stopLeader(): void {
  if (bunServer) log("leader.stopped", { pid: process.pid });
  try {
    bunServer?.stop();
  } catch {
    // already stopped
  }
  bunServer = null;
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
