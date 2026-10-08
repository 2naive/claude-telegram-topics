// Per-topic inbox isolation + bounded cleanup.
//
// Attachments used to be written to ONE shared inbox dir, named only by the
// Telegram file_id. A session told "the file is in your message" but handed no
// path could then browse that dir and read another topic's attachments — a live
// incident: the `compare` session read `system`'s screenshot and a `health`
// photo out of the shared inbox (a cross-topic data leak, confirmed from its
// transcript). Files now live under a per-topic subdir, so a session is only
// ever handed `saved:` paths inside its own topic's folder. (The hard stop is
// the channel instruction to open ONLY the exact `saved:` path and never list
// the inbox — the model has filesystem access regardless; this just removes the
// temptation and keeps topics' files apart on disk.)
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The per-topic directory inside the inbox base; created if missing. */
export function inboxSubdir(base: string, topicId: number | string): string {
  const dir = join(base, String(topicId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Delete inbox files older than maxAgeMs. Walks the per-topic subdirs and also
 * any legacy flat files from before isolation; an empty topic dir is removed
 * afterwards. Every entry is guarded on its own, so one unreadable/busy file
 * can never abort the rest of the sweep (the reaper runs unattended).
 */
export function reapInbox(base: string, now: number, maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return; // inbox base gone — nothing to do
  }
  for (const name of entries) {
    const fp = join(base, name);
    try {
      const st = statSync(fp);
      if (st.isDirectory()) {
        for (const f of readdirSync(fp)) {
          const ff = join(fp, f);
          try {
            if (now - statSync(ff).mtimeMs > maxAgeMs) unlinkSync(ff);
          } catch {
            /* best-effort per file */
          }
        }
        try {
          if (readdirSync(fp).length === 0) rmdirSync(fp);
        } catch {
          /* not empty / busy — leave it */
        }
      } else if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(fp); // legacy flat file from before per-topic isolation
      }
    } catch {
      /* best-effort per entry */
    }
  }
}
