import { describe, expect, test } from "bun:test";
import {
  networkRetryDelayMs,
  retryDelayMs,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_WAIT_SEC,
} from "../src/tgretry.ts";

describe("retryDelayMs", () => {
  test("success never retries", () => {
    expect(retryDelayMs({ ok: true }, 0)).toBeNull();
  });

  test("429 waits retry_after (+ jitter margin)", () => {
    expect(
      retryDelayMs({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 0),
    ).toBe(2500);
  });

  test("429 without retry_after assumes one second", () => {
    expect(retryDelayMs({ ok: false, error_code: 429 }, 0)).toBe(1500);
  });

  test("a flood wait beyond the cap surfaces instead of hanging the tool", () => {
    expect(
      retryDelayMs(
        { ok: false, error_code: 429, parameters: { retry_after: RETRY_MAX_WAIT_SEC + 1 } },
        0,
      ),
    ).toBeNull();
  });

  test("5xx backs off exponentially", () => {
    expect(retryDelayMs({ ok: false, error_code: 502 }, 0)).toBe(1000);
    expect(retryDelayMs({ ok: false, error_code: 502 }, 1)).toBe(2000);
    expect(retryDelayMs({ ok: false, error_code: 502 }, 2)).toBe(4000);
  });

  test("client errors (4xx other than 429) never retry", () => {
    expect(retryDelayMs({ ok: false, error_code: 400 }, 0)).toBeNull();
    expect(retryDelayMs({ ok: false, error_code: 403 }, 0)).toBeNull();
  });

  test("attempts are bounded", () => {
    expect(
      retryDelayMs(
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        RETRY_MAX_ATTEMPTS,
      ),
    ).toBeNull();
  });
});

describe("networkRetryDelayMs", () => {
  test("two bounded retries, then surface", () => {
    expect(networkRetryDelayMs(0)).toBe(500);
    expect(networkRetryDelayMs(1)).toBe(1000);
    expect(networkRetryDelayMs(2)).toBeNull();
  });
});
