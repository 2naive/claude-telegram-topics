// Burst coalescing for inbound messages.
//
// Telegram delivers a forward of several messages, or an album, as separate
// messages a fraction of a second apart — e.g. a caption-less text followed by
// the photo it talks about. Pushed one by one, the first starts a turn on its
// own; the model answers "there is no photo" before the photo (now a queued
// prompt) is even visible to it. Merging a burst from the same sender into one
// channel notification gives the model the whole thing at once.

import type { Inbound } from "./leader.ts";

/** How long the inbound loop waits for the rest of a burst after a message
 * arrives (ms). 0 disables coalescing. */
export const COALESCE_MS = (() => {
  const v = Number(process.env.TG_TOPICS_COALESCE_MS ?? "1200");
  return Number.isFinite(v) && v >= 0 ? v : 1200;
})();

export type Merged = Inbound & { mergedIds?: number[] };

/**
 * Merge consecutive "message" items from the same sender that arrived within
 * `windowMs` of the previous one. The merged item keeps the FIRST message's id
 * (so a reply quotes the start of the burst) and lists every id in mergedIds;
 * texts are joined with a newline. Other kinds (buttons, reactions,
 * permission decisions) are never merged and break a run.
 */
export function coalesce(msgs: Inbound[], windowMs: number): Merged[] {
  if (windowMs <= 0) return msgs;
  const out: Merged[] = [];
  let lastTs = 0;
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (
      m.type === "message" &&
      prev?.type === "message" &&
      prev.from === m.from &&
      m.ts - lastTs <= windowMs
    ) {
      const ids = prev.mergedIds ?? [prev.messageId];
      out[out.length - 1] = { ...prev, text: `${prev.text}\n${m.text}`, mergedIds: [...ids, m.messageId] };
    } else {
      out.push(m);
    }
    lastTs = m.ts;
  }
  return out;
}
