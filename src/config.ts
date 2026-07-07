// Configuration + state paths.
//
// Everything the bridge needs comes from a single .env file (or the process
// environment, which takes precedence). State (the project -> topic map) lives
// next to it so a fresh machine only needs the token + group id to be restored.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import pkg from "../package.json";

// Single source of truth for the running code's version (package.json). Drives
// the leader hand-off: a session running newer code takes leadership over.
export const VERSION: string = pkg.version;

export const STATE_DIR =
  process.env.TG_TOPICS_STATE_DIR ||
  join(homedir(), ".claude", "channels", "telegram-topics");

// Claude Code's config dir — where session records (sessions/<pid>.json) live,
// and the cwd Claude Code gives plugin MCP servers (which is why a bare
// process.cwd() here is always suspect as a project identity).
export const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export const ENV_FILE = join(STATE_DIR, ".env");
export const TOPICS_FILE = join(STATE_DIR, "topics.json");
export const SENT_FILE = join(STATE_DIR, "sent.json");

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

// Load .env without a dependency: KEY=VALUE lines, # comments, shell wins.
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

// A forum-enabled supergroup id (negative, e.g. -1001234567890). Topics are
// created inside it, one per project.
export const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID ?? "";

// Loopback control port the leader binds; followers connect to it. The bind
// itself is the leader-election lock, so this must be stable across sessions.
export const CONTROL_PORT = Number(process.env.TG_TOPICS_PORT ?? "8787");

// Comma-separated numeric user ids allowed to drive sessions. Empty = allow any
// member of the group (relies on the group's own membership as the boundary).
export const ALLOWED_USER_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Optional explicit name for this session's topic. Defaults to the project dir.
export const SESSION_NAME_OVERRIDE = process.env.TG_TOPICS_SESSION_NAME ?? "";

export function assertConfigured(): void {
  const missing: string[] = [];
  if (!BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!GROUP_CHAT_ID) missing.push("TELEGRAM_GROUP_CHAT_ID");
  if (missing.length) {
    throw new Error(
      `telegram-topics: missing ${missing.join(", ")}. Set them in ${ENV_FILE}`,
    );
  }
}
