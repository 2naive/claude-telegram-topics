// Leader: the single process that owns the Telegram bot.
//
// Exactly one getUpdates consumer is allowed per bot token, so exactly one
// session may poll. That session becomes the leader; every other session is a
// follower that reaches the bot through this loopback HTTP control API. The
// leader holds the bot, the poller, the session registry, and does all topic
// routing.

import { Bot, InputFile, GrammyError } from "grammy";
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

export type Inbound =
  | { type: "message"; from: string; text: string; messageId: number; ts: number }
  | { type: "callback"; from: string; data: string; messageId: number; ts: number }
  | { type: "reaction"; from: string; emoji: string; messageId: number; ts: number };

type Session = {
  id: string;
  project: string;
  topicId: number;
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

function deliver(topicId: number, msg: Inbound): void {
  const set = topicSessions.get(topicId);
  if (!set || set.size === 0) return;
  for (const sid of set) {
    const s = sessions.get(sid);
    if (!s) continue;
    s.queue.push(msg);
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

    deliver(topicId, {
      type: "message",
      from,
      text,
      messageId: m.message_id,
      ts: Date.now(),
    });
  });

  bot.on("callback_query", async (ctx) => {
    const cb = ctx.callbackQuery;
    const msg = cb.message;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!msg || !inGroup(msg.chat.id)) return;
    if (!isAllowedUser(cb.from?.id)) return;
    const topicId = msg.message_thread_id;
    if (topicId === undefined) return;
    deliver(topicId, {
      type: "callback",
      from: cb.from?.username ?? String(cb.from?.id ?? "user"),
      data: cb.data ?? "",
      messageId: msg.message_id,
      ts: Date.now(),
    });
  });

  bot.on("message_reaction", (ctx) => {
    const r = ctx.messageReaction;
    if (!inGroup(r.chat.id)) return;
    if (!isAllowedUser(r.user?.id)) return;
    const topicId = topicForSentMessage(r.message_id);
    if (topicId === undefined) return;
    const emoji = r.new_reaction.find((x) => x.type === "emoji")?.emoji ?? "";
    if (!emoji) return;
    deliver(topicId, {
      type: "reaction",
      from: r.user?.username ?? String(r.user?.id ?? "user"),
      emoji,
      messageId: r.message_id,
      ts: Date.now(),
    });
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
  const msgId = await withRecovery(s, async (topicId) => {
    const reply_markup = options?.length
      ? { inline_keyboard: options.map((o) => [{ text: o, callback_data: o }]) }
      : undefined;
    try {
      const sent = await bot.api.sendMessage(GROUP_CHAT_ID, text, {
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
        const sent = await bot.api.sendMessage(GROUP_CHAT_ID, text, {
          message_thread_id: topicId,
          reply_markup,
        });
        return sent.message_id;
      }
      throw e;
    }
  });
  trackSent(msgId, s.topicId);
  return msgId;
}

const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

async function sendFile(s: Session, path: string, caption: string): Promise<number> {
  const isPhoto = PHOTO_EXT.has(path.slice(path.lastIndexOf(".")).toLowerCase());
  const msgId = await withRecovery(s, async (topicId) => {
    const opts = { message_thread_id: topicId, caption: caption || undefined };
    const sent = isPhoto
      ? await bot.api.sendPhoto(GROUP_CHAT_ID, new InputFile(path), opts)
      : await bot.api.sendDocument(GROUP_CHAT_ID, new InputFile(path), opts);
    return sent.message_id;
  });
  trackSent(msgId, s.topicId);
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
    const { project, name } = (await req.json()) as { project: string; name: string };
    let topicId: number;
    try {
      topicId = await resolveTopic(bot.api, project, name);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
    const id = randomUUID().slice(0, 8);
    sessions.set(id, {
      id,
      project,
      topicId,
      queue: [],
      waiter: null,
      waiterTimer: null,
      lastActive: Date.now(),
    });
    bindTopic(id, topicId);
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
    if (path === "/poll") {
      const timeout = Number(url.searchParams.get("timeout") ?? "25") * 1000;
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

  process.stderr.write(`telegram-topics: leader up on 127.0.0.1:${CONTROL_PORT}\n`);
  return true;
}

export function stopLeader(): void {
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
