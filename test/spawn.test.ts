import { describe, expect, test } from "bun:test";
import { buildStartLine, windowTitle, launchCommand } from "../src/spawn.ts";

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
});
