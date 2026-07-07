// Parent-chain resolution.
//
// Claude Code writes each session's record to <config>/sessions/<pid>.json
// where <pid> is the CLAUDE process pid — and the claude process is this
// server's grandparent (claude -> bun wrapper -> bun server.ts), or its parent
// on a direct spawn. Resolving that pid lets identity work even when the
// CLAUDE_CODE_SESSION_ID env var is missing (observed after /reload-plugins).
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
    // One PowerShell invocation: grandparent pid + both creation times (ms).
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}';` +
      `if($p){$ps=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();` +
      `$g=Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\";` +
      `if($g){$gs=([DateTimeOffset]$g.CreationDate).ToUnixTimeMilliseconds();` +
      `Write-Output \"$($p.ParentProcessId)|$ps|$gs\"}else{Write-Output \"|$ps|\"}}`;
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      (out) => {
        if (!out) return finish([{ pid: ppid, startedAt: null }]);
        const [gpRaw, ppStartRaw, gpStartRaw] = out.trim().split("|");
        const gp = parseInt(gpRaw ?? "", 10);
        const ppStart = parseInt(ppStartRaw ?? "", 10);
        const gpStart = parseInt(gpStartRaw ?? "", 10);
        const list: PidInfo[] = [
          { pid: ppid, startedAt: Number.isFinite(ppStart) ? ppStart : null },
        ];
        if (Number.isFinite(gp) && gp > 1 && gp !== ppid) {
          list.push({ pid: gp, startedAt: Number.isFinite(gpStart) ? gpStart : null });
        }
        finish(list);
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
 * Candidate claude pids with start times, cheapest-guess first: [parent,
 * grandparent?]. `null` while the one-shot platform query is still warming —
 * callers treat that as "identity not yet resolvable" and retry on their own
 * cadence.
 */
export function pidCandidates(): PidInfo[] | null {
  return queryFinished ? candidates : null;
}
