import { expect, test } from "bun:test";
import { isQuietMarker, lastAssistantText } from "../src/transcript.ts";

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

// --- the `[quiet]` marker: a turn that deliberately posts nothing ---
//
// The mirror hook skips a turn whose whole answer is the marker, so a scheduled
// check with nothing to report can end its turn without pushing "no changes"
// to the topic. Exact match only — the marker next to other text is an answer.

test("isQuietMarker: the marker alone, in any case and padding, is quiet", () => {
  expect(isQuietMarker("[quiet]")).toBe(true);
  expect(isQuietMarker("[QUIET]")).toBe(true);
  expect(isQuietMarker("  [Quiet]\n")).toBe(true);
});

test("isQuietMarker: the marker with anything else around it is an answer", () => {
  expect(isQuietMarker("[quiet] and more")).toBe(false);
  expect(isQuietMarker("All good. [quiet]")).toBe(false);
  expect(isQuietMarker("[quiet].")).toBe(false);
  expect(isQuietMarker("quiet")).toBe(false);
});

test("isQuietMarker: empty and whitespace-only text is not the marker (the hook skips it anyway)", () => {
  expect(isQuietMarker("")).toBe(false);
  expect(isQuietMarker("   ")).toBe(false);
});

test("a turn that ends on the marker extracts as the marker, so the hook stays quiet", () => {
  const jsonl = [
    userPrompt("q1"),
    asst([text("ANSWER ONE")]),
    userPrompt("check again"),
    asst([text("Checking."), tool("Bash")]),
    toolResult(),
    asst([text("[quiet]")]),
  ].join("\n");
  const t = lastAssistantText(jsonl);
  expect(t).toBe("[quiet]");
  expect(isQuietMarker(t)).toBe(true);
});
