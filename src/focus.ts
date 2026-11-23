// Bring a session's console to the foreground on the machine (remote /fg).
//
// The leader knows each session's claude.exe pid (reported at register). A
// short PowerShell helper attaches to that process's console and then:
//   - classic console window (conhost, class ConsoleWindowClass): restore it
//     and bring it to the front;
//   - Windows Terminal: the console window is a PseudoConsoleWindow (which
//     recent WT reports as VISIBLE — so visibility can't tell them apart; the
//     class does). Raising it would not select the tab, and WT exposes
//     no tab<->process mapping. So the helper briefly sets the console title
//     to a unique marker (WT mirrors it onto the tab), finds the tab carrying
//     the marker via UI Automation, selects it, brings its window forward and
//     restores the title. Tab names are useless for matching (most read
//     "Claude Code"), the marker is exact.
// The marker is re-applied on every probe: a busy claude animates its title
// and could overwrite a one-shot marker before UIA sees it.
// The helper runs windowless (its own console would flash) and prints one
// `RESULT <ok|fail> <detail>` line that focusConsole parses.

import { log } from "./log.ts";

export function buildFocusPs(pid: number): string {
  const target = Math.floor(pid);
  return `$ErrorActionPreference = 'Stop'
try {
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class TgFocus {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetConsoleTitleW(string t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitleW(StringBuilder b, uint n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder b, int n);
  public static string Cls(IntPtr h) { var b = new StringBuilder(256); GetClassNameW(h, b, 256); return b.ToString(); }
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  public static string Title() { var b = new StringBuilder(2048); GetConsoleTitleW(b, 2048); return b.ToString(); }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  // Windows' foreground lock lets a background process "succeed" at
  // SetForegroundWindow while the window stays behind (live: returned True,
  // Telegram kept the front). So: Alt tap, then join the foreground thread's
  // input queue (which lifts the lock), raise and activate; verify with
  // GetForegroundWindow; if still refused, a TOPMOST/NOTOPMOST toggle at least
  // puts the window visually on top.
  public static string Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool joined = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try { BringWindowToTop(h); ShowWindow(h, 5); SetForegroundWindow(h); }
    finally { if (joined) AttachThreadInput(me, fgThread, false); }
    if (GetForegroundWindow() == h) return "front";
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
    return GetForegroundWindow() == h ? "front" : "on-top-unfocused";
  }
}
'@
[TgFocus]::FreeConsole() | Out-Null
if (-not [TgFocus]::AttachConsole(${target})) { 'RESULT fail attach ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit }
$cw = [TgFocus]::GetConsoleWindow()
if ($cw -ne [IntPtr]::Zero -and [TgFocus]::Cls($cw) -eq 'ConsoleWindowClass' -and [TgFocus]::IsWindowVisible($cw)) {
  $fg = [TgFocus]::Front($cw); [TgFocus]::FreeConsole() | Out-Null
  'RESULT ok console ' + $fg; exit
}
$old = [TgFocus]::Title()
$marker = 'tg-fg-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$A = [System.Windows.Automation.AutomationElement]
$tabCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$wtIds = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$tab = $null; $win = $null; $tries = 0
try {
  while ($tries -lt 15 -and -not $tab -and $wtIds.Count -gt 0) {
    $tries++
    [TgFocus]::SetConsoleTitleW($marker) | Out-Null
    Start-Sleep -Milliseconds 150
    foreach ($id in $wtIds) {
      $wc = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$id)
      foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)) {
        foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
          if ($t.Current.Name -like ('*' + $marker + '*')) { $tab = $t; $win = $w; break }
        }
        if ($tab) { break }
      }
      if ($tab) { break }
    }
  }
} finally {
  [TgFocus]::SetConsoleTitleW($old) | Out-Null
  [TgFocus]::FreeConsole() | Out-Null
}
if ($wtIds.Count -eq 0) { 'RESULT fail no-window'; exit }
if (-not $tab) { 'RESULT fail tab-not-found'; exit }
$tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
$fg = [TgFocus]::Front([IntPtr]$win.Current.NativeWindowHandle)
'RESULT ok terminal ' + $fg + ' tries=' + $tries
} catch { 'RESULT fail error ' + ($_.Exception.Message -replace '\\s+', ' ') }
`;
}

export type FocusResult = { ok: boolean; detail: string };

/** Parse the helper's `RESULT <ok|fail> <detail>` line (last one wins). */
export function parseFocusOutput(out: string): FocusResult {
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith("RESULT "));
  const last = lines[lines.length - 1];
  if (!last) return { ok: false, detail: "no-result" };
  const m = /^RESULT (ok|fail)\s*(.*)$/.exec(last.trim());
  if (!m) return { ok: false, detail: "no-result" };
  return { ok: m[1] === "ok", detail: m[2]!.trim() };
}

const FOCUS_TIMEOUT_MS = 30_000;

/** Bring the console of claude process `pid` to the foreground. Never throws. */
export async function focusConsole(pid: number): Promise<FocusResult> {
  if (process.platform !== "win32") return { ok: false, detail: "not-windows" };
  try {
    // -EncodedCommand (UTF-16LE base64): the script carries quotes and a
    // here-string that Windows command-line quoting would mangle.
    const encoded = Buffer.from(buildFocusPs(pid), "utf16le").toString("base64");
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    const timer = setTimeout(() => proc.kill(), FOCUS_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    const r = parseFocusOutput(out);
    log("session.focus", { pid, ok: r.ok, detail: r.detail });
    return r;
  } catch (e) {
    log("session.focus.fail", { pid, error: String(e) });
    return { ok: false, detail: "spawn-failed" };
  }
}
