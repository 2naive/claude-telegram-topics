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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath, displayName } from "./paths.ts";
import { gitTopLevel } from "./projectkey.ts";
import { pickSessionField, type SessionRecord } from "./routing.ts";
import { CONFIG_DIR, SESSION_NAME_OVERRIDE } from "./config.ts";
import { pidCandidates } from "./pids.ts";

// --- Claude Code session records (<config>/sessions/<pid>.json) ---
//
// Claude Code spawns plugin MCP servers with cwd = its CONFIG dir (~/.claude),
// NOT the session's working directory — so process.cwd() here would collapse
// every project on the machine into one "~/.claude" topic. The session's real
// cwd — like its /rename name — lives only in the per-pid session record.
//
// Identity ladder, ordered by trust:
//  1. sessions/<claude pid>.json via the parent chain (record files are NAMED
//     by the claude process pid — this server's grandparent, or parent on a
//     direct spawn). Works even when CLAUDE_CODE_SESSION_ID is missing, which
//     is exactly the /reload-plugins respawn case that once registered a
//     garbage "~/.claude" project. The env id, when present, must CONFIRM the
//     record (a mismatch means pid reuse / a stale file).
//  2. Scan all records matched by CLAUDE_CODE_SESSION_ID (legacy path, covers
//     a failed parent-chain query).
//  3. process.cwd() — provisional, NEVER cached: a record can start answering
//     at any time, and every recomputation is a self-heal opportunity.

function readSessionRecords(): SessionRecord[] {
  let files: string[];
  const dir = join(CONFIG_DIR, "sessions");
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

function readSessionRecordFor(pid: number): SessionRecord | null {
  try {
    const rec: unknown = JSON.parse(
      readFileSync(join(CONFIG_DIR, "sessions", `${pid}.json`), "utf8"),
    );
    return rec && typeof rec === "object" ? (rec as SessionRecord) : null;
  } catch {
    return null;
  }
}

function pidRecord(): SessionRecord | null {
  const cands = pidCandidates();
  if (!cands) return null; // platform query still warming — recheck next tick
  const envId = process.env.CLAUDE_CODE_SESSION_ID || "";
  for (const c of cands) {
    const r = readSessionRecordFor(c.pid);
    if (!r || typeof r.cwd !== "string" || !r.cwd.trim()) continue;
    // The env id, when present, must CONFIRM the record.
    if (envId && r.sessionId && r.sessionId !== envId) continue;
    // Pid-reuse guard: a record last written BEFORE this pid's process even
    // started belongs to a previous (dead) owner of the pid number.
    if (
      c.startedAt !== null &&
      typeof r.updatedAt === "number" &&
      r.updatedAt < c.startedAt - 60_000
    ) {
      continue;
    }
    return r;
  }
  return null;
}

function sessionField(field: "name" | "cwd"): string {
  const fromPid = pidRecord()?.[field];
  if (typeof fromPid === "string" && fromPid.trim()) return fromPid.trim();
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) return "";
  return pickSessionField(readSessionRecords(), id, field);
}

// The session cwd is cached only once a record yields it: at server startup
// the record may not be written yet, and caching the process.cwd() fallback
// then would freeze the wrong identity for the whole session. Re-registration
// (and every send) recomputes until a record answers.
//
// One terminal exception: no CLAUDE_CODE_SESSION_ID AND no sessions dir at all
// (ancient Claude Code / relocated config) — no identity source can ever
// answer, so the fallback is final. Without this, such environments would pay
// the registration wait and run the heal loop forever for nothing. The branch
// arms only after a grace window: on a fresh install the sessions dir is
// created lazily moments after the MCP server spawns, and terminal-caching on
// the very first call would freeze the config-dir identity with the heal
// machinery disarmed — the exact incident this ladder exists to prevent.
const IDENTITY_TERMINAL_AFTER = Date.now() + 10_000;
let cachedCwd: string | null = null;
function baseCwd(): string {
  if (cachedCwd) return cachedCwd;
  const fromStore = sessionField("cwd");
  if (fromStore) {
    cachedCwd = fromStore;
    return fromStore;
  }
  if (
    !process.env.CLAUDE_CODE_SESSION_ID &&
    Date.now() >= IDENTITY_TERMINAL_AFTER &&
    !existsSync(join(CONFIG_DIR, "sessions"))
  ) {
    cachedCwd = process.cwd();
    return cachedCwd;
  }
  return process.cwd();
}

/** True once identity is record-backed (not the provisional cwd fallback). */
export function identityResolved(): boolean {
  return cachedCwd !== null;
}

// --- The claude process pid (for remote /stop) ------------------------------
//
// Reported to the leader at registration so `/stop` / `/new` from Telegram can
// end this session by killing the claude process tree. Two sources, same trust
// rules as the identity ladder: (1) a parent-chain candidate whose session
// record answers (direct chains); (2) the sessions/<pid>.json whose sessionId
// matches ours — the record file is NAMED after the claude pid. Cached once
// found: the pid cannot change within a session's lifetime.
let cachedClaudePid: number | null = null;
export function claudePid(): number | null {
  if (cachedClaudePid !== null) return cachedClaudePid;
  const envId = process.env.CLAUDE_CODE_SESSION_ID || "";
  const cands = pidCandidates();
  if (cands) {
    for (const c of cands) {
      const r = readSessionRecordFor(c.pid);
      if (!r || typeof r.cwd !== "string" || !r.cwd.trim()) continue;
      if (envId && r.sessionId && r.sessionId !== envId) continue;
      cachedClaudePid = c.pid;
      return c.pid;
    }
  }
  if (envId) {
    try {
      for (const f of readdirSync(join(CONFIG_DIR, "sessions"))) {
        if (!f.endsWith(".json")) continue;
        const pid = parseInt(f, 10);
        if (!Number.isFinite(pid) || pid <= 1) continue;
        const rec = readSessionRecordFor(pid);
        if (rec?.sessionId === envId) {
          cachedClaudePid = pid;
          return pid;
        }
      }
    } catch {
      // sessions dir unreadable — no pid, remote stop unavailable for us
    }
  }
  return null;
}

/**
 * Bounded startup wait: give the session record a chance to appear before the
 * first registration, so a fresh (or reloaded) server doesn't register a
 * provisional identity it would immediately have to heal.
 */
export async function waitForIdentity(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    baseCwd(); // recompute — caches as soon as a record answers
    if (identityResolved()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

let cachedRoot: string | null = null;

/** The project's root path as reported by git (or the session cwd), un-normalized. */
function rawProjectPath(): string {
  if (cachedRoot) return cachedRoot;
  // gitTopLevel is the SAME resolver the activity hook uses (projectkey.ts), so
  // keyFromCwd(sessionCwd) in a hook matches this session's projectKey().
  const root = gitTopLevel(baseCwd());
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
