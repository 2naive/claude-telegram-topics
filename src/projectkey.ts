// Shared project-identity key derivation.
//
// Used BOTH by the leader-side session identity (project.ts) AND by the
// activity hook (hooks/activity.ts), so a hook and the leader compute the SAME
// topic key for a given directory — a mismatch would silently route the
// working/idle signal to the wrong (or no) topic. Imports only paths.ts (pure)
// and child_process, so a lightweight hook can load it without pulling in the
// config/state machinery.

import { spawnSync } from "node:child_process";
import { normalizePath } from "./paths.ts";

/**
 * Git repository root of `cwd`, or `cwd` itself when not in a repo / git is
 * absent. Un-normalized (git prints forward slashes; a cwd fallback keeps its
 * native separators — normalizePath folds both).
 */
export function gitTopLevel(cwd: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // git not present or not a repo — the cwd IS the identity
  }
  return cwd;
}

/**
 * The stable project identity key for a raw directory — identical to the
 * leader's projectKey() (normalizePath ∘ gitTopLevel). Passing a subdirectory
 * of a git repo yields the same key as its root, because git resolves both to
 * the same --show-toplevel.
 */
export function keyFromCwd(cwd: string): string {
  return normalizePath(gitTopLevel(cwd));
}
