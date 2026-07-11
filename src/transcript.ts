// Pull the turn's final, user-facing answer out of a Claude Code transcript.
//
// The transcript is JSONL; each assistant turn is one or more `{"type":"assistant",
// "message":{"content":[...]}}` entries interleaved with tool results (recorded as
// `{"type":"user"}` entries carrying a tool_result block). The last assistant
// message with visible text is the concluding answer — narration like "let me
// check X" before a tool call sits in earlier entries. Thinking and tool_use
// blocks are ignored; only `text` blocks are returned.
//
// Bounded to the CURRENT turn: the walk stops at the most recent real user prompt
// (a `user` entry whose content is a string, or an array with no tool_result), so
// a turn that ends without producing any text — an interrupted/tool-only turn, a
// whitespace-only final block, a truncated last line — returns "" (mirror nothing)
// instead of silently re-posting the PREVIOUS turn's answer.
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

export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split("\n");
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
      // Real user prompt → turn boundary: stop before crossing into the
      // previous turn. A tool_result user entry is still inside this turn.
      if (isRealUserPrompt(e.message?.content)) break;
      continue;
    }
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const text = textOf(content).trim();
    // The last assistant message in this turn that actually spoke; text-less
    // (tool_use/thinking-only) entries are skipped, staying within the turn.
    if (text) return text;
  }
  return "";
}
