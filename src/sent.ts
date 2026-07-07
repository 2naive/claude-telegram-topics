// Bot-sent message bookkeeping, persisted across leader hand-offs.
//
// One record per sent message replaces the three independent in-memory maps
// (topic, owning session, button labels) the leader used to hold: keyed
// together they evict together, and persisting them means reactions keep
// routing, button taps keep their labels, and replies regain exact ownership
// (after the owner re-registers) even when leadership changes mid-flight.
//
// Follows the topics.ts persistence pattern: JSON in STATE_DIR, tmp+rename
// atomic writes, corruption -> start empty. Writes are debounced; stopLeader()
// flushes synchronously before the port is released, so the next leader always
// loads the final state (a hard crash loses at most the debounce window).

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { SENT_FILE } from "./config.ts";

export type SentRecord = {
  topicId: number;
  sessionId: string;
  options?: string[];
  at: number;
};

const SENT_LIMIT = 2000;

let sent = new Map<number, SentRecord>();

// --- persistence ---

// Ownership gate: only the CURRENT leader may touch sent.json. Without it, a
// demoted leader's in-flight handler could schedule a debounced write that
// lands AFTER the successor loaded the file — silently clobbering it (and
// racing over the shared .tmp path). loadSent() (called on winning the port)
// takes ownership; flushSent() (called on releasing it) writes and lets go.
let owner = false;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function write(): void {
  try {
    const obj: Record<string, SentRecord> = {};
    for (const [k, v] of sent) obj[String(k)] = v;
    const tmp = SENT_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    // Atomic swap. On Windows, renaming over a file another process holds open
    // can throw EPERM — a couple of short blocking retries ride out a reader.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, SENT_FILE);
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        Bun.sleepSync(25);
      }
    }
  } catch (e) {
    // In-memory state keeps serving; the map just won't survive a hand-off.
    process.stderr.write(`telegram-topics: failed to persist sent.json: ${e}\n`);
  }
}

function schedulePersist(): void {
  if (!owner || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (owner) write();
  }, 1000);
  // A pending write must never hold the process open; flushSent() covers it.
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Final flush + ownership release: call before the control port is released,
 * so the successor loads the final state and no late debounce clobbers it. */
export function flushSent(): void {
  if (!owner) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  write();
  owner = false;
}

function isRecord(v: unknown): v is SentRecord {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SentRecord).topicId === "number" &&
    typeof (v as SentRecord).sessionId === "string" &&
    ((v as SentRecord).options === undefined ||
      (Array.isArray((v as SentRecord).options) &&
        (v as SentRecord).options!.every((o) => typeof o === "string")))
  );
}

/** Load the persisted map and take file ownership (leader startup, right
 * after winning the port). Bad entries are skipped; a corrupt file starts
 * empty rather than crashing. */
export function loadSent(): void {
  owner = true;
  sent = new Map();
  try {
    if (!existsSync(SENT_FILE)) return;
    const parsed: unknown = JSON.parse(readFileSync(SENT_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const entries: Array<[number, SentRecord]> = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (!/^\d+$/.test(k) || !isRecord(v)) continue;
      entries.push([Number(k), v]);
    }
    // Insertion order drives eviction — reconstruct it by age.
    entries.sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    for (const [k, v] of entries.slice(-SENT_LIMIT)) sent.set(k, v);
  } catch {
    sent = new Map(); // corrupt file — start clean
  }
}

// --- tracking & lookups ---

export function trackSent(
  messageId: number,
  rec: { topicId: number; sessionId: string; options?: string[] },
): void {
  sent.set(messageId, { ...rec, at: Date.now() });
  if (sent.size > SENT_LIMIT) {
    const drop = sent.size - SENT_LIMIT / 2;
    let i = 0;
    for (const k of sent.keys()) {
      if (i++ >= drop) break;
      sent.delete(k);
    }
  }
  schedulePersist();
}

export function topicForSentMessage(messageId: number): number | undefined {
  return sent.get(messageId)?.topicId;
}

export function sessionForSentMessage(messageId: number): string | undefined {
  return sent.get(messageId)?.sessionId;
}

/** Read a message's button labels and consume them, so an already-answered
 * keyboard stays consumed across a later hand-off. */
export function takeOptions(messageId: number): string[] | undefined {
  const rec = sent.get(messageId);
  if (!rec?.options) return undefined;
  const options = rec.options;
  delete rec.options;
  schedulePersist();
  return options;
}

/** Move message ownership from a re-registered session's old id to its new
 * one, so replies and taps on already-sent messages keep routing to it. */
export function remapSentSessions(from: string, to: string): void {
  let changed = false;
  for (const rec of sent.values()) {
    if (rec.sessionId === from) {
      rec.sessionId = to;
      changed = true;
    }
  }
  if (changed) schedulePersist();
}
