import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

// The hermetic state dir is pinned by test/preload.ts before any import.
const { SENT_FILE } = await import("../src/config.ts");
const sent = await import("../src/sent.ts");

describe("sent store", () => {
  test("tracks topic, session, and options as one record", () => {
    sent.loadSent(); // start clean
    sent.trackSent(10, { topicId: 31, sessionId: "aaa", options: ["yes", "no"] });
    sent.trackSent(11, { topicId: 31, sessionId: "bbb" });
    expect(sent.topicForSentMessage(10)).toBe(31);
    expect(sent.sessionForSentMessage(11)).toBe("bbb");
    expect(sent.topicForSentMessage(99)).toBeUndefined();
  });

  test("takeOptions returns the labels once and consumes them", () => {
    sent.loadSent();
    sent.trackSent(20, { topicId: 5, sessionId: "s", options: ["a", "b"] });
    expect(sent.takeOptions(20)).toEqual(["a", "b"]);
    expect(sent.takeOptions(20)).toBeUndefined(); // consumed
    expect(sent.topicForSentMessage(20)).toBe(5); // record itself survives
  });

  test("remapSentSessions moves ownership to the re-registered id", () => {
    sent.loadSent();
    sent.trackSent(30, { topicId: 1, sessionId: "old" });
    sent.trackSent(31, { topicId: 1, sessionId: "other" });
    sent.remapSentSessions("old", "new");
    expect(sent.sessionForSentMessage(30)).toBe("new");
    expect(sent.sessionForSentMessage(31)).toBe("other");
  });

  test("survives a flush/load round-trip; unflushed writes are the loss bound", () => {
    sent.loadSent();
    sent.trackSent(40, { topicId: 7, sessionId: "s1", options: ["x"] });
    sent.flushSent();
    sent.trackSent(41, { topicId: 7, sessionId: "s2" });
    sent.loadSent(); // simulates the next leader loading the flushed state
    expect(sent.topicForSentMessage(40)).toBe(7);
    expect(sent.takeOptions(40)).toEqual(["x"]);
    expect(sent.topicForSentMessage(41)).toBeUndefined(); // was never flushed
  });

  test("a corrupt file loads as empty instead of crashing", () => {
    writeFileSync(SENT_FILE, "{not json");
    sent.loadSent();
    expect(sent.topicForSentMessage(40)).toBeUndefined();
  });

  test("bounded: overflow evicts oldest, consistent across all three facts", () => {
    sent.loadSent();
    for (let i = 0; i < 2001; i++) {
      sent.trackSent(i, { topicId: 1, sessionId: "s", options: ["o"] });
    }
    // Oldest entries evicted whole — no topic/session/options drift.
    expect(sent.topicForSentMessage(0)).toBeUndefined();
    expect(sent.takeOptions(0)).toBeUndefined();
    expect(sent.topicForSentMessage(2000)).toBe(1);
  });

  test("peekOptions reads labels without consuming them", () => {
    sent.loadSent();
    sent.trackSent(50, { topicId: 2, sessionId: "s", options: ["a", "b"] });
    expect(sent.peekOptions(50)).toEqual(["a", "b"]);
    expect(sent.peekOptions(50)).toEqual(["a", "b"]); // still there
    expect(sent.takeOptions(50)).toEqual(["a", "b"]); // consuming still works
    expect(sent.peekOptions(50)).toBeUndefined();
  });

  test("ownership gate: a demoted leader's debounced write never lands", async () => {
    // Behavioral pin, not just the flush round-trip: the mutation "delete the
    // owner gate in schedulePersist" kept the whole suite green because every
    // assertion ran inside the 1s debounce window. Here we outwait it and
    // check the FILE — the post-flush record must never reach disk.
    sent.loadSent();
    sent.trackSent(60, { topicId: 9, sessionId: "kept" });
    sent.flushSent(); // leadership released — this process no longer owns the file
    sent.trackSent(61, { topicId: 9, sessionId: "late" }); // demoted-leader write
    await Bun.sleep(1300); // outlive the 1s debounce
    const onDisk = JSON.parse(readFileSync(SENT_FILE, "utf8")) as Record<string, unknown>;
    expect(onDisk["60"]).toBeDefined();
    expect(onDisk["61"]).toBeUndefined();
  }, 5000);
});
