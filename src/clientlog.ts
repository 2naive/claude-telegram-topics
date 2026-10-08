// Client-side diagnostic sink. The MCP server's stderr is not persisted
// anywhere the operator can read (Claude Code's per-session debug log records
// tool calls and notifications, not plugin stderr) — a live incident where the
// inbound loop died silently was undiagnosable for that reason. Rare,
// operationally significant client events land here instead, in the shared
// channel state dir next to leader.log.
//
// Size-bounded: one-deep rotation at MAX_BYTES, identical to log.ts. The sink
// must never grow without limit however often an event fires (a session stuck
// re-registering could otherwise append forever), so the cap is enforced here
// rather than trusted to callers.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

const LOG_FILE = join(STATE_DIR, "client.log");
const MAX_BYTES = 1024 * 1024;

export function clientLog(event: string, detail: Record<string, unknown> = {}): void {
  try {
    try {
      // One-deep rotation; rename replaces an existing .1 on Windows too.
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      // no log file yet
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...detail,
    });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // diagnostics must never break the client
  }
}
