// Client-readiness gate for the FIRST inbound push.
//
// A channel notification is fire-and-forget: pushed into a claude that has not
// finished starting, it is silently dropped — the MCP spec even allows a
// client to discard notifications received before its `initialized`. A
// relaunched session registers with the leader ~2 s after spawn (warm bun), so
// the held-queue drain used to race claude's startup and the recovered message
// vanished (live incident: register + drain at t+1.8 s, no turn ever started;
// the same flow worked earlier only because a cold start took 29 s). Delivery
// is therefore gated on, in order:
//   1. the MCP handshake completing (`oninitialized`) — protocol readiness;
//   2. a ping round-trip — the client's event loop is actually serving;
// each capped, so a client that never gets there cannot black-hole inbound
// forever — after the caps a push is attempted anyway (risky beats never).

export type ClientReadiness = "ready" | "no-pong" | "no-handshake";

export async function waitForClientReady(opts: {
  /** Resolves when the client sent its MCP `initialized` notification. */
  initialized: Promise<void>;
  /** One ping round-trip; must reject on timeout. */
  ping: () => Promise<unknown>;
  handshakeCapMs?: number;
  pingAttempts?: number;
  pingDelayMs?: number;
}): Promise<ClientReadiness> {
  const {
    initialized,
    ping,
    handshakeCapMs = 60_000,
    pingAttempts = 10,
    pingDelayMs = 1_000,
  } = opts;
  const handshake = await Promise.race([
    initialized.then(() => true as const),
    new Promise<false>((r) => setTimeout(() => r(false), handshakeCapMs)),
  ]);
  if (!handshake) return "no-handshake";
  for (let i = 0; i < pingAttempts; i++) {
    try {
      await ping();
      return "ready";
    } catch {
      await new Promise((r) => setTimeout(r, pingDelayMs));
    }
  }
  return "no-pong";
}
