import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPT_OUT_ENV, optedOut } from "../src/optout.ts";

describe("optedOut (TG_TOPICS_DISABLE)", () => {
  test("off by default: unset or empty keeps the bridge on", () => {
    expect(optedOut({})).toBe(false);
    expect(optedOut({ [OPT_OUT_ENV]: "" })).toBe(false);
    expect(optedOut({ [OPT_OUT_ENV]: "  " })).toBe(false);
  });

  test("1 keeps this run off the bridge", () => {
    expect(optedOut({ [OPT_OUT_ENV]: "1" })).toBe(true);
  });

  test("only an exact 1 counts — the TG_TOPICS_AUTOSTART rule", () => {
    for (const v of ["0", "false", "no", "true", "yes", "2", "01"]) {
      expect(optedOut({ [OPT_OUT_ENV]: v })).toBe(false);
    }
  });

  test("reads exactly TG_TOPICS_DISABLE", () => {
    expect(OPT_OUT_ENV).toBe("TG_TOPICS_DISABLE");
    expect(optedOut({ TG_TOPICS_DISABLED: "1" })).toBe(false);
  });
});

// The entry points Claude Code starts on its own — both hooks and the MCP
// server — run as real processes against a stand-in for the leader's control
// port that records every request. An opted-out run must leave it untouched;
// each case has a control run that is NOT opted out, proving the same setup
// does reach the port (so "nothing arrived" can't pass by accident).
describe("entry points honour TG_TOPICS_DISABLE", () => {
  const ROOT = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "tg-optout-"));
  const hits: string[] = [];
  let port = 0;
  let stop: () => void = () => {};

  beforeAll(() => {
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.push(path);
        // Hold the port and answer /health like a real leader: a server that is
        // NOT opted out then loses the election to it (instead of failing on a
        // "foreign" port) and never polls Telegram.
        if (path === "/health") return Response.json({ ok: true, version: "0.0.0" });
        return Response.json({ ok: true });
      },
    });
    port = srv.port!;
    stop = () => srv.stop(true);
  });
  afterAll(() => {
    stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  // Hermetic child env: the preload's throwaway state dir and credentials, the
  // stand-in port, and an empty Claude config dir (session-identity lookup).
  function childEnv(disabled: boolean, stateDir?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (stateDir) env.TG_TOPICS_STATE_DIR = stateDir;
    env.TG_TOPICS_PORT = String(port);
    env.CLAUDE_CONFIG_DIR = scratch;
    env.CLAUDE_PROJECT_DIR = scratch;
    delete env[OPT_OUT_ENV];
    if (disabled) env[OPT_OUT_ENV] = "1";
    return env;
  }

  async function runHook(
    disabled: boolean,
    file: string,
    args: string[],
    stdin = "",
  ): Promise<string[]> {
    hits.length = 0;
    const proc = Bun.spawn([process.execPath, join(ROOT, "hooks", file), ...args], {
      cwd: scratch,
      env: childEnv(disabled),
      stdin: new Blob([stdin]),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0); // the hook contract: always exit 0
    return [...hits];
  }

  test("activity hook: no /activity ping when opted out", async () => {
    expect(await runHook(false, "activity.ts", ["start"])).toEqual(["/activity"]);
    expect(await runHook(true, "activity.ts", ["start"])).toEqual([]);
  });

  test("mirror hook: no /mirror post when opted out", async () => {
    const transcript = join(scratch, "t.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    );
    const payload = JSON.stringify({ transcript_path: transcript, cwd: scratch, session_id: "s1" });
    expect(await runHook(false, "mirror.ts", [], payload)).toEqual(["/mirror"]);
    expect(await runHook(true, "mirror.ts", [], payload)).toEqual([]);
  });

  // Minimal MCP client over the server's stdio (newline-delimited JSON-RPC).
  function startServer(disabled: boolean, stateDir?: string) {
    const proc = Bun.spawn([process.execPath, join(ROOT, "src", "server.ts")], {
      cwd: scratch,
      env: childEnv(disabled, stateDir),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let nextId = 1;
    const send = (msg: object) => {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
      proc.stdin.flush();
    };
    async function request(method: string, params: object = {}): Promise<any> {
      const id = nextId++;
      send({ id, method, params });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          const { value, done } = await reader.read();
          if (done) throw new Error("server closed stdout");
          buf += decoder.decode(value, { stream: true });
          continue;
        }
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        // Skip the server's own requests (e.g. ping) — only our response counts.
        if (msg.id === id && ("result" in msg || "error" in msg)) return msg.result;
      }
    }
    async function handshake(): Promise<any> {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "optout-test", version: "0" },
      });
      send({ method: "notifications/initialized" });
      return init;
    }
    return { proc, request, handshake };
  }

  test(
    "MCP server: no election, no registration, no tools when opted out",
    async () => {
      hits.length = 0;
      const s = startServer(true);
      try {
        const init = await s.handshake();
        expect(init.instructions).toBeUndefined();
        // Not a channel: no approval relay for Claude Code to send prompts to.
        expect(init.capabilities.experimental).toBeUndefined();
        expect((await s.request("tools/list")).tools).toEqual([]);
        // A normal server probes the port before its handshake even completes
        // (control below), so a short grace period after it is plenty.
        await Bun.sleep(500);
        expect(hits).toEqual([]);
      } finally {
        s.proc.kill();
        await s.proc.exited;
      }
    },
    20_000,
  );

  test(
    "MCP server control: environment-only — a .env value does not opt out",
    async () => {
      // The channel .env is shared by every session, so config.ts never merges
      // the opt-out from it; this run is therefore NOT opted out and must
      // reach the port like any session.
      const stateDir = join(scratch, "state-with-env");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, ".env"), `${OPT_OUT_ENV}=1\n`);
      hits.length = 0;
      const s = startServer(false, stateDir);
      try {
        const init = await s.handshake();
        expect(typeof init.instructions).toBe("string");
        expect(init.capabilities.experimental["claude/channel/permission"]).toEqual({});
        expect((await s.request("tools/list")).tools.length).toBeGreaterThan(0);
        const deadline = Date.now() + 10_000;
        while (!hits.includes("/health") && Date.now() < deadline) await Bun.sleep(100);
        expect(hits).toContain("/health");
      } finally {
        s.proc.kill();
        await s.proc.exited;
      }
    },
    20_000,
  );
});
