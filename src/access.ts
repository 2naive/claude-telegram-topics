// Access control + outbound-file hardening.
//
// Ported in spirit from the official plugin: an allowlist gates who may drive a
// session, and the bridge refuses to upload its own state files (which hold the
// bot token) even if a tool is asked to.

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { ALLOWED_USER_IDS, STATE_DIR } from "./config.ts";

export function isAllowedUser(userId: string | number | undefined): boolean {
  if (userId === undefined) return false;
  // Empty allowlist => trust the group's own membership as the boundary.
  if (ALLOWED_USER_IDS.size === 0) return true;
  return ALLOWED_USER_IDS.has(String(userId));
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
