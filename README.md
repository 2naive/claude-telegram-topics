# claude-telegram-topics

A Telegram channel for [Claude Code](https://claude.com/claude-code) where
**1 project = 1 forum topic**. Every project's session streams into its own
topic inside one Telegram forum group, and multiple projects run **concurrently**
— each in its own thread.

A clean fork of Anthropic's official Telegram plugin (Apache-2.0). See
[`NOTICE`](./NOTICE) for attribution and the list of changes.

## Why

Telegram allows exactly one `getUpdates` consumer per bot token, so the official
plugin is single-session: a new session steals the bot from the old one, and it
has no concept of per-project threads. This fork solves both:

- **Project → topic.** The git root of your session's cwd maps to a stable
  forum topic (`topics.json`). Reopen the same repo — even from a subdirectory,
  even in a second session — and you land in the same topic.
- **Concurrent projects.** The first session to start binds a loopback control
  port and becomes the **leader**: it owns the single bot poller. Every other
  session is a **follower** that reaches the bot through the leader over
  `127.0.0.1`. If the leader exits, the next session transparently re-elects.

```
 session A ─┐
 session B ─┼─▶ leader (owns bot + poller) ─▶ Telegram forum group
 session C ─┘         ▲                         ├─ topic: project A
   (followers, HTTP over 127.0.0.1)             ├─ topic: project B
                                                └─ topic: project C
```

## Prerequisites

- [Bun](https://bun.sh) — the server runs on Bun.
- A Telegram **bot** ([@BotFather](https://t.me/BotFather) → `/newbot`).
- A Telegram **forum-enabled supergroup** (group → *Edit* → *Topics* on). Add
  the bot as an **admin** with *Manage Topics* (and reactions require admin).

## Setup

1. Install and build:
   ```
   git clone https://github.com/<you>/claude-telegram-topics
   cd claude-telegram-topics && bun install
   ```

2. Configure `~/.claude/channels/telegram-topics/.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_GROUP_CHAT_ID=-1001234567890
   # optional: only these numeric user ids may drive sessions
   TELEGRAM_ALLOWED_USER_IDS=11111111,22222222
   # optional: control port (default 8787) and state dir
   # TG_TOPICS_PORT=8787
   ```
   Get the group id by adding the bot and reading any message's `chat.id`
   (e.g. via [@userinfobot](https://t.me/userinfobot) added to the group), or
   from the Bot API `getUpdates`.

3. Register it as an MCP server for Claude Code (either install this repo as a
   plugin, or point your MCP config at `bun run --cwd <repo> start`).

## Tools

Deliberately thin and transparent — inbound content is relayed **verbatim**
(no editorializing of reactions, no autonomous model calls):

| Tool | Purpose |
| --- | --- |
| `send_message(text)` | Post to this project's topic; no wait. |
| `ask_user(question, options?)` | Post and wait up to 5 min for a reply (text, button, or reaction). |
| `check_messages()` | Return messages sent since the last check (non-blocking). |
| `wait_for_message()` | Block until the next message (up to 25 min). |
| `send_file(path, caption?)` | Send a local file (photo or document). Refuses to send channel state. |
| `react(message_id, emoji)` | React with one of Telegram's allowed emoji. |
| `edit_message(message_id, text)` | Edit a message the bot sent. |

## Security notes

- The bot token only ever reaches `api.telegram.org`. The control API binds to
  `127.0.0.1` only.
- The loopback control API is **unauthenticated** — any local process can reach
  it. Fine for a single-user machine; do not run on shared/multi-user hosts as-is.
- `send_file` refuses paths inside the state dir (won't leak the token).
- Inbound files are written to `~/.claude/channels/telegram-topics/inbox/` with
  sanitized names.

## Limitations (v0.1)

- During a leader hand-off (leader session exits), inbound messages are not
  buffered until a follower re-elects on its next call.
- One forum group per machine (all projects share it, one topic each).
- Needs a live smoke test against a real bot/group; grammy calls and topic
  permissions are exercised only at runtime.

## License

[Apache-2.0](./LICENSE). Derivative work — see [`NOTICE`](./NOTICE).
