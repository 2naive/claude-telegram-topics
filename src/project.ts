// Project identity: the unit that maps 1:1 to a Telegram forum topic.
//
// A "project" is the git repository root of the session's cwd, so opening the
// same repo from a subdirectory (or in a second session) resolves to the same
// topic. Falls back to the cwd when the session is not inside a git repo.

import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { SESSION_NAME_OVERRIDE } from "./config.ts";

let cachedKey: string | null = null;

export function projectKey(): string {
  if (cachedKey) return cachedKey;
  const cwd = process.cwd();
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout.trim()) {
      cachedKey = r.stdout.trim();
      return cachedKey;
    }
  } catch {
    // git not present or not a repo — fall through to cwd
  }
  cachedKey = cwd;
  return cachedKey;
}

export function projectName(): string {
  if (SESSION_NAME_OVERRIDE) return SESSION_NAME_OVERRIDE;
  return basename(projectKey()) || "project";
}
