import { expect, test } from "bun:test";
import { lastAssistantText } from "../src/transcript.ts";

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
