// Pull the turn's user-facing answer out of a Claude Code transcript.
//
// The transcript is JSONL; each assistant turn is one or more `{"type":"assistant",
// "message":{"content":[...]}}` entries interleaved with tool results (recorded as
// `{"type":"user"}` entries carrying a tool_result block). A SINGLE turn can emit
// several text blocks separated by tool calls — "Результат теста…" → run tcpdump →
// "Два варианта…" → run again → "Вердикт…". The console (TUI) renders every one of
// them, so a faithful mirror (console ↔ Telegram, byte-for-byte) must carry every
// one too — not only the last. Posting just the final block silently dropped the
// substance of multi-step turns: the phone saw a trailing fragment while the
// console held the full answer. Thinking and tool_use blocks are ignored; only
// `text` blocks are returned.
//
// Bounded to the CURRENT turn: the walk stops at the most recent real user prompt
// (a `user` entry whose content is a string, or an array with no tool_result), so
// a turn that produced no text returns "" (mirror nothing) instead of reaching
// back into the previous turn's answer.
//
// Pure and dependency-free so the Stop hook and a unit test share one definition.

function isRealUserPrompt(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    // A tool_result is also recorded as a `user` entry — it is NOT a turn
    // boundary. A real prompt carries no tool_result block.
    return !content.some((b) => b && (b as { type?: unknown }).type === "tool_result");
  }
  return false;
}

function textOf(content: unknown[]): string {
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

// Every assistant text block of the current turn, in chronological order, each
// trimmed, empties dropped. Walks from the end of the JSONL back to the turn
// boundary (the most recent real user prompt). This is the whole answer the
// console showed — the mirror posts all of it, not just the tail.
export function turnTextBlocks(jsonl: string): string[] {
  const lines = jsonl.split("\n");
  const blocks: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially-written or non-JSON line — skip it
    }
    const e = entry as { type?: unknown; message?: { content?: unknown } };
    if (e?.type === "user") {
      // Real user prompt → turn boundary: stop before crossing into the previous
      // turn. A tool_result user entry is still inside this turn.
      if (isRealUserPrompt(e.message?.content)) break;
      continue;
    }
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const text = textOf(content).trim();
    if (text) blocks.push(text); // collected newest-first
  }
  blocks.reverse(); // → chronological
  return blocks;
}

// The single last assistant text block of the current turn (a primitive, kept for
// callers/tests that want only the concluding block). "" when the turn produced
// no text.
export function lastAssistantText(jsonl: string): string {
  const blocks = turnTextBlocks(jsonl);
  return blocks.length ? blocks[blocks.length - 1]! : "";
}

// Whitespace-insensitive equality, used only to decide whether the Stop payload's
// final block is already present as the transcript's last block. Claude Code joins
// a multi-text-block final message its own way for the payload, while the
// transcript joins that same message's blocks with "" in one entry — so an exact
// compare would see them as different and duplicate the final message. Comparing
// with all whitespace stripped recognises them as one.
const squash = (s: string): string => s.replace(/\s+/g, "");

// The text the Stop hook mirrors: the WHOLE current turn.
//
// Base is `turnTextBlocks` from the transcript — every in-turn text block, joined
// with a blank line, so the phone gets the same multi-step answer the console
// shows. The Stop payload's `last_assistant_message` (Claude Code 2.1.47+: the
// text of the turn's last in-memory assistant message, trimmed; omitted when there
// is none) is used only to BACKFILL the final block: Stop can fire before the
// turn's last entry is written to the JSONL, and the transcript walk would then
// miss it (or, with nothing of the turn on disk yet, return nothing). It is
// appended only when it is not already the turn's last block (whitespace-insensitive
// compare), so a fully-flushed turn is not duplicated.
//
// Degradation: if reading the transcript throws, the payload — when present — is
// still mirrored on its own (better the final answer than nothing); only with no
// payload either does the error reach the caller (the hook then skips silently, as
// before). Result is trimmed, so both paths hand the leader the same shape of text
// (its lastMirrored de-dupe compares byte-for-byte).
export function finalAnswerText(lastAssistantMessage: unknown, readTranscript: () => string): string {
  const tail = typeof lastAssistantMessage === "string" ? lastAssistantMessage.trim() : "";
  let blocks: string[];
  try {
    blocks = turnTextBlocks(readTranscript());
  } catch (err) {
    if (tail) return tail; // transcript unreadable but we still have the final answer
    throw err; // no payload to fall back on — surface to the hook (it skips)
  }
  if (tail && (blocks.length === 0 || squash(blocks[blocks.length - 1]!) !== squash(tail))) {
    blocks.push(tail);
  }
  return blocks.join("\n\n").trim();
}
