import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStartLine,
  windowTitle,
  launchCommand,
  isPathAllowed,
  projectNameFromPath,
  launchRoots,
  spawnSession,
  discoverLaunchable,
} from "../src/spawn.ts";
import { normalizePath } from "../src/paths.ts";

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

describe("windows arg passing (the \"Windows cannot find '\\tg_…\\'\" popup)", () => {
  // Bun's default Windows arg encoding escapes embedded quotes C-runtime-style
  // (\") — cmd.exe does not understand that, so the quoted window title reached
  // `start` as `\"tg_x\"` and start resolved the PROGRAM to `\tg_x\`: an error
  // popup and no session. spawnSession must pass the line VERBATIM.
  test.if(process.platform === "win32")(
    "verbatim spawn delivers embedded quotes to cmd intact",
    async () => {
      const line = 'echo PROBE "tg_title" tail';
      const p = Bun.spawn(["cmd", "/c", line], {
        stdout: "pipe",
        stderr: "ignore",
        windowsVerbatimArguments: true,
      });
      const out = await new Response(p.stdout).text();
      expect(out).toContain('PROBE "tg_title" tail');
      expect(out).not.toContain('\\"');
    },
  );

  test.if(process.platform === "win32")(
    "default (non-verbatim) spawn mangles them — the regression this pins",
    async () => {
      const line = 'echo PROBE "tg_title" tail';
      const p = Bun.spawn(["cmd", "/c", line], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(p.stdout).text();
      // If a future Bun stops mangling, this fails and the verbatim flag can
      // be revisited; until then it documents WHY the flag is load-bearing.
      expect(out).toContain('\\"tg_title\\"');
    },
  );

  test.if(process.platform === "win32")(
    "spawn cwd uses the canonical on-disk case, not the lowercased key",
    () => {
      // Claude Code keys folder trust AND per-cwd conversation history by the
      // exact path string. Spawning with the normalized (lowercased) topic key
      // hung the launched session at the "do you trust this folder?" prompt
      // (live incident) and --continue would miss the history and start blank.
      const real = mkdtempSync(join(tmpdir(), "TgCase-"));
      try {
        const canon = realpathSync.native(real);
        const spy = spyOn(Bun, "spawn").mockReturnValue({} as never);
        try {
          expect(spawnSession(real.toLowerCase(), "x", false)).toBeNull();
          const [, opts] = spy.mock.calls[0]! as [string[], Record<string, unknown>];
          expect(opts.cwd).toBe(canon);
          expect(opts.cwd).not.toBe(real.toLowerCase());
        } finally {
          spy.mockRestore();
        }
      } finally {
        rmSync(real, { recursive: true, force: true });
      }
    },
  );

  test.if(process.platform === "win32")(
    "spawnSession passes the start line verbatim — pins the fix itself",
    () => {
      // The two probes above pin Bun's ENCODING; this pins OUR call: without
      // it, deleting windowsVerbatimArguments from spawnSession leaves the
      // whole suite green while reproducing the live popup (mutation-tested).
      const spy = spyOn(Bun, "spawn").mockReturnValue({} as never);
      try {
        expect(spawnSession("C:\\proj\\x", "x", true)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        const [argv, opts] = spy.mock.calls[0]! as [string[], Record<string, unknown>];
        expect(argv).toEqual(["cmd", "/c", `start "tg_x" cmd /k ${launchCommand(true)}`]);
        expect(opts.windowsVerbatimArguments).toBe(true);
        expect(opts.cwd).toBe("C:\\proj\\x");
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe("launchCommand", () => {
  test("defaults to the APPROVED --channels form (no interactive gate)", () => {
    // preload deletes TG_TOPICS_LAUNCH_CMD, so this is the default path.
    // --dangerously-load-development-channels shows a blocking "local
    // development" confirmation on every start, which hung hands-off
    // relaunches — the default must use --channels.
    expect(launchCommand()).toContain(" --channels plugin:telegram-topics@");
    expect(launchCommand()).not.toContain("--dangerously-load-development-channels");
  });

  test("fresh start (resume=false) does not add --continue", () => {
    expect(launchCommand()).not.toContain("--continue");
    expect(launchCommand(false)).not.toContain("--continue");
  });

  test("resume inserts --continue BEFORE the variadic channels flag", () => {
    // The channels flags are variadic: every following token is eaten as a
    // channel name, so a trailing --continue became a bogus channel (launch
    // error popup) and no resume. It must come first.
    const cmd = launchCommand(true);
    expect(cmd).toContain("--continue --channels");
    expect(cmd.endsWith("--continue")).toBe(false);
  });

  test("resume insertion also handles a custom dev-channels command", () => {
    const prev = process.env.TG_TOPICS_LAUNCH_CMD;
    try {
      process.env.TG_TOPICS_LAUNCH_CMD =
        "claude --permission-mode auto --dangerously-load-development-channels plugin:x@y";
      expect(launchCommand(true)).toBe(
        "claude --permission-mode auto --continue --dangerously-load-development-channels plugin:x@y",
      );
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_LAUNCH_CMD;
      else process.env.TG_TOPICS_LAUNCH_CMD = prev;
    }
  });

  test("resume appends --continue when there is no variadic flag", () => {
    const prev = process.env.TG_TOPICS_LAUNCH_CMD;
    try {
      process.env.TG_TOPICS_LAUNCH_CMD = "claude --permission-mode auto";
      expect(launchCommand(true)).toBe("claude --permission-mode auto --continue");
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_LAUNCH_CMD;
      else process.env.TG_TOPICS_LAUNCH_CMD = prev;
    }
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

describe("discoverLaunchable (the /list discovery section)", () => {
  test("lists unbridged dirs under the roots; skips files, dot-dirs, bridged", () => {
    const root = mkdtempSync(join(tmpdir(), "TgDiscover-"));
    const prev = process.env.TG_TOPICS_LAUNCH_ROOTS;
    try {
      mkdirSync(join(root, "proj-a"));
      mkdirSync(join(root, "proj-b"));
      mkdirSync(join(root, ".hidden"));
      writeFileSync(join(root, "not-a-dir.txt"), "x");
      process.env.TG_TOPICS_LAUNCH_ROOTS = root;
      const known = new Set([normalizePath(join(root, "proj-b"))]);
      const found = discoverLaunchable(known);
      expect(found.map((f) => f.name)).toEqual(["proj-a"]);
      // canonical on-disk case, ready to be a spawn cwd
      expect(found[0]!.path.toLowerCase()).toBe(join(root, "proj-a").toLowerCase());
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_LAUNCH_ROOTS;
      else process.env.TG_TOPICS_LAUNCH_ROOTS = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no roots configured (default-deny) — nothing advertised", () => {
    // preload deletes TG_TOPICS_LAUNCH_ROOTS
    expect(discoverLaunchable(new Set())).toEqual([]);
  });
});
