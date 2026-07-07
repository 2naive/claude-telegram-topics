// Test preload — runs before any test file or module import (bunfig.toml).
//
// config.ts freezes env-derived values at first import, and bun test shares
// one module cache across files, so whichever file imported config first used
// to decide the state dir for everyone (each file raced with `||=`). Setting
// the environment here, unconditionally, removes the ordering hazard AND the
// scarier one: without it a stray import could read the LIVE channel state
// (real bot token in ~/.claude/channels/telegram-topics/.env) or dial the real
// control port where a production leader may be running.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TG_TOPICS_STATE_DIR = mkdtempSync(join(tmpdir(), "tg-topics-test-"));
process.env.TG_TOPICS_PORT = "18787";
process.env.TELEGRAM_BOT_TOKEN = "000000:test-dummy-token";
process.env.TELEGRAM_GROUP_CHAT_ID = "-100999";
// Deliberately NOT set: TELEGRAM_ALLOWED_USER_IDS — a shell-provided value
// pins the allowlist for the process lifetime (envFromShell), which would
// disable the TTL re-read path that access.test.ts exercises.
delete process.env.TELEGRAM_ALLOWED_USER_IDS;
delete process.env.TG_TOPICS_LAUNCH_CMD;
delete process.env.TG_TOPICS_AUTOSTART;
