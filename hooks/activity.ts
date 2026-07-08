// Activity hook — reports this session's working/idle state to the
// telegram-topics leader so its topic-name badge (⏳ working / 🟢 ready)
// reflects what Claude is ACTUALLY doing. The Claude Code channel protocol
// carries no working/idle signal, so hooks are the only reliable source for
// console-driven turns.
//
// Wired (hooks/hooks.json): UserPromptSubmit + PreToolUse -> "working" (the
// second re-arms the leader's working-TTL through long turns); Stop -> "idle";
// StopFailure -> "failed" (an API error aborted the turn — Stop and StopFailure
// are mutually exclusive, so this cleanly flags a failed turn).
//
// CONTRACT: this runs on every prompt and every tool call, so it MUST be
// fire-and-forget — a 300ms timeout, all errors swallowed, always exit 0. It
// must never delay or fail a turn.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromCwd } from "../src/projectkey.ts";

// The control port the leader listens on — env wins, else the channel .env
// (a custom port may live only there), else the 8787 default. Mirrors
// config.ts precedence without importing it (config.ts has load-time side
// effects unwanted in a per-tool hook).
function resolvePort(): number {
  const fromEnv = process.env.TG_TOPICS_PORT?.trim();
  if (fromEnv) return Number(fromEnv) || 8787;
  const stateDir =
    process.env.TG_TOPICS_STATE_DIR?.trim() ||
    join(
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
      "channels",
      "telegram-topics",
    );
  try {
    const env = readFileSync(join(stateDir, ".env"), "utf8");
    const m = env.match(/^\s*TG_TOPICS_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]) || 8787;
  } catch {
    // no .env — fall through to the default
  }
  return 8787;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const state = arg === "idle" ? "idle" : arg === "failed" ? "failed" : "working";
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
