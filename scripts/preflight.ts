#!/usr/bin/env bun
// Setup preflight: one verdict line per check, exit 1 if any hard check fails.
//
// Lives in code rather than in the skill's inline shell so the checks parse
// the .env exactly like the runtime does (same precedence, CRLF-safe — the
// old grep|cut pipeline kept a trailing \r from Notepad-edited files and
// reported false TOKEN INVALID), and so the skill needs a single pre-approved
// command instead of a raw multi-line script.
//
// The token is read from config and never printed.

import { BOT_TOKEN, GROUP_CHAT_ID, ENV_FILE } from "../src/config.ts";
import { channelAllowlistState } from "../src/allowlist.ts";

type TgResponse = {
  ok: boolean;
  error_code?: number;
  description?: string;
  result?: Record<string, unknown>;
};

async function api(method: string, params = ""): Promise<TgResponse | null> {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}${params}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    return (await resp.json()) as TgResponse;
  } catch {
    return null;
  }
}

let failed = false;
function verdict(ok: boolean, okText: string, failText: string, hard = true): void {
  console.log(ok ? `OK   ${okText}` : `FAIL ${failText}`);
  if (!ok && hard) failed = true;
}

if (!BOT_TOKEN || !GROUP_CHAT_ID) {
  console.log(
    `FAIL not configured: missing ${[
      !BOT_TOKEN && "TELEGRAM_BOT_TOKEN",
      !GROUP_CHAT_ID && "TELEGRAM_GROUP_CHAT_ID",
    ]
      .filter(Boolean)
      .join(", ")} in ${ENV_FILE}`,
  );
  process.exit(1);
}

// 1) Token valid?
const me = await api("getMe");
verdict(
  me?.ok === true,
  `token valid (bot @${(me?.result as { username?: string } | undefined)?.username ?? "?"})`,
  me === null ? "Telegram unreachable (network?)" : "TOKEN INVALID (revoked or mistyped)",
);

// 2) Group reachable, and a forum? Two distinct failures the old check
// conflated: a wrong id / bot-not-in-group also fails getChat, and telling
// that user to "enable Topics" sends them debugging the wrong thing.
const chat = me?.ok ? await api("getChat", `?chat_id=${GROUP_CHAT_ID}`) : null;
if (chat && !chat.ok) {
  verdict(false, "", `GROUP NOT REACHABLE (wrong chat id, or the bot was never added): ${chat.description ?? ""}`);
} else {
  verdict(
    (chat?.result as { is_forum?: boolean } | undefined)?.is_forum === true,
    "group is a forum",
    chat === null ? "group check skipped (token invalid / network)" : "NOT A FORUM (enable Topics in the group settings)",
  );
}

// 3) Bot is an admin with Manage Topics?
const myId = (me?.result as { id?: number } | undefined)?.id;
const member =
  me?.ok && myId ? await api("getChatMember", `?chat_id=${GROUP_CHAT_ID}&user_id=${myId}`) : null;
verdict(
  (member?.result as { can_manage_topics?: boolean } | undefined)?.can_manage_topics === true,
  "bot can manage topics",
  "BOT LACKS can_manage_topics (promote it to admin and enable Manage Topics)",
);

// 4) Is something else already polling this token? A second consumer causes
// the classic persistent 409. Soft check: if a telegram-topics leader is
// already running on this machine, ITS poller legitimately holds the slot.
// No `offset`: an offset would ACK/discard the update it returns, eating a
// real queued inbound message the user is waiting on.
const upd = me?.ok ? await api("getUpdates", "?timeout=0&limit=1") : null;
verdict(
  upd?.error_code !== 409,
  "getUpdates slot free (or this machine's leader holds it — fine)",
  "409 CONFLICT: the token is being polled elsewhere. If a telegram-topics session is running right now, that is expected (its leader polls); otherwise another integration (e.g. the official Telegram plugin, still enabled) owns this token — disable it or use a dedicated bot.",
  false,
);

// 5) Approved for --channels? Not being allowlisted is the worst first-run
// failure: the plugin loads as plain MCP, tools work, and inbound silently
// never arrives. Soft: launching with the development flag needs no allowlist.
const allow = channelAllowlistState();
verdict(
  allow.ok,
  `channel allowlisted for --channels (${allow.detail})`,
  `NOT ALLOWLISTED for --channels (${allow.detail}) — with --channels, inbound messages will silently never arrive. Fix: run /telegram-topics:allowlist (writes managed settings; one admin prompt), or launch with --dangerously-load-development-channels instead (no admin, but an interactive confirmation gates every start — unusable for hands-off relaunch).`,
  false,
);

process.exit(failed ? 1 : 0);
