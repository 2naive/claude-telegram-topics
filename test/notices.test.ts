import { describe, expect, test } from "bun:test";
import { channelLostNotice, memWarnNotice } from "../src/routing.ts";

describe("channelLostNotice", () => {
  test("names the session, the exit reason and the way back", () => {
    const t = channelLostNotice("hh", "rss 1501MB");
    expect(t).toContain("«hh»");
    expect(t).toContain("(rss 1501MB)");
    expect(t).toContain("/mcp");
    expect(t).toContain("autostart");
  });

  test("degrades without a label or a reason", () => {
    const t = channelLostNotice("", "");
    expect(t.startsWith("⚠️ This session lost its Telegram link")).toBe(true);
    expect(t).not.toContain("()");
  });
});

describe("memWarnNotice", () => {
  test("states the size and that the bridge keeps working", () => {
    const t = memWarnNotice("system", 1501);
    expect(t).toContain("«system»");
    expect(t).toContain("1501 MB");
    expect(t).toContain("keeps working");
  });
});
