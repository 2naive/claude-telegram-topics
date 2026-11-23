import { describe, expect, test } from "bun:test";
import { buildFocusPs, parseFocusOutput } from "../src/focus.ts";

describe("focus helper", () => {
  test("the script targets the given pid as an integer", () => {
    const ps = buildFocusPs(12345.7);
    expect(ps).toContain("AttachConsole(12345)");
    expect(ps).not.toContain("12345.7");
  });

  test("the script restores the title and frees the console in a finally block", () => {
    const ps = buildFocusPs(1);
    const fin = ps.indexOf("} finally {");
    expect(fin).toBeGreaterThan(0);
    expect(ps.indexOf("SetConsoleTitleW($old)", fin)).toBeGreaterThan(fin);
    expect(ps.indexOf("FreeConsole()", fin)).toBeGreaterThan(fin);
  });

  test("the marker is re-applied on every probe (a busy claude animates its title)", () => {
    const ps = buildFocusPs(1);
    const loop = ps.indexOf("while ($tries");
    expect(ps.indexOf("SetConsoleTitleW($marker)", loop)).toBeGreaterThan(loop);
  });

  test("the here-string survives UTF-16LE base64 encoding round-trip", () => {
    const ps = buildFocusPs(42);
    const back = Buffer.from(Buffer.from(ps, "utf16le").toString("base64"), "base64").toString("utf16le");
    expect(back).toBe(ps);
    expect(ps).toMatch(/Add-Type @'\n[\s\S]*\n'@\n/);
  });

  test("parse: ok and fail results", () => {
    expect(parseFocusOutput("noise\r\nRESULT ok terminal front tries=1\r\n")).toEqual({
      ok: true,
      detail: "terminal front tries=1",
    });
    expect(parseFocusOutput("RESULT fail tab-not-found")).toEqual({ ok: false, detail: "tab-not-found" });
  });

  test("parse: missing or malformed result is a failure", () => {
    expect(parseFocusOutput("")).toEqual({ ok: false, detail: "no-result" });
    expect(parseFocusOutput("RESULT maybe")).toEqual({ ok: false, detail: "no-result" });
  });

  test("parse: the last result line wins", () => {
    expect(parseFocusOutput("RESULT fail x\nRESULT ok console front").ok).toBe(true);
  });
});
