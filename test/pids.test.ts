import { describe, expect, test } from "bun:test";
import { parseWinChain } from "../src/pids.ts";

describe("parseWinChain (Windows ancestor walk output)", () => {
  test("parses a full chain nearest-ancestor-first with start times", () => {
    const out = "205436|1788559630805;227392|1788559629941;77840|1788559618242";
    expect(parseWinChain(out, 205436)).toEqual([
      { pid: 205436, startedAt: 1788559630805 },
      { pid: 227392, startedAt: 1788559629941 },
      { pid: 77840, startedAt: 1788559618242 },
    ]);
  });

  test("empty / null output falls back to the bare ppid (a failed snapshot)", () => {
    expect(parseWinChain("", 999)).toEqual([{ pid: 999, startedAt: null }]);
    expect(parseWinChain(null, 999)).toEqual([{ pid: 999, startedAt: null }]);
    expect(parseWinChain("   ", 999)).toEqual([{ pid: 999, startedAt: null }]);
  });

  test("a missing creation time yields startedAt null, not NaN", () => {
    expect(parseWinChain("205436|", 205436)).toEqual([{ pid: 205436, startedAt: null }]);
    expect(parseWinChain("205436", 205436)).toEqual([{ pid: 205436, startedAt: null }]);
  });

  test("garbage / non-numeric tokens are dropped, valid ones kept", () => {
    expect(parseWinChain("abc|def;227392|123", 1)).toEqual([{ pid: 227392, startedAt: 123 }]);
  });

  test("a lone-ppid result is length 1 — the retry trigger the driver keys on", () => {
    // The driver retries when length < 2; this documents that a snapshot which
    // found no ancestors is distinguishable from a real 2+ level chain.
    expect(parseWinChain("205436|123", 205436).length).toBe(1);
    expect(parseWinChain("205436|123;77840|100", 205436).length).toBe(2);
  });
});
