// Project identity: the unit that maps 1:1 to a Telegram forum topic.
//
// A "project" is the git repository root of the session's cwd, so opening the
// same repo from a subdirectory (or in a second session) resolves to the same
// topic. Falls back to the cwd when the session is not inside a git repo.
//
// Identity is the NORMALIZED full path (see normalizePath) so path-spelling
// differences don't spawn duplicate topics; the topic TITLE is the project's
// own folder name, in its original case.

import { spawnSync } from "node:child_process";
import { normalizePath, displayName } from "./paths.ts";
import { SESSION_NAME_OVERRIDE } from "./config.ts";

let cachedRaw: string | null = null;

/** The project's root path as reported by git (or cwd), un-normalized. */
function rawProjectPath(): string {
  if (cachedRaw) return cachedRaw;
  const cwd = process.cwd();
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout.trim()) {
      cachedRaw = r.stdout.trim();
      return cachedRaw;
    }
  } catch {
    // git not present or not a repo — fall through to cwd
  }
  cachedRaw = cwd;
  return cachedRaw;
}

/** Stable identity key: the normalized full path of the project. */
export function projectKey(): string {
  return normalizePath(rawProjectPath());
}

/** Topic title: the project folder name (SESSION_NAME_OVERRIDE wins). */
export function projectName(): string {
  if (SESSION_NAME_OVERRIDE) return SESSION_NAME_OVERRIDE;
  return displayName(rawProjectPath());
}

let cachedLabel: string | null = null;

/**
 * A short label distinguishing concurrent sessions on the same project. Prefers
 * the git branch (two sessions on one repo usually differ by branch); empty when
 * unavailable, in which case the leader falls back to a slice of the session id.
 */
export function sessionLabel(): string {
  if (cachedLabel !== null) return cachedLabel;
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0) {
      const b = r.stdout.trim();
      if (b && b !== "HEAD") {
        cachedLabel = b;
        return b;
      }
    }
  } catch {
    // not a repo / detached HEAD — no branch label
  }
  cachedLabel = "";
  return "";
}
