// Project -> topic mapping, persisted to disk.
//
// The map is the whole point of the bridge: a stable projectKey resolves to a
// stable Telegram forum topic. If the topic was deleted on Telegram's side we
// transparently recreate it and update the map.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { Api } from "grammy";
import { GROUP_CHAT_ID, TOPICS_FILE } from "./config.ts";

type TopicRecord = { topicId: number; name: string; createdAt: number };
type TopicMap = Record<string, TopicRecord>;

let map: TopicMap = load();

function isTopicMap(v: unknown): v is TopicMap {
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
      if (isTopicMap(parsed)) return parsed;
    }
  } catch {
    // missing / corrupt / parse error — start clean rather than crash the leader
  }
  return {};
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

function createOnce(api: Api, key: string, name: string): Promise<number> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const topicId = await createTopic(api, name);
    map[key] = { topicId, name, createdAt: Date.now() };
    persist();
    return topicId;
  })();
  inFlight.set(key, p);
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
  const name = map[key]?.name ?? key;
  // Drop the stale record first so createOnce always makes a fresh topic.
  delete map[key];
  return createOnce(api, key, name);
}

/** Reverse lookup: which project owns a given topic id. */
export function projectForTopic(topicId: number): string | undefined {
  for (const [key, rec] of Object.entries(map)) {
    if (rec.topicId === topicId) return key;
  }
  return undefined;
}

export function topicName(key: string): string {
  return map[key]?.name ?? key;
}
