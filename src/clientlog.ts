// Client-side diagnostic sink. The MCP server's stderr is not persisted
// anywhere the operator can read (Claude Code's per-session debug log records
// tool calls and notifications, not plugin stderr) — a live incident where the
// inbound loop died silently was undiagnosable for that reason. Rare,
// operationally significant client events land here instead, in the shared
// channel state dir next to leader.log.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

export function clientLog(event: string, detail: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...detail,
    });
    appendFileSync(join(STATE_DIR, "client.log"), line + "\n");
  } catch {
    // diagnostics must never break the client
  }
}
