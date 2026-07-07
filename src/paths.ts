// Pure path helpers — no config, no I/O — so they are trivially unit-testable
// and safe to import from anywhere.

/**
 * Canonicalize a project path into a STABLE identity key. The same project must
 * always yield the same key regardless of how the path was spelled:
 *   - slash direction: `git rev-parse` prints `/`, `process.cwd()` prints `\` on
 *     Windows, so a git repo and its cwd fallback would otherwise differ;
 *   - a trailing separator;
 *   - letter case on case-insensitive platforms (Windows).
 * Without this, one project could map to two different topics.
 */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s || p.trim();
}

/**
 * The trailing folder name of a path — used verbatim as the topic title, in the
 * path's original case. Handles both `/` and `\` separators and a trailing one.
 */
export function displayName(p: string): string {
  const s = p.trim().replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const base = i >= 0 ? s.slice(i + 1) : s;
  return base || "project";
}
