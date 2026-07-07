// Leader-side diagnostic log (STATE_DIR/leader.log, JSONL).
//
// The leader is a detached background process with no visible console, so
// without a file there is zero visibility into poller health and routing
// decisions — two live bugs went undiagnosable for exactly this reason.
// Best-effort by design: a logging failure must never break routing.

import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

const LOG_FILE = join(STATE_DIR, "leader.log");
const MAX_BYTES = 1024 * 1024;

export function log(event: string, detail: Record<string, unknown> = {}): void {
  try {
    try {
      // One-deep rotation; rename replaces an existing .1 on Windows too.
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      // no log file yet
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // best-effort
  }
}
