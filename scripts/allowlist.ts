#!/usr/bin/env bun
// One-command channels-allowlist setup: put this plugin (and the official
// Telegram plugin, since the list REPLACES the default allowlist) into
// Claude Code's managed settings, so `--channels` actually wires the channel.
//
// Merge-safe: existing managed-settings keys and allowlist entries are
// preserved. Idempotent: already allowlisted -> no-op. On Windows the target
// lives under Program Files, so a direct write is attempted first (elevated
// shells work) and otherwise a UAC prompt applies it; on macOS/Linux a failed
// write prints the exact sudo command instead.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  channelAllowlistState,
  managedSettingsPath,
  mergeManagedSettings,
} from "../src/allowlist.ts";

const path = managedSettingsPath();

const before = channelAllowlistState();
if (before.ok) {
  console.log(`OK   already allowlisted — nothing to do (${path})`);
  process.exit(0);
}

let existing: unknown = null;
if (existsSync(path)) {
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.log(`FAIL existing managed settings are not valid JSON: ${path}`);
    console.log(`     ${e}`);
    console.log("     Fix or remove that file, then re-run.");
    process.exit(1);
  }
}

const json = JSON.stringify(mergeManagedSettings(existing), null, 2) + "\n";

function verifyAndExit(): never {
  const after = channelAllowlistState();
  if (after.ok) {
    console.log(`OK   channel allowlisted (${path})`);
    console.log(
      "     Restart Claude Code sessions to apply — the allowlist is read at session start.",
    );
    process.exit(0);
  }
  console.log(`FAIL verification failed: ${after.detail}`);
  process.exit(1);
}

// 1) Direct write (works in an elevated shell, and on macOS/Linux when root).
try {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  verifyAndExit();
} catch {
  // fall through to the platform-specific privileged path
}

if (process.platform !== "win32") {
  console.log(`FAIL cannot write ${path} (permission denied). Run:`);
  console.log(`  sudo mkdir -p '${dirname(path)}' && sudo tee '${path}' > /dev/null <<'EOF'`);
  process.stdout.write(json);
  console.log("EOF");
  process.exit(1);
}

// 2) Windows: apply via an elevated helper — the user approves one UAC prompt.
const work = join(tmpdir(), `tg-topics-allowlist-${process.pid}`);
mkdirSync(work, { recursive: true });
const payload = join(work, "managed-settings.json");
const marker = join(work, "result.txt");
const ps1 = join(work, "apply.ps1");
writeFileSync(payload, json);
writeFileSync(
  ps1,
  [
    "try {",
    `  New-Item -ItemType Directory -Path '${dirname(path)}' -Force | Out-Null`,
    `  Copy-Item -Path '${payload}' -Destination '${path}' -Force`,
    `  'OK' | Out-File -FilePath '${marker}' -Encoding ascii`,
    "} catch {",
    `  ('FAILED: ' + $_.Exception.Message) | Out-File -FilePath '${marker}' -Encoding ascii`,
    "}",
    "",
  ].join("\n"),
);

console.log("     Writing needs admin — approve the UAC prompt to continue…");
const proc = Bun.spawn(
  [
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`,
  ],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
);
await proc.exited;

// The elevated helper writes the marker; give the filesystem a moment.
for (let i = 0; i < 20 && !existsSync(marker); i++) {
  await new Promise((r) => setTimeout(r, 500));
}
if (!existsSync(marker)) {
  console.log("FAIL the elevated helper did not run (UAC declined or blocked).");
  console.log(`     Re-run this command, or create ${path} by hand with:`);
  process.stdout.write(json);
  process.exit(1);
}
const result = readFileSync(marker, "utf8").trim();
if (!result.startsWith("OK")) {
  console.log(`FAIL elevated write failed: ${result}`);
  process.exit(1);
}
verifyAndExit();
