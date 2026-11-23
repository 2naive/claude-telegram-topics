// Delivery-confirmation decisions for the leader (pure, unit-tested; the
// timers and side effects stay in leader.ts).
//
// The leader re-queues messages a session did not visibly pick up (no turn
// hook within CONFIRM_TIMEOUT_MS) — the guard against a console that opens and
// silently never surfaces them. A BUSY session looks the same from outside: a
// turn waiting on a console menu, one long tool call or generation, or
// auto-compaction fires no hook for minutes, while the client has already
// handed every message to Claude Code, which queues it until the turn ends.
// Re-queueing there only produced copies (4 per message: the pending list was
// re-extended with the redelivered copies, so the second retry carried two)
// and a false "relaunch the console" notice.

/** Messages of `incoming` that are not pending yet. A redelivered message
 * comes back through /poll and must be counted once, not appended again. */
export function newPendingMessages<M extends { messageId: number }>(pending: M[], incoming: M[]): M[] {
  const have = new Set(pending.map((m) => m.messageId));
  return incoming.filter((m) => {
    if (have.has(m.messageId)) return false;
    have.add(m.messageId);
    return true;
  });
}

/** What the turn hooks alone say about the project's turn. Only hooks count:
 * the leader itself marks a topic "working" when it routes a message, which
 * must not make a deaf console look busy. `open`: the last hook since this
 * session registered was start/working (no Stop, no failure after it) —
 * hooks are per project, so a sibling session's turn counts too. `fresh`: that
 * hook is younger than `ttl`. */
export function hookTurn(x: { last: number; bornAt: number; hook: string; now: number; ttl: number }): {
  open: boolean;
  fresh: boolean;
} {
  const open = x.last >= x.bornAt && (x.hook === "start" || x.hook === "working");
  return { open, fresh: open && x.now - x.last < x.ttl };
}

export type ConfirmStep = "defer" | "retry" | "give-up";

/** What the confirmation timer does next. A turn open by its hooks holds the
 * messages behind it (the client already handed them to Claude Code): wait for
 * it while its hooks are fresh, and once it has been silent past the TTL give
 * up at once with the "turn went quiet" notice — re-queueing would only add
 * copies that surface when the turn ends. A session with no open turn is
 * retried up to `max` times, then given up. */
export function confirmStep(x: {
  turn: { open: boolean; fresh: boolean };
  redeliveries: number;
  max: number;
}): ConfirmStep {
  if (x.turn.open) return x.turn.fresh ? "defer" : "give-up";
  return x.redeliveries >= x.max ? "give-up" : "retry";
}

/** The topic notice when the leader gives up. `allowlisted`: the plugin is on
 * the channels allowlist (otherwise that is the deterministic cause).
 * `turnWasOpen`: the hooks last reported a turn in progress that never ended
 * (no Stop). Usually it waits in the console or runs one long step, but an Esc
 * or a crash fires no hook either, so a console launched without the channels
 * flag can look the same: the notice names both. */
export function unconfirmedNotice(x: { allowlisted: boolean; turnWasOpen: boolean }): string {
  if (!x.allowlisted) {
    return "⚠️ The session cannot receive messages: the plugin is not on the channels allowlist, so --channels loads it without the inbound half. On the machine run /telegram-topics:allowlist (one admin prompt), or launch with --dangerously-load-development-channels, then restart the session.";
  }
  if (x.turnWasOpen) {
    return "⚠️ The session has not picked the message up: its last turn never reported an end and has been silent for a long time. It may be waiting for an answer in the console (a menu or a prompt), still running one long step (then wait), or stuck (interrupt it with Esc). If the console shows no turn running, it was probably launched without the channels flag: close it and relaunch from here (▶️ button / autostart), then resend.";
  }
  return "⚠️ The session has not picked the message up. If it is still starting it may catch up; if it was launched without the channels flag (a plain `claude`), it can never receive — close that console and relaunch from here (▶️ button / autostart), then resend.";
}
