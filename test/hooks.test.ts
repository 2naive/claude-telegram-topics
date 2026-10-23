// Pins the hooks.json contract against the activity hook's own worst case.
//
// activity.ts bounds itself: `git rev-parse` 3s + fetch 0.3s (+ bun startup,
// ~0.3s idle). A hooks.json `timeout` at or below that kills a merely slow hook
// and discards its signal — a lost `start` lets a stale "spoke" flag stand the
// auto-mirror down, a lost `idle` leaves ⏳ until the working-TTL. Live
// incident: a 5s cap killed `start` on a cold `--continue` console start
// (2–14s observed under starvation), so the cap must clear the self-bound by a
// wide margin — it should only ever fire when the whole machine is starved.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Hook = { type: string; command: string; timeout?: number; async?: boolean };
type Group = { matcher?: string; hooks: Hook[] };

const cfg = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "hooks", "hooks.json"), "utf8"),
) as { hooks: Record<string, Group[]> };

const HOOK_SELF_BOUND_S = 3.3;
const MIN_TIMEOUT_S = HOOK_SELF_BOUND_S * 3;

const hooksOf = (event: string): Hook[] =>
  (cfg.hooks[event] ?? []).flatMap((g) => g.hooks);

const allHooks = (): Array<[string, Hook]> =>
  Object.keys(cfg.hooks).flatMap((event) =>
    hooksOf(event).map((h) => [event, h] as [string, Hook]),
  );

describe("hooks.json contract", () => {
  test("every event we rely on is wired", () => {
    for (const event of ["UserPromptSubmit", "PreToolUse", "Stop", "StopFailure"]) {
      expect(hooksOf(event).length).toBeGreaterThan(0);
    }
  });

  test("every hook is a command hook whose timeout clears the script's self-bound with margin", () => {
    const violations = allHooks()
      .filter(([, h]) => h.type !== "command" || (h.timeout ?? 0) < MIN_TIMEOUT_S)
      .map(([event, h]) => `${event}: ${h.command} (timeout ${h.timeout ?? "default"})`);
    expect(violations).toEqual([]);
  });

  test("the PreToolUse heartbeat is async — tool calls never wait on it", () => {
    for (const h of hooksOf("PreToolUse")) expect(h.async).toBe(true);
  });

  test("turn-boundary hooks stay synchronous — their order matters", () => {
    // `start` must land before the turn's first send_message (else it clears
    // the "spoke" flag the send just set → double post); idle/mirror must land
    // before the next turn's start. A background hook, starved, could overtake.
    for (const event of ["UserPromptSubmit", "Stop", "StopFailure"]) {
      for (const h of hooksOf(event)) expect(h.async ?? false).toBe(false);
    }
  });
});
