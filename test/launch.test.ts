// Pins the server launch contract: the start script (what the plugin's
// .mcp.json runs through bun's shell) must carry BUN_JSC_numberOfGCMarkers=1.
// Without it every collection on an idle follower spawns bun's 7 GC helper
// threads afresh (they idle out between ~26 s poll cycles) and each burst
// leaves native memory and a thread handle behind — ~200 MB/h of private
// bytes, 1.5 GB of working set in ~1.5 days (live incident, 0.20.24). The
// option must be set before the VM starts, so it lives in the launch line, not
// in server code — and the launch line must go through bun's shell for the
// `VAR=value cmd` prefix to work on Windows too.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));

describe("server launch", () => {
  test("the plugin runs the start script through bun's shell", () => {
    const srv = mcp.mcpServers["telegram-topics"];
    expect(srv.command).toBe("bun");
    expect(srv.args).toContain("--shell=bun");
    expect(srv.args[srv.args.length - 1]).toBe("start");
  });

  test("start pins a single GC marker thread", () => {
    expect(pkg.scripts.start).toMatch(/(^|&&\s)BUN_JSC_numberOfGCMarkers=1 bun src\/server\.ts$/);
  });
});
