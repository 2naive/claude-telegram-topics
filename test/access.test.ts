import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV_FILE, STATE_DIR } from "../src/config.ts";
import {
  assertSendable,
  isAllowedUser,
  parseAllowlist,
  resetAllowlistCacheForTest,
} from "../src/access.ts";

function writeAllowlist(value: string | null): void {
  const body =
    value === null
      ? "TELEGRAM_BOT_TOKEN=000000:test-dummy-token\n"
      : `TELEGRAM_BOT_TOKEN=000000:test-dummy-token\nTELEGRAM_ALLOWED_USER_IDS=${value}\n`;
  writeFileSync(ENV_FILE, body);
  resetAllowlistCacheForTest();
}

describe("parseAllowlist", () => {
  test("splits, trims, drops empties", () => {
    expect([...parseAllowlist(" 1, 2 ,,3 ")].sort()).toEqual(["1", "2", "3"]);
    expect(parseAllowlist("").size).toBe(0);
  });
});

describe("isAllowedUser (live re-read)", () => {
  test("undefined user is always denied", () => {
    writeAllowlist("1");
    expect(isAllowedUser(undefined)).toBe(false);
  });

  test("empty allowlist trusts the group boundary", () => {
    writeAllowlist(null);
    expect(isAllowedUser(42)).toBe(true);
  });

  test("listed user allowed, others denied", () => {
    writeAllowlist("111,222");
    expect(isAllowedUser(111)).toBe(true);
    expect(isAllowedUser("222")).toBe(true);
    expect(isAllowedUser(333)).toBe(false);
  });

  test("a revocation applies after the cache expires — no leader restart", () => {
    writeAllowlist("111,222");
    expect(isAllowedUser(222)).toBe(true);
    writeAllowlist("111"); // /access remove 222 rewrites the .env
    expect(isAllowedUser(222)).toBe(false);
    expect(isAllowedUser(111)).toBe(true);
  });
});

describe("assertSendable (token-leak guard)", () => {
  test("refuses files inside the state dir and the dir itself", () => {
    writeAllowlist(null); // ensures ENV_FILE exists
    expect(() => assertSendable(ENV_FILE)).toThrow(/refusing/);
    expect(() => assertSendable(STATE_DIR)).toThrow(/refusing/);
  });

  test("a sibling dir sharing the name prefix is NOT blocked", () => {
    const sibling = STATE_DIR + "-sibling";
    mkdirSync(sibling, { recursive: true });
    const f = join(sibling, "ok.txt");
    writeFileSync(f, "x");
    try {
      expect(() => assertSendable(f)).not.toThrow();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("a nonexistent path passes through (the read will fail clearly later)", () => {
    expect(() => assertSendable(join(dirname(STATE_DIR), "no-such-file-xyz"))).not.toThrow();
  });
});
