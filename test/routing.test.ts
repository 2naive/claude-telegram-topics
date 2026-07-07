import { test, expect, describe } from "bun:test";
import {
  parseCallback,
  permCallbackData,
  pickSessionField,
  pickSessionName,
  remapValues,
  sessionPrefix,
  truncate,
} from "../src/routing.ts";

describe("parseCallback", () => {
  test("parses a permission button", () => {
    expect(parseCallback("perm:allow:ab12cd34:xyzab")).toEqual({
      kind: "permission",
      behavior: "allow",
      sessionId: "ab12cd34",
      requestId: "xyzab",
    });
  });

  test("parses deny and more behaviors", () => {
    expect(parseCallback("perm:deny:s:r")).toMatchObject({ behavior: "deny" });
    expect(parseCallback("perm:more:s:r")).toMatchObject({ behavior: "more" });
  });

  test("round-trips permCallbackData", () => {
    const data = permCallbackData("allow", "sess1234", "reqid");
    expect(parseCallback(data)).toEqual({
      kind: "permission",
      behavior: "allow",
      sessionId: "sess1234",
      requestId: "reqid",
    });
  });

  test("parses a numeric choice index", () => {
    expect(parseCallback("2")).toEqual({ kind: "choice", index: 2 });
  });

  test("treats anything else as raw", () => {
    expect(parseCallback("hello")).toEqual({ kind: "raw", data: "hello" });
  });

  test("does not misread a raw string that merely starts with 'perm'", () => {
    expect(parseCallback("permission").kind).toBe("raw");
  });
});

describe("sessionPrefix", () => {
  test("is empty for a single session", () => {
    expect(sessionPrefix("main", 1)).toBe("");
  });

  test("tags when the topic has more than one session", () => {
    expect(sessionPrefix("main", 2)).toBe("«main» ");
  });

  test("is empty when there is no label", () => {
    expect(sessionPrefix("", 3)).toBe("");
  });
});

describe("truncate", () => {
  test("leaves short strings untouched", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  test("cuts and ellipsizes long strings", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
});

describe("pickSessionName", () => {
  const rows = [
    { sessionId: "aaa", name: "other", updatedAt: 5 },
    { sessionId: "bbb", name: "system:cct", updatedAt: 10 },
  ];

  test("returns the /rename name for the matching session", () => {
    expect(pickSessionName(rows, "bbb")).toBe("system:cct");
  });

  test("returns empty when no session matches", () => {
    expect(pickSessionName(rows, "zzz")).toBe("");
  });

  test("prefers the most recently updated record on a duplicate id", () => {
    const dup = [
      { sessionId: "bbb", name: "old", updatedAt: 1 },
      { sessionId: "bbb", name: "new", updatedAt: 99 },
    ];
    expect(pickSessionName(dup, "bbb")).toBe("new");
  });

  test("ignores blank names and trims", () => {
    const rows2 = [
      { sessionId: "bbb", name: "   ", updatedAt: 50 },
      { sessionId: "bbb", name: "  main  ", updatedAt: 40 },
    ];
    expect(pickSessionName(rows2, "bbb")).toBe("main");
  });
});

describe("pickSessionField (cwd)", () => {
  test("returns the session's cwd", () => {
    const rows = [
      { sessionId: "aaa", cwd: "C:\\other", updatedAt: 5 },
      { sessionId: "bbb", cwd: "C:\\Users\\naive\\claude\\system", updatedAt: 10 },
    ];
    expect(pickSessionField(rows, "bbb", "cwd")).toBe(
      "C:\\Users\\naive\\claude\\system",
    );
  });

  test("returns empty when the record has no cwd", () => {
    expect(pickSessionField([{ sessionId: "bbb", name: "x" }], "bbb", "cwd")).toBe("");
  });

  test("a fresher record without the field does not shadow an older one with it", () => {
    const rows = [
      { sessionId: "bbb", cwd: "C:\\repo", updatedAt: 1 },
      { sessionId: "bbb", name: "renamed", updatedAt: 99 },
    ];
    expect(pickSessionField(rows, "bbb", "cwd")).toBe("C:\\repo");
  });
});

describe("remapValues", () => {
  test("rewrites every value equal to `from`", () => {
    const m = new Map<number, string>([
      [1, "old"],
      [2, "other"],
      [3, "old"],
    ]);
    remapValues(m, "old", "new");
    expect(m.get(1)).toBe("new");
    expect(m.get(2)).toBe("other");
    expect(m.get(3)).toBe("new");
  });

  test("leaves the map untouched when nothing matches", () => {
    const m = new Map<number, string>([[1, "a"]]);
    remapValues(m, "zzz", "new");
    expect(m.get(1)).toBe("a");
  });
});
