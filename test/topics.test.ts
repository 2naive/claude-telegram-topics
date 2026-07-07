import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point state at a throwaway dir BEFORE importing topics.ts — config.ts reads
// TG_TOPICS_STATE_DIR at import time, and a dynamic import defers that to here.
const dir = mkdtempSync(join(tmpdir(), "tgtopics-"));
process.env.TG_TOPICS_STATE_DIR = dir;
process.env.TELEGRAM_GROUP_CHAT_ID = "-100999";

// Seed a legacy topics.json with an un-normalized key to exercise migration.
writeFileSync(
  join(dir, "topics.json"),
  JSON.stringify({
    "C:\\Users\\Me\\Legacy": { topicId: 42, name: "Legacy", createdAt: 1 },
  }),
);

const topics = await import("../src/topics.ts");
const { normalizePath } = await import("../src/paths.ts");

function fakeApi() {
  let n = 100;
  const calls: string[] = [];
  const api = {
    createForumTopic: async (_chat: unknown, name: string) => {
      calls.push(name);
      return { message_thread_id: ++n };
    },
  } as any;
  return { api, calls };
}

describe("isTopicMap", () => {
  test("accepts well-formed maps", () => {
    expect(topics.isTopicMap({ k: { topicId: 1, name: "a", createdAt: 0 } })).toBe(true);
    expect(topics.isTopicMap({})).toBe(true);
  });

  test("rejects wrong shapes", () => {
    expect(topics.isTopicMap(null)).toBe(false);
    expect(topics.isTopicMap([])).toBe(false);
    expect(topics.isTopicMap({ k: { topicId: "x" } })).toBe(false);
    expect(topics.isTopicMap({ k: 5 })).toBe(false);
  });
});

describe("resolveTopic", () => {
  test("a migrated legacy key resolves without creating a topic", async () => {
    const { api, calls } = fakeApi();
    const key = normalizePath("C:\\Users\\Me\\Legacy");
    expect(await topics.resolveTopic(api, key, "Legacy")).toBe(42);
    expect(calls.length).toBe(0);
  });

  test("creates a topic once, then serves it from cache", async () => {
    const { api, calls } = fakeApi();
    const key = normalizePath("/tmp/project-a");
    const first = await topics.resolveTopic(api, key, "project-a");
    const second = await topics.resolveTopic(api, key, "project-a");
    expect(first).toBe(second);
    expect(calls.length).toBe(1);
  });

  test("single-flight: concurrent resolves share ONE createForumTopic", async () => {
    const { api, calls } = fakeApi();
    const key = normalizePath("/tmp/project-b");
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => topics.resolveTopic(api, key, "project-b")),
    );
    expect(new Set(ids).size).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("recreateTopic", () => {
  test("produces a fresh topic id", async () => {
    const { api } = fakeApi();
    const key = normalizePath("/tmp/project-c");
    const first = await topics.resolveTopic(api, key, "project-c");
    const fresh = await topics.recreateTopic(api, key);
    expect(fresh).not.toBe(first);
  });
});
