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
// Supported (single pass, no nesting except heading-bold over inline runs):
// fenced code blocks, inline code, [text](url) links, **bold**, _italic_ /
// *italic* at word boundaries only, ~~strikethrough~~, `# ` headings (rendered
// bold), and backslash escapes for literal marker characters.
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
const FENCE_RE = /```([A-Za-z0-9+_-]*)\n([\s\S]*?)```/g;

// Inline tokens, ordered so the alternation picks the intended reading:
// escape first (so \* never opens bold), code before italic (backticks may
// contain markers), bold before single-star italic. Emphasis runs forbid
// whitespace immediately inside the delimiters (CommonMark flanking) so
// "2 * 3 * 4", "*.log and *.tmp", "press _ then _" stay literal, and forbid a
// backslash right before the closing marker so `**foo\**` doesn't leak it.
const INLINE_RE = new RegExp(
  [
    /\\([\\`*_~[\]()#])/.source, // 1: escaped marker
    /`([^`\n]+)`/.source, // 2: inline code
    /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/.source, // 3,4: link
    /\*\*(?!\s)([^*\n]*?[^*\n\s\\])\*\*/.source, // 5: bold
    /~~(?!\s)([^~\n]*?[^~\n\s\\])~~/.source, // 6: strikethrough
    // 7: italic, underscore — word-boundary AND no inner whitespace, so
    // snake_case identifiers and spaced underscores stay literal.
    "(?<![\\p{L}\\p{N}_])_(?!\\s)([^_\\n]*?[^_\\n\\s\\\\])_(?![\\p{L}\\p{N}_])",
    // 8: italic, star form.
    "(?<![\\p{L}\\p{N}*])\\*(?!\\s)([^*\\n]*?[^*\\n\\s\\\\])\\*(?![\\p{L}\\p{N}*])",
  ].join("|"),
  "gu",
);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

type Out = { text: string; entities: TgEntity[] };

function emitInline(src: string, out: Out): void {
  INLINE_RE.lastIndex = 0;
  let pos = 0;
  for (let m = INLINE_RE.exec(src); m; m = INLINE_RE.exec(src)) {
    out.text += src.slice(pos, m.index);
    pos = m.index + m[0].length;
    if (m[1] !== undefined) {
      out.text += m[1]; // escaped char, literal
    } else if (m[2] !== undefined) {
      out.entities.push({ type: "code", offset: out.text.length, length: m[2].length });
      out.text += m[2];
    } else if (m[4] !== undefined) {
      const label = m[3] || m[4];
      out.entities.push({
        type: "text_link",
        offset: out.text.length,
        length: label.length,
        url: m[4],
      });
      out.text += label;
    } else if (m[5] !== undefined) {
      out.entities.push({ type: "bold", offset: out.text.length, length: m[5].length });
      out.text += m[5];
    } else if (m[6] !== undefined) {
      out.entities.push({
        type: "strikethrough",
        offset: out.text.length,
        length: m[6].length,
      });
      out.text += m[6];
    } else {
      const italic = m[7] ?? m[8] ?? "";
      out.entities.push({ type: "italic", offset: out.text.length, length: italic.length });
      out.text += italic;
    }
  }
  out.text += src.slice(pos);
}

function emitBlock(src: string, out: Out): void {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.text += "\n";
    const line = lines[i]!;
    const h = HEADING_RE.exec(line);
    if (h) {
      const start = out.text.length;
      emitInline(h[2]!, out);
      const len = out.text.length - start;
      // The heading entity must fully contain any inline entities inside it
      // (Telegram allows nesting, not partial overlap) — it does by
      // construction, spanning the whole emitted line.
      if (len > 0) out.entities.push({ type: "bold", offset: start, length: len });
    } else {
      emitInline(line, out);
    }
  }
}

/** Convert model markdown to Telegram text + entities. Never throws. */
export function mdToTelegram(src: string): { text: string; entities?: TgEntity[] } {
  try {
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
    if (!out.text && src) return { text: src };
    // Entities must be sorted by offset for consistent client rendering. The
    // MAX_ENTITIES cap is applied PER MESSAGE in splitTelegram, not here — a
    // long message is split into several sends, each allowed its own 100.
    out.entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
    return out.entities.length ? { text: out.text, entities: out.entities } : { text: out.text };
  } catch {
    return { text: src }; // formatting is best-effort, delivery is not
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
