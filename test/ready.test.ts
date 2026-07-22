import { describe, expect, test } from "bun:test";
import { waitForClientReady } from "../src/ready.ts";

const resolved = Promise.resolve();
const never = new Promise<void>(() => {});

describe("waitForClientReady (first-push gate)", () => {
  test("ready: handshake done and ping answers at once", async () => {
    const r = await waitForClientReady({
      initialized: resolved,
      ping: async () => ({}),
    });
    expect(r).toBe("ready");
  });

  test("retries ping until the client starts answering", async () => {
    let calls = 0;
    const r = await waitForClientReady({
      initialized: resolved,
      ping: async () => {
        calls++;
        if (calls < 3) throw new Error("not serving yet");
        return {};
      },
      pingDelayMs: 5,
    });
    expect(r).toBe("ready");
    expect(calls).toBe(3);
  });

  test("no-pong: caps ping attempts, then delivery proceeds anyway", async () => {
    let calls = 0;
    const r = await waitForClientReady({
      initialized: resolved,
      ping: async () => {
        calls++;
        throw new Error("never answers");
      },
      pingAttempts: 4,
      pingDelayMs: 2,
    });
    expect(r).toBe("no-pong");
    expect(calls).toBe(4);
  });

  test("no-handshake: caps the wait for a client that never initializes", async () => {
    const r = await waitForClientReady({
      initialized: never,
      ping: async () => ({}),
      handshakeCapMs: 20,
    });
    expect(r).toBe("no-handshake");
  });

  test("waits for a late handshake instead of pushing early", async () => {
    let done!: () => void;
    const initialized = new Promise<void>((res) => {
      done = res;
    });
    setTimeout(done, 30);
    const r = await waitForClientReady({
      initialized,
      ping: async () => ({}),
      handshakeCapMs: 5_000,
    });
    expect(r).toBe("ready");
  });
});
