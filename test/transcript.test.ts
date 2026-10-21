import { expect, test } from "bun:test";
import { finalAnswerText, lastAssistantText, turnTextBlocks } from "../src/transcript.ts";

const line = (o: unknown) => JSON.stringify(o);
const asst = (blocks: unknown[]) => line({ type: "assistant", message: { content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string) => ({ type: "tool_use", name, input: {} });
const think = (t: string) => ({ type: "thinking", thinking: t });

test("returns the last assistant message's text", () => {
  const jsonl = [
    line({ type: "user", message: { content: "do the thing" } }),
    asst([text("Let me check."), tool("Read")]),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    asst([text("Here is the answer.")]),
  ].join("\n");
  expect(lastAssistantText(jsonl)).toBe("Here is the answer.");
});

test("skips a trailing tool-only assistant message to the real answer", () => {
  const jsonl = [
    asst([text("The final answer.")]),
    asst([tool("Bash")]), // e.g. a text-less entry after — walk back to the text
  ].join("\n");
  expect(lastAssistantText(jsonl)).toBe("The final answer.");
});

test("ignores thinking and tool_use blocks, keeps only text", () => {
  const jsonl = asst([think("reasoning..."), text("Visible reply."), tool("Grep")]);
  expect(lastAssistantText(jsonl)).toBe("Visible reply.");
});

test("joins multiple text blocks in one message", () => {
  const jsonl = asst([text("Part one. "), text("Part two.")]);
  expect(lastAssistantText(jsonl)).toBe("Part one. Part two.");
});

test("trims surrounding whitespace", () => {
  expect(lastAssistantText(asst([text("\n  spaced  \n")]))).toBe("spaced");
});

test("no assistant message yields empty string", () => {
  const jsonl = [line({ type: "user", message: { content: "hi" } })].join("\n");
  expect(lastAssistantText(jsonl)).toBe("");
});

test("survives blank and non-JSON lines", () => {
  const jsonl = ["", "not json {", asst([text("Solid.")]), "  "].join("\n");
  expect(lastAssistantText(jsonl)).toBe("Solid.");
});

test("empty input yields empty string", () => {
  expect(lastAssistantText("")).toBe("");
});

// --- turn-boundary bounding (0.10.1): never mirror a stale prior-turn answer ---

const userPrompt = (t: string) => line({ type: "user", message: { content: t } });
const toolResult = () =>
  line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });

test("a turn that produced no text returns '' — not the previous turn's answer", () => {
  const jsonl = [
    userPrompt("q1"),
    asst([text("ANSWER ONE")]),
    userPrompt("q2"),
    asst([tool("Bash")]), // turn 2 ends on a tool call, no final text
    toolResult(),
  ].join("\n");
  expect(lastAssistantText(jsonl)).toBe("");
});

test("returns the CURRENT turn's answer, not an earlier turn's", () => {
  const jsonl = [
    userPrompt("q1"),
    asst([text("ANSWER ONE")]),
    userPrompt("q2"),
    asst([text("Checking."), tool("Read")]),
    toolResult(),
    asst([text("ANSWER TWO")]),
  ].join("\n");
  expect(lastAssistantText(jsonl)).toBe("ANSWER TWO");
});

test("a tool_result user entry is not treated as a turn boundary", () => {
  const jsonl = [userPrompt("q"), asst([tool("Read")]), toolResult(), asst([text("Done.")])].join("\n");
  expect(lastAssistantText(jsonl)).toBe("Done.");
});

test("whitespace-only final text returns '' (not the prior turn)", () => {
  const jsonl = [userPrompt("q1"), asst([text("REAL")]), userPrompt("q2"), asst([text("   ")])].join("\n");
  expect(lastAssistantText(jsonl)).toBe("");
});

// --- Stop payload first (last_assistant_message): no dependence on the transcript write ---

// A reader that records whether the transcript was touched.
function reader(jsonl: string) {
  let reads = 0;
  return {
    read: (): string => {
      reads++;
      return jsonl;
    },
    get reads() {
      return reads;
    },
  };
}

test("mirrors every in-turn text block, not just the last (the fix)", () => {
  // A multi-step turn: text → tool → text → tool → text. The console shows all
  // three blocks; the mirror must too (byte-for-byte console ↔ Telegram).
  const jsonl = [
    userPrompt("diagnose"),
    asst([text("Результат теста: ноль входящих."), tool("Bash")]),
    toolResult(),
    asst([text("Два варианта: A или B."), tool("Bash")]),
    toolResult(),
    asst([text("Вердикт: приём не настроен.")]),
  ].join("\n");
  expect(finalAnswerText("Вердикт: приём не настроен.", reader(jsonl).read)).toBe(
    "Результат теста: ноль входящих.\n\nДва варианта: A или B.\n\nВердикт: приём не настроен.",
  );
});

test("the whole turn is read, including blocks the payload omits", () => {
  // The payload only ever carries the LAST message; earlier blocks come from the
  // transcript, so the transcript is always consulted.
  const r = reader(
    [userPrompt("q"), asst([text("earlier"), tool("Read")]), toolResult(), asst([text("last")])].join("\n"),
  );
  expect(finalAnswerText("last", r.read)).toBe("earlier\n\nlast");
  expect(r.reads).toBe(1);
});

test("does not duplicate the final block when the payload equals it", () => {
  const jsonl = [
    userPrompt("q"),
    asst([text("Step one."), tool("Read")]),
    toolResult(),
    asst([text("Final.")]),
  ].join("\n");
  expect(finalAnswerText("Final.", reader(jsonl).read)).toBe("Step one.\n\nFinal.");
});

test("multi-text-block final message is not duplicated (whitespace-insensitive match)", () => {
  // Claude Code joins the final message's text blocks its own way for the payload;
  // the transcript joins that same message with '' in one entry. Compared with
  // whitespace stripped, the payload is recognised as already present.
  const jsonl = asst([text("Part one. "), text("Part two.")]);
  expect(finalAnswerText("Part one.\nPart two.", reader(jsonl).read)).toBe("Part one. Part two.");
});

test("backfills the final answer from the payload when the JSONL has not caught up (race)", () => {
  // Stop fired before the final entry hit the JSONL: the tail still ends at an
  // in-turn block + tool call. The earlier block is kept (the console showed it)
  // and the payload supplies the missing final answer.
  const stale = [userPrompt("q"), asst([text("Let me check."), tool("Read")]), toolResult()].join("\n");
  expect(lastAssistantText(stale)).toBe("Let me check.");
  expect(finalAnswerText("The real answer.", reader(stale).read)).toBe("Let me check.\n\nThe real answer.");
  // ...and with nothing of this turn on disk yet, the payload alone is mirrored.
  const empty = [userPrompt("q1"), asst([text("OLD")]), userPrompt("q2")].join("\n");
  expect(finalAnswerText("NEW", reader(empty).read)).toBe("NEW");
});

test("turn-bounded across multiple blocks: never reaches a previous turn", () => {
  const jsonl = [
    userPrompt("q1"),
    asst([text("PRIOR ANSWER")]),
    userPrompt("q2"),
    asst([text("now A"), tool("Bash")]),
    toolResult(),
    asst([text("now B")]),
  ].join("\n");
  expect(finalAnswerText("now B", reader(jsonl).read)).toBe("now A\n\nnow B");
});

test("turnTextBlocks returns the turn's text blocks in chronological order", () => {
  const jsonl = [
    userPrompt("q"),
    asst([text("one"), tool("Read")]),
    toolResult(),
    asst([think("x"), text("two")]),
  ].join("\n");
  expect(turnTextBlocks(jsonl)).toEqual(["one", "two"]);
});

test("missing field falls back to the transcript (older Claude Code)", () => {
  const r = reader([userPrompt("q"), asst([text("Transcript answer.")])].join("\n"));
  expect(finalAnswerText(undefined, r.read)).toBe("Transcript answer.");
  expect(r.reads).toBe(1);
});

test("field omitted on a text-less final message: fallback stays turn-bounded", () => {
  // Claude Code leaves the field out when the last assistant message has no
  // text (tool-only / thinking-only). The fallback must still not reach back
  // into the previous turn — the 0.10.1 guarantee holds on this path too.
  const jsonl = [
    userPrompt("q1"),
    asst([text("PREVIOUS ANSWER")]),
    userPrompt("q2"),
    asst([tool("Bash")]),
  ].join("\n");
  expect(finalAnswerText(undefined, reader(jsonl).read)).toBe("");
});

test("blank or non-string field falls back to the transcript", () => {
  const jsonl = asst([text("Transcript answer.")]);
  for (const v of ["", "  \n ", null, 42, { text: "x" }, ["x"]]) {
    expect(finalAnswerText(v, reader(jsonl).read)).toBe("Transcript answer.");
  }
});

test("payload text is trimmed like the transcript path (stable for the leader's de-dupe)", () => {
  expect(finalAnswerText("\n  Answer.  \n", reader("").read)).toBe("Answer.");
});

test("no field and nothing in the transcript yields empty string (mirror nothing)", () => {
  expect(finalAnswerText(undefined, reader("").read)).toBe("");
});

test("a transcript read error surfaces to the caller only on the fallback path", () => {
  const boom = () => {
    throw new Error("ENOENT");
  };
  expect(finalAnswerText("Answer.", boom)).toBe("Answer.");
  expect(() => finalAnswerText(undefined, boom)).toThrow("ENOENT");
});
