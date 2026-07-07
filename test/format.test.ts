import { describe, expect, test } from "bun:test";
import { mdToTelegram, splitTelegram, MAX_ENTITIES } from "../src/format.ts";

describe("mdToTelegram", () => {
  test("intra-word underscores stay literal (the aaa_bbb_ccc regression)", () => {
    const r = mdToTelegram("rename aaa_bbb_ccc to xxx_yyy");
    expect(r.text).toBe("rename aaa_bbb_ccc to xxx_yyy");
    expect(r.entities).toBeUndefined();
  });

  test("word-boundary underscores become italic with markers stripped", () => {
    const r = mdToTelegram("this is _important_ here");
    expect(r.text).toBe("this is important here");
    expect(r.entities).toEqual([{ type: "italic", offset: 8, length: 9 }]);
  });

  test("Cyrillic snake_case stays literal, Cyrillic italic works", () => {
    const literal = mdToTelegram("дорожная_карта_проекта");
    expect(literal.text).toBe("дорожная_карта_проекта");
    expect(literal.entities).toBeUndefined();
    const italic = mdToTelegram("сделай _вот так_ и всё");
    expect(italic.text).toBe("сделай вот так и всё");
    expect(italic.entities).toEqual([{ type: "italic", offset: 7, length: 7 }]);
  });

  test("bold, code, strikethrough, links", () => {
    const r = mdToTelegram("**b** `c` ~~s~~ [t](https://x.io/p)");
    expect(r.text).toBe("b c s t");
    expect(r.entities).toEqual([
      { type: "bold", offset: 0, length: 1 },
      { type: "code", offset: 2, length: 1 },
      { type: "strikethrough", offset: 4, length: 1 },
      { type: "text_link", offset: 6, length: 1, url: "https://x.io/p" },
    ]);
  });

  test("fenced code block becomes pre with language, markers inside untouched", () => {
    const r = mdToTelegram("before\n```ts\nconst a_b = **x**;\n```\nafter");
    expect(r.text).toBe("before\nconst a_b = **x**;\nafter");
    expect(r.entities).toEqual([{ type: "pre", offset: 7, length: 18, language: "ts" }]);
  });

  test("inline code protects markers inside it", () => {
    const r = mdToTelegram("use `a_b_c` here");
    expect(r.text).toBe("use a_b_c here");
    expect(r.entities).toEqual([{ type: "code", offset: 4, length: 5 }]);
  });

  test("headings render bold and may nest inline entities", () => {
    const r = mdToTelegram("## Plan `x`\nbody");
    expect(r.text).toBe("Plan x\nbody");
    expect(r.entities).toEqual([
      { type: "bold", offset: 0, length: 6 },
      { type: "code", offset: 5, length: 1 },
    ]);
  });

  test("backslash escapes yield literal markers", () => {
    const r = mdToTelegram("a \\*literal\\* star");
    expect(r.text).toBe("a *literal* star");
    expect(r.entities).toBeUndefined();
  });

  test("offsets are UTF-16 code units (astral emoji counts as 2)", () => {
    const r = mdToTelegram("😀 **b**");
    // "😀 " is 3 UTF-16 units (surrogate pair + space).
    expect(r.entities).toEqual([{ type: "bold", offset: 3, length: 1 }]);
  });

  test("mdToTelegram keeps all entities (the cap is applied per message on split)", () => {
    const src = Array.from({ length: MAX_ENTITIES + 20 }, (_, i) => `**b${i}**`).join(" ");
    const r = mdToTelegram(src);
    expect(r.entities!.length).toBe(MAX_ENTITIES + 20);
    expect(r.text).toContain(`b${MAX_ENTITIES + 19}`);
  });

  test("unbalanced markers degrade to literal text, never throw", () => {
    const r = mdToTelegram("broken **bold and _open");
    expect(r.text).toBe("broken **bold and _open");
  });

  // Regressions from the 0.8.0 review.
  test("whitespace-flanked stars/underscores stay literal (arithmetic, globs)", () => {
    for (const src of [
      "2 * 3 * 4",
      "2 ** 3 ** 4",
      "deleted *.log and *.tmp files",
      "press _ then _ to exit",
      "a _ b _ c",
    ]) {
      const r = mdToTelegram(src);
      expect(r.text).toBe(src);
      expect(r.entities).toBeUndefined();
    }
  });

  test("real emphasis still works next to the literal cases", () => {
    expect(mdToTelegram("use *this* one").entities).toEqual([
      { type: "italic", offset: 4, length: 4 },
    ]);
  });

  test("same-line triple backticks do not swallow their token", () => {
    const r = mdToTelegram("run ```ls``` now");
    expect(r.text).toContain("ls");
  });

  test("a lone empty fenced block never yields an empty send", () => {
    const r = mdToTelegram("```\n```");
    expect(r.text.length).toBeGreaterThan(0);
  });

  test("an escaped marker before a closing ** does not leak a backslash", () => {
    const r = mdToTelegram("**foo\\**");
    expect(r.text).not.toContain("\\");
    // Either literal or bold-without-backslash, but never "foo\\" as bold text.
    if (r.entities) expect(r.text).not.toMatch(/\\/);
  });
});

describe("splitTelegram entity cap and surrogate safety", () => {
  test("each chunk gets its own 100-entity budget", () => {
    // 120 links, short labels so the text fits one 4096 chunk: without the
    // per-chunk cap the 20 links past 100 would lose their URLs.
    const entities = Array.from({ length: 120 }, (_, i) => ({
      type: "text_link" as const,
      offset: i,
      length: 1,
      url: `https://x.io/${i}`,
    }));
    const text = "x".repeat(120);
    const [chunk] = splitTelegram(text, entities);
    expect(chunk!.entities!.length).toBe(100);
  });

  test("a hard cut never severs a surrogate pair", () => {
    // 6 astral emoji (2 UTF-16 units each) = length 12; limit 5 forces a hard
    // cut that must land on an even boundary, never mid-pair.
    const text = "😀".repeat(6);
    const chunks = splitTelegram(text, undefined, 5);
    for (const c of chunks) {
      expect(c.text).toBe(c.text.replace(/�/g, "")); // no replacement char
      expect([...c.text].every((ch) => ch === "😀")).toBe(true);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });
});

describe("splitTelegram", () => {
  test("short message passes through as one chunk", () => {
    const chunks = splitTelegram("hi", [{ type: "bold", offset: 0, length: 2 }]);
    expect(chunks).toEqual([
      { text: "hi", entities: [{ type: "bold", offset: 0, length: 2 }] },
    ]);
  });

  test("splits at line boundaries under the limit", () => {
    const text = "aaaa\nbbbb\ncccc";
    const chunks = splitTelegram(text, undefined, 10);
    expect(chunks.map((c) => c.text)).toEqual(["aaaa\nbbbb", "cccc"]);
  });

  test("entities are re-offset per chunk and split across the cut", () => {
    // "xxxxx\nyyyyy" with bold spanning the whole string, limit forces a cut.
    const chunks = splitTelegram(
      "xxxxx\nyyyyy",
      [{ type: "bold", offset: 0, length: 11 }],
      7,
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({
      text: "xxxxx",
      entities: [{ type: "bold", offset: 0, length: 5 }],
    });
    expect(chunks[1]).toEqual({
      text: "yyyyy",
      entities: [{ type: "bold", offset: 0, length: 5 }],
    });
  });

  test("an unbreakable long line still splits hard at the limit", () => {
    const chunks = splitTelegram("a".repeat(25), undefined, 10);
    expect(chunks.map((c) => c.text)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });
});
