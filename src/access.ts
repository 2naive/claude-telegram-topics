// Access control + outbound-file hardening.
//
// Ported in spirit from the official plugin: an allowlist gates who may drive a
// session, and the bridge refuses to upload its own state files (which hold the
// bot token) even if a tool is asked to.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  ALLOWED_USER_IDS,
  ENV_FILE,
  STATE_DIR,
  envFromShell,
  parseEnvFile,
} from "./config.ts";

/** Comma-separated ids -> set. Pure. */
export function parseAllowlist(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// The allowlist is a security control, so it re-reads from the .env on a short
// TTL: an /access revocation applies within seconds on the LIVE leader, not
// only when leadership happens to change (which on a stable fleet can be
// days). A shell-exported TELEGRAM_ALLOWED_USER_IDS keeps precedence and pins
// the import-time snapshot, matching the .env-load semantics.
export const ALLOWLIST_TTL_MS = 15_000;
let cachedList: Set<string> = ALLOWED_USER_IDS;
let cachedAt = 0;

export function currentAllowlist(): Set<string> {
  if (envFromShell("TELEGRAM_ALLOWED_USER_IDS")) return ALLOWED_USER_IDS;
  const now = Date.now();
  if (now - cachedAt < ALLOWLIST_TTL_MS) return cachedList;
  cachedAt = now;
  try {
    if (existsSync(ENV_FILE)) {
      const value = parseEnvFile(readFileSync(ENV_FILE, "utf8"))["TELEGRAM_ALLOWED_USER_IDS"];
      cachedList = parseAllowlist(value ?? "");
    }
    // A missing .env is treated like an unreadable one: keep the last known
    // list rather than silently opening the channel to every group member.
    // (The very first read starts from the import-time snapshot, which is
    // already empty when nothing was configured.)
  } catch {
    // Unreadable .env: keep the last known list rather than failing open.
  }
  return cachedList;
}

/** Test seam: drop the TTL cache so the next call re-reads the file. */
export function resetAllowlistCacheForTest(): void {
  cachedAt = 0;
}

export function isAllowedUser(userId: string | number | undefined): boolean {
  if (userId === undefined) return false;
  const list = currentAllowlist();
  // Empty allowlist => trust the group's own membership as the boundary.
  if (list.size === 0) return true;
  return list.has(String(userId));
}

// Reject attempts to send anything inside the state dir (the .env with the
// token). Mirrors the official plugin's assertSendable guard.
export function assertSendable(path: string): void {
  let real: string;
  let stateReal: string;
  try {
    real = realpathSync(path);
    stateReal = realpathSync(STATE_DIR);
  } catch {
    return; // let the normal read fail with a clear error instead
  }
  if (real === stateReal || real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send channel state file: ${path}`);
  }
}
