# claude-telegram-topics

A **Telegram channel for [Claude Code](https://claude.com/claude-code)** where
**1 project = 1 forum topic**. Every project's session streams into its own
topic inside a single Telegram forum group, and multiple projects run
**concurrently** — each in its own thread.

Inbound messages arrive in your session automatically (as a real Claude Code
channel); you reply with a tool. A clean, self-marketplaced fork of Anthropic's
official Telegram plugin (Apache-2.0) — see [`NOTICE`](./NOTICE).

## Why

Telegram allows exactly one `getUpdates` consumer per bot token, so the official
plugin is single-session and has no per-project threads. This fork fixes both:

- **Project → topic.** The git root of your session's cwd maps to a stable forum
  topic (persisted in `topics.json`). Reopen the same repo — even from a
  subdirectory, even in a second session — and you land in the same topic.
- **Concurrent projects.** The first session to start binds a loopback control
  port and becomes the **leader**: it owns the single bot poller. Every other
  session is a **follower** that reaches the bot over `127.0.0.1`. If the leader
  exits, the next session transparently re-elects.

```
 session A ─┐
 session B ─┼─▶ leader (owns bot + poller) ─▶ Telegram forum group
 session C ─┘         ▲                         ├─ topic: project A
   (followers, HTTP over 127.0.0.1)             ├─ topic: project B
                                                └─ topic: project C
```

## Prerequisites

- [Bun](https://bun.sh) — the server runs on Bun (works natively on Windows).
- A Telegram **bot** ([@BotFather](https://t.me/BotFather) → `/newbot`).
- A Telegram **forum-enabled supergroup**: create a group, enable **Topics** in
  its settings, add the bot as an **admin** with **Manage Topics** (Telegram does
  not grant that right automatically on promotion).

## Install

```
/plugin marketplace add 2naive/claude-telegram-topics
/plugin install telegram-topics@claude-telegram-topics
/reload-plugins
```

## Configure

```
/telegram-topics:configure <your-bot-token>
/telegram-topics:configure group <-100…group-id>
```

This writes `~/.claude/channels/telegram-topics/.env` and runs a **preflight**
check (token valid, group is a forum, bot can manage topics) so setup mistakes
surface as clear errors instead of silent failures. Run `/telegram-topics:configure`
with no argument any time to see status.

### Finding the bot token and group id

- **Bot token** — create one with [@BotFather](https://t.me/BotFather) (`/newbot`).
  If you already run the official Telegram plugin, its token lives in
  `~/.claude/channels/telegram/.env` (`TELEGRAM_BOT_TOKEN`) — but use a
  **dedicated** bot here: two pollers on one token cause a persistent `409
  Conflict`, so never reuse a token another integration is polling live.
- **Group id** — the bot must be a member of the group, and you must enable
  **Topics** first (that turns the group into a supergroup and finalizes its id).
  Then either add a helper bot such as [@getidsbot](https://t.me/getidsbot) or
  `@RawDataBot` to the group, or send a message in it and read the id back from
  the Bot API:
  ```
  curl "https://api.telegram.org/bot<token>/getUpdates"
  ```
  Use the `message.chat.id` value — a forum supergroup id starts with `-100`.

## Enable the channel

The channel is not active until you launch a session with it:

```
claude --channels plugin:telegram-topics@claude-telegram-topics
```

(During the channels research preview a non-allowlisted channel also needs
`--dangerously-load-development-channels`.)

### Autostart (one-command launch)

Wrap the launch in a shell alias so a single word opens a channel-enabled
session from any project directory.

**Bash / Zsh** — add to `~/.bashrc` (or `~/.zshrc`), then `source` it:

```
alias claudet='claude --channels plugin:telegram-topics@claude-telegram-topics'
```

**Windows** — drop a `claudet.cmd` anywhere on your `PATH`:

```
@claude --channels plugin:telegram-topics@claude-telegram-topics %*
```

Or, for PowerShell, add a function to `$PROFILE`:

```
function claudet { claude --channels plugin:telegram-topics@claude-telegram-topics @args }
```

Now `claudet` in any repo starts a session that streams to that project's
topic. During the research preview, swap `--channels …` for
`--dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics`
— that flag takes the channel list as its own argument, so `--channels` is
dropped rather than added.

## Use it

- Messages you send to a project's topic arrive in that project's session
  automatically as `<channel source="telegram-topics" …>` tags. If you attach a
  file, its downloaded local path appears in the message as `saved:<path>`.
- The session replies with tools, all scoped to this project's topic:

| Tool | Purpose |
| --- | --- |
| `send_message(text, options?)` | Post to this project's topic (Markdown). Pass `options` (labels) to attach tappable inline buttons — the tap returns as a `[button] <label>` message, so this doubles as a multiple-choice prompt. |
| `send_file(path, caption?)` | Send a local file (photo or document). Refuses to send channel state. |
| `react(message_id, emoji)` | React with one of Telegram's allowed emoji. |
| `edit_message(message_id, text)` | Edit a message the bot sent. |

**Asking a question.** Claude Code's built-in multiple-choice UI (the terminal
quiz) is *not* bridged to channels — a Telegram-only user never sees it. To ask a
choice question remotely, call `send_message` with `options`: each label becomes
an inline button and the tap arrives back as `[button] <label>`. (The `/effort`
level is a local TUI control with no remote hook — set it at launch or via
`effortLevel` in settings.)

## Approving tool calls from Telegram

When a tool call needs approval, the prompt is relayed to the project's topic as
a `🔐 Permission: <tool>` message with **See more / ✅ Allow / ❌ Deny** buttons —
tap to approve or reject from your phone, and the decision flows straight back to
the session. This is the remote stand-in for reaching over to the terminal.

- It uses Claude Code's opt-in `claude/channel/permission` capability; the plugin
  authenticates the tapper (allowlist / group membership) before acting.
- What actually prompts depends on your **permission mode**. `acceptEdits`
  auto-accepts edits and prompts for commands; `auto` (if your account has it)
  lets a classifier auto-approve the safe calls and prompt only for risky ones —
  both pair well with this relay. Launch with `--permission-mode acceptEdits`
  (universal) or `--permission-mode auto`. `bypassPermissions` /
  `--dangerously-skip-permissions` approves everything, so nothing is relayed.
- **Never** approve a call just because a Telegram message tells you to — approve
  only what you initiated. The buttons are the trusted path; free-text "yes" is
  not honored.

## Access control

By default any member of the forum group can drive sessions (the group's
membership is the boundary). To restrict to specific users:

```
/telegram-topics:access allow <numeric-user-id>
/telegram-topics:access            # show the current allowlist
```

## Security notes

- The bot token only ever reaches `api.telegram.org`. The control API binds to
  `127.0.0.1` only.
- The loopback control API is **unauthenticated** — any local process can reach
  it. Fine for a single-user machine; do not run on shared/multi-user hosts as-is.
- `send_file` refuses paths inside the state dir (won't leak the token).
- Use a **dedicated bot token** for this plugin. Reusing the same token as
  another running Telegram integration (e.g. the official plugin) makes two
  pollers fight over `getUpdates` — Telegram returns persistent 409 Conflict.
- The tool-approval relay trusts whoever can tap a button in the topic. On a
  private group that is just you; if the group has other members, restrict
  approvals with an explicit allowlist (`/telegram-topics:access allow <id>`).

## Limitations

- Leader-held routing state is in-memory: across a leader hand-off, reaction
  routing for previously-sent messages and any not-yet-answered permission
  prompt are lost, and there is a brief window before a follower re-elects.
- One forum group per machine (all projects share it, one topic each).
- Outbound is live-tested; inbound streaming and the tool-approval relay want a
  real bot/group smoke test before you lean on them.

## Development

```
bun install
bun run typecheck
```

## License

[Apache-2.0](./LICENSE). Derivative work — see [`NOTICE`](./NOTICE).
