import { test, expect, describe } from "bun:test";
import {
  isNewerVersion,
  parseCallback,
  permCallbackData,
  pickSessionField,
  pickSessionName,
  remapValues,
  sessionPrefix,
  truncate,
  statusGlyph,
  stripStatusGlyph,
  withStatusGlyph,
} from "../src/routing.ts";

describe("topic status glyphs", () => {
  test("withStatusGlyph prefixes the state glyph", () => {
    expect(withStatusGlyph("system", "active")).toBe("🟢 system");
    expect(withStatusGlyph("system", "queued")).toBe("🟡 system");
    expect(withStatusGlyph("system", "idle")).toBe("⚪ system");
  });

  test("re-tagging is idempotent — the old glyph is stripped first", () => {
    const once = withStatusGlyph("system", "active");
    expect(withStatusGlyph(once, "idle")).toBe("⚪ system");
    // No glyph accumulation across many transitions.
    let name = "my-repo";
    for (const s of ["active", "idle", "queued", "active"] as const) name = withStatusGlyph(name, s);
    expect(name).toBe("🟢 my-repo");
  });

  test("stripStatusGlyph leaves an unbadged name untouched", () => {
    expect(stripStatusGlyph("plain name")).toBe("plain name");
    expect(stripStatusGlyph(`${statusGlyph("active")} x`)).toBe("x");
  });
});

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

describe("isNewerVersion", () => {
  test("compares each semver segment numerically", () => {
    expect(isNewerVersion("0.6.0", "0.5.2")).toBe(true);
    expect(isNewerVersion("0.5.2", "0.6.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.5.10", "0.5.9")).toBe(true);
  });

  test("equal versions never trade leadership", () => {
    expect(isNewerVersion("0.6.0", "0.6.0")).toBe(false);
  });

  test("missing segments count as zero", () => {
    expect(isNewerVersion("0.6", "0.5.9")).toBe(true);
    expect(isNewerVersion("0.6", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.6.1", "0.6")).toBe(true);
  });

  test("an absent or garbage client version never outranks a real one", () => {
    expect(isNewerVersion("", "0.6.0")).toBe(false);
    expect(isNewerVersion("dev", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.6.0", "")).toBe(true);
  });
});

describe("long-poll invariants", () => {
  test("the server socket idle timeout outlives the longest /poll wait", async () => {
    // Regression pin for the re-registration storm: Bun.serve cuts a response
    // that writes nothing for idleTimeout seconds, so it must exceed the
    // longest long-poll the control API will hold open (plus headroom for
    // request parsing before the wait starts).
    const { LEADER_IDLE_TIMEOUT_SEC, POLL_MAX_SEC } = await import("../src/routing.ts");
    expect(LEADER_IDLE_TIMEOUT_SEC).toBeGreaterThanOrEqual(POLL_MAX_SEC + 5);
  });

  test("control API responses close their connection", async () => {
    // Regression pin for the demoted-leader black hole: a pooled keep-alive
    // /poll connection survives graceful stop AND the delayed force-close, so
    // a stepped-down leader with no successor serves it forever and inbound
    // dies silently. Per-response close guarantees the next poll is a fresh
    // connect that surfaces leader death as ECONNREFUSED.
    const { CONTROL_RESPONSE_HEADERS } = await import("../src/routing.ts");
    expect(CONTROL_RESPONSE_HEADERS.connection).toBe("close");
  });
});

describe("start-session callbacks", () => {
  test("round-trip through callback_data", async () => {
    const { parseCallback, startCallbackData } = await import("../src/routing.ts");
    expect(parseCallback(startCallbackData(31))).toEqual({ kind: "start", topicId: 31 });
  });

  test("does not shadow numeric choice callbacks", async () => {
    const { parseCallback } = await import("../src/routing.ts");
    expect(parseCallback("2")).toEqual({ kind: "choice", index: 2 });
    expect(parseCallback("start:x")).toEqual({ kind: "raw", data: "start:x" });
  });
});

describe("release invariants", () => {
  test("package.json and plugin.json versions match", async () => {
    // VERSION (hand-off, /health) derives from package.json while the plugin
    // manager shows plugin.json — if they diverge, users see a new version
    // installed but the leader hand-off compares old-vs-old and never fires,
    // resurrecting the stale-leader problem with no tell.
    const pkg = (await import("../package.json")).default as { version: string };
    const plugin = (await import("../.claude-plugin/plugin.json")).default as {
      version: string;
    };
    expect(pkg.version).toBe(plugin.version);
  });
});
