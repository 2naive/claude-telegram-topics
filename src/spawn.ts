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

import { log } from "./log.ts";

export const DEFAULT_LAUNCH_CMD =
  "claude --permission-mode auto --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics";

export function launchCommand(): string {
  return process.env.TG_TOPICS_LAUNCH_CMD?.trim() || DEFAULT_LAUNCH_CMD;
}

export function autostartEnabled(): boolean {
  return process.env.TG_TOPICS_AUTOSTART === "1";
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
 * Spawn a detached session for the project. Returns null on success or a
 * user-facing error message. `projectPath` must come from topics.json (a
 * project the user has already bridged) — never from raw message text; it is
 * passed as the spawn cwd (not interpolated into the command line), so a path
 * with shell metacharacters cannot inject.
 */
export function spawnSession(projectPath: string, name: string): string | null {
  if (process.platform !== "win32") {
    return "session launch is only supported on Windows for now — start one manually on the machine";
  }
  const cmd = launchCommand();
  try {
    const line = buildStartLine(windowTitle(name), cmd);
    Bun.spawn(["cmd", "/c", line], {
      cwd: projectPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    log("session.spawn", { project: projectPath, cmd });
    return null;
  } catch (e) {
    log("session.spawn.fail", { project: projectPath, error: String(e) });
    return `failed to launch: ${e}`;
  }
}
