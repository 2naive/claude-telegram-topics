import { test, expect, describe } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, isRealProjectKey } from "../src/config.ts";
import { normalizePath } from "../src/paths.ts";

describe("isRealProjectKey", () => {
  test("rejects the config dir and its subtree (junk-topic sources)", () => {
    // The exact "~/.claude" key that once became a ".claude" topic.
    expect(isRealProjectKey(CONFIG_DIR)).toBe(false);
    expect(isRealProjectKey(normalizePath(CONFIG_DIR))).toBe(false);
    // The plugin cache dir beneath it — the key of the detached-launch misfire.
    expect(
      isRealProjectKey(join(CONFIG_DIR, "plugins", "cache", "x", "0.1.0")),
    ).toBe(false);
  });

  test("rejects the bare home dir", () => {
    expect(isRealProjectKey(homedir())).toBe(false);
  });

  test("rejects empty / whitespace", () => {
    expect(isRealProjectKey("")).toBe(false);
    expect(isRealProjectKey("   ")).toBe(false);
  });

  test("accepts real project paths (incl. under home but not under .claude)", () => {
    expect(isRealProjectKey(join(homedir(), "claude", "system"))).toBe(true);
    expect(isRealProjectKey(join(homedir(), "code", "myrepo"))).toBe(true);
    expect(isRealProjectKey("/tmp/some-project")).toBe(true);
  });

  test("a sibling that only shares the .claude name prefix is allowed", () => {
    // "…/.claude-backup" must not be folded into the "…/.claude" subtree.
    expect(isRealProjectKey(CONFIG_DIR + "-backup")).toBe(true);
  });
});
