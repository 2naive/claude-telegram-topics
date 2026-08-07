// Parent-chain resolution.
//
// Claude Code writes each session's record to <config>/sessions/<pid>.json
// where <pid> is the CLAUDE process pid. Resolving that pid lets identity work
// even when the CLAUDE_CODE_SESSION_ID env var is missing (observed after
// /reload-plugins, and — live incident — for autostart-spawned sessions on a
// recent Claude Code).
//
// How far up the claude pid sits depends on how the session was launched:
//  - manual `cct`: claude -> bun wrapper -> bun server.ts — claude is the
//    GRANDPARENT (2 levels), which the old 2-level probe caught.
//  - remote autostart (Windows): the Start-Process launcher (0.16.1, to stop
//    the port-hostage) adds cmd layers — claude -> cmd -> bun -> cmd -> bun
//    server.ts — claude is FOUR levels up. The 2-level probe missed it, so
//    identity fell back to process.cwd() = the plugin cache dir, which the
//    isRealProjectKey guard rejects, so the client deferred registration
//    forever and the session NEVER registered (badge 💤, message expired
//    unanswered). Windows therefore walks the FULL ancestor chain; the deep
//    chain is Windows-only (remote launch is), so POSIX stays at 2 levels.
//
// The platform query is fired ONCE, asynchronously, at import — a synchronous
// query here would block the MCP event loop for seconds right in the startup
// handshake. Until it lands, callers see `null` ("still warming") and identity
// stays provisional; the registration wait / heal loop recompute on their own
// cadence, so the answer is picked up within a tick of arriving.
//
// Start times ride along in the same query: a sessions/<pid>.json written
// BEFORE its process started belongs to a previous owner of that pid number
// (Windows reuses pids aggressively) and must not be trusted.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export type PidInfo = { pid: number; startedAt: number | null };

let candidates: PidInfo[] | null = null;
let queryStarted = false;
let queryFinished = false;

function finish(list: PidInfo[]): void {
  candidates = list;
  queryFinished = true;
}

function run(cmd: string, args: string[], onDone: (out: string | null) => void): void {
  try {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    let settled = false;
    const settle = (v: string | null): void => {
      if (!settled) {
        settled = true;
        onDone(v);
      }
    };
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle(null);
    }, 7000);
    (t as { unref?: () => void }).unref?.();
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", () => {
      clearTimeout(t);
      settle(out);
    });
    child.on("error", () => {
      clearTimeout(t);
      settle(null);
    });
  } catch {
    onDone(null);
  }
}

function startQuery(): void {
  if (queryStarted) return;
  queryStarted = true;
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) {
    finish([]);
    return;
  }

  if (process.platform === "win32") {
    // One PowerShell invocation walks the whole ancestor chain from ppid up,
    // emitting `pid|creationMs` per level (';'-separated). Bounded to 16 to
    // avoid a runaway; the real chain is ~5. Each candidate is later checked
    // against sessions/<pid>.json (only the real claude pid has a record), so
    // walking extra non-claude ancestors is safe.
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$id=${ppid};$out=@();` +
      `for($i=0;$i -lt 16;$i++){` +
      `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";` +
      `if(-not $p){break};` +
      `$ms=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();` +
      `$out+=(\"$id|$ms\");` +
      `$id=$p.ParentProcessId;` +
      `if(-not $id -or $id -le 1){break}};` +
      `Write-Output ($out -join ';')`;
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      (out) => {
        if (!out || !out.trim()) return finish([{ pid: ppid, startedAt: null }]);
        const list: PidInfo[] = [];
        for (const tok of out.trim().split(";")) {
          const [pidRaw, msRaw] = tok.split("|");
          const pid = parseInt(pidRaw ?? "", 10);
          const ms = parseInt(msRaw ?? "", 10);
          if (Number.isFinite(pid) && pid > 1) {
            list.push({ pid, startedAt: Number.isFinite(ms) ? ms : null });
          }
        }
        finish(list.length ? list : [{ pid: ppid, startedAt: null }]);
      },
    );
    return;
  }

  // POSIX. The grandparent pid itself comes from /proc when available —
  // instant, and works where `ps` is busybox. `ps -o etimes=` then fills in
  // start times best-effort (start = now - etimes); where etimes is missing
  // the pid-reuse guard simply doesn't apply, but identity still resolves.
  let gpFromProc: number | null = null;
  try {
    // /proc/<pid>/stat field 4 = ppid; comm (field 2) may contain spaces and
    // parens, so parse AFTER the last ')'.
    const stat = readFileSync(`/proc/${ppid}/stat`, "utf8");
    const n = parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]!, 10);
    if (Number.isFinite(n) && n > 1 && n !== ppid) gpFromProc = n;
  } catch {
    // no /proc (macOS) — ps below resolves the grandparent too
  }
  run("ps", ["-o", "ppid=,etimes=", "-p", String(ppid)], (out) => {
    const now = Date.now();
    const parts = (out ?? "").trim().split(/\s+/);
    const psGp = parseInt(parts[0] ?? "", 10);
    const ppEt = parseInt(parts[1] ?? "", 10);
    let gp = gpFromProc;
    if (gp === null && Number.isFinite(psGp) && psGp > 1 && psGp !== ppid) gp = psGp;
    const list: PidInfo[] = [
      { pid: ppid, startedAt: Number.isFinite(ppEt) ? now - ppEt * 1000 : null },
    ];
    if (gp === null) return finish(list);
    const gpPid = gp;
    run("ps", ["-o", "etimes=", "-p", String(gpPid)], (out2) => {
      const gpEt = parseInt((out2 ?? "").trim(), 10);
      list.push({
        pid: gpPid,
        startedAt: Number.isFinite(gpEt) ? Date.now() - gpEt * 1000 : null,
      });
      finish(list);
    });
  });
}

startQuery();

/**
 * Candidate claude pids with start times, nearest ancestor first: on Windows
 * the full ppid chain (claude can be several levels up behind the launcher's
 * cmd/bun layers); on POSIX [parent, grandparent?]. `null` while the one-shot
 * platform query is still warming — callers treat that as "identity not yet
 * resolvable" and retry on their own cadence.
 */
export function pidCandidates(): PidInfo[] | null {
  return queryFinished ? candidates : null;
}
