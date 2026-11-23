import { describe, expect, test } from "bun:test";
import { confirmStep, hookTurn, newPendingMessages, unconfirmedNotice } from "../src/confirm.ts";

const msg = (messageId: number) => ({ type: "message" as const, from: "u", text: `m${messageId}`, messageId, ts: 1 });

describe("newPendingMessages", () => {
  test("drops messages already pending, keeps new ones in order", () => {
    const pending = [msg(1), msg(2)];
    expect(newPendingMessages(pending, [msg(2), msg(3), msg(1), msg(4)]).map((m) => m.messageId)).toEqual([3, 4]);
  });

  test("drops a duplicate inside the same batch", () => {
    expect(newPendingMessages([], [msg(5), msg(5)]).map((m) => m.messageId)).toEqual([5]);
  });

  test("a message redelivered twice is sent three times in all, not four", () => {
    // Model of the leader: /poll arms the pending set with what it drained;
    // each retry re-queues the pending set, which comes back through /poll.
    const pending = [msg(7)];
    let sent = 1;
    for (let retry = 0; retry < 2; retry++) {
      const requeued = [...pending];
      sent += requeued.length;
      pending.push(...newPendingMessages(pending, requeued));
    }
    expect(sent).toBe(3);
    expect(pending.length).toBe(1);
  });
});

describe("hookTurn", () => {
  const base = { last: 1_000, bornAt: 500, now: 2_000, ttl: 900_000 };

  test("an open turn needs a start/working hook since the session registered", () => {
    expect(hookTurn({ ...base, hook: "working" })).toEqual({ open: true, fresh: true });
    expect(hookTurn({ ...base, hook: "start" })).toEqual({ open: true, fresh: true });
    expect(hookTurn({ ...base, hook: "working", bornAt: 1_500 })).toEqual({ open: false, fresh: false });
  });

  test("a Stop or a failure closes it, whatever the leader shows on the badge", () => {
    // The leader marks the topic working when it routes a message (beginTurn);
    // only the hooks decide here, so a deaf console after its last Stop is not busy.
    expect(hookTurn({ ...base, hook: "idle" })).toEqual({ open: false, fresh: false });
    expect(hookTurn({ ...base, hook: "failed" })).toEqual({ open: false, fresh: false });
    expect(hookTurn({ ...base, hook: "" })).toEqual({ open: false, fresh: false });
  });

  test("an open turn silent past the TTL is open but not fresh", () => {
    expect(hookTurn({ ...base, hook: "working", now: 1_000 + 900_000 })).toEqual({ open: true, fresh: false });
  });
});

describe("confirmStep", () => {
  const open = { open: true, fresh: true };
  const closed = { open: false, fresh: false };

  test("waits while the hooks report a fresh open turn, whatever the count", () => {
    expect(confirmStep({ turn: open, redeliveries: 0, max: 2 })).toBe("defer");
    expect(confirmStep({ turn: open, redeliveries: 2, max: 2 })).toBe("defer");
  });

  test("an open turn silent past the TTL is given up at once, without copies", () => {
    expect(confirmStep({ turn: { open: true, fresh: false }, redeliveries: 0, max: 2 })).toBe("give-up");
  });

  test("retries a quiet session up to the limit, then gives up", () => {
    expect(confirmStep({ turn: closed, redeliveries: 0, max: 2 })).toBe("retry");
    expect(confirmStep({ turn: closed, redeliveries: 1, max: 2 })).toBe("retry");
    expect(confirmStep({ turn: closed, redeliveries: 2, max: 2 })).toBe("give-up");
  });
});

describe("unconfirmedNotice", () => {
  test("a missing allowlist entry is named first, even mid-turn", () => {
    const t = unconfirmedNotice({ allowlisted: false, turnWasOpen: true });
    expect(t).toContain("/telegram-topics:allowlist");
    expect(t).not.toContain("Esc");
  });

  test("a turn that went quiet points at the console first, and names the flagless case", () => {
    // An Esc or a crash fires no hook, so a console without the channels flag
    // can look like a silent open turn: the notice must cover both.
    const t = unconfirmedNotice({ allowlisted: true, turnWasOpen: true });
    expect(t).toContain("waiting for an answer in the console");
    expect(t).toContain("Esc");
    expect(t).toContain("channels flag");
    expect(t).not.toContain("surface when the turn ends");
    expect(t).not.toBe(unconfirmedNotice({ allowlisted: true, turnWasOpen: false }));
  });

  test("a session that never surfaced input keeps the relaunch advice", () => {
    const t = unconfirmedNotice({ allowlisted: true, turnWasOpen: false });
    expect(t).toContain("relaunch");
    expect(t).toContain("channels flag");
  });
});
