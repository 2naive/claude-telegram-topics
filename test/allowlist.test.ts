import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelAllowlistState,
  mergeManagedSettings,
  OUR_ENTRY,
  OFFICIAL_ENTRY,
} from "../src/allowlist.ts";

const dir = mkdtempSync(join(tmpdir(), "tg-allowlist-"));
let n = 0;
function file(content?: string): string {
  const p = join(dir, `ms-${n++}.json`);
  if (content !== undefined) writeFileSync(p, content);
  return p;
}

describe("channelAllowlistState", () => {
  test("missing file — not allowlisted, path named", () => {
    const s = channelAllowlistState(file());
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("no managed settings");
  });

  test("allowlisted when our entry is present", () => {
    const s = channelAllowlistState(
      file(JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [OUR_ENTRY] })),
    );
    expect(s.ok).toBe(true);
  });

  test("file exists but our entry is absent — not allowlisted", () => {
    const s = channelAllowlistState(
      file(JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [OFFICIAL_ENTRY] })),
    );
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("no telegram-topics@claude-telegram-topics");
  });

  test("channelsEnabled:false blocks even with the entry", () => {
    const s = channelAllowlistState(
      file(JSON.stringify({ channelsEnabled: false, allowedChannelPlugins: [OUR_ENTRY] })),
    );
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("channelsEnabled is false");
  });

  test("invalid JSON — not allowlisted, reason surfaced", () => {
    const s = channelAllowlistState(file("{not json"));
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("unreadable");
  });
});

describe("mergeManagedSettings", () => {
  test("from nothing: both entries + channelsEnabled", () => {
    const m = mergeManagedSettings(null);
    expect(m.channelsEnabled).toBe(true);
    expect(m.allowedChannelPlugins).toEqual([OUR_ENTRY, OFFICIAL_ENTRY]);
  });

  test("preserves foreign keys and existing entries", () => {
    const existing = {
      strictPluginOnlyCustomization: true,
      allowedChannelPlugins: [{ plugin: "slack", marketplace: "acme-corp" }],
    };
    const m = mergeManagedSettings(existing);
    expect(m.strictPluginOnlyCustomization).toBe(true);
    expect(m.allowedChannelPlugins).toEqual([
      { plugin: "slack", marketplace: "acme-corp" },
      OUR_ENTRY,
      OFFICIAL_ENTRY,
    ]);
  });

  test("idempotent: merging twice adds nothing", () => {
    const once = mergeManagedSettings(null);
    const twice = mergeManagedSettings(once);
    expect(twice.allowedChannelPlugins).toEqual(once.allowedChannelPlugins);
  });

  test("forces channelsEnabled on (an allowlist with channels off is self-defeating)", () => {
    const m = mergeManagedSettings({ channelsEnabled: false });
    expect(m.channelsEnabled).toBe(true);
  });

  test("does not mutate the input", () => {
    const existing = { allowedChannelPlugins: [] as unknown[] };
    mergeManagedSettings(existing);
    expect(existing.allowedChannelPlugins).toEqual([]);
  });
});
