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
// The platform query runs asynchronously, off the import — a synchronous query
// here would block the MCP event loop for seconds right in the startup
// handshake. Until it lands, callers see `null` ("still warming") and identity
// stays provisional; the registration wait / heal loop recompute on their own
// cadence, so the answer is picked up within a tick of arriving.
//
// Windows walk performance (live incident, CC 2.1.260): the walk MUST take one
// snapshot of the whole process table and traverse it in memory. The old code
// ran a separate `Get-CimInstance -Filter ProcessId=$id` per level — ~2.8 s
// EACH, so a 5-level autostart chain took ~14 s and blew past the 7 s timeout;
// the query then fell back to the ppid alone (a cmd wrapper with no session
// record), identity never resolved, and — because the query was one-shot — the
// session was deaf forever (badge 💤, messages expired). One snapshot walks any
// depth in ~2.8 s, and the query now RETRIES a degenerate/failed result instead
// of latching it, so a single slow snapshot under mass-autostart load can't
// permanently strand a session.
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

// Windows retry: a walk that yields only the ppid (no ancestors) means the
// snapshot failed or was truncated — retrying beats latching a [ppid] that can
// never match a session record. Bounded so a genuinely short chain still
// settles. ~10 attempts × 4 s covers a mass-autostart contention window.
const WIN_MAX_ATTEMPTS = 10;
const WIN_RETRY_MS = 4000;

/**
 * Parse the Windows walk output (`pid|creationMs;pid|creationMs;…`) into the
 * candidate list, nearest ancestor first. Falls back to the bare ppid when the
 * output is empty (a failed snapshot) so callers still have something to try.
 * Pure and exported for tests.
 */
export function parseWinChain(out: string | null, ppid: number): PidInfo[] {
  if (!out || !out.trim()) return [{ pid: ppid, startedAt: null }];
  const list: PidInfo[] = [];
  for (const tok of out.trim().split(";")) {
    const [pidRaw, msRaw] = tok.split("|");
    const pid = parseInt(pidRaw ?? "", 10);
    const ms = parseInt(msRaw ?? "", 10);
    if (Number.isFinite(pid) && pid > 1) {
      list.push({ pid, startedAt: Number.isFinite(ms) ? ms : null });
    }
  }
  return list.length ? list : [{ pid: ppid, startedAt: null }];
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
    }, 12000);
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
    // ONE snapshot of the whole process table, then walk the parent map from
    // ppid up in memory, emitting `pid|creationMs` per level (';'-separated).
    // Bounded to 16 to avoid a runaway; the real chain is ~5. Each candidate is
    // later checked against sessions/<pid>.json (only the real claude pid has a
    // record), so walking extra non-claude ancestors is safe. Building the map
    // once is depth-independent (~2.8 s) — the per-level filtered query it
    // replaces cost that much PER LEVEL and timed out on deep chains.
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$m=@{};Get-CimInstance Win32_Process|ForEach-Object{$m[[int64]$_.ProcessId]=$_};` +
      `$id=[int64]${ppid};$out=@();` +
      `for($i=0;$i -lt 16;$i++){` +
      `$p=$m[$id];` +
      `if(-not $p){break};` +
      `$ms=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();` +
      `$out+=(\"$id|$ms\");` +
      `$id=[int64]$p.ParentProcessId;` +
      `if(-not $id -or $id -le 1){break}};` +
      `Write-Output ($out -join ';')`;
    let attempt = 0;
    const tryOnce = (): void => {
      attempt++;
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (out) => {
        const list = parseWinChain(out, ppid);
        // A good walk reaches at least one ancestor above the MCP server's
        // parent; a lone [ppid] is a failed/truncated snapshot — retry while we
        // can rather than latch an identity that never resolves.
        if (list.length >= 2 || attempt >= WIN_MAX_ATTEMPTS) {
          finish(list);
        } else {
          const rt = setTimeout(tryOnce, WIN_RETRY_MS);
          (rt as { unref?: () => void }).unref?.();
        }
      });
    };
    tryOnce();
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
