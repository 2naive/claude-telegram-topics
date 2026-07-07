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
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath, displayName } from "./paths.ts";
import { pickSessionName } from "./routing.ts";
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

// --- Session label (the tag shown when >1 session shares one topic) ---
//
// Preferred source: the session NAME the user set via /rename. Claude Code does
// not hand that name to MCP servers, but it DOES set CLAUDE_CODE_SESSION_ID and
// records each session (keyed by pid) under <config>/sessions/*.json with
// matching `sessionId` + `name` fields — rewritten whenever the name changes. So
// we look it up there. Falls back to the git branch, then (leader-side) an id
// slice.

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function sessionNameFromStore(sessionId: string): string {
  let files: string[];
  const dir = join(configDir(), "sessions");
  try {
    files = readdirSync(dir);
  } catch {
    return ""; // no sessions dir (older Claude Code, or relocated config)
  }
  const entries: Array<{ sessionId?: string; name?: string; updatedAt?: number }> = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      // skip an unreadable / half-written record
    }
  }
  return pickSessionName(entries, sessionId);
}

let cachedBranch: string | null = null;
function gitBranch(): string {
  if (cachedBranch !== null) return cachedBranch;
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0) {
      const b = r.stdout.trim();
      if (b && b !== "HEAD") {
        cachedBranch = b;
        return b;
      }
    }
  } catch {
    // not a repo / detached HEAD
  }
  cachedBranch = "";
  return "";
}

// Short TTL so a mid-session /rename is reflected without re-reading the store
// on every outbound message.
let labelCache: { value: string; at: number } | null = null;
const LABEL_TTL_MS = 15_000;

/**
 * Label distinguishing concurrent sessions on one project: the /rename session
 * name, else the git branch, else "" (the leader then uses a slice of the id).
 */
export function sessionLabel(): string {
  const now = Date.now();
  if (labelCache && now - labelCache.at < LABEL_TTL_MS) return labelCache.value;
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  const value = (id ? sessionNameFromStore(id) : "") || gitBranch();
  labelCache = { value, at: now };
  return value;
}
