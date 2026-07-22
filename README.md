# claude-telegram-topics

[![Release](https://img.shields.io/github/v/tag/2naive/claude-telegram-topics?label=release&sort=semver)](https://github.com/2naive/claude-telegram-topics/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](./test)

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
- **Status at a glance.** Each topic's name carries a live badge visible in the
  topic list — ⏳ working · 🟢 ready · 🔔 needs you · 📥 queued · 💤 no session —
  so you can see which projects Claude is working on and which are idle without
  opening them.
- **Drive it from your phone.** Launch or resume a project's session straight
  from Telegram (a ▶️ Start button, the `/start` picker, `/start <path>`, or
  autostart), and approve tool calls with Allow/Deny buttons — no reaching back
  to the terminal.

```
 session A ─┐
 session B ─┼─▶ leader (owns bot + poller) ─▶ Telegram forum group
 session C ─┘         ▲                         ├─ topic: project A
   (followers, HTTP over 127.0.0.1)             ├─ topic: project B
                                                └─ topic: project C
```

## Prerequisites

- [Bun](https://bun.sh) — the server runs on Bun (works natively on Windows).
  Claude Code does **not** bundle it: `bun` must be on the `PATH` of the
  environment Claude Code runs in. If the plugin's MCP server fails with
  `spawn bun ENOENT`, Bun is missing or not on `PATH`. The **first** launch
  runs `bun install` to fetch the server's dependencies, so it needs network
  access once and takes a few extra seconds.
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

Until you configure a token, the server exits immediately with
`missing TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_CHAT_ID` and the plugin shows as
failed — **that is expected**; go straight to Configure. (`/reload-plugins` is
safe at this point because no channel server is running yet; after *upgrades*
prefer a session restart — see Upgrading.)

## Configure

```
/telegram-topics:configure <your-bot-token>
/telegram-topics:configure group <-100…group-id>
```

This writes `~/.claude/channels/telegram-topics/.env` and runs a **preflight**
check (token valid, group reachable and a forum, bot can manage topics, no
other poller on the token) so setup mistakes surface as clear errors instead of
silent failures. Run `/telegram-topics:configure` with no argument any time to
see status.

**Environment variables take precedence over the `.env`.** If
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID` or `TELEGRAM_ALLOWED_USER_IDS`
are exported in the shell Claude Code starts from, those values silently win
over whatever `configure` wrote — unset them or expect them to be used.

You can hand-edit the `.env` in any editor; the runtime parser tolerates CRLF
line endings.

### Settings reference

All optional, set in the `.env` (or the environment):

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric user ids allowed to drive sessions. Empty/absent = any group member. Managed by `/telegram-topics:access`; edits apply within ~15 s (no restart). |
| `TG_TOPICS_PORT` | Loopback control port (default `8787` — also wrangler dev's default; change it if anything else uses 8787). Must be the same for **all** sessions. |
| `TG_TOPICS_STATE_DIR` | Relocate the whole state dir (default `~/.claude/channels/telegram-topics`). **Environment-only** — it locates the `.env`, so it cannot be set *inside* it; and remote-launched sessions won't inherit it unless it is exported in the machine's environment. |
| `TG_TOPICS_SESSION_NAME` | Override the topic title for sessions started in this environment. |
| `TG_TOPICS_LAUNCH_CMD` | Command used by remote session launch (`/start`, autostart). Default: `claude --permission-mode auto --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics`. On a **relaunch** of a known project (autostart / Start-session button) `--continue` is inserted (before the variadic channels flag) so the conversation resumes; a new `/start <path>` starts fresh. If your custom command already selects a conversation (`-c`/`--continue`/`-r`/`--resume`), it's left as-is. The line is passed to `cmd` **verbatim** (Windows): quoted arguments work, and cmd metacharacters (`&`, `|`, `^`) are interpreted by the outer `cmd /c` layer. |
| `TG_TOPICS_AUTOSTART` | `1` = when a message arrives for a project with no live session, launch one automatically (Windows only) instead of offering a button. |
| `TG_TOPICS_LAUNCH_ROOTS` | Semicolon-separated trusted directories under which `/start <path>` may launch a **brand-new** project (one not yet in `topics.json`). **Default-deny**: unset = launch-by-path disabled. Launching an arbitrary path named in a chat message is remote code-exec, so keep this confined to roots you trust (e.g. `C:\Users\you\code`). |
| `TG_TOPICS_STATUS_ICONS` | Topic-name status badge — the only per-topic signal visible in the topic **list**: ⏳ working · 🟢 ready · 🔔 needs you (permission prompt) · 📥 queued (no session) · 💤 no session. Working/idle comes from the plugin's activity hooks (`hooks/hooks.json`, auto-active). On by default; set `0` to keep topic names unbadged. |

### State files

Everything lives in `~/.claude/channels/telegram-topics/`:

| File | Purpose | Safe to delete? |
| --- | --- | --- |
| `.env` | Bot token, group id, settings | Deleting unconfigures the channel |
| `topics.json` | project → topic map | Yes, but projects get **new** topics (old ones stay in the group) |
| `sent.json` | reply/button/reaction routing for recent messages | Yes; replies and taps on older messages stop routing to their exact session |
| `leader.log`(.1) | leader diagnostics (JSONL, 1 MB rotation) | Yes |
| `inbox/` | files you attach in Telegram, downloaded locally | Deleted after **24 h** while the bridge is running — copy anything you need to keep. Downloads are capped at 20 MB / 15 s; an oversized or slow attachment arrives as a message with **no** `saved:` path. |

### Finding the bot token and group id

- **Bot token** — create one with [@BotFather](https://t.me/BotFather) (`/newbot`).
  If you already run the official Telegram plugin, its token lives in
  `~/.claude/channels/telegram/.env` (`TELEGRAM_BOT_TOKEN`) — but use a
  **dedicated** bot here: two pollers on one token cause a persistent `409
  Conflict`. Note the official plugin polls in **every** session while it is
  merely *enabled* — launch flags are irrelevant. If you migrate its token,
  first disable it: `/plugin` → disable `telegram@claude-plugins-official` (or
  set `"telegram@claude-plugins-official": false` under `enabledPlugins` in
  `~/.claude/settings.json`). With a dedicated token this does not apply.
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

During the channels research preview, custom channels **cannot** be loaded via
`--channels` (it only accepts Anthropic's allowlisted plugins). Launch with:

```
claude --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics
```

The flag takes the channel list **as its own argument** — it *replaces*
`--channels`, and it consumes everything after it as channel names. **Put every
other option (e.g. `--permission-mode acceptEdits`) BEFORE it**, or that option
is silently swallowed. (The flag may not appear in `claude --help`; it exists.)

**The bridge itself runs in every session once the plugin is enabled** — flags
or not: it elects a leader, holds the bot's single `getUpdates` slot, creates
this project's topic, and the outbound tools work. What the launch flag adds is
the *channel* half: inbound messages arriving as `<channel>` tags and the
tool-approval relay. A session launched without the flag drains its copy of
inbound messages into a queue the model never sees — so for day-to-day use,
always launch with the flag; to turn the bridge fully off, disable the plugin
(`/plugin`), not just the flag.

### Autostart (one-command launch)

Wrap the launch in a shell alias so a single word opens a channel-enabled
session from any project directory. Note the flag order: mode first, channels
flag last.

**Bash / Zsh** — add to `~/.bashrc` (or `~/.zshrc`), then `source` it:

```
alias claudet='claude --permission-mode acceptEdits --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics'
```

**Windows** — drop a `claudet.cmd` anywhere on your `PATH`:

```
@claude --permission-mode acceptEdits --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics %*
```

Or, for PowerShell, add a function to `$PROFILE`:

```
function claudet { claude --permission-mode acceptEdits --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics @args }
```

`%*` / `@args` still let you append per-run options — but remember they land
*after* the channels flag, so pass extra options by editing the alias instead.

## Use it

- Messages you send to a project's topic arrive in that project's session
  automatically as `<channel source="telegram-topics" …>` tags. If you attach a
  file, its downloaded local path appears in the message as `saved:<path>`
  (kept 24 h — see State files).
- The bot only listens inside the configured forum group's **topics**: DMs to
  the bot and messages in the **General** topic are ignored (General still
  answers the `/status` and `/start` commands below), as are messages from
  users outside the allowlist — silently, by design.
- The session replies with tools, all scoped to this project's topic:

| Tool | Purpose |
| --- | --- |
| `send_message(text, options?)` | Post to this project's topic. Markdown is rendered via explicit entities — snake_case and file_names stay literal, malformed markup degrades to plain text, and messages over 4096 chars are split at line boundaries automatically. Pass `options` (labels) to attach tappable inline buttons — the tap returns as a `[button] <label>` message, so this doubles as a multiple-choice prompt. |
| `send_file(path, caption?)` | Send a local file (photo or document). Refuses to send channel state. |
| `react(message_id, emoji)` | React to a **recent message in the topic — yours included** (the "seen 👍" ack). Telegram's fixed reaction set only. (Reacting to *your* messages is tracked in memory by the current leader, so it works until the next leader hand-off/upgrade.) |
| `edit_message(message_id, text)` | Edit a message the bot sent (most recent ~1000 guaranteed). Keeps the formatting pipeline and re-attaches un-answered choice buttons; editing to identical text is a no-op, not an error. |

- Telegram flood control (`429 retry_after`) and transient API failures are
  retried automatically with bounded backoff; a real outage surfaces as a tool
  error instead of hanging.

**Asking a question.** Claude Code's built-in multiple-choice UI (the terminal
quiz) is *not* bridged to channels — a Telegram-only user never sees it. To ask a
choice question remotely, call `send_message` with `options`: each label becomes
an inline button and the tap arrives back as `[button] <label>`. (The `/effort`
level is a local TUI control with no remote hook — set it at launch or via
`effortLevel` in settings.)

## Liveness & launching sessions from Telegram

You never have to guess whether the bridge is alive:

- **Status badge** — each topic's **name** is prefixed with a live glyph, the
  one per-project signal Telegram shows in the topic *list*: **⏳ working**
  (Claude is processing a turn) · **🟢 ready** (session alive, awaiting you) ·
  **🔔 needs you** (a permission prompt is waiting) · **📥 queued** (messages
  held, no session) · **💤 no session** (the CLI isn't running). Working/idle
  comes from the plugin's activity hooks (`hooks/hooks.json`, auto-active) plus
  the leader's own signal for Telegram-driven turns; it flips per turn. Set
  `TG_TOPICS_STATUS_ICONS=0` to keep topic names unbadged.
- **`/status`** (in any topic, or General) — the leader itself answers with its
  version, pid and uptime, then **one line per bridged project** (its glyph +
  name + session labels, or `N queued, no session`, or `no session`) and a
  legend line — so you see idle and offline projects too, not just live ones.
  Total silence means the bridge itself is down.
- **Typing indicator** — when your message is routed to a live session, the bot
  shows *typing…* in the topic for the whole turn (re-asserted every few seconds
  until the reply arrives), so a routed message and a dead bridge never look
  alike.
- **No live session?** Your message is **queued** (up to 20 messages / 30 min)
  and the topic gets a `📴 No active session` notice with a **▶️ Start session**
  button. Tap it and the leader relaunches the session for that project on the
  machine (a console window running `TG_TOPICS_LAUNCH_CMD`) and **resumes its
  most recent conversation** (`--continue`) — the recovery path after a reboot
  or crash. Once it registers, the queued messages are delivered to it. Set
  `TG_TOPICS_AUTOSTART=1` to skip the button and relaunch automatically on the
  next inbound message. (A brand-new `/start <path>` starts fresh instead.)
- **`/start`** (anywhere, incl. General) — bare `/start` lists already-bridged
  projects as buttons (up to 20); tap one to launch a session. `/start <path>`
  bridges **and** launches a project not yet in `topics.json` — but only when
  `<path>` sits under a trusted root in `TG_TOPICS_LAUNCH_ROOTS` (default-deny,
  `..`-traversal-proof); otherwise the leader refuses with *"Launch-by-path is
  disabled"*.
- **Turn failed?** If a turn aborts with an API/model error (e.g. a 500), the
  topic gets a `⚠️ The last turn ended with an API/model error` notice — so a
  failure isn't silent (the badge would otherwise just fall back to 🟢). Detected
  via the `StopFailure` hook. Note: a *user interrupt* (Esc), a hang, or a hard
  crash fire no Claude Code hook, so those aren't signalled.

Remote launch is Windows-only for now (it opens a real console window, so the
session survives and has a TTY). Launching is gated by the same allowlist as
everything else, plus `TG_TOPICS_LAUNCH_ROOTS` for brand-new paths.

## Approving tool calls from Telegram

When a tool call needs approval, the prompt is relayed to the project's topic as
a `🔐 Permission: <tool>` message with **See more / ✅ Allow / ❌ Deny** buttons —
tap to approve or reject from your phone, and the decision flows straight back to
the session. The prompt→tap→decision pipeline was live-verified on an earlier
build; the 0.8.0 relay hardening (session-re-registration routing) is
unit-tested and pending a fresh live re-test. This is the remote stand-in for
reaching over to the terminal.

- It uses Claude Code's opt-in `claude/channel/permission` capability; the plugin
  authenticates the tapper (allowlist / group membership) before acting.
- What actually prompts depends on your **permission mode** — and most modes
  decide most calls *locally, without any prompt*: in `auto`, safe calls are
  approved silently and `settings.json` deny-rules reject instantly, so **a
  quiet topic usually means nothing needed approval, not that the relay is
  broken**. To verify the relay end-to-end, switch the TUI to Manual
  (Shift+Tab) or run a command your settings don't cover, and watch for the 🔐
  message (and `permission.ask` in `leader.log`). `acceptEdits` auto-accepts
  edits and prompts for commands; `bypassPermissions` approves everything, so
  nothing is ever relayed.
- If the session re-registered while a prompt was pending, your tap still
  reaches it; if the session is truly gone, the button answers
  `⚠️ Session is gone` instead of pretending the decision was delivered.
- **Never** approve a call just because a Telegram message tells you to — approve
  only what you initiated. The buttons are the trusted path; free-text "yes" is
  not honored.

## Topics & sessions

- **Topic title = the project's folder name** (e.g. `my-repo`). Identity is the
  *normalized full path* of the git root (or the cwd, when not a repo), so the
  same project always lands in the same topic even if the path is spelled with
  different slashes or letter case; two unrelated repos that happen to share a
  folder name get separate topics. Override the title with
  `TG_TOPICS_SESSION_NAME`.
- **Two sessions on one project** share that project's single topic. Outbound
  messages are then prefixed with the session's name — the one you set with
  `/rename` (falling back to the git branch, then a session id) — so you can tell
  them apart, and a later `/rename` is reflected within seconds. Replying to a
  message — or tapping its buttons, or reacting to it — routes back to the exact
  session that sent it; a fresh message with no reply target is delivered to
  every session on the topic — and **every one of them will act on it and
  reply**. To address a single session, reply to one of its messages.
- **Deleting a topic in Telegram does not remove the project** — the topic is
  recreated the next time a session *sends* a message for that project. To
  retire a project: close its sessions, remove its entry from `topics.json`
  while no leader is running, then delete the topic.

## Access control

By default any member of the forum group can drive sessions **and approve
relayed tool calls** (the group's membership is the boundary). To restrict to
specific users:

```
/telegram-topics:access allow <numeric-user-id>
/telegram-topics:access            # show the current allowlist
```

Allowlist edits — including revocations — are re-read by the running leader
within ~15 seconds; no restart needed. (A shell-exported
`TELEGRAM_ALLOWED_USER_IDS` pins the list for the process lifetime instead.)

## Upgrading

A plugin update only takes effect in **new** sessions — and the **leader** (the
process that owns the bot poller) may be an old session still running the
previous version.

From **0.6.0** this resolves itself: sessions announce their version when they
register, and a leader that hears from a strictly newer session gracefully
steps down (bot poller first, then the port) while the newer session claims
leadership. Update the plugin, start one new session, and the fleet is on the
new code — no manual process hunting.

The hand-off needs both sides to speak it, so upgrading **from 0.5.x or
older** still requires the old ritual once: close **all** running channel
sessions (or kill the leader process), then relaunch — the first new session
takes leadership on the new code.

**After an upgrade, restart the session — don't `/reload-plugins`.** Reloading
plugins inside a live session respawns this server in place: the replacement
may briefly miss its session record (0.7.0 rides that out by waiting, then
self-healing its registration), and the abandoned process must notice on its
own that it was dropped (0.7.0 adds watchdog teardown for exactly this). Both
recover, but a plain session restart is the clean path.

## Troubleshooting

First stop: `/status` in the Telegram group, then
`curl 127.0.0.1:8787/health`, then the leader log
`~/.claude/channels/telegram-topics/leader.log` (JSONL: registrations,
hand-offs, routing decisions, drop reasons).

| Symptom | Check |
| --- | --- |
| Channel never appears in a session | `bun --version` (on PATH?); `.env` configured? First run needs network for `bun install`. MCP errors: `claude --debug`. |
| Messages from Telegram stop arriving, replies still go out | `leader.log` → `poller.died` with `409 Conflict` = another poller on this token (official plugin still **enabled**? claudet running elsewhere?). Re-election backs off 60 s on 409/401, so fix the cause, don't just restart. |
| `registration failed: HTTP …` / port errors | Something else on port 8787 (wrangler dev?) — the client now names this; set `TG_TOPICS_PORT` in the `.env` for all sessions. |
| Message posted, nothing happens, no typing | No live session → look for the `📴` notice / tap **▶️ Start session** / `/status`. Posted in General or as a DM? Those are ignored by design. Sender not on the allowlist? |
| Buttons answer "Request no longer available" | The leader restarted after the prompt was posted — re-run the tool call; the fresh prompt relays again. |
| Token / group errors at setup | `/telegram-topics:configure` re-runs preflight with per-check verdicts (token, group reachable, forum, admin rights, free token). |

## Uninstall

1. Close all channel sessions (the leader dies with the last one).
2. `/plugin uninstall telegram-topics@claude-telegram-topics`.
3. Delete `~/.claude/channels/telegram-topics/` — **it contains the bot token**
   (`.env`), plus the topic map and downloaded attachments. Plugin removal does
   not touch it.
4. Optionally revoke the token in [@BotFather](https://t.me/BotFather)
   (`/revoke`) and delete the forum topics.

## Security notes

- The bot token only ever reaches `api.telegram.org`. The control API binds to
  `127.0.0.1` only.
- The loopback control API is **unauthenticated** — any local process can reach
  it. Fine for a single-user machine; do not run on shared/multi-user hosts as-is.
- `send_file` refuses paths inside the state dir (won't leak the token).
- Remote session launch (`/start`, the ▶️ button, autostart) executes
  `TG_TOPICS_LAUNCH_CMD` on your machine. Launch targets are a project already in
  `topics.json` **or**, via `/start <path>`, any directory under a
  `TG_TOPICS_LAUNCH_ROOTS` trusted root (default-deny, `..`-traversal-proof) —
  so treat allowlist membership as "may start Claude Code at any path under the
  trusted roots". Note the **default empty allowlist is fail-open**,
  so on a shared group this means any member can launch sessions too, not just
  send messages — set an allowlist if that matters.
- Use a **dedicated bot token** for this plugin. Reusing the same token as
  another running Telegram integration (e.g. the official plugin — which polls
  whenever it is *enabled*, in every session) makes two pollers fight over
  `getUpdates` — Telegram returns persistent 409 Conflict.
- The tool-approval relay trusts whoever can tap a button in the topic. On a
  private group that is just you; if the group has other members, restrict
  approvals with an explicit allowlist (`/telegram-topics:access allow <id>`).
- Uninstalling the plugin does **not** delete the stored token — see Uninstall.

## Limitations

- A not-yet-answered `🔐 Permission` prompt dies with its leader (the tap then
  answers "Request no longer available" — honest, but the prompt must be
  re-triggered). Re-election after a leader death is bounded by one poll cycle
  (~30 s); messages sent to a session-less project are queued for 30 min rather
  than lost.
- One forum group per machine (all projects share it, one topic each).
- Remote session launch is Windows-only.
- A **user interrupt** (Esc), a hang, or a hard crash fire no Claude Code hook,
  so — unlike an API error, which raises a `⚠️` notice via `StopFailure` — those
  cases aren't signalled to Telegram; the working badge falls back to 🟢 on its
  120 s TTL.
- Outbound, inbound streaming, choice buttons, reply routing and reactions are
  live-tested. The tool-approval relay was live-verified on an earlier build; its
  0.8.0 re-registration-routing hardening is unit-tested, live re-test pending.

## Development

```
bun install
bun run typecheck
bun test
```

Tests are hermetic: `bunfig.toml` preloads `test/preload.ts`, which pins the
state dir, port and credentials to throwaway values so the suite can never
touch a live channel.

## License

[Apache-2.0](./LICENSE). Derivative work — see [`NOTICE`](./NOTICE).
