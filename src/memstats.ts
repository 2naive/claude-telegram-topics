// Pure helpers for the MCP server's memory diagnostics (server.ts watchdog).
//
// The per-session server leaks ~30–40 MB/h in production — role- and
// traffic-independent, and NOT reproducible in isolation (replays of the poll
// loop and of the MCP ping tick stay flat). Periodic heap snapshots written to
// client.log, with per-type object-count deltas between samples, are the
// fingerprint that names the leaking allocation without attaching a debugger
// to a day-old process.

export type TypeCounts = Record<string, number>;

/**
 * `[type, count, delta]` for the `n` object types that grew the most since the
 * previous sample (by delta when one exists, else by count). Ties break by
 * count, then name, so the output is stable. Types that vanished entirely are
 * not listed — a shrinking type is never the leak.
 */
export function topTypeDeltas(
  prev: TypeCounts | null,
  cur: TypeCounts,
  n = 10,
): Array<[string, number, number]> {
  const rows: Array<[string, number, number]> = Object.entries(cur).map(([t, c]) => [
    t,
    c,
    c - (prev?.[t] ?? 0),
  ]);
  rows.sort(
    (a, b) =>
      (prev ? b[2] - a[2] || b[1] - a[1] : b[1] - a[1]) || a[0].localeCompare(b[0]),
  );
  return rows.slice(0, Math.max(0, n));
}

/** One compact token per type for a log line: `Array:1200+300`, `string:90-5`. */
export function renderTypeDeltas(rows: Array<[string, number, number]>): string[] {
  return rows.map(([t, c, d]) => `${t}:${c}${d >= 0 ? "+" : ""}${d}`);
}
