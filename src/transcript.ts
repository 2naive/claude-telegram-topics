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

// The model's explicit "post nothing": a turn whose ENTIRE answer is this
// marker is deliberately silent and the mirror hook does not post it.
// The auto-mirror posts the last text of every turn, so a turn with nothing to
// report — a scheduled check that found no change, a background-task
// notification — would otherwise push "no changes" to the phone each time.
// The marker still shows in the console. Exact match only (case and
// surrounding whitespace aside): "[quiet] and more" is an answer.
const QUIET_MARKER = "[quiet]";

export function isQuietMarker(text: string): boolean {
  return text.trim().toLowerCase() === QUIET_MARKER;
}

// The text the Stop hook should mirror. Claude Code (2.1.47+) passes the final
// answer IN the Stop payload as `last_assistant_message` — the text blocks of
// the last in-memory assistant message, trimmed; omitted when there is none. It
// is built from the in-memory conversation, not from the JSONL, so it does not
// depend on the transcript write (the hooks reference recommends it over
// transcript_path for exactly this): at the moment Stop fires the JSONL may not
// yet hold the turn's final entry, and the walk-back above then returns "" (the
// answer is silently not mirrored) or, in a turn with tool calls, an earlier
// in-turn narration ("Let me check…") instead of the answer. Using the payload
// also spares reading a long transcript on every turn.
//
// Unlike lastAssistantText, Claude Code does not bound the field to the current
// turn: it is the last assistant message of the whole conversation. That keeps
// the 0.10.1 guarantee only because, as far as we can tell from its (minified)
// source, every Stop follows at least one assistant message of the current
// turn, and a text-less one (tool-only, thinking-only) omits the field, which
// falls back to the turn-bounded lastAssistantText. A user interrupt does not
// fire Stop at all, and API errors fire StopFailure (per the hooks reference).
// A successful response with no content blocks at all was not verified.
//
// Falls back to the transcript when the field is missing (an older Claude Code,
// or a last message without text), not a string, or blank — exactly the
// previous behaviour. The reader is lazy so the file is not touched when the
// payload already carries the answer; a reader error propagates to the caller
// (the hook skips silently, as before). Trimmed like lastAssistantText, so both
// paths hand the leader the same shape of text (its lastMirrored de-dupe
// compares byte-for-byte).
export function finalAnswerText(lastAssistantMessage: unknown, readTranscript: () => string): string {
  const direct = typeof lastAssistantMessage === "string" ? lastAssistantMessage.trim() : "";
  if (direct) return direct;
  return lastAssistantText(readTranscript());
}
