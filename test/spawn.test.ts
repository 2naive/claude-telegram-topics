import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchPs,
  psQuote,
  windowTitle,
  launchCommand,
  isPathAllowed,
  projectNameFromPath,
  launchRoots,
  spawnSession,
  discoverLaunchable,
  resolveClaudeBin,
  resolveBunDir,
  launchPathPrefix,
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

describe("psQuote", () => {
  test("wraps in single quotes and doubles embedded ones", () => {
    expect(psQuote("plain")).toBe("'plain'");
    expect(psQuote("O'Brien's")).toBe("'O''Brien''s'");
    expect(psQuote("")).toBe("''");
  });
});

describe("buildLaunchPs (non-inheriting launcher)", () => {
  // Why Start-Process: a directly spawned console inherits copies of the
  // leader's handles — including its LISTEN socket — so any leader death with
  // spawned consoles alive left the control port LISTEN-ing under a dead pid
  // and no new leader could bind (three live incidents in one night). Probed:
  // direct spawn = port hostage, Start-Process (ShellExecute) = port free.
  test("composes Start-Process with title, command and working dir", () => {
    const line = buildLaunchPs("tg_x", "claude --flag", "C:\\Proj\\X");
    expect(line).toBe(
      "Start-Process -FilePath cmd.exe -ArgumentList '/k','title tg_x & claude --flag' " +
        "-WorkingDirectory 'C:\\Proj\\X'",
    );
  });

  test("PS-quotes embedded single quotes in cmd and cwd", () => {
    const line = buildLaunchPs("tg_x", "claude --note 'hi'", "C:\\O'Brien");
    expect(line).toContain("'title tg_x & claude --note ''hi'''");
    expect(line).toContain("-WorkingDirectory 'C:\\O''Brien'");
  });

  test("a pathPrefix prepends a cmd `set PATH` so a bare `bun` resolves", () => {
    // The MCP server launches via bare `bun` (.mcp.json); an autostart console
    // inherits the leader's stale PATH and dies with "'bun' is not recognized".
    const line = buildLaunchPs("tg_x", "claude --flag", "C:\\Proj\\X", "C:\\dir\\npm");
    expect(line).toContain(`'set "PATH=C:\\dir\\npm;%PATH%" & title tg_x & claude --flag'`);
  });

  test("no pathPrefix (default) leaves the line exactly as before — no regression", () => {
    const line = buildLaunchPs("tg_x", "claude --flag", "C:\\Proj\\X");
    expect(line).not.toContain("set \"PATH=");
    expect(line).toContain("'title tg_x & claude --flag'");
  });
});

describe("resolveBunDir (so the spawned MCP server's bare `bun` resolves)", () => {
  test("TG_TOPICS_BUN_DIR is used when it holds a bun shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "TgBun-"));
    writeFileSync(join(dir, "bun.cmd"), "x");
    const prev = process.env.TG_TOPICS_BUN_DIR;
    try {
      process.env.TG_TOPICS_BUN_DIR = dir;
      expect(resolveBunDir()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_BUN_DIR;
      else process.env.TG_TOPICS_BUN_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an override dir without a bun shim is ignored (never returned)", () => {
    const dir = mkdtempSync(join(tmpdir(), "TgBunEmpty-"));
    const prev = process.env.TG_TOPICS_BUN_DIR;
    try {
      process.env.TG_TOPICS_BUN_DIR = dir; // exists, but no bun.exe/.cmd inside
      expect(resolveBunDir()).not.toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.TG_TOPICS_BUN_DIR;
      else process.env.TG_TOPICS_BUN_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnSession mechanics", () => {
  test.if(process.platform === "win32")(
    "spawns via powershell Start-Process with the canonical cwd inside the line",
    () => {
      // Pins BOTH launch lessons: (a) the console gets the canonical on-disk
      // path (a lowercased cwd broke Claude Code's folder-trust and history
      // lookups — live incident); (b) the launch goes through Start-Process,
      // not a direct cmd spawn (handle-inheritance port hostage — live
      // incident), and WITHOUT windowsVerbatimArguments: PowerShell parses
      // MSVCRT-style, so Bun's default encoding is the correct one here.
      const real = mkdtempSync(join(tmpdir(), "TgCase-"));
      try {
        const canon = realpathSync.native(real);
        const spy = spyOn(Bun, "spawn").mockReturnValue({} as never);
        try {
          expect(spawnSession(real.toLowerCase(), "x", true)).toBeNull();
          expect(spy).toHaveBeenCalledTimes(1);
          const [argv, opts] = spy.mock.calls[0]! as [string[], Record<string, unknown>];
          expect(argv).toEqual([
            "powershell",
            "-NoProfile",
            "-Command",
            // includes launchPathPrefix() — bun's dir on PATH so the MCP
            // server's bare `bun` resolves under a stale inherited leader PATH.
            buildLaunchPs("tg_x", launchCommand(true), canon, launchPathPrefix()),
          ]);
          expect(opts.windowsVerbatimArguments).toBeUndefined();
        } finally {
          spy.mockRestore();
        }
      } finally {
        rmSync(real, { recursive: true, force: true });
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

describe("resolveClaudeBin (absolute-path spawn, PATH-independent)", () => {
  // A long-lived leader inherits a stale PATH: the npm-global -> native-installer
  // migration moved claude to ~/.local/bin and emptied the old npm dir, so a
  // pre-migration leader spawned consoles that died with "'claude' is not
  // recognized". Resolving to an absolute path fixes this at the source.
  const withEnv = (
    over: Record<string, string | undefined>,
    fn: () => void,
  ) => {
    const keys = Object.keys(over);
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];
    try {
      for (const k of keys) {
        const v = over[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    }
  };

  test("TG_TOPICS_CLAUDE_BIN (when it exists) becomes the leading absolute token", () => {
    const dir = mkdtempSync(join(tmpdir(), "TgBin-"));
    const bin = join(dir, "claude.exe");
    writeFileSync(bin, "x");
    try {
      withEnv({ TG_TOPICS_CLAUDE_BIN: bin, TG_TOPICS_LAUNCH_CMD: undefined }, () => {
        expect(resolveClaudeBin()).toBe(bin);
        const cmd = launchCommand();
        // leading token is the quoted absolute path, rest of DEFAULT preserved
        expect(cmd.startsWith(`"${bin}" --permission-mode auto`)).toBe(true);
        expect(cmd).toContain("--channels plugin:telegram-topics@");
        // resume still inserts --continue before the variadic channels flag
        expect(launchCommand(true)).toContain("--continue --channels");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nonexistent TG_TOPICS_CLAUDE_BIN is never returned", () => {
    const missing = join(tmpdir(), "no-such-claude-binary.exe");
    withEnv({ TG_TOPICS_CLAUDE_BIN: missing }, () => {
      expect(resolveClaudeBin()).not.toBe(missing);
    });
  });

  test("a custom TG_TOPICS_LAUNCH_CMD is trusted verbatim (never rewritten)", () => {
    withEnv({ TG_TOPICS_LAUNCH_CMD: "claude --permission-mode auto --channels plugin:x@y" }, () => {
      expect(launchCommand()).toBe("claude --permission-mode auto --channels plugin:x@y");
    });
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

describe("buildStopPs (remote /stop, /new)", () => {
  const { buildStopPs } = require("../src/spawn.ts");

  test("detached taskkill of the process tree, hidden window", () => {
    expect(buildStopPs(1234)).toBe(
      "Start-Process -FilePath taskkill.exe -ArgumentList '/PID','1234','/T','/F' -WindowStyle Hidden",
    );
  });

  test("coerces a fractional pid to an integer", () => {
    expect(buildStopPs(99.9)).toContain("'/PID','99',");
  });
});
