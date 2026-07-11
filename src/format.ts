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
// line break): fenced code blocks (length-aware ``` / ```` fences), GFM tables
// (rendered as an aligned monospace grid — Telegram has no table markup),
// inline code, [text](url) links and ![alt](url) images, <https://…> autolinks,
// **bold**, _italic_ / *italic* at word boundaries only, ~~strikethrough~~,
// `# ` headings (rendered bold), and backslash escapes for literal marker chars.
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

// Above this the inline scanner (O(n²) worst case on marker/bracket storms) is
// skipped and the text is delivered raw — a huge answer is delivered, not
// formatted, and never freezes the single-threaded leader for seconds.
const MAX_FORMAT_LEN = 50_000;
// An unclosed emphasis opener bails after this forward scan instead of walking
// to EOF for every marker — bounds findClose to keep the scanner near-linear.
const FIND_CLOSE_WINDOW = 2 * TG_MESSAGE_LIMIT;
// Cap the greedy char classes in link matching so a "[" / "(" storm can't make
// each LINK_RE.exec quadratic.
const LINK_SPAN = 8192;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// `_` and `\` are NOT escapable. `\_` is overwhelmingly a Windows path
// (`C:\_temp`) and `\\` a UNC path or a doubled regex backslash — eating the
// backslash there corrupted the value. A literal `_` is handled by the strict
// opener below; a literal `\` is simply emitted as-is unless it precedes an
// active marker (`\*`, `` \` ``, `\[`).
const ESCAPABLE = "`*~[]()#";
// A link/image body and URL, with one level of balanced parens allowed in the
// URL so `…_(disambiguation)` Wikipedia/MSDN links keep their closing paren.
const LINK_RE = new RegExp(
  `^!?\\[([^\\]\\n]{0,${LINK_SPAN}})\\]\\((https?:\\/\\/(?:[^\\s()]|\\([^\\s()]*\\)){1,${LINK_SPAN}})\\)`,
);
const AUTOLINK_RE = /^<(https?:\/\/[^\s>]+)>/;

type Out = { text: string; entities: TgEntity[] };

const isAlnum = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isMarker = (ch: string | undefined): boolean =>
  ch === "*" || ch === "_" || ch === "~";
// Chars a `_` run may sit right after — start, whitespace, an opening
// bracket/quote/dash, or another marker (for stacking). Deliberately excludes
// backslash and letters/digits so `C:\_naive_`, `App_Data` stay literal.
const UNDERSCORE_LEFT = /[\s([{«"'—–-]/u;

// Emoji / symbol / astral flanking. Models emit emoji-led emphasis constantly
// (`**✅ Done**`, `_😀 note_`), which the alnum-only opener never opened, leaking
// the literal `**`. A run may also START on a symbol/pictographic/astral char.
const SYMBOLIC = /[\p{S}\p{Extended_Pictographic}]/u;
const isHighSurrogate = (ch: string | undefined): boolean =>
  ch !== undefined && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff;
const isLowSurrogate = (ch: string | undefined): boolean =>
  ch !== undefined && ch.charCodeAt(0) >= 0xdc00 && ch.charCodeAt(0) <= 0xdfff;
const isContentStart = (ch: string | undefined): boolean =>
  ch !== undefined && (isHighSurrogate(ch) || SYMBOLIC.test(ch));
const isContentEnd = (ch: string | undefined): boolean =>
  ch !== undefined && (isLowSurrogate(ch) || SYMBOLIC.test(ch));

// Emphasis flanking, tightened past bare CommonMark for model output where
// code-shaped text must survive verbatim. An emphasis run (length-`len` marker
// at `i`) may OPEN only when it is not glued to a word on its outer side and
// its content starts with a letter/digit, an emoji/symbol, or a nested marker.
// `_` is stricter (paths and identifiers are full of underscores): its left
// neighbour must be a boundary char, not merely a non-alnum. So `x**2`, `a_b`,
// `2 * 3`, `*.log`, `**/dist`, `a[*]`, `C:\_naive_` stay literal, while
// `**bold**`, `*it*`, `**_bolditalic_**`, `_x_` and `**✅ ok**` open.
function opensAt(src: string, i: number, len: number, marker: string): boolean {
  const left = src[i - 1];
  const leftOk =
    marker === "_" ? left === undefined || UNDERSCORE_LEFT.test(left) : !isAlnum(left);
  const right = src[i + len];
  return leftOk && (isAlnum(right) || isMarker(right) || isContentStart(right));
}

function findClose(src: string, from: number, marker: string, len: number): number {
  const limit = Math.min(src.length, from + FIND_CLOSE_WINDOW);
  for (let j = from; j + len - 1 < limit; j++) {
    if (src[j] !== marker) continue;
    if (src[j - 1] === "\\") continue; // escaped
    if (len === 2 && src[j + 1] !== marker) continue; // need a pair
    if (len === 1 && (src[j + 1] === marker || src[j - 1] === marker)) continue; // not part of a pair
    if (isAlnum(src[j + len])) continue; // closer glued to a following word
    // Content must not end on whitespace. A single `*`/`_` additionally
    // requires a letter/digit or emoji/symbol right before it: `(*a)*(*b)`,
    // `a[*]` and other code shapes otherwise close on a `)`/`]`. A double
    // `**`/`~~` is lax here so `**Heading:**` (trailing colon) still bolds.
    if (
      len === 1
        ? !(isAlnum(src[j - 1]) || isContentEnd(src[j - 1]))
        : /\s/.test(src[j - 1] ?? "")
    )
      continue;
    return j;
  }
  return -1;
}

// Recursive inline scanner — a bold run can contain a nested italic
// (`**a *b* c**`), emphasis can span newlines, and an unmatched marker degrades
// to a literal instead of corrupting the text.
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

    // Autolink <https://…> — drop the angle brackets, keep the URL linked.
    if (ch === "<") {
      const m = AUTOLINK_RE.exec(src.slice(i, i + LINK_SPAN + 2));
      if (m) {
        const url = m[1]!;
        out.entities.push({
          type: "text_link",
          offset: out.text.length,
          length: url.length,
          url,
        });
        out.text += url;
        i += m[0].length;
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

    // Link [text](https://…) or image ![alt](https://…) — the leading `!` (if
    // any) is dropped; Telegram can't embed a text-mirror image, so the alt
    // text links to the URL.
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const m = LINK_RE.exec(src.slice(i, i + 2 * LINK_SPAN + 8));
      if (m) {
        const start = out.text.length;
        emitInline(m[1] ?? "", out);
        // A body that renders empty (`[****](url)`, `[](url)`) must still show
        // and link the URL rather than dropping it — and never emit a
        // zero-length entity (Telegram rejects length 0).
        if (out.text.length === start) out.text += m[2]!;
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

// --- GFM tables -> aligned monospace grid (Telegram has no table markup) ---

// A separator row: dashes with optional alignment colons, and REQUIRING an
// interior pipe (≥2 columns) so a lone `---` rule or a prose dash never matches.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const looksLikeTableRow = (line: string): boolean => line.includes("|");

// Split a table row on unescaped `|`, trimming the optional outer pipes and
// turning `\|` into a literal `|` inside a cell.
function splitCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (s[k] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += s[k];
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// Render header + body rows (the separator row is dropped) as a fixed-width
// grid: cells padded to per-column max width, a dashed rule under the header.
// The whole block becomes one `pre` entity — Telegram renders it monospace with
// horizontal scroll, so wide tables stay readable on a phone and every cell is
// preserved verbatim.
function renderTable(rows: string[]): string {
  const grid = rows.map(splitCells);
  const ncol = Math.max(...grid.map((r) => r.length));
  const width = (s: string): number => [...s].length; // code points, not UTF-16 units
  const widths: number[] = [];
  for (let c = 0; c < ncol; c++) {
    widths[c] = Math.max(1, ...grid.map((r) => width(r[c] ?? "")));
  }
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - width(s)));
  const line = (r: string[]): string =>
    Array.from({ length: ncol }, (_, c) => pad(r[c] ?? "", widths[c]!)).join(" | ");
  const rule = widths.map((w) => "-".repeat(w)).join("-+-");
  return [line(grid[0]!), rule, ...grid.slice(1).map(line)].join("\n");
}

// --- Block layer: fences, tables, headings, and inline runs ---

function isFenceOpen(line: string): boolean {
  return /^`{3,}[^`\n]*$/.test(line);
}

function startsTable(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length && looksLikeTableRow(lines[i]!) && TABLE_SEP_RE.test(lines[i + 1]!)
  );
}

function isBlockStart(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return isFenceOpen(l) || HEADING_RE.test(l) || startsTable(lines, i);
}

function emitBlocks(src: string, out: Out): void {
  const lines = src.split("\n");
  let i = 0;
  let emitted = false;
  const sep = (): void => {
    if (emitted) out.text += "\n";
    emitted = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: open on ```/````… then run to a line of >= that many
    // backticks (or EOF, preserving graceful degradation). A same-line
    // ```ls``` has trailing backticks so it never matches — it falls through
    // to the inline scanner, as before.
    const fence = /^(`{3,})([^`\n]*)$/.exec(line);
    if (fence) {
      const ticks = fence[1]!.length;
      const language = (fence[2]!.trim().split(/\s+/)[0] ?? "").slice(0, 64);
      const closeRe = new RegExp("^`{" + ticks + ",}\\s*$");
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j]!)) body.push(lines[j++]!);
      const code = body.join("\n");
      if (code.length > 0) {
        sep();
        out.entities.push({
          type: "pre",
          offset: out.text.length,
          length: code.length,
          ...(language ? { language } : {}),
        });
        out.text += code;
      }
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    // GFM table (header line immediately followed by a separator line).
    if (startsTable(lines, i)) {
      const rows: string[] = [line];
      let j = i + 2; // skip the separator row
      while (j < lines.length && looksLikeTableRow(lines[j]!) && lines[j]!.trim() !== "") {
        rows.push(lines[j++]!);
      }
      const grid = renderTable(rows);
      sep();
      out.entities.push({ type: "pre", offset: out.text.length, length: grid.length });
      out.text += grid;
      i = j;
      continue;
    }

    // Heading line (`# …`) renders bold.
    const h = HEADING_RE.exec(line);
    if (h) {
      sep();
      const start = out.text.length;
      emitInline(h[2]!, out);
      if (out.text.length > start) {
        out.entities.push({ type: "bold", offset: start, length: out.text.length - start });
      }
      i++;
      continue;
    }

    // Inline run: consecutive non-block lines scanned as one run so emphasis
    // may span a soft line break.
    const run: string[] = [];
    while (i < lines.length && !isBlockStart(lines, i)) run.push(lines[i++]!);
    sep();
    emitInline(run.join("\n"), out);
  }
}

/** Convert model markdown to Telegram text + entities. Never throws. */
export function mdToTelegram(input: string): { text: string; entities?: TgEntity[] } {
  try {
    // Normalize line endings first: a stray \r left the fence header
    // ("```bash\r") and heading lines ("# H\r") unmatched. Then strip C0
    // control chars (except \t and \n): a NUL makes Telegram reject the message
    // as empty, and since the mirror is the only phone copy a bare resend of the
    // same bytes cannot recover — drop them so the answer still lands.
    const src = input
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    // Oversized input: skip the inline scan (quadratic worst case) and deliver
    // raw — splitTelegram still chunks it. Delivery matters more than markup.
    if (src.length > MAX_FORMAT_LEN) return { text: src };
    const out: Out = { text: "", entities: [] };
    emitBlocks(src, out);
    // A parse that produced only whitespace from non-whitespace input (e.g. a
    // lone empty fenced block, or `# \n```\n``` `) must not send a blank/1-char
    // message Telegram would reject — fall back to the raw input.
    if (!out.text.trim() && input.trim()) return { text: input };
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
 * splitting here turns a hard failure into several messages. Whitespace-only
 * chunks are dropped — Telegram rejects an all-space message as empty, which
 * would otherwise abort the whole mirror mid-answer.
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
      } else {
        // Hard cut mid-text: never sever a surrogate pair (the edge would
        // render as U+FFFD or Telegram would reject it)…
        if (
          end > start + 1 &&
          text.charCodeAt(end - 1) >= 0xd800 &&
          text.charCodeAt(end - 1) <= 0xdbff &&
          text.charCodeAt(end) >= 0xdc00 &&
          text.charCodeAt(end) <= 0xdfff
        ) {
          end -= 1;
        }
        // …and back off a ZWJ / variation-selector / combining-mark cluster so
        // a family emoji isn't split into pieces across two messages (bounded
        // against a Zalgo run).
        for (let g = 0; g < 32 && end > start + 1; g++) {
          const at = text.charCodeAt(end);
          const prev = text.charCodeAt(end - 1);
          const nextCh = text[end];
          const joins =
            at === 0x200d ||
            prev === 0x200d ||
            at === 0xfe0e ||
            at === 0xfe0f ||
            (nextCh !== undefined && /\p{M}/u.test(nextCh));
          if (!joins) break;
          end -= 1;
        }
        // A backoff must not leave the chunk ending on a lone high surrogate.
        if (
          end > start + 1 &&
          text.charCodeAt(end - 1) >= 0xd800 &&
          text.charCodeAt(end - 1) <= 0xdbff
        ) {
          end -= 1;
        }
      }
    }
    chunks.push({ start, end });
    start = end < text.length && text[end] === "\n" ? end + 1 : end;
  }
  const mapped = chunks.map(({ start, end }) => {
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
  // Drop whitespace-only chunks (a wide blank run splits into one), but never
  // return an empty list — the caller relies on at least one chunk.
  const nonEmpty = mapped.filter((c) => c.text.trim().length > 0);
  return nonEmpty.length ? nonEmpty : mapped.slice(0, 1);
}
