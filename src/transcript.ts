// Pull the turn's final, user-facing answer out of a Claude Code transcript.
//
// The transcript is JSONL; each assistant turn is one or more `{"type":"assistant",
// "message":{"content":[...]}}` entries interleaved with tool results. The last
// assistant message with visible text is the concluding answer — narration like
// "let me check X" before a tool call sits in earlier entries and is skipped.
// Thinking and tool_use blocks are ignored; only `text` blocks are returned.
//
// Pure and dependency-free so the Stop hook and a unit test share one definition.
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
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
    // Keep walking past a text-less assistant message (tool_use/thinking only) to
    // the real answer; stop at the first assistant entry that actually spoke.
    if (text.trim()) return text.trim();
  }
  return "";
}
