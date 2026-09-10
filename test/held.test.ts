import { describe, expect, test } from "bun:test";
import { parseHeld } from "../src/held.ts";

const TTL = 30 * 60_000;
const now = 1_000_000_000_000;
const msg = (messageId: number) => ({
  type: "message" as const,
  from: "u",
  text: "hi",
  messageId,
  ts: now,
});

describe("parseHeld (held-queue restore across a leader hand-off, 0.20.4)", () => {
  test("restores fresh entries with their messages", () => {
    const raw = { "c:/p/a": { msgs: [msg(1), msg(2)], at: now - 60_000 } };
    const m = parseHeld(raw, now, TTL);
    expect(m.get("c:/p/a")?.msgs.map((x) => x.messageId)).toEqual([1, 2]);
  });

  test("drops entries older than the TTL (expired while there was no leader)", () => {
    const raw = {
      fresh: { msgs: [msg(1)], at: now - 60_000 },
      stale: { msgs: [msg(2)], at: now - TTL - 1 },
    };
    const m = parseHeld(raw, now, TTL);
    expect([...m.keys()]).toEqual(["fresh"]);
  });

  test("skips malformed entries and empty queues, never throws", () => {
    const raw = {
      good: { msgs: [msg(1)], at: now },
      noAt: { msgs: [msg(2)] },
      notArr: { msgs: "x", at: now },
      badMsg: { msgs: [{ nope: true }], at: now },
      empty: { msgs: [], at: now },
    };
    const m = parseHeld(raw, now, TTL);
    expect([...m.keys()]).toEqual(["good"]);
  });

  test("garbage input yields an empty map", () => {
    expect(parseHeld(null, now, TTL).size).toBe(0);
    expect(parseHeld("nope", now, TTL).size).toBe(0);
    expect(parseHeld(42, now, TTL).size).toBe(0);
  });

  test("the incident: a message held just before a hand-off survives", () => {
    // Held 8s before the leader changed — well inside TTL, must be restored.
    const raw = { "c:/users/naive/claude/greensms_my": { msgs: [msg(7465)], at: now - 8_000 } };
    const m = parseHeld(raw, now, TTL);
    expect(m.get("c:/users/naive/claude/greensms_my")?.msgs[0]?.messageId).toBe(7465);
  });
});
