// The control port the telegram-topics leader listens on — env wins, else the
// channel .env (a custom port may live only there), else the 8787 default.
// Mirrors config.ts precedence without importing it (config.ts has load-time
// side effects unwanted in a per-tool hook). Shared by the activity and mirror
// hooks.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolvePort(): number {
  const fromEnv = process.env.TG_TOPICS_PORT?.trim();
  if (fromEnv) return Number(fromEnv) || 8787;
  const stateDir =
    process.env.TG_TOPICS_STATE_DIR?.trim() ||
    join(
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
      "channels",
      "telegram-topics",
    );
  try {
    const env = readFileSync(join(stateDir, ".env"), "utf8");
    const m = env.match(/^\s*TG_TOPICS_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]) || 8787;
  } catch {
    // no .env — fall through to the default
  }
  return 8787;
}
