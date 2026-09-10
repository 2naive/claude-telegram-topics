// Persistence for the held-inbox — messages that arrived for a project with no
// live session, waiting for one to register.
//
// Why this file exists (live incident): heldInbox lived only in the leader's
// memory. A message could arrive, get held, and then a LEADER HAND-OFF (a newer
// version stepping up, a crash, a restart) would drop the outgoing leader's
// memory before the message drained — the user's message vanished with no
// trace (register fired, but no held.drained). Redelivery (0.14.0) covers a
// message lost to a SESSION; this covers one lost to a leader change.
//
// Follows the sent.ts / topics.ts pattern: JSON in STATE_DIR, tmp+rename atomic
// swap, an ownership gate so only the current leader writes (a demoted leader
// must not clobber its successor's file), a debounced write, and a final flush
// on releasing the port so the successor loads the last state.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { HELD_FILE } from "./config.ts";
import type { Inbound } from "./leader.ts";

export type HeldEntry = { msgs: Inbound[]; at: number };

let owner = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let current: Map<string, HeldEntry> | null = null; // the map to serialize

function write(): void {
  if (!current) return;
  try {
    const obj: Record<string, HeldEntry> = {};
    for (const [k, v] of current) if (v.msgs.length > 0) obj[k] = v;
    const tmp = HELD_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    // Atomic swap. On Windows, renaming over a file a reader holds open can
    // throw EPERM — a couple of short blocking retries ride it out.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, HELD_FILE);
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        Bun.sleepSync(25);
      }
    }
  } catch (e) {
    // In-memory state keeps serving; it just won't survive a hand-off.
    process.stderr.write(`telegram-topics: failed to persist held.json: ${e}\n`);
  }
}

/** Debounced persist of the held map. No-op unless this process owns the file
 * (is the leader). Call after every heldInbox mutation. */
export function persistHeld(map: Map<string, HeldEntry>): void {
  current = map;
  if (!owner || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (owner) write();
  }, 1000);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Final flush + ownership release: call before releasing the control port so
 * the successor loads the final held state and no late debounce clobbers it. */
export function flushHeld(): void {
  if (!owner) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  write();
  owner = false;
}

function validEntry(v: unknown): v is HeldEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as HeldEntry;
  return (
    typeof e.at === "number" &&
    Array.isArray(e.msgs) &&
    e.msgs.every(
      (m) => !!m && typeof m === "object" && typeof (m as Inbound).messageId === "number",
    )
  );
}

/** Turn parsed held.json into a live map: skip malformed entries, drop those
 * older than ttlMs (they expired while there was no leader) and empty ones.
 * Pure and exported for tests. */
export function parseHeld(parsed: unknown, now: number, ttlMs: number): Map<string, HeldEntry> {
  const out = new Map<string, HeldEntry>();
  if (!parsed || typeof parsed !== "object") return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!validEntry(v)) continue;
    if (now - v.at >= ttlMs) continue;
    if (v.msgs.length > 0) out.set(k, v);
  }
  return out;
}

/** Load the persisted held map and take file ownership (leader startup, right
 * after winning the port). A corrupt file starts empty rather than crashing.
 * Returns the entries to merge into the live heldInbox. */
export function loadHeld(ttlMs: number): Map<string, HeldEntry> {
  owner = true;
  try {
    if (!existsSync(HELD_FILE)) return new Map();
    return parseHeld(JSON.parse(readFileSync(HELD_FILE, "utf8")), Date.now(), ttlMs);
  } catch (e) {
    process.stderr.write(`telegram-topics: failed to load held.json: ${e}\n`);
    return new Map();
  }
}
