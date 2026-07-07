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
import { pickSessionField, type SessionRecord } from "./routing.ts";
import { SESSION_NAME_OVERRIDE } from "./config.ts";

// --- Claude Code session records (<config>/sessions/<pid>.json) ---
//
// Claude Code spawns plugin MCP servers with cwd = its CONFIG dir (~/.claude),
// NOT the session's working directory — so process.cwd() here would collapse
// every project on the machine into one "~/.claude" topic. The session's real
// cwd — like its /rename name — lives only in the per-pid session record,
// matched via the CLAUDE_CODE_SESSION_ID env var.

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function readSessionRecords(): SessionRecord[] {
  let files: string[];
  const dir = join(configDir(), "sessions");
  try {
    files = readdirSync(dir);
  } catch {
    return []; // no sessions dir (older Claude Code, or relocated config)
  }
  const entries: SessionRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      // skip an unreadable / half-written record
    }
  }
  return entries;
}

function sessionField(field: "name" | "cwd"): string {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) return "";
  return pickSessionField(readSessionRecords(), id, field);
}

// The session cwd is cached only once the store yields it: at server startup
// the record may not be written yet, and caching the process.cwd() fallback
// then would freeze the wrong identity for the whole session. Re-registration
// (and every send) recomputes until the store answers.
let cachedCwd: string | null = null;
function baseCwd(): string {
  if (cachedCwd) return cachedCwd;
  if (!process.env.CLAUDE_CODE_SESSION_ID) {
    // No session id — no record will ever appear; the fallback is final.
    cachedCwd = process.cwd();
    return cachedCwd;
  }
  const fromStore = sessionField("cwd");
  if (fromStore) cachedCwd = fromStore;
  return fromStore || process.cwd();
}

let cachedRoot: string | null = null;

/** The project's root path as reported by git (or the session cwd), un-normalized. */
function rawProjectPath(): string {
  if (cachedRoot) return cachedRoot;
  const cwd = baseCwd();
  let root = cwd;
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout.trim()) root = r.stdout.trim();
  } catch {
    // git not present or not a repo — keep the cwd
  }
  // Cache only once the identity is store-backed (see baseCwd) — recomputing
  // until then is cheap and self-heals the startup race.
  if (cachedCwd) cachedRoot = root;
  return root;
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

let cachedBranch: string | null = null;
function gitBranch(): string {
  if (cachedBranch !== null) return cachedBranch;
  const cwd = baseCwd();
  let branch = "";
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0) {
      const b = r.stdout.trim();
      if (b && b !== "HEAD") branch = b;
    }
  } catch {
    // not a repo / detached HEAD
  }
  // Same startup-race rule as rawProjectPath: don't freeze a fallback-derived
  // answer while the session record may still be on its way.
  if (cachedCwd) cachedBranch = branch;
  return branch;
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
  const value = sessionField("name") || gitBranch();
  labelCache = { value, at: now };
  return value;
}
