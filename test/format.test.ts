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

  test("nested emphasis: bold containing italic yields both entities, no leftover markers", () => {
    const r = mdToTelegram("**жирный с *курсивом* внутри**");
    expect(r.text).toBe("жирный с курсивом внутри");
    const types = (r.entities ?? []).map((e) => e.type).sort();
    expect(types).toEqual(["bold", "italic"]);
    const bold = r.entities!.find((e) => e.type === "bold")!;
    const italic = r.entities!.find((e) => e.type === "italic")!;
    // The italic run sits inside the bold run.
    expect(bold.offset).toBe(0);
    expect(bold.length).toBe(24);
    expect(italic.offset).toBeGreaterThanOrEqual(bold.offset);
    expect(italic.offset + italic.length).toBeLessThanOrEqual(bold.offset + bold.length);
  });

  test("emphasis spans a soft line break", () => {
    const r = mdToTelegram("Многострочный **bold\nчерез строку** дальше");
    expect(r.text).toBe("Многострочный bold\nчерез строку дальше");
    expect(r.entities).toEqual([{ type: "bold", offset: 14, length: 17 }]);
  });

  test("Python power operator stays literal (2 ** 3 ** 4)", () => {
    for (const src of ["2 ** 3 ** 4", "a ~~ b ~~ c", "x ** y"]) {
      const r = mdToTelegram(src);
      expect(r.text).toBe(src);
      expect(r.entities).toBeUndefined();
    }
  });

  test("three bold runs in a row each format independently", () => {
    const r = mdToTelegram("**a** **b** **c**");
    expect(r.text).toBe("a b c");
    expect((r.entities ?? []).filter((e) => e.type === "bold").length).toBe(3);
  });

  // Regressions from the adversarial fuzz pass — code-shaped text must survive.
  test("math, globs, pointers and selectors stay literal", () => {
    for (const src of [
      "x**2 + y**2 = z**2",
      "Compute 2**3**4 tower",
      "cleanup: rm *.log,*.tmp,*.bak",
      "webpack **/dist/** and **/build/**",
      "ignore **/*.js and **/*.ts",
      "C expr (*a)*(*b)",
      "JSONPath a[*].b[*].c[*]",
    ]) {
      const r = mdToTelegram(src);
      expect(r.text).toBe(src);
      expect(r.entities).toBeUndefined();
    }
  });

  test("a trailing colon inside bold still bolds (**Заголовок:**)", () => {
    const r = mdToTelegram("**Заголовок:** текст");
    expect(r.text).toBe("Заголовок: текст");
    expect(r.entities).toEqual([{ type: "bold", offset: 0, length: 10 }]);
  });

  test("CRLF line endings do not leak fence/heading markers", () => {
    expect(mdToTelegram("```bash\r\nls -la *.log\r\n```").text).toBe("ls -la *.log");
    const h = mdToTelegram("# Report\r\ntext");
    expect(h.text).toBe("Report\ntext");
    expect(h.entities).toEqual([{ type: "bold", offset: 0, length: 6 }]);
  });

  // Regressions from the second fuzz pass — paths, non-ASCII fences, stacking.
  test("a Windows path with an underscore folder keeps every backslash", () => {
    for (const p of [
      "Path C:\\Users\\_naive_\\App_Data\\config.ini",
      "open C:\\_temp\\log_2026.txt now",
      "Смотри C:\\Users\\naive\\.claude\\settings.json там",
    ]) {
      const r = mdToTelegram(p);
      expect(r.text).toBe(p);
      expect(r.entities).toBeUndefined();
    }
  });

  test("a fenced block with a non-ASCII language still fences", () => {
    const r = mdToTelegram("```питон\nprint('привет')\n```");
    expect(r.text).toBe("print('привет')");
    expect(r.entities).toEqual([
      { type: "pre", offset: 0, length: 15, language: "питон" },
    ]);
  });

  test("stacked delimiters nest fully with no leftover markers", () => {
    const combo = mdToTelegram("**_bolditalic_**");
    expect(combo.text).toBe("bolditalic");
    expect((combo.entities ?? []).map((e) => e.type).sort()).toEqual(["bold", "italic"]);

    const triple = mdToTelegram("~~**_all three_**~~");
    expect(triple.text).toBe("all three");
    expect((triple.entities ?? []).map((e) => e.type).sort()).toEqual([
      "bold",
      "italic",
      "strikethrough",
    ]);
  });

  test("an empty-bodied link emits no zero-length entity", () => {
    const r = mdToTelegram("[****](https://example.com) x");
    expect((r.entities ?? []).every((e) => e.length > 0)).toBe(true);
  });

  test("all entity offsets/lengths stay within the text bounds", () => {
    const samples = [
      "**a *b* `c` [d](https://x.io/1)**",
      "# H\n**b**\n- *i*\n```js\ncode\n```",
      "**незакрытый *и вложенный",
      "~~strike **bold inside** end~~",
    ];
    for (const s of samples) {
      const r = mdToTelegram(s);
      for (const e of r.entities ?? []) {
        expect(e.offset).toBeGreaterThanOrEqual(0);
        expect(e.length).toBeGreaterThan(0);
        expect(e.offset + e.length).toBeLessThanOrEqual(r.text.length);
      }
    }
  });
});

describe("mdToTelegram hardening (0.10.1)", () => {
  test("GFM table becomes one aligned monospace pre block, every cell kept", () => {
    const r = mdToTelegram(
      "| Name | Age | City |\n| ---- | --- | ---- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |",
    );
    expect(r.entities).toEqual([{ type: "pre", offset: 0, length: r.text.length }]);
    for (const cell of ["Name", "Age", "City", "Alice", "30", "NYC", "Bob", "25", "LA"]) {
      expect(r.text).toContain(cell);
    }
    expect(r.text).not.toContain("|---"); // the separator row is dropped
    // columns aligned: header names padded to their column width
    expect(r.text.split("\n")[0]).toBe("Name  | Age | City");
  });

  test("a stray * in a table cell does not italicize across rows", () => {
    const r = mdToTelegram("| C1 | C2 |\n| -- | -- |\n| *foo | bar |\n| baz | qux* |");
    expect((r.entities ?? []).some((e) => e.type === "italic")).toBe(false);
    expect(r.text).toContain("*foo");
    expect(r.text).toContain("qux*");
  });

  test("an escaped pipe in a table cell is a literal pipe, no backslash", () => {
    const r = mdToTelegram("| Expr | R |\n| ---- | - |\n| a \\| b | or |");
    expect(r.text).not.toContain("\\");
    expect(r.text).toContain("a | b");
  });

  test("a bare --- rule or prose dash is not treated as a table", () => {
    expect(mdToTelegram("text\n---\nmore").entities).toBeUndefined();
    expect(mdToTelegram("a - b - c").entities).toBeUndefined();
  });

  test("a stray ``` inside a fence body no longer cascades into later blocks", () => {
    const r = mdToTelegram('Here:\n```py\nprint("```")\n```\nAnd:\n```sh\nls\n```');
    const pre = (r.entities ?? []).filter((e) => e.type === "pre");
    expect(pre.length).toBe(2);
    expect(r.text).toContain('print("```")');
    expect(r.text).toContain("ls");
  });

  test("four-backtick fence keeps an inner triple-backtick verbatim", () => {
    const r = mdToTelegram("````js\ncode ``` inside\n````");
    expect(r.text).toBe("code ``` inside");
    expect(r.entities).toEqual([{ type: "pre", offset: 0, length: 15, language: "js" }]);
  });

  test("a pathological info-string is capped to 64 chars", () => {
    const r = mdToTelegram("```" + "x".repeat(5000) + "\nbody\n```");
    const pre = (r.entities ?? []).find((e) => e.type === "pre") as { language?: string };
    expect(pre.language!.length).toBeLessThanOrEqual(64);
  });

  test("emoji/symbol/astral-led emphasis opens (was leaking literal markers)", () => {
    expect(mdToTelegram("**✅ Done**")).toEqual({ text: "✅ Done", entities: [{ type: "bold", offset: 0, length: 6 }] });
    expect(mdToTelegram("note _😀 hi_ end").entities).toEqual([{ type: "italic", offset: 5, length: 5 }]);
    expect(mdToTelegram("**𠀀𠀁**").entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
  });

  test("a URL with a balanced paren keeps its closing paren", () => {
    const r = mdToTelegram("see [Turing](https://en.wikipedia.org/wiki/Alan_Turing_(scientist)) here");
    expect(r.entities).toEqual([
      { type: "text_link", offset: 4, length: 6, url: "https://en.wikipedia.org/wiki/Alan_Turing_(scientist)" },
    ]);
    expect(r.text).toBe("see Turing here");
  });

  test("an image drops the ! and links the alt text", () => {
    const r = mdToTelegram("![a cat](https://x.io/cat.png)");
    expect(r.text).toBe("a cat");
    expect(r.entities).toEqual([{ type: "text_link", offset: 0, length: 5, url: "https://x.io/cat.png" }]);
  });

  test("an autolink drops the angle brackets", () => {
    const r = mdToTelegram("Docs at <https://example.com/docs>.");
    expect(r.text).toBe("Docs at https://example.com/docs.");
    expect(r.entities).toEqual([{ type: "text_link", offset: 8, length: 24, url: "https://example.com/docs" }]);
  });

  test("an empty-bodied link shows and links the URL instead of dropping it", () => {
    const r = mdToTelegram("before [****](https://ex.com) after");
    const link = (r.entities ?? []).find((e) => e.type === "text_link") as { url?: string };
    expect(link?.url).toBe("https://ex.com");
    expect(r.text).toContain("https://ex.com");
  });

  test("Vec<T> and a lone < stay literal (no autolink false positive)", () => {
    expect(mdToTelegram("Vec<T> and a < b").entities).toBeUndefined();
  });

  test("C0 control characters are stripped so a NUL cannot 400-drop the answer", () => {
    const r = mdToTelegram("he" + String.fromCharCode(0) + "llo\tworld");
    expect(r.text).toBe("hello\tworld"); // NUL gone, tab kept
  });

  test("a UNC path keeps its doubled backslashes", () => {
    const r = mdToTelegram("copy \\\\server\\share\\file to C:\\Users");
    expect(r.text).toBe("copy \\\\server\\share\\file to C:\\Users");
    expect(r.entities).toBeUndefined();
  });

  test("a whitespace-only render falls back to raw input", () => {
    const r = mdToTelegram("# \n```\n```");
    expect(r.text.trim().length).toBeGreaterThan(0);
  });

  test("oversized input is delivered raw (never freezes the leader)", () => {
    const big = "a".repeat(60_000);
    const r = mdToTelegram(big);
    expect(r.text).toBe(big);
    expect(r.entities).toBeUndefined();
  });

  test("marker/bracket storms stay near-linear (no quadratic blowup)", () => {
    for (const s of ["[".repeat(200_000), "*a ".repeat(50_000), "**a".repeat(50_000)]) {
      const t = performance.now();
      mdToTelegram(s);
      expect(performance.now() - t).toBeLessThan(1000);
    }
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

  test("a whitespace-only chunk is dropped, real chunks survive", () => {
    const chunks = splitTelegram("Start.\n" + " ".repeat(4200) + "\nEnd.", undefined);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
    const joined = chunks.map((c) => c.text).join("\n");
    expect(joined).toContain("Start.");
    expect(joined).toContain("End.");
  });
});
