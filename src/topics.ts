// Project -> topic mapping, persisted to disk.
//
// The map is the whole point of the bridge: a stable projectKey resolves to a
// stable Telegram forum topic. If the topic was deleted on Telegram's side we
// transparently recreate it and update the map.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { Api } from "grammy";
import { GROUP_CHAT_ID, TOPICS_FILE, isRealProjectKey } from "./config.ts";
import { normalizePath } from "./paths.ts";
import { log } from "./log.ts";

type TopicRecord = { topicId: number; name: string; createdAt: number };
type TopicMap = Record<string, TopicRecord>;

let migratedDirty = false;
let map: TopicMap = load();
// Persist the key migration (if any) now that `map` is initialized.
if (migratedDirty) persist();

export function isTopicMap(v: unknown): v is TopicMap {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const rec of Object.values(v as Record<string, unknown>)) {
    if (!rec || typeof rec !== "object") return false;
    if (typeof (rec as TopicRecord).topicId !== "number") return false;
  }
  return true;
}

function load(): TopicMap {
  try {
    if (existsSync(TOPICS_FILE)) {
      const parsed: unknown = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
      // Guard against valid JSON of the wrong shape, not just parse errors —
      // a poisoned map would otherwise re-create duplicate topics forever.
      if (isTopicMap(parsed)) {
        // Re-key legacy entries under the normalized project key, so a map
        // written before path normalization keeps resolving to its existing
        // topic instead of creating a duplicate. First entry wins on collision.
        const out: TopicMap = {};
        for (const [k, rec] of Object.entries(parsed)) {
          const nk = normalizePath(k);
          // Drop junk entries keyed on the config tree / home dir (past
          // identity misfires: "~/.claude", ".claude", the cache dir). Keeping
          // them would keep routing to those garbage topics; dropping self-heals
          // the map. The forum topics themselves are cleaned separately.
          if (!isRealProjectKey(nk)) {
            migratedDirty = true;
            continue;
          }
          if (nk !== k) migratedDirty = true;
          if (!(nk in out)) out[nk] = rec;
        }
        return out;
      }
    }
  } catch {
    // missing / corrupt / parse error — start clean rather than crash the leader
  }
  return {};
}

// Fresh, normalized read of the on-disk map. Used to re-check right before
// creating a topic: a sibling leader (after a hand-off or during churn) may
// have created and persisted this topic since our in-memory `map` was loaded,
// and the per-process single-flight lock below cannot see other processes.
function diskMap(): TopicMap {
  const out: TopicMap = {};
  try {
    if (existsSync(TOPICS_FILE)) {
      const parsed: unknown = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
      if (isTopicMap(parsed)) {
        for (const [k, rec] of Object.entries(parsed)) {
          const nk = normalizePath(k);
          if (!(nk in out)) out[nk] = rec;
        }
      }
    }
  } catch {
    // unreadable / racing writer — caller falls through to create
  }
  return out;
}

function persist(): void {
  try {
    const tmp = TOPICS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, TOPICS_FILE); // atomic swap (replaces existing on Windows too)
  } catch (e) {
    // Keep serving from the in-memory map; the mapping just won't survive a
    // restart. Better than aborting /register on a transient disk error.
    process.stderr.write(`telegram-topics: failed to persist topics.json: ${e}\n`);
  }
}

async function createTopic(api: Api, name: string): Promise<number> {
  const t = await api.createForumTopic(GROUP_CHAT_ID, name);
  return t.message_thread_id;
}

// Single-flight guard: concurrent resolve/recreate calls for the same key must
// share ONE createForumTopic call, or we create duplicate topics — which
// directly defeats the "1 project = 1 topic" invariant in exactly the
// concurrent-start case the design targets. The leader is a single event loop,
// so registering the promise before the first await makes this a real lock.
const inFlight = new Map<string, Promise<number>>();

// After a failed create (e.g. the bot lost Manage Topics), refuse retries for
// a window instead of hammering createForumTopic on every registration retry —
// the register loop runs at sub-second cadence and each failure is a live
// Telegram API call (reproduced: ~4 calls/sec indefinitely).
const CREATE_RETRY_COOLDOWN_MS = 30_000;
const failedUntil = new Map<string, number>();

// reuseDisk: adopt an entry a sibling persisted since our map was loaded
// (the find-or-create path) instead of minting a duplicate. recreateTopic sets
// it false — the on-disk entry there points at the topic Telegram just reported
// GONE, so it must not be reused.
function createOnce(
  api: Api,
  key: string,
  name: string,
  reuseDisk = true,
): Promise<number> {
  // Never mint a topic for the plugin's own config tree or the bare home dir:
  // that key is the process.cwd() fallback of an unresolved session identity,
  // and creating for it produced the "~/.claude" / ".claude" / cache-dir junk
  // topics. There is no real project there, so refuse rather than pollute.
  if (!isRealProjectKey(key)) {
    return Promise.reject(
      new Error(`refusing to create a topic for non-project path "${key}"`),
    );
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const blockedUntil = failedUntil.get(key) ?? 0;
  if (Date.now() < blockedUntil) {
    return Promise.reject(
      new Error(`topic create for "${name}" failed recently; retrying after cooldown`),
    );
  }
  const p = (async () => {
    // Cross-process idempotency: reuse a topic another leader persisted since
    // our map was loaded, instead of creating a duplicate. This is the fix for
    // the burst of duplicate topics minted while leadership flapped every ~20s.
    if (reuseDisk) {
      const onDisk = diskMap()[key];
      if (onDisk) {
        failedUntil.delete(key);
        map[key] = onDisk;
        return onDisk.topicId;
      }
    }
    const topicId = await createTopic(api, name);
    failedUntil.delete(key);
    map[key] = { topicId, name, createdAt: Date.now() };
    persist();
    log("topic.created", { key, name, topicId });
    return topicId;
  })();
  inFlight.set(key, p);
  p.catch(() => failedUntil.set(key, Date.now() + CREATE_RETRY_COOLDOWN_MS));
  // Clear on both success and failure so a failed create can be retried.
  return p.finally(() => inFlight.delete(key));
}

/** Resolve (and lazily create) the topic id for a project. */
export async function resolveTopic(
  api: Api,
  key: string,
  name: string,
): Promise<number> {
  const existing = map[key];
  if (existing) return existing.topicId;
  return createOnce(api, key, name);
}

/** Recreate a topic that Telegram reports as gone, updating the map. */
export async function recreateTopic(api: Api, key: string): Promise<number> {
  // Cross-process dedup: if a sibling leader already recreated this topic (the
  // on-disk id now differs from the gone one we knew), adopt it instead of
  // minting yet another duplicate — the exact burst seen while leadership
  // flapped and each new leader independently hit "topic gone". (Fix A removes
  // the concurrent-leader condition; this is defense-in-depth.)
  const known = map[key];
  const onDisk = diskMap()[key];
  if (onDisk && (!known || onDisk.topicId !== known.topicId)) {
    map[key] = onDisk;
    log("topic.recreate.adopted", { key, topicId: onDisk.topicId });
    return onDisk.topicId;
  }
  const name = known?.name ?? key;
  log("topic.recreate", { key, name });
  // The stale record is replaced only AFTER the create succeeds (createOnce
  // overwrites map[key]). Deleting it first meant a failed recreate erased the
  // mapping, and every later /register took the failing create path — the
  // registration-storm half of the no-backoff incident. reuseDisk=false: the
  // on-disk entry points at the gone topic, so force a fresh create.
  return createOnce(api, key, name, false);
}

/** Reverse lookup: which project owns a given topic id. */
export function projectForTopic(topicId: number): string | undefined {
  for (const [key, rec] of Object.entries(map)) {
    if (rec.topicId === topicId) return key;
  }
  return undefined;
}

/** Every bridged project key (drives the /start project picker). */
export function knownProjects(): string[] {
  return Object.keys(map);
}

export function projectTopicId(key: string): number | undefined {
  return map[key]?.topicId;
}

export function topicName(key: string): string {
  return map[key]?.name ?? key;
}
