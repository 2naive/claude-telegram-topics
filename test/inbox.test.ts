import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxSubdir, reapInbox } from "../src/inbox.ts";

const DAY = 24 * 3600 * 1000;

describe("inboxSubdir (per-topic isolation)", () => {
  test("creates and returns a per-topic directory under the base", () => {
    const base = mkdtempSync(join(tmpdir(), "inbox-sub-"));
    try {
      const dir = inboxSubdir(base, 42);
      expect(dir).toBe(join(base, "42"));
      expect(existsSync(dir)).toBe(true);
      // Idempotent and stringifies the id the same way.
      expect(inboxSubdir(base, "42")).toBe(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("reapInbox (bounded cleanup across subdirs and legacy flat files)", () => {
  let base: string;
  const now = Date.now();
  const old = (p: string) => {
    const t = (now - 25 * 3600 * 1000) / 1000; // 25h ago, in seconds
    utimesSync(p, t, t);
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "inbox-reap-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("deletes an old file in a topic subdir, keeps a fresh one", () => {
    const d = inboxSubdir(base, 1);
    const stale = join(d, "a_old.jpg");
    const fresh = join(d, "b_new.jpg");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "y");
    old(stale);
    reapInbox(base, now, DAY);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // The topic dir still holds the fresh file, so it stays.
    expect(existsSync(d)).toBe(true);
  });

  test("removes a topic dir once its last file is reaped", () => {
    const d = inboxSubdir(base, 2);
    const stale = join(d, "only_old.png");
    writeFileSync(stale, "x");
    old(stale);
    reapInbox(base, now, DAY);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(d)).toBe(false); // empty → removed
  });

  test("reaps a legacy flat file (pre-isolation), keeps a fresh flat file", () => {
    const staleFlat = join(base, "legacy_old.ogg");
    const freshFlat = join(base, "legacy_new.ogg");
    writeFileSync(staleFlat, "x");
    writeFileSync(freshFlat, "y");
    old(staleFlat);
    reapInbox(base, now, DAY);
    expect(existsSync(staleFlat)).toBe(false);
    expect(existsSync(freshFlat)).toBe(true);
  });

  test("a topic dir with a fresh file survives even if it also had an old one", () => {
    const d = inboxSubdir(base, 3);
    const stale = join(d, "s_old.mp4");
    const fresh = join(d, "f_new.mp4");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "y");
    old(stale);
    reapInbox(base, now, DAY);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(d)).toBe(true);
  });

  test("a missing base is a no-op, not a throw", () => {
    expect(() => reapInbox(join(base, "does-not-exist"), now, DAY)).not.toThrow();
  });
});
