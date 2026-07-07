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

function load(): TopicMap {
  try {
    if (existsSync(TOPICS_FILE)) {
      return JSON.parse(readFileSync(TOPICS_FILE, "utf8")) as TopicMap;
    }
  } catch {
    // corrupt file — start clean rather than crash the leader
  }
  return {};
}

function persist(): void {
  const tmp = TOPICS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  renameSync(tmp, TOPICS_FILE); // atomic swap
}

async function createTopic(api: Api, name: string): Promise<number> {
  const t = await api.createForumTopic(GROUP_CHAT_ID, name);
  return t.message_thread_id;
}

/** Resolve (and lazily create) the topic id for a project. */
export async function resolveTopic(
  api: Api,
  key: string,
  name: string,
): Promise<number> {
  const existing = map[key];
  if (existing) return existing.topicId;
  const topicId = await createTopic(api, name);
  map[key] = { topicId, name, createdAt: Date.now() };
  persist();
  return topicId;
}

/** Recreate a topic that Telegram reports as gone, updating the map. */
export async function recreateTopic(api: Api, key: string): Promise<number> {
  const name = map[key]?.name ?? key;
  const topicId = await createTopic(api, name);
  map[key] = { topicId, name, createdAt: Date.now() };
  persist();
  return topicId;
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
