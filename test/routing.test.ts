import { test, expect, describe } from "bun:test";
import {
  isNewerVersion,
  planRescue,
  pickMirrorOwner,
  partitionConsoles,
  isServiceMessage,
  inboundAttachment,
  formatDuration,
  withSavedPath,
  richMessageToText,
  richTextToString,
  type AttachmentMessage,
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

  test("a media message (sticker/voice) is NOT service — it goes on to the media path", () => {
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

describe("formatDuration (media labels)", () => {
  test("seconds, minutes and hours read compactly", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m00s");
    expect(formatDuration(185)).toBe("3m05s");
    expect(formatDuration(3723)).toBe("1h02m03s");
  });

  test("a missing or malformed duration reads as 0s rather than throwing", () => {
    expect(formatDuration(-3)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(undefined as unknown as number)).toBe("0s");
  });
});

describe("inboundAttachment (voice, audio, video and video notes download like documents)", () => {
  test("a document keeps its label and file name verbatim", () => {
    expect(inboundAttachment({ document: { file_id: "d1", file_name: "report.pdf" } })).toEqual({
      kind: "document",
      fileId: "d1",
      filename: "report.pdf",
      text: "[file: report.pdf]",
    });
    expect(inboundAttachment({ document: { file_id: "d2" }, caption: "see p.3" })).toEqual({
      kind: "document",
      fileId: "d2",
      filename: "file",
      text: "[file: file] see p.3",
    });
  });

  test("a photo downloads its largest size as photo.jpg", () => {
    expect(
      inboundAttachment({ photo: [{ file_id: "small" }, { file_id: "large" }], caption: "the sign" }),
    ).toEqual({ kind: "photo", fileId: "large", filename: "photo.jpg", text: "[photo]: the sign" });
    expect(inboundAttachment({ photo: [{ file_id: "only" }] })?.text).toBe("[photo]");
  });

  test("a voice note is labelled with its duration and saved by MIME type", () => {
    const voice = { file_id: "v1", duration: 12, mime_type: "audio/ogg" };
    expect(inboundAttachment({ voice })).toEqual({
      kind: "voice",
      fileId: "v1",
      filename: "voice.ogg",
      text: "[voice 12s]",
    });
    // The caption follows the label, as it does for a document.
    expect(inboundAttachment({ voice: { file_id: "v2", duration: 12 }, caption: "urgent" })?.text).toBe(
      "[voice 12s] urgent",
    );
  });

  test("an audio file is named from file_name, then title, else by duration alone", () => {
    expect(
      inboundAttachment({
        audio: { file_id: "a1", duration: 185, file_name: "track.mp3", mime_type: "audio/mpeg" },
      }),
    ).toEqual({ kind: "audio", fileId: "a1", filename: "track.mp3", text: "[audio: track.mp3, 3m05s]" });
    expect(
      inboundAttachment({
        audio: { file_id: "a2", duration: 185, title: "Interview", mime_type: "audio/mp4" },
      }),
    ).toEqual({ kind: "audio", fileId: "a2", filename: "audio.m4a", text: "[audio: Interview, 3m05s]" });
    expect(inboundAttachment({ audio: { file_id: "a3", duration: 7 } })).toEqual({
      kind: "audio",
      fileId: "a3",
      filename: "audio.mp3",
      text: "[audio 7s]",
    });
  });

  test("a video keeps its file name; a video note has none", () => {
    expect(
      inboundAttachment({
        video: { file_id: "vd1", duration: 65, file_name: "clip.mov", mime_type: "video/quicktime" },
      }),
    ).toEqual({ kind: "video", fileId: "vd1", filename: "clip.mov", text: "[video: clip.mov, 1m05s]" });
    expect(inboundAttachment({ video: { file_id: "vd2", duration: 65 } })).toEqual({
      kind: "video",
      fileId: "vd2",
      filename: "video.mp4",
      text: "[video 1m05s]",
    });
    expect(inboundAttachment({ video_note: { file_id: "vn", duration: 8 }, caption: "hi" })).toEqual({
      kind: "video_note",
      fileId: "vn",
      filename: "video_note.mp4",
      text: "[video note 8s] hi",
    });
  });

  test("an unknown MIME type falls back to the kind's default extension", () => {
    const voice = (mime_type?: string) =>
      inboundAttachment({ voice: { file_id: "v", duration: 1, mime_type } })?.filename;
    expect(voice("audio/x-unknown")).toBe("voice.ogg");
    expect(voice(undefined)).toBe("voice.ogg");
    expect(voice("audio/MPEG; codecs=x")).toBe("voice.mp3");
  });

  test("plain text and media the bridge does not download give null — the placeholder path", () => {
    expect(inboundAttachment({})).toBeNull();
    expect(inboundAttachment({ caption: "orphan caption" })).toBeNull();
    const sticker = { sticker: { file_id: "s" } } as AttachmentMessage;
    expect(inboundAttachment(sticker)).toBeNull();
  });

  test("precedence matches the old handler: a document wins over a photo", () => {
    const m: AttachmentMessage = { document: { file_id: "d" }, photo: [{ file_id: "p" }] };
    expect(inboundAttachment(m)?.kind).toBe("document");
  });
});

describe("withSavedPath (what the session reads after the download)", () => {
  test("a downloaded file appends saved:<path>", () => {
    expect(withSavedPath("[voice 12s]", "/inbox/abc_voice.ogg")).toBe(
      "[voice 12s] saved:/inbox/abc_voice.ogg",
    );
  });

  test("a failed, oversized or timed-out download leaves the label alone — no saved: path", () => {
    // downloadFile() returns null in all three cases; the session still learns
    // that a voice note arrived and how long it is, as it does for a document.
    expect(withSavedPath("[voice 12s]", null)).toBe("[voice 12s]");
    expect(withSavedPath("[audio: track.mp3, 3m05s] listen", null)).toBe(
      "[audio: track.mp3, 3m05s] listen",
    );
    expect(withSavedPath("[file: report.pdf]", null)).toBe("[file: report.pdf]");
  });
});

describe("richTextToString (flatten a RichText node)", () => {
  test("plain string, array, and formatting wrappers", () => {
    expect(richTextToString("hello")).toBe("hello");
    expect(richTextToString(["a", "b", "c"])).toBe("abc");
    expect(richTextToString({ type: "bold", text: "B" })).toBe("B");
    expect(
      richTextToString(["pre ", { type: "italic", text: ["nested ", { type: "bold", text: "X" }] }]),
    ).toBe("pre nested X");
  });

  test("leaf nodes: url keeps its text, custom emoji its alt, math its expression", () => {
    expect(richTextToString({ type: "url", text: "site", url: "https://t.me" })).toBe("site");
    expect(
      richTextToString({ type: "custom_emoji", custom_emoji_id: "1", alternative_text: "👍" }),
    ).toBe("👍");
    expect(richTextToString({ type: "mathematical_expression", expression: "E=mc^2" })).toBe("E=mc^2");
  });

  test("null / junk is the empty string, never a throw", () => {
    expect(richTextToString(null)).toBe("");
    expect(richTextToString(undefined)).toBe("");
    expect(richTextToString(42)).toBe("");
    expect(richTextToString({ type: "divider" })).toBe("");
  });
});

describe("richMessageToText (incoming native rich message → plain text)", () => {
  test("headings and paragraphs join with blank lines", () => {
    const rich = {
      blocks: [
        { type: "heading", text: "Verdict" },
        { type: "paragraph", text: ["Prescription ", { type: "bold", text: "OK" }, "."] },
      ],
    };
    expect(richMessageToText(rich)).toBe("Verdict\n\nPrescription OK.");
  });

  test("a table flattens to pipe-joined rows (+ caption)", () => {
    const rich = {
      blocks: [
        {
          type: "table",
          cells: [
            [{ text: "Eye", is_header: true }, { text: "Value", is_header: true }],
            [{ text: "R" }, { text: "+4.25" }],
            [{ text: "L" }, { text: [{ type: "bold", text: "+5.00" }] }],
          ],
          caption: "cyclo",
        },
      ],
    };
    expect(richMessageToText(rich)).toBe("Eye | Value\nR | +4.25\nL | +5.00\ncyclo");
  });

  test("lists keep their labels and nested block content", () => {
    const rich = {
      blocks: [
        {
          type: "list",
          items: [
            { label: "1.", blocks: [{ type: "paragraph", text: "first" }] },
            { label: "2.", blocks: [{ type: "paragraph", text: "second" }] },
          ],
        },
      ],
    };
    expect(richMessageToText(rich)).toBe("1. first\n2. second");
  });

  test("details summary + body, blockquote nesting, and media captions", () => {
    expect(
      richMessageToText({
        blocks: [{ type: "details", summary: "More", blocks: [{ type: "paragraph", text: "body" }] }],
      }),
    ).toBe("More\nbody");
    expect(
      richMessageToText({
        blocks: [{ type: "blockquote", blocks: [{ type: "paragraph", text: "quoted" }] }],
      }),
    ).toBe("quoted");
    expect(
      richMessageToText({ blocks: [{ type: "photo", caption: { text: "a caption" } }] }),
    ).toBe("a caption");
  });

  test("empty / junk / no blocks yields an empty string (→ handler keeps [non-text message])", () => {
    expect(richMessageToText(null)).toBe("");
    expect(richMessageToText(undefined)).toBe("");
    expect(richMessageToText({})).toBe("");
    expect(richMessageToText({ blocks: [] })).toBe("");
    expect(richMessageToText({ blocks: [{ type: "divider" }, { type: "unknown_future" }] })).toBe("---");
  });
});
