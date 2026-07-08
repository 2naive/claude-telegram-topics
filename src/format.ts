// Markdown -> Telegram entities, replacing parse_mode entirely.
//
// parse_mode "Markdown" is a trap for model-generated text: Telegram's legacy
// parser treats intra-word underscores as italic markers, so `aaa_bbb_ccc`
// renders as "aaa" + italic "bbb" + "ccc" with the underscores eaten (live
// complaint), and any unbalanced marker rejects the whole message. Converting
// to explicit entities ourselves means: word-internal underscores stay
// literal, unknown syntax degrades to plain text instead of an API error, and
// what we send is exactly what renders.
//
// Supported (recursive inline scanner, so emphasis nests and may span a soft
// line break): fenced code blocks, inline code, [text](url) links, **bold**,
// _italic_ / *italic* at word boundaries only, ~~strikethrough~~, `# ` headings
// (rendered bold), and backslash escapes for literal marker characters. A
// nested run (`**bold with *italic* inside**`) yields overlapping entities,
// which Telegram renders correctly.
//
// Offsets/lengths are UTF-16 code units — exactly Telegram's convention and
// exactly what JS string indexing yields, so no conversion is needed.

// Discriminated exactly like grammY's MessageEntity subset we emit, so the
// result feeds bot.api.sendMessage without casts.
export type TgEntity =
  | {
      type: "bold" | "italic" | "code" | "strikethrough";
      offset: number;
      length: number;
    }
  | { type: "pre"; offset: number; length: number; language?: string }
  | { type: "text_link"; offset: number; length: number; url: string };

// Telegram rejects messages with more than 100 entities; formatting past the
// cap is dropped (text is kept) rather than failing the send.
export const MAX_ENTITIES = 100;

// Telegram's hard message length limit (UTF-16 code units).
export const TG_MESSAGE_LIMIT = 4096;

// A fenced block requires a newline after the language header: without it a
// same-line `­``ls``­` would parse as language="ls", empty body — dropping the
// text. Same-line triple backticks fall through to the inline handler instead.
// Language token accepts any non-newline (Cyrillic/other info-strings), not
// just ASCII, so `­```питон` still fences.
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// `_` is NOT escapable: `\_` is overwhelmingly a Windows path (`C:\_temp`), and
// eating the backslash there corrupted the path. A literal `_` is handled by
// the strict opener below instead.
const ESCAPABLE = "\\`*~[]()#";
const LINK_RE = /^\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/;

type Out = { text: string; entities: TgEntity[] };

const isAlnum = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isMarker = (ch: string | undefined): boolean =>
  ch === "*" || ch === "_" || ch === "~";
// Chars a `_` run may sit right after — start, whitespace, an opening
// bracket/quote/dash, or another marker (for stacking). Deliberately excludes
// backslash and letters/digits so `C:\_naive_`, `App_Data` stay literal.
const UNDERSCORE_LEFT = /[\s([{«"'—–-]/u;

// Emphasis flanking, tightened past bare CommonMark for model output where
// code-shaped text must survive verbatim. An emphasis run (length-`len` marker
// at `i`) may OPEN only when it is not glued to a word on its outer side and
// its content starts with a letter/digit or a nested marker. `_` is stricter
// (paths and identifiers are full of underscores): its left neighbour must be a
// boundary char, not merely a non-alnum. So `x**2`, `a_b`, `2 * 3`, `*.log`,
// `**/dist`, `a[*]`, `C:\_naive_` stay literal, while `**bold**`, `*it*`,
// `**_bolditalic_**` and `_x_` open.
function opensAt(src: string, i: number, len: number, marker: string): boolean {
  const left = src[i - 1];
  const leftOk =
    marker === "_" ? left === undefined || UNDERSCORE_LEFT.test(left) : !isAlnum(left);
  const right = src[i + len];
  return leftOk && (isAlnum(right) || isMarker(right));
}

function findClose(src: string, from: number, marker: string, len: number): number {
  for (let j = from; j + len - 1 < src.length; j++) {
    if (src[j] !== marker) continue;
    if (src[j - 1] === "\\") continue; // escaped
    if (len === 2 && src[j + 1] !== marker) continue; // need a pair
    if (len === 1 && (src[j + 1] === marker || src[j - 1] === marker)) continue; // not part of a pair
    if (isAlnum(src[j + len])) continue; // closer glued to a following word
    // Content must not end on whitespace. A single `*`/`_` additionally
    // requires a letter/digit right before it: `(*a)*(*b)`, `a[*]` and other
    // code shapes otherwise close on a `)`/`]`. A double `**`/`~~` is lax here
    // so `**Заголовок:**` (trailing colon) still bolds.
    if (len === 1 ? !isAlnum(src[j - 1]) : /\s/.test(src[j - 1] ?? "")) continue;
    return j;
  }
  return -1;
}

// Recursive inline scanner — replaces the old single-pass regex so a bold run
// can contain a nested italic (`**a *b* c**`), emphasis can span newlines, and
// an unmatched marker degrades to a literal instead of corrupting the text.
function emitInline(src: string, out: Out): void {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    // Backslash escape: the next char is emitted literally.
    if (ch === "\\" && i + 1 < n && ESCAPABLE.includes(src[i + 1]!)) {
      out.text += src[i + 1];
      i += 2;
      continue;
    }

    // Inline code — contents are literal (markers inside are not parsed).
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1) {
        const code = src.slice(i + 1, close);
        out.entities.push({ type: "code", offset: out.text.length, length: code.length });
        out.text += code;
        i = close + 1;
        continue;
      }
    }

    // Bold ** … ** (contents scanned recursively for nested emphasis).
    if (ch === "*" && src[i + 1] === "*" && opensAt(src, i, 2, "*")) {
      const close = findClose(src, i + 2, "*", 2);
      if (close > i + 1) {
        const start = out.text.length;
        emitInline(src.slice(i + 2, close), out);
        if (out.text.length > start) {
          out.entities.push({ type: "bold", offset: start, length: out.text.length - start });
        }
        i = close + 2;
        continue;
      }
    }

    // Strikethrough ~~ … ~~.
    if (ch === "~" && src[i + 1] === "~" && opensAt(src, i, 2, "~")) {
      const close = findClose(src, i + 2, "~", 2);
      if (close > i + 1) {
        const start = out.text.length;
        emitInline(src.slice(i + 2, close), out);
        if (out.text.length > start) {
          out.entities.push({ type: "strikethrough", offset: start, length: out.text.length - start });
        }
        i = close + 2;
        continue;
      }
    }

    // Link [text](https://…).
    if (ch === "[") {
      const m = LINK_RE.exec(src.slice(i));
      if (m) {
        const start = out.text.length;
        emitInline(m[1] || m[2]!, out);
        // A link whose body renders empty (e.g. `[****](url)`) must not emit a
        // zero-length entity — Telegram rejects length 0.
        if (out.text.length > start) {
          out.entities.push({
            type: "text_link",
            offset: start,
            length: out.text.length - start,
            url: m[2]!,
          });
        }
        i += m[0].length;
        continue;
      }
    }

    // Italic * … * or _ … _ (single marker) — same flanking as bold.
    if ((ch === "*" || ch === "_") && src[i + 1] !== ch && opensAt(src, i, 1, ch)) {
      const close = findClose(src, i + 1, ch, 1);
      if (close > i) {
        const start = out.text.length;
        emitInline(src.slice(i + 1, close), out);
        if (out.text.length > start) {
          out.entities.push({ type: "italic", offset: start, length: out.text.length - start });
        }
        i = close + 1;
        continue;
      }
    }

    // Literal character.
    out.text += ch;
    i++;
  }
}

function emitBlock(src: string, out: Out): void {
  // Heading lines (`# …`) render bold; consecutive non-heading lines are
  // scanned as one run so emphasis may span a soft line break. A newline
  // separates every emitted segment.
  const lines = src.split("\n");
  let i = 0;
  let emitted = false;
  const sep = (): void => {
    if (emitted) out.text += "\n";
    emitted = true;
  };
  while (i < lines.length) {
    const h = HEADING_RE.exec(lines[i]!);
    if (h) {
      sep();
      const start = out.text.length;
      emitInline(h[2]!, out);
      if (out.text.length > start) {
        out.entities.push({ type: "bold", offset: start, length: out.text.length - start });
      }
      i++;
    } else {
      const run: string[] = [];
      while (i < lines.length && !HEADING_RE.test(lines[i]!)) run.push(lines[i++]!);
      sep();
      emitInline(run.join("\n"), out);
    }
  }
}

/** Convert model markdown to Telegram text + entities. Never throws. */
export function mdToTelegram(input: string): { text: string; entities?: TgEntity[] } {
  try {
    // Normalize line endings first: a stray \r left the fence header ("```bash\r")
    // and heading lines ("# H\r") unmatched, leaking their markers. Telegram
    // renders \n anyway, so dropping \r is lossless.
    const src = input.replace(/\r\n?/g, "\n");
    const out: Out = { text: "", entities: [] };
    FENCE_RE.lastIndex = 0;
    let pos = 0;
    for (let m = FENCE_RE.exec(src); m; m = FENCE_RE.exec(src)) {
      emitBlock(src.slice(pos, m.index), out);
      pos = m.index + m[0].length;
      const code = m[2]!.replace(/\n$/, "");
      if (code.length > 0) {
        out.entities.push({
          type: "pre",
          offset: out.text.length,
          length: code.length,
          ...(m[1] ? { language: m[1] } : {}),
        });
        out.text += code;
      }
    }
    emitBlock(src.slice(pos), out);
    // A parse that ate all the text but had non-empty input (e.g. a lone empty
    // fenced block) must not produce an empty send — Telegram rejects it.
    if (!out.text && input) return { text: input };
    // Entities must be sorted by offset for consistent client rendering. The
    // MAX_ENTITIES cap is applied PER MESSAGE in splitTelegram, not here — a
    // long message is split into several sends, each allowed its own 100.
    out.entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
    return out.entities.length ? { text: out.text, entities: out.entities } : { text: out.text };
  } catch {
    return { text: input }; // formatting is best-effort, delivery is not
  }
}

/**
 * Split a formatted message into <= limit chunks at line boundaries, carrying
 * each entity into the chunk(s) it overlaps (an entity spanning a cut becomes
 * one entity per side). Telegram rejects oversized messages outright, so
 * splitting here turns a hard failure into several messages.
 */
export function splitTelegram(
  text: string,
  entities: TgEntity[] | undefined,
  limit = TG_MESSAGE_LIMIT,
): Array<{ text: string; entities?: TgEntity[] }> {
  if (text.length <= limit) {
    const es = entities?.slice(0, MAX_ENTITIES);
    return [{ text, ...(es?.length ? { entities: es } : {}) }];
  }
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start) {
        end = nl; // cut at a line break when one fits
      } else if (
        // Hard cut mid-text: never sever a surrogate pair, or the chunk edge
        // renders as U+FFFD (or Telegram rejects it).
        end > start + 1 &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1;
      }
    }
    chunks.push({ start, end });
    start = end < text.length && text[end] === "\n" ? end + 1 : end;
  }
  return chunks.map(({ start, end }) => {
    const slice = text.slice(start, end);
    const es: TgEntity[] = [];
    for (const e of entities ?? []) {
      const from = Math.max(e.offset, start);
      const to = Math.min(e.offset + e.length, end);
      if (to > from) es.push({ ...e, offset: from - start, length: to - from });
    }
    // The 100-entity limit is per message, so each chunk gets its own budget.
    const capped = es.slice(0, MAX_ENTITIES);
    return { text: slice, ...(capped.length ? { entities: capped } : {}) };
  });
}
