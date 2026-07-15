import { describe, expect, test } from "bun:test";
import {
  buildStartLine,
  windowTitle,
  launchCommand,
  isPathAllowed,
  projectNameFromPath,
  launchRoots,
} from "../src/spawn.ts";

describe("isPathAllowed (launch-by-path gate)", () => {
  const roots = ["c:/users/naive/claude"];

  test("default-deny when no roots are configured", () => {
    // preload deletes TG_TOPICS_LAUNCH_ROOTS, so the env default is empty.
    expect(launchRoots()).toEqual([]);
    expect(isPathAllowed("c:/users/naive/claude/anything")).toBe(false);
  });

  test("allows a directory inside a trusted root (any slash/case)", () => {
    expect(isPathAllowed("c:/users/naive/claude/newproj", roots)).toBe(true);
    expect(isPathAllowed("C:\\Users\\naive\\claude\\newproj", roots)).toBe(true);
    expect(isPathAllowed("c:/users/naive/claude", roots)).toBe(true); // the root itself
  });

  test("denies a sibling that only shares a name prefix", () => {
    // "claude-evil" must not match root "claude" — the boundary check.
    expect(isPathAllowed("c:/users/naive/claude-evil/x", roots)).toBe(false);
    expect(isPathAllowed("c:/users/naive/elsewhere", roots)).toBe(false);
  });

  test("rejects .. traversal that would escape the root", () => {
    expect(isPathAllowed("c:/users/naive/claude/../../windows/system32", roots)).toBe(false);
    expect(isPathAllowed("c:/users/naive/claude/..", roots)).toBe(false);
  });
});

describe("projectNameFromPath", () => {
  test("takes the last path segment, keeping original case", () => {
    expect(projectNameFromPath("C:\\Users\\naive\\claude\\MyRepo")).toBe("MyRepo");
    expect(projectNameFromPath("/home/x/some-proj/")).toBe("some-proj");
    expect(projectNameFromPath("c:/a/b/c")).toBe("c");
  });
});

describe("windowTitle", () => {
  test("restricts to safe chars and prefixes", () => {
    expect(windowTitle("my-repo")).toBe("tg_my-repo");
    expect(windowTitle('evil" & calc')).toBe("tg_evil_calc");
    expect(windowTitle("")).toBe("tg_session");
  });
});

describe("buildStartLine", () => {
  test("quotes the title so cmd start never treats it as the program", () => {
    // The bug this pins: `start tg_foo cmd …` ran `tg_foo` (a plantable file in
    // the cwd). A quoted title is always a title.
    const line = buildStartLine("tg_foo", "claude --x");
    expect(line).toBe('start "tg_foo" cmd /k claude --x');
    expect(line.startsWith('start "')).toBe(true);
  });
});

describe("launchCommand", () => {
  test("defaults to the channel launch command", () => {
    // preload deletes TG_TOPICS_LAUNCH_CMD, so this is the default path.
    expect(launchCommand()).toContain("--dangerously-load-development-channels");
  });

  test("fresh start (resume=false) does not add --continue", () => {
    expect(launchCommand()).not.toContain("--continue");
    expect(launchCommand(false)).not.toContain("--continue");
  });

  test("resume start appends --continue for recovery", () => {
    const cmd = launchCommand(true);
    expect(cmd).toContain("--dangerously-load-development-channels");
    expect(cmd.endsWith("--continue")).toBe(true);
  });

  test("resume does not double-select when the base already resumes", () => {
    const prev = process.env.TG_TOPICS_LAUNCH_CMD;
    try {
      process.env.TG_TOPICS_LAUNCH_CMD = "claude --continue --permission-mode auto";
      expect(launchCommand(true)).toBe("claude --continue --permission-mode auto");
      process.env.TG_TOPICS_LAUNCH_CMD = "claude -r 1234 --model opus";
      expect(launchCommand(true)).toBe("claude -r 1234 --model opus");
      process.env.TG_TOPICS_LAUNCH_CMD = "claude --resume";
      expect(launchCommand(true)).toBe("claude --resume");
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_LAUNCH_CMD;
      else process.env.TG_TOPICS_LAUNCH_CMD = prev;
    }
  });
});
