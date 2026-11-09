import { describe, expect, test } from "bun:test";
import { renderTypeDeltas, topTypeDeltas } from "../src/memstats.ts";

describe("topTypeDeltas", () => {
  test("without a previous sample, ranks by count and reports count as delta", () => {
    const rows = topTypeDeltas(null, { Array: 10, string: 500, Promise: 40 }, 2);
    expect(rows).toEqual([
      ["string", 500, 500],
      ["Promise", 40, 40],
    ]);
  });

  test("with a previous sample, ranks by growth, not by size", () => {
    const prev = { string: 500, Array: 10, Timeout: 1 };
    const cur = { string: 505, Array: 10, Timeout: 301, Socket: 3 };
    const rows = topTypeDeltas(prev, cur, 3);
    expect(rows).toEqual([
      ["Timeout", 301, 300],
      ["string", 505, 5],
      ["Socket", 3, 3],
    ]);
  });

  test("ties break by count then name (stable output)", () => {
    const prev = { a: 1, b: 5 };
    const cur = { a: 2, b: 6, c: 1 };
    expect(topTypeDeltas(prev, cur, 10)).toEqual([
      ["b", 6, 1],
      ["a", 2, 1],
      ["c", 1, 1],
    ]);
  });

  test("n caps the rows; n ≤ 0 yields nothing; vanished types are not listed", () => {
    const prev = { gone: 50, kept: 1 };
    const cur = { kept: 1 };
    expect(topTypeDeltas(prev, cur, 10)).toEqual([["kept", 1, 0]]);
    expect(topTypeDeltas(prev, cur, 0)).toEqual([]);
  });
});

describe("renderTypeDeltas", () => {
  test("renders compact tokens with a signed delta", () => {
    expect(
      renderTypeDeltas([
        ["Array", 1200, 300],
        ["string", 90, -5],
        ["Timeout", 7, 0],
      ]),
    ).toEqual(["Array:1200+300", "string:90-5", "Timeout:7+0"]);
  });
});
