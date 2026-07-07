// Telegram API retry transformer.
//
// grammY surfaces flood control as an ApiResponse with error_code 429 and
// parameters.retry_after (seconds); without handling it, a burst of sends
// (topic fan-out, message splitting) turns into hard tool errors the moment
// Telegram throttles. The transformer retries 429 after the advertised wait
// and transient 5xx/network failures with exponential backoff — bounded, so a
// real outage still surfaces instead of hanging a tool call forever.

import type { Transformer } from "grammy";

export const RETRY_MAX_ATTEMPTS = 4;
// A retry_after above this means Telegram wants us gone for minutes — waiting
// inside a tool call would just hang the session; surface the error instead.
export const RETRY_MAX_WAIT_SEC = 62;

type ApiErrorShape = {
  ok: boolean;
  error_code?: number;
  parameters?: { retry_after?: number };
};

/** Delay before the next attempt, or null to stop retrying. Pure. */
export function retryDelayMs(res: ApiErrorShape, attempt: number): number | null {
  if (res.ok || attempt >= RETRY_MAX_ATTEMPTS) return null;
  if (res.error_code === 429) {
    const after = res.parameters?.retry_after ?? 1;
    if (after > RETRY_MAX_WAIT_SEC) return null;
    return Math.round((after + 0.5) * 1000);
  }
  if ((res.error_code ?? 0) >= 500) return 1000 * 2 ** attempt;
  return null;
}

/** Delay before retrying a thrown (network-level) failure, or null. Pure. */
export function networkRetryDelayMs(attempt: number): number | null {
  return attempt < 2 ? 500 * 2 ** attempt : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function apiRetry(): Transformer {
  return async (prev, method, payload, signal) => {
    let attempt = 0;
    let netAttempt = 0;
    for (;;) {
      let res: Awaited<ReturnType<typeof prev>>;
      try {
        res = await prev(method, payload, signal);
      } catch (e) {
        const delay = networkRetryDelayMs(netAttempt++);
        if (delay === null || signal?.aborted) throw e;
        await sleep(delay);
        continue;
      }
      const delay = retryDelayMs(res as ApiErrorShape, attempt++);
      if (delay === null) return res;
      await sleep(delay);
    }
  };
}
