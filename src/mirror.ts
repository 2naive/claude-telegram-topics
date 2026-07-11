// Delivery orchestration for the console→Telegram auto-mirror, kept pure and
// Telegram-agnostic so it can be unit-tested with mocks. Because manual
// duplication is OFF, the mirror is the ONLY phone copy — so the rules encoded
// here are: (1) a mid-stream failure must NOT drop the rest of the answer,
// (2) every non-recoverable failure is surfaced (a gap notice), (3) a deleted
// topic is recovered once, (4) rejected entities fall back to plain text, and
// (5) a huge answer is attached as a file instead of flooding with pushes.
import type { TgEntity } from "./format.ts";

export type MirrorChunk = { text: string; entities?: TgEntity[] };
export type MirrorErrorKind = "thread-gone" | "retry-plain" | "fatal";

export interface MirrorIO {
  // Send one message; throws to signal failure. `notify=false` suppresses the push.
  send(text: string, entities: TgEntity[] | undefined, notify: boolean): Promise<void>;
  // Attach the full answer as a file (the flood-guard path).
  attach(fullText: string, chunkCount: number): Promise<void>;
  // Recreate a deleted/closed topic; the IO updates its own destination.
  recover(): Promise<void>;
  // Classify a thrown error into a handling strategy.
  classify(e: unknown): MirrorErrorKind;
  // Record a swallowed failure (logging).
  onFail(e: unknown): void;
  // Surface an incomplete mirror to the user (cooldown-guarded by the caller).
  notifyGap(sent: number, total: number): void;
}

async function deliverChunk(
  chunk: MirrorChunk,
  notify: boolean,
  io: MirrorIO,
  state: { recovered: boolean },
): Promise<boolean> {
  let entities = chunk.entities;
  // At most: initial try, one recover-retry, one plain-text retry.
  for (let tries = 0; tries < 3; tries++) {
    try {
      await io.send(chunk.text, entities, notify);
      return true;
    } catch (e) {
      const kind = io.classify(e);
      if (kind === "thread-gone" && !state.recovered) {
        state.recovered = true;
        try {
          await io.recover();
          continue; // resend to the fresh topic
        } catch (e2) {
          io.onFail(e2);
          return false;
        }
      }
      if (kind === "retry-plain" && entities) {
        entities = undefined; // formatting rejected — resend as plain text
        continue;
      }
      io.onFail(e);
      return false; // give up on THIS chunk, but the caller sends the rest
    }
  }
  return false;
}

export async function mirrorChunks(
  chunks: MirrorChunk[],
  fullText: string,
  maxChunks: number,
  io: MirrorIO,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  if (chunks.length === 0) return { sent, failed };
  const state = { recovered: false };
  if (chunks.length > maxChunks) {
    // Flood guard: one preview message + the whole answer as a file.
    (await deliverChunk(chunks[0]!, true, io, state)) ? sent++ : failed++;
    try {
      await io.attach(fullText, chunks.length);
      sent++;
    } catch (e) {
      failed++;
      io.onFail(e);
    }
  } else {
    for (let k = 0; k < chunks.length; k++) {
      // Only the first message of an answer pings the phone.
      (await deliverChunk(chunks[k]!, k === 0, io, state)) ? sent++ : failed++;
    }
  }
  if (failed > 0) io.notifyGap(sent, sent + failed);
  return { sent, failed };
}
