// Launch a new Claude Code channel session for a project, on request from
// Telegram (the /start command, the Start-session button on a queued-message
// notice, or TG_TOPICS_AUTOSTART). The leader can receive messages for a
// project with no live session; this is the way back without touching the
// machine.
//
// Windows: `cmd /c start` opens a real console window running the launch
// command in the project directory — the session gets a TTY and keeps running
// after the leader exits. Other platforms have no reliable headless TTY story,
// so spawning is refused with a clear message instead of half-working.

import { realpathSync } from "node:fs";
import { log } from "./log.ts";
import { normalizePath } from "./paths.ts";

// --channels is the APPROVED way to load an installed plugin channel: no
// interactive gate. --dangerously-load-development-channels shows a blocking
// "I am using this for local development" confirmation on every start, which
// hung hands-off relaunches (live incident) — it remains supported in a custom
// TG_TOPICS_LAUNCH_CMD, but is no longer the default.
export const DEFAULT_LAUNCH_CMD =
  "claude --permission-mode auto --channels plugin:telegram-topics@claude-telegram-topics";

// Already selects a conversation? Then don't append our own --continue.
const SELECTS_CONVERSATION = /(^|\s)(-c|--continue|-r|--resume)(\s|$)/;

/**
 * The launch command line. When `resume` is true (relaunching a project that
 * already ran — reboot/crash recovery, the autostart and "Start session"
 * paths), add `--continue` so the session picks up its most recent
 * conversation in that directory instead of starting blank. A brand-new
 * `/start <path>` passes resume=false and starts fresh. If the operator's
 * custom TG_TOPICS_LAUNCH_CMD already selects a conversation, it's left alone.
 *
 * Placement matters: both channels flags are VARIADIC and consume every
 * following token as a channel name — flag-shaped ones included. Appending
 * `--continue` after one made claude treat "--continue" as a channel to load
 * (error popup at launch) and start WITHOUT resuming, so the flag is inserted
 * BEFORE the first variadic; it is appended only when neither is present.
 */
const VARIADIC_CHANNELS_RE =
  /(^|\s)(--channels|--dangerously-load-development-channels)(\s|$)/;

export function launchCommand(resume = false): string {
  const base = process.env.TG_TOPICS_LAUNCH_CMD?.trim() || DEFAULT_LAUNCH_CMD;
  if (!resume || SELECTS_CONVERSATION.test(base)) return base;
  const m = VARIADIC_CHANNELS_RE.exec(base);
  if (m) {
    const at = m.index + m[1]!.length;
    return base.slice(0, at) + "--continue " + base.slice(at);
  }
  return `${base} --continue`;
}

export function autostartEnabled(): boolean {
  return process.env.TG_TOPICS_AUTOSTART === "1";
}

/**
 * Trusted roots under which `/start <path>` may launch a BRAND-NEW project (one
 * not yet in topics.json). Semicolon-separated, from TG_TOPICS_LAUNCH_ROOTS.
 */
export function launchRoots(): string[] {
  return (process.env.TG_TOPICS_LAUNCH_ROOTS ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizePath);
}

/**
 * True when `target` sits inside an allowlisted launch root. DEFAULT-DENY: with
 * no TG_TOPICS_LAUNCH_ROOTS set nothing is launchable by path — launching an
 * arbitrary directory named in a chat message is remote code-exec, so it stays
 * opt-in and confined to roots the user explicitly trusts. A `..` segment is
 * rejected outright — normalizePath folds slashes and case but does NOT resolve
 * `..`, so `root/../../Windows` would otherwise prefix-match its root.
 */
export function isPathAllowed(target: string, roots = launchRoots()): boolean {
  if (roots.length === 0) return false;
  const t = normalizePath(target);
  if (t.split("/").includes("..")) return false;
  return roots.some((r) => t === r || t.startsWith(r.endsWith("/") ? r : r + "/"));
}

/** Project display name from a path — its last segment, original case kept. */
export function projectNameFromPath(target: string): string {
  const seg = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return (seg ?? "").trim() || target;
}

/** Console window title: strictly safe chars so cmd quoting can't break. */
export function windowTitle(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "session";
  return `tg_${safe}`;
}

/**
 * Build the `cmd /c` command line for a detached launch. The title MUST be
 * quoted: `start` treats the first *unquoted* token as the program to run, so
 * `start tg_foo cmd …` tried to execute `tg_foo` — which both broke the launch
 * and, worse, would run a `tg_foo.cmd`/`.exe` planted in the project directory.
 * A quoted title is always a title. windowTitle already restricts it to
 * [A-Za-z0-9_-], so nothing inside the quotes can break out.
 */
export function buildStartLine(title: string, cmd: string): string {
  return `start "${title}" cmd /k ${cmd}`;
}

/**
 * Canonical on-disk spelling of a project path (drive letter + segment case).
 * The topic map stores the NORMALIZED (lowercased) key, but Claude Code keys
 * both its folder-trust record and its per-cwd conversation history by the
 * exact path string — a session spawned with the lowercased spelling hung at
 * the "do you trust this folder?" prompt (live incident) and `--continue`
 * would look for history under the wrong key and start blank.
 */
function canonicalCwd(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // path gone / native unavailable — spawn fails loudly downstream
  }
}

/**
 * Spawn a detached session for the project. Returns null on success or a
 * user-facing error message. `projectPath` must come from topics.json (a
 * project the user has already bridged) — never from raw message text; it is
 * passed as the spawn cwd (not interpolated into the command line), so a path
 * with shell metacharacters cannot inject.
 */
export function spawnSession(
  projectPath: string,
  name: string,
  resume = false,
): string | null {
  if (process.platform !== "win32") {
    return "session launch is only supported on Windows for now — start one manually on the machine";
  }
  const cmd = launchCommand(resume);
  try {
    const line = buildStartLine(windowTitle(name), cmd);
    Bun.spawn(["cmd", "/c", line], {
      cwd: canonicalCwd(projectPath),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // The composed line must reach cmd VERBATIM. Bun's default Windows arg
      // encoding escapes embedded quotes C-runtime-style (\") — which cmd.exe
      // does not understand, so `start "tg_x" …` arrived as `start \"tg_x\" …`
      // and start resolved the PROGRAM to `\tg_x\` ("Windows cannot find
      // '\tg_x\'" popup, nothing launched, queued messages expired).
      windowsVerbatimArguments: true,
    });
    log("session.spawn", { project: projectPath, cmd, resume });
    return null;
  } catch (e) {
    log("session.spawn.fail", { project: projectPath, error: String(e) });
    return `failed to launch: ${e}`;
  }
}
