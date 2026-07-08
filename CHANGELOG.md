# Changelog

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
