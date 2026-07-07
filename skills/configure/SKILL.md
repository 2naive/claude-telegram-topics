---
name: configure
description: Set up the telegram-topics channel — save the bot token and forum group id, then run a preflight check. Use when the user pastes a Telegram bot token, asks to configure telegram-topics, asks "how do I set this up", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(curl *)
---

# Configure telegram-topics

State lives in `~/.claude/channels/telegram-topics/.env` (create the directory if
missing). **Write the `.env` with LF line endings only** — a CRLF file is parsed
incorrectly. Keys:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) (`/newbot`)
- `TELEGRAM_GROUP_CHAT_ID` — a forum-enabled supergroup id (looks like `-100…`)
- `TELEGRAM_ALLOWED_USER_IDS` — optional CSV of numeric user ids (managed by
  `/telegram-topics:access`)

## Dispatch on the argument

- **no argument** — Read the `.env` and report status: is the token set? is the
  group id set? Then show the remaining steps below. Never print the token value.
- **a bot token** (looks like `123456789:AA…`) — write/replace `TELEGRAM_BOT_TOKEN`
  in the `.env`, preserving other keys. Then run **Preflight** below.
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

This is the single most common source of first-run failure, so validate it and
report **actionable** errors. Read the token and group id from the `.env`, then
(so the token never appears in a printed command, read it from the file inside
the shell):

```bash
cd ~/.claude/channels/telegram-topics
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)
GID=$(grep -E '^TELEGRAM_GROUP_CHAT_ID=' .env | cut -d= -f2-)
# 1) token valid?
curl -s "https://api.telegram.org/bot$TOKEN/getMe" | grep -q '"ok":true' && echo "token OK" || echo "TOKEN INVALID"
# 2) group is a forum?
curl -s "https://api.telegram.org/bot$TOKEN/getChat?chat_id=$GID" | grep -q '"is_forum":true' && echo "forum OK" || echo "NOT A FORUM (enable Topics in the group)"
# 3) bot is an admin that can manage topics?
curl -s "https://api.telegram.org/bot$TOKEN/getChatMember?chat_id=$GID&user_id=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)" | grep -q '"can_manage_topics":true' && echo "admin OK" || echo "BOT LACKS can_manage_topics (promote it to admin with Manage Topics)"
```

Report each line's result plainly. If all three are OK, tell the user the channel
is ready and to relaunch with:

```
claude --channels plugin:telegram-topics@claude-telegram-topics
```

(During the channels research preview, a non-allowlisted channel also needs
`--dangerously-load-development-channels`.)
