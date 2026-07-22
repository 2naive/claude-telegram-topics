# Changelog

## 0.12.1 — 2026-07-22

- **Resume flag no longer swallowed by the channels flag.**
  `--dangerously-load-development-channels` is variadic — it consumes every
  following token as a channel name, flag-shaped ones included. The 0.11.0
  relaunch appended `--continue` after it, so claude tried to load a channel
  called `--continue` (error popup at launch) and started WITHOUT resuming.
  `--continue` is now inserted before the variadic (appended only when the
  custom command has no such flag).

## 0.12.0 — 2026-07-22

Fixes a live outage: several concurrent sessions (plus one on another device on
the same bot token) fell into a `getUpdates` **409 thrash** — leadership hopped
between sessions every ~20 s for 15 min and inbound Telegram messages stopped
arriving. The churn also minted duplicate and junk topics.

- **409/401 back-off is now cross-process.** A token-level conflict means another
  consumer holds the token (another device, or a force-killed sibling whose
  getUpdates is still open server-side for ~50 s). The 60 s cooldown was
  per-process, so when one leader freed the port another session grabbed it and
  re-collided — a leaderless thrash that never recovered. The cooldown is now
  persisted (`poller.cooldown`) and honored by **every** local session, so the
  token gets a quiet window and the next single retry succeeds instead of
  cascading. Benign network blips stay per-process.
- **No more junk topics from unresolved identity.** Claude Code spawns plugin MCP
  servers with cwd = `~/.claude`, so a session whose identity hasn't resolved
  yet used to register that fallback path and mint a garbage topic (`~/.claude`,
  `.claude`, the plugin cache dir). Such keys are now refused at creation, not
  registered by the client, and dropped from `topics.json` on load — the map
  self-heals. (The forum topics themselves are cleaned separately.)
- **Duplicate topics under churn are deduped.** Topic creation re-reads the
  on-disk map right before creating and reuses an entry a sibling persisted since
  load; recreation adopts a sibling's fresh topic instead of minting another.
  Combined with the thrash fix, the same project no longer spawns 5–6 topics.

## 0.11.0 — 2026-07-15

- **Relaunches resume the conversation.** When a project session is brought back
  — autostart on an inbound message, or the "▶️ Start session" button — the
  launch now appends `--continue`, so the session picks up its most recent
  conversation in that directory instead of starting blank. This is the recovery
  path after a reboot or crash killed a long-running session: message the topic
  (or tap Start) and the same conversation resumes. A brand-new `/start <path>`
  still starts fresh. An operator `TG_TOPICS_LAUNCH_CMD` that already selects a
  conversation (`-c`/`--continue`/`-r`/`--resume`) is left untouched.

## 0.10.2 — 2026-07-11

- **Hookless-session warning.** Plugin hooks load at session start, so a session
  started before the auto-mirror hook existed fires no mirror — and with manual
  duplication now off, its answers would silently never reach the topic (a green
  badge and no reply). The leader now detects this: when a Telegram-routed turn
  on a project produces no hook activity within a grace window, it posts a
  one-time (per topic, hourly) notice to restart that session. Restarting loads
  the hook and enables auto-mirror. (A console-driven hookless turn is invisible
  to the leader, so restarting a pre-0.10.0 session is the real fix.)
- All plugin-emitted notices are English (a few new ones were briefly Russian).

## 0.10.1 — 2026-07-11

Auto-mirror content-hardening — an adversarial audit (10 content categories,
each run through the real formatter, 31 verified findings) closed the ways a
mirrored answer could arrive mangled, empty, or silently dropped. Because manual
duplication is now off, the mirror is the only phone copy, so these matter.

- **Failures are now visible and never truncate the answer.** A mid-stream send
  error no longer aborts the rest of the message; every non-recoverable failure
  posts a cooldown-guarded `⚠️ Answer only partially mirrored (k/N)` notice, and
  a deleted/closed topic is recreated and retried (the mirror path had no
  recovery). Rejected entities fall back to plain text. Delivery is split into a
  pure, unit-tested orchestrator (`src/mirror.ts`).
- **Tables are adapted.** GFM tables — which Telegram can't render and which used
  to arrive as a wall of pipes — become an aligned monospace grid in one `pre`
  block (columns padded, every cell preserved, `\|` handled). This also fixes a
  stray `*` in a cell italicizing across rows.
- **Code fences no longer cascade.** A stray ` ``` ` inside a fenced block used to
  re-pair with the next block and corrupt everything after it; a length-aware
  line scanner handles ` ``` `/` ```` ` fences correctly and caps the info-string.
- **Emoji/symbol-led emphasis opens** (`**✅ Done**`, `_😀 note_`, astral) instead
  of leaking literal `**`.
- **Link fixes:** URLs with a balanced paren keep their `)`
  (`…_(disambiguation)`), images `![alt](url)` drop the `!`, `<https://…>`
  autolinks drop the brackets, and an empty-bodied link shows its URL.
- **Robustness:** C0 control chars (a NUL would 400-drop the whole answer) are
  stripped; a whitespace-only render/chunk falls back instead of sending an empty
  message Telegram rejects; the inline scanner is de-quadratic'd and guards
  oversized input (a 200k `[` storm went from seconds to <1ms — it ran
  synchronously and froze the single-threaded leader); a huge answer is attached
  as a `.md` file instead of flooding the topic with pushes; a re-fired Stop
  won't double-post; and the transcript reader is bounded to the current turn so
  a tool-only/interrupted turn can't mirror the previous turn's answer.
- UNC paths (`\\server\share`) keep their doubled backslashes.

## 0.10.0 — 2026-07-11

- **Console → Telegram auto-mirror.** The turn's final answer is posted to the
  topic **verbatim from the transcript** by the `Stop` hook, instead of the model
  re-typing it with `send_message`. Re-typing drifted — dropped steps, reworded
  lines, different counts between what you saw in the console and on your phone
  (a real hazard when the two must agree, e.g. instructions or figures). The
  mirror sends the exact assistant text, rendered through the same entity
  formatter as every other message.
  - New `Stop` hook `hooks/mirror.ts` reads the transcript's last assistant
    message (`src/transcript.ts`, a pure, unit-tested extractor) and POSTs it to
    the leader's new `/mirror` endpoint. Fire-and-forget: a bounded read + one
    localhost POST, always exits 0, never delays a turn.
  - **No double-posting.** If the session already sent something itself this turn
    — a `send_message` with buttons, a file, an `edit` — the mirror stands down;
    the model's own message is authoritative. Tracked by a per-project "spoke
    this turn" flag, reset at each turn start (`UserPromptSubmit` for a console
    turn, inbound routing for a Telegram turn).
  - `UserPromptSubmit` now pings the leader with `start` (a turn boundary) rather
    than `working`; `PreToolUse` still sends `working` (the TTL heartbeat). Older
    leaders treat `start` as `working`, so the change is backward compatible.
- **Adopting it:** drop the "manually duplicate every answer" convention — let
  the hook mirror the final text and use `send_message` only for buttons, files,
  or edits. Until you do, the mirror stays dormant (the manual copy sets the
  "spoke" flag and the mirror skips), so nothing double-posts during the switch.
- `resolvePort` is now shared by both hooks (`hooks/port.ts`).

## 0.9.3 — 2026-07-10

- **Badge no longer flips to 🟢 mid-turn.** The working-state TTL was 2 minutes;
  a long turn whose final generation runs longer than that between tool calls
  (which re-arm it) expired the timer and showed a busy topic as ready before
  its reply arrived. The `Stop`/`StopFailure` hooks return the badge to idle
  reliably at turn end (now verified live from `leader.log`), so the TTL is only
  a backstop for turns that fire no terminal hook at all (Esc-interrupt, hang,
  crash) — raised to 15 minutes, so it never trips on real work while a genuine
  hang still clears within it.
- **Quieter logs**: a `TOPIC_NOT_MODIFIED` from the first badge edit after a
  leader hand-off (the topic name already carries the glyph) is treated as
  success instead of logged as `badge.fail`.
- **Activity hooks confirmed**: `leader.log` now shows `activity working/idle`
  and `badge` transitions on every turn, verifying that this Claude Code build
  honors the plugin-shipped hooks — the load-bearing assumption behind the 0.9.0
  working/idle badge and the 0.9.1 turn-failure notice.

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
- **Non-ASCII fenced languages**: a Cyrillic/CJK info-string (any non-ASCII) now
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
