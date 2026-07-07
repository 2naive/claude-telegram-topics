import { test, expect, describe } from "bun:test";
import { normalizePath, displayName } from "../src/paths.ts";

describe("normalizePath", () => {
  test("unifies slash direction (git '/' vs cwd '\\')", () => {
    expect(normalizePath("C:\\Users\\me\\app")).toBe(normalizePath("C:/Users/me/app"));
  });

  test("strips trailing separators", () => {
    expect(normalizePath("/home/me/app/")).toBe(normalizePath("/home/me/app"));
    expect(normalizePath("/home/me/app//")).toBe(normalizePath("/home/me/app"));
  });

  test("collapses repeated separators", () => {
    expect(normalizePath("/home//me///app")).toBe(normalizePath("/home/me/app"));
  });

  test("is idempotent", () => {
    const once = normalizePath("C:\\Users\\Me\\App\\");
    expect(normalizePath(once)).toBe(once);
  });

  test("case-folds on Windows only", () => {
    const out = normalizePath("/Home/Me/App");
    if (process.platform === "win32") {
      expect(out).toBe("/home/me/app");
    } else {
      expect(out).toBe("/Home/Me/App");
    }
  });
});

describe("displayName", () => {
  test("returns the trailing folder name (both separators)", () => {
    expect(displayName("C:/Users/naive/system")).toBe("system");
    expect(displayName("C:\\Users\\naive\\.claude")).toBe(".claude");
    expect(displayName("/home/me/my-repo")).toBe("my-repo");
  });

  test("ignores a trailing separator", () => {
    expect(displayName("/home/me/app/")).toBe("app");
  });

  test("preserves original case", () => {
    expect(displayName("/home/me/MyApp")).toBe("MyApp");
  });

  test("falls back to 'project' at a root", () => {
    expect(displayName("/")).toBe("project");
  });
});
