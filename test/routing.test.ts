import { test, expect, describe } from "bun:test";
import {
  isNewerVersion,
  planRescue,
  pickMirrorOwner,
  partitionConsoles,
  isServiceMessage,
  messageDropReason,
  messageDropLog,
  type MessageDropReason,
  parseCallback,
  permCallbackData,
  pickSessionField,
  pickSessionName,
  remapValues,
  sessionPrefix,
  truncate,
  statusGlyph,
  stripStatusGlyph,
  withStatusGlyph,
  computeTopicStatus,
} from "../src/routing.ts";

describe("topic status glyphs", () => {
  test("withStatusGlyph prefixes the state glyph", () => {
    expect(withStatusGlyph("system", "working")).toBe("⏳ system");
    expect(withStatusGlyph("system", "ready")).toBe("🟢 system");
    expect(withStatusGlyph("system", "attention")).toBe("🔔 system");
    expect(withStatusGlyph("system", "queued")).toBe("📥 system");
    expect(withStatusGlyph("system", "offline")).toBe("💤 system");
  });

  test("re-tagging is idempotent — the old glyph is stripped first", () => {
    const once = withStatusGlyph("system", "working");
    expect(withStatusGlyph(once, "offline")).toBe("💤 system");
    // No glyph accumulation across many transitions.
    let name = "my-repo";
    for (const s of ["working", "offline", "queued", "ready"] as const) name = withStatusGlyph(name, s);
    expect(name).toBe("🟢 my-repo");
  });

  test("stripping also peels the legacy 0.8.x glyphs so upgrades stay clean", () => {
    // 0.8.2 tagged topics 🟢/🟡/⚪; the first refresh under 0.9.0 must replace,
    // not stack, those.
    expect(withStatusGlyph("🟡 system", "working")).toBe("⏳ system");
    expect(withStatusGlyph("⚪ system", "ready")).toBe("🟢 system");
  });

  test("stripStatusGlyph leaves an unbadged name untouched", () => {
    expect(stripStatusGlyph("plain name")).toBe("plain name");
    expect(stripStatusGlyph(`${statusGlyph("working")} x`)).toBe("x");
  });
});

describe("computeTopicStatus precedence", () => {
  const base = { hasSession: false, working: false, queued: false, attention: false };
  test("offline when nothing is happening", () => {
    expect(computeTopicStatus(base)).toBe("offline");
  });
  test("queued only when no session holds messages", () => {
    expect(computeTopicStatus({ ...base, queued: true })).toBe("queued");
    // a live session outranks a queue (the queue drains into it)
    expect(computeTopicStatus({ ...base, hasSession: true, queued: true })).toBe("ready");
  });
  test("a live session with no activity is ready", () => {
    expect(computeTopicStatus({ ...base, hasSession: true })).toBe("ready");
  });
  test("working outranks ready but needs a live session", () => {
    expect(computeTopicStatus({ ...base, hasSession: true, working: true })).toBe("working");
    // working reported with no session must NOT show working (turn can't run)
    expect(computeTopicStatus({ ...base, working: true })).toBe("offline");
  });
  test("attention (permission) outranks working and ready", () => {
    expect(
      computeTopicStatus({ hasSession: true, working: true, queued: false, attention: true }),
    ).toBe("attention");
    // attention also needs a session (the prompt belongs to one)
    expect(computeTopicStatus({ ...base, attention: true })).toBe("offline");
  });
});

describe("parseCallback", () => {
  test("parses a permission button", () => {
    expect(parseCallback("perm:allow:ab12cd34:xyzab")).toEqual({
      kind: "permission",
      behavior: "allow",
      sessionId: "ab12cd34",
      requestId: "xyzab",
    });
  });

  test("parses deny and more behaviors", () => {
    expect(parseCallback("perm:deny:s:r")).toMatchObject({ behavior: "deny" });
    expect(parseCallback("perm:more:s:r")).toMatchObject({ behavior: "more" });
  });

  test("round-trips permCallbackData", () => {
    const data = permCallbackData("allow", "sess1234", "reqid");
    expect(parseCallback(data)).toEqual({
      kind: "permission",
      behavior: "allow",
      sessionId: "sess1234",
      requestId: "reqid",
    });
  });

  test("parses a numeric choice index", () => {
    expect(parseCallback("2")).toEqual({ kind: "choice", index: 2 });
  });

  test("treats anything else as raw", () => {
    expect(parseCallback("hello")).toEqual({ kind: "raw", data: "hello" });
  });

  test("does not misread a raw string that merely starts with 'perm'", () => {
    expect(parseCallback("permission").kind).toBe("raw");
  });
});

describe("sessionPrefix", () => {
  test("is empty for a single session", () => {
    expect(sessionPrefix("main", 1)).toBe("");
  });

  test("tags when the topic has more than one session", () => {
    expect(sessionPrefix("main", 2)).toBe("«main» ");
  });

  test("is empty when there is no label", () => {
    expect(sessionPrefix("", 3)).toBe("");
  });
});

describe("truncate", () => {
  test("leaves short strings untouched", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  test("cuts and ellipsizes long strings", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
});

describe("pickSessionName", () => {
  const rows = [
    { sessionId: "aaa", name: "other", updatedAt: 5 },
    { sessionId: "bbb", name: "system:cct", updatedAt: 10 },
  ];

  test("returns the /rename name for the matching session", () => {
    expect(pickSessionName(rows, "bbb")).toBe("system:cct");
  });

  test("returns empty when no session matches", () => {
    expect(pickSessionName(rows, "zzz")).toBe("");
  });

  test("prefers the most recently updated record on a duplicate id", () => {
    const dup = [
      { sessionId: "bbb", name: "old", updatedAt: 1 },
      { sessionId: "bbb", name: "new", updatedAt: 99 },
    ];
    expect(pickSessionName(dup, "bbb")).toBe("new");
  });

  test("ignores blank names and trims", () => {
    const rows2 = [
      { sessionId: "bbb", name: "   ", updatedAt: 50 },
      { sessionId: "bbb", name: "  main  ", updatedAt: 40 },
    ];
    expect(pickSessionName(rows2, "bbb")).toBe("main");
  });
});

describe("pickSessionField (cwd)", () => {
  test("returns the session's cwd", () => {
    const rows = [
      { sessionId: "aaa", cwd: "C:\\other", updatedAt: 5 },
      { sessionId: "bbb", cwd: "C:\\Users\\naive\\claude\\system", updatedAt: 10 },
    ];
    expect(pickSessionField(rows, "bbb", "cwd")).toBe(
      "C:\\Users\\naive\\claude\\system",
    );
  });

  test("returns empty when the record has no cwd", () => {
    expect(pickSessionField([{ sessionId: "bbb", name: "x" }], "bbb", "cwd")).toBe("");
  });

  test("a fresher record without the field does not shadow an older one with it", () => {
    const rows = [
      { sessionId: "bbb", cwd: "C:\\repo", updatedAt: 1 },
      { sessionId: "bbb", name: "renamed", updatedAt: 99 },
    ];
    expect(pickSessionField(rows, "bbb", "cwd")).toBe("C:\\repo");
  });
});

describe("remapValues", () => {
  test("rewrites every value equal to `from`", () => {
    const m = new Map<number, string>([
      [1, "old"],
      [2, "other"],
      [3, "old"],
    ]);
    remapValues(m, "old", "new");
    expect(m.get(1)).toBe("new");
    expect(m.get(2)).toBe("other");
    expect(m.get(3)).toBe("new");
  });

  test("leaves the map untouched when nothing matches", () => {
    const m = new Map<number, string>([[1, "a"]]);
    remapValues(m, "zzz", "new");
    expect(m.get(1)).toBe("a");
  });
});

describe("isNewerVersion", () => {
  test("compares each semver segment numerically", () => {
    expect(isNewerVersion("0.6.0", "0.5.2")).toBe(true);
    expect(isNewerVersion("0.5.2", "0.6.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.5.10", "0.5.9")).toBe(true);
  });

  test("equal versions never trade leadership", () => {
    expect(isNewerVersion("0.6.0", "0.6.0")).toBe(false);
  });

  test("missing segments count as zero", () => {
    expect(isNewerVersion("0.6", "0.5.9")).toBe(true);
    expect(isNewerVersion("0.6", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.6.1", "0.6")).toBe(true);
  });

  test("an absent or garbage client version never outranks a real one", () => {
    expect(isNewerVersion("", "0.6.0")).toBe(false);
    expect(isNewerVersion("dev", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.6.0", "")).toBe(true);
  });
});

describe("long-poll invariants", () => {
  test("the server socket idle timeout outlives the longest /poll wait", async () => {
    // Regression pin for the re-registration storm: Bun.serve cuts a response
    // that writes nothing for idleTimeout seconds, so it must exceed the
    // longest long-poll the control API will hold open (plus headroom for
    // request parsing before the wait starts).
    const { LEADER_IDLE_TIMEOUT_SEC, POLL_MAX_SEC } = await import("../src/routing.ts");
    expect(LEADER_IDLE_TIMEOUT_SEC).toBeGreaterThanOrEqual(POLL_MAX_SEC + 5);
  });

  test("control API responses close their connection", async () => {
    // Regression pin for the demoted-leader black hole: a pooled keep-alive
    // /poll connection survives graceful stop AND the delayed force-close, so
    // a stepped-down leader with no successor serves it forever and inbound
    // dies silently. Per-response close guarantees the next poll is a fresh
    // connect that surfaces leader death as ECONNREFUSED.
    const { CONTROL_RESPONSE_HEADERS } = await import("../src/routing.ts");
    expect(CONTROL_RESPONSE_HEADERS.connection).toBe("close");
  });
});

describe("start-session callbacks", () => {
  test("round-trip through callback_data", async () => {
    const { parseCallback, startCallbackData } = await import("../src/routing.ts");
    expect(parseCallback(startCallbackData(31))).toEqual({ kind: "start", topicId: 31 });
  });

  test("does not shadow numeric choice callbacks", async () => {
    const { parseCallback } = await import("../src/routing.ts");
    expect(parseCallback("2")).toEqual({ kind: "choice", index: 2 });
    expect(parseCallback("start:x")).toEqual({ kind: "raw", data: "start:x" });
  });
});

describe("release invariants", () => {
  test("package.json and plugin.json versions match", async () => {
    // VERSION (hand-off, /health) derives from package.json while the plugin
    // manager shows plugin.json — if they diverge, users see a new version
    // installed but the leader hand-off compares old-vs-old and never fires,
    // resurrecting the stale-leader problem with no tell.
    const pkg = (await import("../package.json")).default as { version: string };
    const plugin = (await import("../.claude-plugin/plugin.json")).default as {
      version: string;
    };
    expect(pkg.version).toBe(plugin.version);
  });
});

describe("topicLink (the /list deep links)", () => {
  const { topicLink } = require("../src/routing.ts");

  test("builds a t.me/c link from a -100 supergroup id", () => {
    expect(topicLink("-1002364817044", 378)).toBe("https://t.me/c/2364817044/378");
  });

  test("tolerates surrounding whitespace", () => {
    expect(topicLink(" -1001234567890 ", 5)).toBe("https://t.me/c/1234567890/5");
  });

  test("no -100 prefix — no linkable form", () => {
    expect(topicLink("-987654", 5)).toBeNull();
    expect(topicLink("123456", 5)).toBeNull();
    expect(topicLink("", 5)).toBeNull();
    expect(topicLink("-100abc", 5)).toBeNull();
  });
});

describe("planRescue (dead session's undelivered messages, 0.20.0)", () => {
  type M = { messageId: number; solo: boolean };
  const m = (messageId: number, solo: boolean): M => ({ messageId, solo });
  const isSolo = (x: M): boolean => x.solo;

  test("live incident: drained (solo) messages with a late-registered sibling reroute, not drop", () => {
    const drained = [m(3854, true), m(3863, true)];
    const plan = planRescue(drained, true, isSolo);
    expect(plan.reroute).toEqual(drained);
    expect(plan.hold).toEqual([]);
  });

  test("fanned messages with live siblings are dropped (siblings own copies)", () => {
    const plan = planRescue([m(1, false), m(2, false)], true, isSolo);
    expect(plan.reroute).toEqual([]);
    expect(plan.hold).toEqual([]);
  });

  test("mixed queue with siblings reroutes only the solo part", () => {
    const solo = m(10, true);
    const plan = planRescue([m(9, false), solo], true, isSolo);
    expect(plan.reroute).toEqual([solo]);
    expect(plan.hold).toEqual([]);
  });

  test("no siblings: everything is re-held regardless of provenance", () => {
    const orphans = [m(1, false), m(2, true)];
    const plan = planRescue(orphans, false, isSolo);
    expect(plan.hold).toEqual(orphans);
    expect(plan.reroute).toEqual([]);
  });
});

describe("pickMirrorOwner (reply attribution for auto-mirror, 0.20.3)", () => {
  const m = (sid: string, cid?: string) => ({ sid, claudeSessionId: cid });

  test("matches the session by Claude conversation id among several", () => {
    const members = [m("s1", "conv-A"), m("s2", "conv-B"), m("s3", "conv-C")];
    expect(pickMirrorOwner(members, "conv-B")).toBe("s2");
  });

  test("a lone session owns its mirror even without an id match", () => {
    expect(pickMirrorOwner([m("only", "conv-X")], "conv-Y")).toBe("only");
    expect(pickMirrorOwner([m("only")], undefined)).toBe("only");
  });

  test("two-plus sessions with no id match stay unattributed (reply fans out)", () => {
    const members = [m("s1", "conv-A"), m("s2", "conv-B")];
    expect(pickMirrorOwner(members, undefined)).toBeUndefined();
    expect(pickMirrorOwner(members, "conv-Z")).toBeUndefined();
  });

  test("no sessions -> undefined", () => {
    expect(pickMirrorOwner([], "conv-A")).toBeUndefined();
  });

  test("the live incident: reply to console A's answer routes to A, not both", () => {
    // Two consoles resuming different conversations on one topic.
    const members = [m("consoleA", "conv-A"), m("consoleB", "conv-B")];
    expect(pickMirrorOwner(members, "conv-A")).toBe("consoleA");
    expect(pickMirrorOwner(members, "conv-B")).toBe("consoleB");
  });
});

describe("partitionConsoles (booting vs zombie autostart guard, 0.20.8)", () => {
  const now = 1_000_000_000_000;
  const BOOT = 120_000;
  const C = (pid, ageMs) => ({ pid, startedAt: ageMs === null ? null : now - ageMs });

  test("a young console is booting (blocks autostart, not killed)", () => {
    const { booting, zombies } = partitionConsoles([C(1, 10_000)], now, BOOT);
    expect(booting.map((c) => c.pid)).toEqual([1]);
    expect(zombies).toEqual([]);
  });

  test("the hh incident: an 11-day-old alive console is a zombie", () => {
    const elefenDays = 11 * 24 * 3600_000;
    const { booting, zombies } = partitionConsoles([C(252008, elefenDays)], now, BOOT);
    expect(booting).toEqual([]);
    expect(zombies.map((c) => c.pid)).toEqual([252008]);
  });

  test("a console with no known start time is treated as a zombie", () => {
    const { booting, zombies } = partitionConsoles([C(9, null)], now, BOOT);
    expect(booting).toEqual([]);
    expect(zombies.map((c) => c.pid)).toEqual([9]);
  });

  test("mixed: young blocks, old is a zombie", () => {
    const { booting, zombies } = partitionConsoles([C(1, 5_000), C(2, 600_000)], now, BOOT);
    expect(booting.map((c) => c.pid)).toEqual([1]);
    expect(zombies.map((c) => c.pid)).toEqual([2]);
  });

  test("exactly at the boundary is a zombie (not younger than bootMs)", () => {
    const { booting, zombies } = partitionConsoles([C(1, BOOT)], now, BOOT);
    expect(booting).toEqual([]);
    expect(zombies.map((c) => c.pid)).toEqual([1]);
  });
});

describe("isServiceMessage (skip Telegram pins & service messages, 0.20.9)", () => {
  test("a pinned-message service message is a service message", () => {
    expect(isServiceMessage({ message_id: 5, pinned_message: { message_id: 4, text: "x" } })).toBe(
      true,
    );
  });

  test("forum-topic and member service messages are service messages", () => {
    expect(isServiceMessage({ forum_topic_created: { name: "t" } })).toBe(true);
    expect(isServiceMessage({ new_chat_members: [{ id: 1 }] })).toBe(true);
    expect(isServiceMessage({ new_chat_title: "New" })).toBe(true);
  });

  test("a normal text message is NOT a service message", () => {
    expect(isServiceMessage({ message_id: 5, text: "привет" })).toBe(false);
  });

  test("a photo/document/caption message is NOT a service message", () => {
    expect(isServiceMessage({ photo: [{ file_id: "a" }] })).toBe(false);
    expect(isServiceMessage({ document: { file_id: "a" }, caption: "hi" })).toBe(false);
  });

  test("an unhandled-media message (sticker/voice) is NOT service — the placeholder still applies", () => {
    expect(isServiceMessage({ sticker: { file_id: "s" } })).toBe(false);
    expect(isServiceMessage({ voice: { file_id: "v" } })).toBe(false);
  });

  test("null/undefined/empty are not service messages", () => {
    expect(isServiceMessage(null)).toBe(false);
    expect(isServiceMessage(undefined)).toBe(false);
    expect(isServiceMessage({})).toBe(false);
  });

  test("a service field explicitly null does not count", () => {
    expect(isServiceMessage({ pinned_message: null, text: "hi" })).toBe(false);
  });
});

describe("message drops: gate order and the leader.log line (message.drop)", () => {
  const GROUP = -1001;
  const inGroup = (id: number) => id === GROUP;
  const allowed = (id: number | undefined) => id === 7;
  const person = { id: 7, is_bot: false };
  const inbound = (extra: Record<string, unknown> = {}) => ({
    message_id: 5,
    chat: { id: GROUP },
    from: person,
    text: "hi",
    ...extra,
  });

  test("an allowlisted person's message in the group passes every gate", () => {
    expect(messageDropReason(inbound(), inGroup, allowed)).toBeNull();
  });

  test("each gate names itself; another chat wins over a service message", () => {
    expect(messageDropReason(inbound({ chat: { id: 42 } }), inGroup, allowed)).toBe("chat");
    // The bot added to some other group: logged as "chat", not the quiet
    // "service" — the chat gate runs first.
    expect(
      messageDropReason(
        inbound({ chat: { id: 42 }, new_chat_members: [{ id: 1 }] }),
        inGroup,
        allowed,
      ),
    ).toBe("chat");
    const pin = inbound({ pinned_message: { message_id: 4 } });
    expect(messageDropReason(pin, inGroup, allowed)).toBe("service");
    expect(messageDropReason(inbound({ from: { id: 9, is_bot: true } }), inGroup, allowed)).toBe(
      "bot",
    );
    expect(messageDropReason(inbound({ from: { id: 8, is_bot: false } }), inGroup, allowed)).toBe(
      "user",
    );
    // No sender at all can't be on the allowlist.
    expect(messageDropReason(inbound({ from: undefined }), inGroup, allowed)).toBe("user");
  });

  test("another chat short-circuits: the allowlist (may re-read .env) is not consulted", () => {
    let consulted = 0;
    const counting = (id: number | undefined) => {
      consulted++;
      return allowed(id);
    };
    expect(messageDropReason(inbound({ chat: { id: 42 } }), inGroup, counting)).toBe("chat");
    expect(consulted).toBe(0);
  });

  test("the bot's own badge-rename echo is a quiet service drop, not a logged bot one", () => {
    // editForumTopic makes Telegram post forum_topic_edited back into the topic;
    // the service gate comes before the bot gate, so the echo stays quiet even
    // though "bot" drops are logged.
    const echo = inbound({
      from: { id: 9, is_bot: true },
      forum_topic_edited: { name: "⏳ repo" },
    });
    expect(messageDropReason(echo, inGroup, allowed)).toBe("service");
    expect(messageDropLog("service", echo)).toBeNull();
    expect(messageDropLog("bot", echo)).not.toBeNull();
  });

  test("logged drops carry exactly callback.drop's fields for the same reason", () => {
    const m = { message_id: 5, from: { id: 8 } };
    expect(messageDropLog("chat", m)).toEqual({ reason: "chat" });
    expect(messageDropLog("user", m)).toEqual({ reason: "user", from: "8" });
    expect(messageDropLog("user", { message_id: 5 })).toEqual({ reason: "user", from: "" });
    expect(messageDropLog("no-thread", m)).toEqual({ reason: "no-thread", mid: 5 });
    // No callback.drop counterpart: "bot" records the sender id like "user".
    expect(messageDropLog("bot", m)).toEqual({ reason: "bot", from: "8" });
  });

  test("never logs message content — text, caption or a file name", () => {
    const m = {
      message_id: 5,
      from: { id: 8 },
      text: "private words",
      caption: "a caption",
      document: { file_id: "f", file_name: "passport-scan.pdf" },
    };
    const all: MessageDropReason[] = ["chat", "service", "bot", "user", "no-thread"];
    for (const r of all) {
      const line = JSON.stringify(messageDropLog(r, m));
      for (const secret of ["private words", "a caption", "passport-scan"]) {
        expect(line).not.toContain(secret);
      }
    }
  });
});
