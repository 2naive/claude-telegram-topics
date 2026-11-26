import { describe, expect, test } from "bun:test";
import { coalesce } from "../src/coalesce.ts";
import type { Inbound } from "../src/leader.ts";

const T = 1_000_000_000_000;
const msg = (messageId: number, text: string, dt = 0, from = "u"): Inbound => ({
  type: "message",
  from,
  text,
  messageId,
  ts: T + dt,
});

describe("coalesce (burst of separate Telegram messages → one channel tag)", () => {
  test("a forwarded text + the photo 0.7 s later become one item", () => {
    const out = coalesce([msg(1, "make this photo too"), msg(2, "[photo] saved:/x.jpg", 700)], 1200);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ messageId: 1, text: "make this photo too\n[photo] saved:/x.jpg", mergedIds: [1, 2] });
  });

  test("a chain is measured message to message, not from the first one", () => {
    const out = coalesce([msg(1, "a"), msg(2, "b", 1000), msg(3, "c", 2000)], 1200);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ mergedIds: [1, 2, 3], text: "a\nb\nc" });
  });

  test("messages further apart than the window stay separate", () => {
    const out = coalesce([msg(1, "a"), msg(2, "b", 5000)], 1200);
    expect(out.map((m) => m.messageId)).toEqual([1, 2]);
    expect(out.every((m) => !("mergedIds" in m))).toBe(true);
  });

  test("different senders are never merged", () => {
    const out = coalesce([msg(1, "a", 0, "u1"), msg(2, "b", 100, "u2")], 1200);
    expect(out).toHaveLength(2);
  });

  test("buttons, reactions and permission decisions are passed through and break a run", () => {
    const btn: Inbound = { type: "callback", from: "u", data: "yes", messageId: 5, ts: T + 100 };
    const perm: Inbound = { type: "permission", requestId: "r", behavior: "allow", messageId: 6, ts: T + 150 };
    const out = coalesce([msg(1, "a"), btn, perm, msg(2, "b", 200)], 1200);
    expect(out.map((m) => m.type)).toEqual(["message", "callback", "permission", "message"]);
  });

  test("window 0 disables coalescing (returns the input as is)", () => {
    const input = [msg(1, "a"), msg(2, "b", 10)];
    expect(coalesce(input, 0)).toBe(input);
  });

  test("a single message is untouched", () => {
    const out = coalesce([msg(1, "a")], 1200);
    expect(out).toEqual([msg(1, "a")]);
  });
});
