// Auto-mirror hook — on Stop, posts the turn's FINAL assistant message to the
// project's Telegram topic, byte-for-byte with the console. This replaces the
// old "manually re-send every answer via send_message" convention, which made
// the model retype its reply and drift (dropped steps, reworded, different
// counts — a real risk when the console and the phone must agree).
//
// The leader skips the mirror when the session already sent something itself
// this turn (send_message with buttons, a file, an edit), so interactive turns
// are not double-posted — the model's own message stands.
//
// CONTRACT: fire-and-forget. Reads the transcript, does one bounded localhost
// POST (the leader sends to Telegram asynchronously), always exits 0 — it must
// never delay or fail a turn.

import { readFileSync } from "node:fs";
import { keyFromCwd } from "../src/projectkey.ts";
import { lastAssistantText } from "../src/transcript.ts";
import { resolvePort } from "./port.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin().catch(() => "");
  let input: { transcript_path?: string; cwd?: string } = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return; // no hook payload — nothing to mirror
  }
  const transcriptPath = input.transcript_path?.trim();
  if (!transcriptPath) return;

  let text = "";
  try {
    // Whole-file read: transcripts are JSONL and typically small; a very long
    // session could make this heavier, but it stays well within the 5s hook
    // budget. lastAssistantText walks from the end, so only the tail is parsed.
    text = lastAssistantText(readFileSync(transcriptPath, "utf8"));
  } catch {
    return; // transcript unreadable — skip silently
  }
  if (!text.trim()) return;

  // Same project key the leader registered (git top-level), so the mirror lands
  // in the right topic even from a subdirectory cwd.
  const cwd = process.env.CLAUDE_PROJECT_DIR?.trim() || input.cwd?.trim() || process.cwd();
  const project = keyFromCwd(cwd);
  const port = resolvePort();
  try {
    await fetch(`http://127.0.0.1:${port}/mirror`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, text }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // leader down, no session/topic for this project, or timeout — silently
    // no-op; the answer still shows in the console.
  }
}

main().finally(() => process.exit(0));
