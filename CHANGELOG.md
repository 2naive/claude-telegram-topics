# Changelog

## 0.9.2 — 2026-07-08

- **Observability for the activity signal**: the leader now logs an `activity`
  entry on every `/activity` POST and a `badge` entry each time a topic-name
  badge changes (with `badge.fail` + the error if `editForumTopic` is rejected).
  This makes it verifiable from `leader.log` whether the plugin's hooks are
  actually firing — the load-bearing assumption behind the working/idle badge
  and the turn-failure notice — and surfaces any missing-permission failures.

## 0.9.1 — 2026-07-08

- **Turn-failure notice**: when a turn aborts with an API/model error (500,
  rate_limit, overloaded, max_tokens, …), the topic gets a `⚠️` alert instead of
  silently falling back to 🟢 — so a failure that used to be invisible in
  Telegram now pings you. Detected via the `StopFailure` hook (mutually
  exclusive with `Stop`, so success vs failure is unambiguous), rate-limited to
  one notice / 20 s / topic. A user interrupt (Esc), hang, or hard crash fire no
  Claude Code hook, so those remain unsignalled (documented).
- **Docs refreshed for 0.9.x**: the status-badge legend now appears in the
  narrative and the "Why", the `/start <path>` behaviour is corrected (it was
  described as impossible), `/status` is documented as covering every project +
  legend, the typing indicator as turn-long, and the permission-relay test
  status is reconciled between sections.
- **Discovery metadata**: `author`, expanded keywords and a phone-first
  description across `plugin.json`/`package.json`; `repository`/`homepage`/`bugs`
  added to `package.json`; owner URL in `marketplace.json`. Annotated release
  tags added.

## 0.9.0 — 2026-07-08

Topic-name status badge now distinguishes **working** from **idle** — the
0.8.2 badge showed 🟢 whenever a session existed, conflating "Claude is working"
with "session sitting idle".

- **Five shape-distinct states**, visible in the topic list: ⏳ working · 🟢
  ready · 🔔 needs you (a permission prompt is waiting) · 📥 queued (messages
  held, no session) · 💤 no session. `/status` gains a legend line.
- **Working/idle via hooks** (the channel protocol carries no such signal): the
  plugin ships `hooks/hooks.json` (auto-activates when the plugin is enabled) —
  `UserPromptSubmit` + `PreToolUse` → working, `Stop` → idle. Each fires a
  fire-and-forget `POST /activity` to the leader (300 ms timeout, always exits
  0, never blocks a turn). The leader also sets working itself for Telegram
  turns, so the badge is correct even if the hook doesn't fire for
  channel-injected prompts. A 120 s working-TTL (re-armed by each `PreToolUse`
  heartbeat) means a missed `Stop` degrades to 🟢, never a stuck ⏳.
- **Shared identity** (`src/projectkey.ts` `keyFromCwd`): the hook computes the
  exact project key the leader registers (`normalizePath ∘ git-top-level`), so
  the two never diverge; a parity test pins it.
- `🔔` needs-you is derived by the leader from a pending permission relay — no
  hook needed. Precedence: attention > working > ready > queued > offline.
- Upgrading from 0.8.2 strips the old 🟢/🟡/⚪ badges before re-tagging, so names
  don't stack glyphs. Opt out entirely with `TG_TOPICS_STATUS_ICONS=0`.

## 0.8.2 — 2026-07-08

Liveness & remote-launch improvements:

- **Turn-long typing indicator**: the `typing…` action is now re-asserted every
  ~4.5 s from an inbound message until the session replies (was a single ~5 s
  blip), so the phone shows Claude is still working through the whole turn. It
  is dropped the moment output arrives.
- **Topic-name status badge**: each bridged topic is prefixed with 🟢 (live
  session) / 🟡 (messages queued, no session) / ⚪ (idle) — the only per-topic
  signal Telegram renders in the topic **list**. Updated only on a real state
  change (one `editForumTopic` per session start/stop). Opt out with
  `TG_TOPICS_STATUS_ICONS=0`.
- **`/status` covers every bridged project**, not just the live ones — the
  overview now answers "which projects are being worked on and which are idle".
- **Launch a brand-new project from Telegram**: `/start <path>` bridges and
  launches a directory that isn't in `topics.json` yet. Gated by
  `TG_TOPICS_LAUNCH_ROOTS` (semicolon-separated trusted roots); **default-deny**
  and `..`-traversal-proof, because launching an arbitrary path named in a chat
  message is remote code-exec. Bare `/start` still shows the picker of already
  bridged projects.

## 0.8.1 — 2026-07-08

Formatting fidelity (second fuzz pass on the entity converter):

- **Windows paths survive verbatim**: `C:\Users\_naive_\App_Data` no longer
  loses its backslash — `\_` is treated as a literal path, not a markdown
  escape, and a `_` opens emphasis only after a real boundary (start,
  whitespace, opening bracket/quote), never after `\` or a word char.
- **Non-ASCII fenced languages**: ` ```питон ` (any non-ASCII info-string) now
  fences instead of leaking backtick markers.
- **Stacked delimiters nest fully**: `**_bold italic_**` and
  `~~**_all three_**~~` emit the full set of overlapping entities with no
  leftover `*`/`_`/`~` in the text.

## 0.8.0 — 2026-07-08

Features:

- **Formatting via explicit entities** (no more `parse_mode`): snake_case and
  file_names stay literal (`aaa_bbb_ccc` no longer renders with an italic
  middle), malformed markup degrades to plain text instead of a Telegram 400,
  and messages over 4096 chars split automatically at line boundaries.
- **Flood-control handling**: 429 `retry_after` and transient 5xx/network
  failures are retried with bounded backoff inside the API layer.
- **Liveness**: `/status` answered by the leader itself; a *typing…* indicator
  acknowledges routed inbound; a `📴 No active session` notice appears when a
  topic has no session.
- **Remote session launch** (Windows): `/start` lists bridged projects as
  buttons; the 📴 notice carries a ▶️ Start-session button;
  `TG_TOPICS_AUTOSTART=1` launches automatically. Launch command configurable
  via `TG_TOPICS_LAUNCH_CMD`; restricted to projects already in `topics.json`
  and allowlisted users.
- **Queued inbound**: messages to a session-less project are held (20 msgs /
  30 min) and delivered to the next session that registers, instead of being
  silently lost.
- **react** now works on the user's recent messages too (the "seen 👍" ack).
- **edit_message** keeps formatting, re-attaches unanswered choice buttons and
  treats "not modified" as success.

Fixes (from the 2026-07-08 audit):

- Inbound loop survives a failed first registration (retry with backoff) —
  previously one setup hiccup left inbound dead while outbound worked.
- Allowlist is re-read on a 15 s TTL: revocations apply to the live leader.
- Permission decisions survive session re-registration; a decision that cannot
  be delivered answers "Session is gone" instead of a false "✅ Allowed".
- Re-election cooldown after poller death (60 s on 409/401) kills the
  elect→die churn; topic recreate no longer drops the mapping before the new
  topic exists, and failed creates cool down 30 s (no more createForumTopic
  storms).
- Lost leader election now verifies the port holder is a real leader and names
  a port conflict (`TG_TOPICS_PORT`) instead of failing cryptically.
- Version hand-off: `bot.stop()` is raced against a 5 s deadline so a wedged
  getUpdates cannot hold the port hostage.
- Preflight moved into `scripts/preflight.ts`: CRLF-proof, distinguishes
  "group unreachable" from "not a forum", and detects a foreign poller (409).
- Hermetic test preload (`bunfig.toml`) — the suite can no longer touch a live
  channel; sent.json ownership gate now has a behavioral pin; package.json ↔
  plugin.json version parity is pinned by a test.

Docs: launch command corrected (the dev-channels flag replaces `--channels`;
option ordering), always-on-bridge behavior documented, Troubleshooting and
Uninstall sections, state-file reference (inbox 24 h retention, 20 MB cap),
env-precedence, official-plugin disable guidance, honest Limitations.

Hardening from the pre-release adversarial review of this diff:

- Formatting: whitespace-flanked `*`/`_` stay literal (`2 * 3 * 4`, `*.log`),
  the entity cap is applied per split message (long link lists keep their
  URLs), same-line triple-backticks no longer swallow their token, an empty
  fenced block never produces an empty send, `/edit` splits oversized text and
  falls back to unformatted, hard splits never sever a surrogate pair, and an
  escaped marker no longer leaks a backslash.
- A solo session recovers from poller death: the leader-election latch is
  cleared when registration fails at the connection level, so re-election runs
  again after the cooldown instead of leaving inbound permanently dead.
- Permission decisions resolve by the tapped message id, never a bare
  requestId scan that could approve a same-id call in another project.
- `/status` and `/start` use their handler's result, so a message merely
  starting with those words falls through to normal delivery.
- Remote launch quotes the window title — `start "…"` can no longer execute a
  file planted in the project directory (the old unquoted form both broke
  launch and was a code-exec risk).
- `probeLeader` treats a non-JSON 200 as a foreign server (named port error),
  the allowlist keeps its last list if the `.env` goes missing (no fail-open),
  and preflight's `getUpdates` probe no longer discards a queued message.

## 0.7.1 — 2026-07-07

- Control API responses send `connection: close`: a demoted leader can no
  longer serve a pooled long-poll forever (inbound black hole after a
  hand-off with no successor); leader death now surfaces within one poll
  cycle.

## 0.7.0 — 2026-07-07

- Survive `/reload-plugins`: layered teardown (stdin/transport/watchdog),
  pid-chain session identity, persisted routing state (`sent.json`),
  two-phase leader stop.

## 0.6.0 — 2026-07-07

- Version handshake: a session running newer code takes leadership over
  gracefully; `/health` reports version and pid.

## 0.5.x — 2026-07-07

- Leader diagnostics log; long-poll idle-timeout fix (re-registration storm);
  session identity from Claude Code's session records; choice-button UX.

## 0.1.0 – 0.4.0 — 2026-07-07

- Initial fork: leader/follower architecture, project→topic map, channel
  capability (inbound `<channel>` tags), choice buttons, permission relay,
  path-normalized project identity, `bun test` suite.
