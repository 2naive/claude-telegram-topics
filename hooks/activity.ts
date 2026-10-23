// Activity hook — reports this session's working/idle state to the
// telegram-topics leader so its topic-name badge (⏳ working / 🟢 ready)
// reflects what Claude is ACTUALLY doing. The Claude Code channel protocol
// carries no working/idle signal, so hooks are the only reliable source for
// console-driven turns.
//
// Wired (hooks/hooks.json): UserPromptSubmit -> "start" (turn boundary — the
// leader resets its "spoke this turn" flag and marks working); PreToolUse ->
// "working" (re-arms the leader's working-TTL through long turns); Stop ->
// "idle"; StopFailure -> "failed" (an API error aborted the turn — Stop and
// StopFailure are mutually exclusive, so this cleanly flags a failed turn).
//
// CONTRACT: this runs on every prompt and every tool call, so it MUST be
// fire-and-forget — a 300ms timeout, all errors swallowed, always exit 0. It
// must never delay or fail a turn. Its own worst case is bounded (git 3s +
// fetch 0.3s + bun startup, ~0.33s idle) and sits well under the hooks.json
// `timeout` (15s), so that timeout only fires when the whole machine is starved
// — a `--continue` console cold-starting a big transcript (2–14s observed) —
// and then waiting beats discarding the signal. The PreToolUse heartbeat is
// `async` (Claude Code doesn't wait for it), so tool calls don't pay its
// startup; the turn-boundary hooks stay synchronous because their ORDER
// matters (start before the turn's first send_message, idle before the next
// start).

import { keyFromCwd } from "../src/projectkey.ts";
import { resolvePort } from "./port.ts";

const STATES = new Set(["start", "idle", "failed", "working"]);

async function main(): Promise<void> {
  const arg = process.argv[2];
  const state = STATES.has(arg ?? "") ? arg! : "working";
  // CLAUDE_PROJECT_DIR is the session's project root; keyFromCwd resolves it to
  // the git top-level (the same key the leader registered), so a subdirectory
  // cwd still maps to the right topic. Falls back to process.cwd() on older
  // Claude Code that doesn't export it (hooks run in the project dir anyway).
  const cwd = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const project = keyFromCwd(cwd);
  const port = resolvePort();
  try {
    await fetch(`http://127.0.0.1:${port}/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, state }),
      signal: AbortSignal.timeout(300),
    });
  } catch {
    // leader down, no session for this project, or timeout — silently no-op
  }
}

main().finally(() => process.exit(0));
