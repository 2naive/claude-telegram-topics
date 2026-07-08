import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { keyFromCwd, gitTopLevel } from "../src/projectkey.ts";
import { normalizePath } from "../src/paths.ts";

describe("keyFromCwd (leader/hook identity parity)", () => {
  test("a non-git directory keys to its normalized path", () => {
    // This is exactly projectKey() for a non-git session: normalizePath(cwd).
    const dir = mkdtempSync(join(tmpdir(), "tg-key-"));
    expect(keyFromCwd(dir)).toBe(normalizePath(dir));
  });

  test("a subdirectory of a git repo keys to the repo root (same as its top)", () => {
    const repo = mkdtempSync(join(tmpdir(), "tg-git-"));
    const init = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    if (init.status !== 0) return; // git unavailable in this environment — skip
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    // The hook (given a subdir cwd) and the leader (given the launch cwd) must
    // resolve to the SAME key — both via git --show-toplevel.
    expect(keyFromCwd(sub)).toBe(keyFromCwd(repo));
    expect(keyFromCwd(sub)).toBe(normalizePath(gitTopLevel(repo)));
  });
});
