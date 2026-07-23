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

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** Console window title: strictly safe chars so shell quoting can't break. */
export function windowTitle(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "session";
  return `tg_${safe}`;
}

/** PowerShell single-quoted literal: the only escape is doubling the quote. */
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the PowerShell Start-Process line for a detached console launch.
 *
 * Why Start-Process and not `cmd /c start`: a child spawned directly inherits
 * copies of ALL our handles on Windows — including the leader's LISTEN socket
 * on the control port. Any leader death with such consoles alive then left the
 * port LISTEN-ing under a dead pid: no re-election possible, whole bridge dead
 * (three live incidents in one night). Start-Process goes through ShellExecute,
 * which passes NO handles to the console; the intermediary powershell inherits
 * them but exits right after launching, shrinking the hostage window to ~1 s.
 * Probed empirically: direct spawn = port hostage, Start-Process = port free.
 *
 * The working directory rides inside the line (-WorkingDirectory) because the
 * console must start in the project, not wherever the leader happens to run.
 * All embedded values are PS single-quoted (psQuote); windowTitle is already
 * restricted to [A-Za-z0-9_-].
 */
export function buildLaunchPs(title: string, cmd: string, cwd: string): string {
  const inner = `title ${title} & ${cmd}`;
  return (
    `Start-Process -FilePath cmd.exe -ArgumentList '/k',${psQuote(inner)} ` +
    `-WorkingDirectory ${psQuote(cwd)}`
  );
}

/**
 * Canonical on-disk spelling of a project path (drive letter + segment case).
 * The topic map stores the NORMALIZED (lowercased) key, but Claude Code keys
 * both its folder-trust record and its per-cwd conversation history by the
 * exact path string — a session spawned with the lowercased spelling hung at
 * the "do you trust this folder?" prompt (live incident) and `--continue`
 * would look for history under the wrong key and start blank.
 */
export function canonicalCwd(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // path gone / native unavailable — spawn fails loudly downstream
  }
}

/**
 * Directories under the launch roots that are NOT bridged yet — the `/list`
 * discovery section: projects you could `/start` without remembering the path.
 * Depth 1 per root, dot-dirs skipped, already-bridged keys excluded. Paths are
 * canonicalized for display AND because the eventual spawn cwd must carry the
 * on-disk case. Empty when TG_TOPICS_LAUNCH_ROOTS is unset — default-deny
 * means nothing is launchable, so nothing is advertised.
 */
export function discoverLaunchable(
  knownKeys: Set<string>,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const root of launchRoots()) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // root missing/unreadable — nothing to discover there
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const p = join(root, name);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      if (knownKeys.has(normalizePath(p))) continue;
      out.push({ name, path: canonicalCwd(p) });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Build the detached kill line for a session's claude process tree. */
export function buildStopPs(pid: number): string {
  return (
    `Start-Process -FilePath taskkill.exe -ArgumentList ` +
    `'/PID','${Math.floor(pid)}','/T','/F' -WindowStyle Hidden`
  );
}

/**
 * End a session by killing its claude process tree (remote /stop, /new).
 * Start-Process detaches the taskkill, so this works even when the CALLER sits
 * inside the tree being killed (stopping the leader's own session: the kill
 * survives the leader's death and the fleet re-elects — safe now that spawned
 * consoles no longer inherit the listen socket).
 */
export function stopProcessTree(pid: number): boolean {
  if (process.platform !== "win32") return false;
  try {
    Bun.spawn(["powershell", "-NoProfile", "-Command", buildStopPs(pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    log("session.stop", { pid });
    return true;
  } catch (e) {
    log("session.stop.fail", { pid, error: String(e) });
    return false;
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
    const line = buildLaunchPs(windowTitle(name), cmd, canonicalCwd(projectPath));
    // NOTE: no windowsVerbatimArguments here — PowerShell parses MSVCRT-style
    // quoting, so Bun's DEFAULT encoding is correct for it (the 0.12.2 verbatim
    // lesson applies only when composing a line for cmd.exe, which this spawn
    // no longer does).
    Bun.spawn(["powershell", "-NoProfile", "-Command", line], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    log("session.spawn", { project: projectPath, cmd, resume });
    return null;
  } catch (e) {
    log("session.spawn.fail", { project: projectPath, error: String(e) });
    return `failed to launch: ${e}`;
  }
}
