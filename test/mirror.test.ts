import { describe, expect, test } from "bun:test";
import { mirrorChunks, type MirrorIO, type MirrorChunk, type MirrorErrorKind } from "../src/mirror.ts";

const chunk = (t: string): MirrorChunk => ({ text: t });

class GErr extends Error {
  constructor(public kind: MirrorErrorKind) {
    super(kind);
  }
}

// A scriptable IO: `fail` maps a 0-based send index to the error kind to throw
// on that attempt (once), so we can simulate mid-stream failures and recovery.
function makeIO(overrides: Partial<MirrorIO> & { failOn?: Record<number, MirrorErrorKind> } = {}) {
  const sends: Array<{ text: string; notify: boolean; entities: unknown }> = [];
  const state = { attaches: 0, recovers: 0, fails: 0, gap: null as null | { sent: number; total: number } };
  const failOn = overrides.failOn ?? {};
  let sendCount = 0;
  const io: MirrorIO = {
    async send(text, entities, notify) {
      const idx = sendCount++;
      if (failOn[idx]) {
        const kind = failOn[idx]!;
        delete failOn[idx]; // throw once, then succeed on retry
        throw new GErr(kind);
      }
      sends.push({ text, notify, entities });
    },
    async attach() {
      state.attaches++;
    },
    async recover() {
      state.recovers++;
    },
    classify: (e) => (e as GErr).kind,
    onFail: () => {
      state.fails++;
    },
    notifyGap: (sent, total) => {
      state.gap = { sent, total };
    },
    ...overrides,
  };
  return { io, sends, state };
}

describe("mirrorChunks", () => {
  test("all chunks succeed → every part sent, only the first notifies, no gap notice", async () => {
    const { io, sends, state } = makeIO();
    const r = await mirrorChunks([chunk("a"), chunk("b"), chunk("c")], "abc", 4, io);
    expect(r).toEqual({ sent: 3, failed: 0 });
    expect(sends.map((s) => s.text)).toEqual(["a", "b", "c"]);
    expect(sends.map((s) => s.notify)).toEqual([true, false, false]);
    expect(state.gap).toBeNull();
  });

  test("a mid-stream fatal error does NOT drop the tail, and surfaces a gap notice", async () => {
    // chunk index 1 throws a fatal error; chunks 0 and 2 must still be attempted.
    const { io, sends, state } = makeIO({ failOn: { 1: "fatal" } });
    const r = await mirrorChunks([chunk("a"), chunk("b"), chunk("c")], "abc", 4, io);
    expect(r).toEqual({ sent: 2, failed: 1 });
    expect(sends.map((s) => s.text)).toEqual(["a", "c"]); // b failed, c still sent
    expect(state.fails).toBe(1);
    expect(state.gap).toEqual({ sent: 2, total: 3 });
  });

  test("rejected entities fall back to a plain-text resend of the same chunk", async () => {
    const { io, sends, state } = makeIO({ failOn: { 0: "retry-plain" } });
    const r = await mirrorChunks([{ text: "x", entities: [{ type: "bold", offset: 0, length: 1 }] }], "x", 4, io);
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toBe("x");
    expect(sends[0]!.entities).toBeUndefined(); // resent without entities
    expect(state.gap).toBeNull();
  });

  test("a deleted topic is recovered once, then the chunk lands", async () => {
    const { io, sends, state } = makeIO({ failOn: { 0: "thread-gone" } });
    const r = await mirrorChunks([chunk("a"), chunk("b")], "ab", 4, io);
    expect(state.recovers).toBe(1);
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(sends.map((s) => s.text)).toEqual(["a", "b"]);
    expect(state.gap).toBeNull();
  });

  test("recovery is attempted at most once; a second thread-gone gives up on that chunk", async () => {
    const { io, state } = makeIO({ failOn: { 0: "thread-gone", 1: "thread-gone" } });
    const r = await mirrorChunks([chunk("a")], "a", 4, io);
    expect(state.recovers).toBe(1);
    expect(r).toEqual({ sent: 0, failed: 1 });
    expect(state.gap).toEqual({ sent: 0, total: 1 });
  });

  test("more than maxChunks → one preview send + a file attachment, no push flood", async () => {
    const many = Array.from({ length: 9 }, (_, i) => chunk("c" + i));
    const { io, sends, state } = makeIO();
    const r = await mirrorChunks(many, "FULL", 4, io);
    expect(sends).toHaveLength(1); // only the preview goes inline
    expect(sends[0]!.text).toBe("c0");
    expect(state.attaches).toBe(1); // the full answer as a file
    expect(r).toEqual({ sent: 2, failed: 0 });
  });

  test("an attachment failure in the flood path is surfaced", async () => {
    const many = Array.from({ length: 9 }, (_, i) => chunk("c" + i));
    const { io, state } = makeIO({
      async attach() {
        throw new GErr("fatal");
      },
    });
    const r = await mirrorChunks(many, "FULL", 4, io);
    expect(r.failed).toBe(1);
    expect(state.gap).not.toBeNull();
  });

  test("no chunks → nothing sent, no notice", async () => {
    const { io, state } = makeIO();
    const r = await mirrorChunks([], "", 4, io);
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(state.gap).toBeNull();
  });
});
