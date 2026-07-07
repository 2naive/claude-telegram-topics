---
name: configure
description: Set up the telegram-topics channel — save the bot token and forum group id, then run a preflight check. Use when the user pastes a Telegram bot token, asks to configure telegram-topics, asks "how do I set this up", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(bun run *)
---

# Configure telegram-topics

State lives in `~/.claude/channels/telegram-topics/.env` (create the directory if
missing). Write the `.env` with LF line endings (the runtime parser tolerates
CRLF, but LF keeps every shell tool happy too). Keys:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) (`/newbot`)
- `TELEGRAM_GROUP_CHAT_ID` — a forum-enabled supergroup id (looks like `-100…`)
- `TELEGRAM_ALLOWED_USER_IDS` — optional CSV of numeric user ids (managed by
  `/telegram-topics:access`)

Note: process environment variables take precedence over the `.env` — if the
user has any `TELEGRAM_*` of these exported in their shell, warn them that the
exported value wins over what you write here.

## Dispatch on the argument

- **no argument** — Read the `.env` and report status: is the token set? is the
  group id set? Then run **Preflight** below and show its verdicts. Never print
  the token value.
- **a bot token** (looks like `123456789:AA…`) — write/replace `TELEGRAM_BOT_TOKEN`
  in the `.env`, preserving other keys. Then run **Preflight**.
- **`group <id>`** — write/replace `TELEGRAM_GROUP_CHAT_ID`. Then run **Preflight**.
- **`clear`** — remove `TELEGRAM_BOT_TOKEN` from the `.env`.

## Getting the group id

1. In Telegram, create a **group**, open its settings, and enable **Topics**
   (this makes it a forum). 2. Add the bot to the group and **promote it to admin**
   with **Manage Topics** enabled (Telegram does not grant that right by default).
3. Send any message in the group, then read the chat id — e.g. add
   [@userinfobot](https://t.me/userinfobot) to the group, or call the Bot API
   `getUpdates` once. Forum supergroup ids start with `-100`.

## Preflight (run after both token and group id are set)

Setup mistakes are the most common first-run failure, so validate and report
**actionable** verdicts. The checks live in the plugin (`scripts/preflight.ts`)
so they parse the `.env` exactly like the runtime (CRLF-safe, same precedence)
and the token never appears in a command or output. Run:

```bash
bun run --cwd "${CLAUDE_PLUGIN_ROOT}" preflight
```

(If `${CLAUDE_PLUGIN_ROOT}` is not substituted in your context, the plugin root
is the installed plugin directory, e.g.
`~/.claude/plugins/cache/claude-telegram-topics/telegram-topics/<version>`.)

It prints one `OK`/`FAIL` line per check — token validity, group reachable,
group is a forum, bot can Manage Topics, and whether another poller already
holds the token's `getUpdates` slot (the classic shared-token 409). Report each
verdict plainly; on 409 note that an already-running telegram-topics leader on
this machine is a false alarm, but the official Telegram plugin being *enabled*
is the usual real cause.

If all checks pass, tell the user the channel is ready and to relaunch with:

```
claude --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics
```

During the channels research preview this flag **replaces** `--channels`
(custom channels are not allowlisted for it), and it consumes everything after
it as channel names — any other option (`--permission-mode`, …) must come
BEFORE it.
