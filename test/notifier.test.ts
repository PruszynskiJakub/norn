import { describe, expect, test } from "vitest";
import { makeNotifier } from "../src/notifier.js";
import type { Run } from "../src/local-workspace.js";

function recording(code = 0) {
  const calls: [string, string[]][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, args]);
    return { code, stdout: "", stderr: "boom" };
  };
  return { run, calls };
}

const msg = { title: "psdd: #131 needs you", body: 'escalated: "it\'s \\"broken\\""\nhttps://x/131' };

describe("local notifier", () => {
  test("herdr shows a notification with the request sound", async () => {
    const { run, calls } = recording();
    await makeNotifier("darwin", run)("herdr", msg);
    expect(calls).toEqual([["herdr", ["notification", "show", msg.title, "--body", msg.body, "--sound", "request"]]]);
  });

  test("macOS uses osascript, with quotes escaped", async () => {
    const { run, calls } = recording();
    await makeNotifier("darwin", run)("os", { title: 'say "hi"', body: "a\\b" });
    expect(calls).toEqual([["osascript", ["-e", 'display notification "a\\\\b" with title "say \\"hi\\""']]]);
  });

  test("Linux uses notify-send", async () => {
    const { run, calls } = recording();
    await makeNotifier("linux", run)("os", msg);
    expect(calls).toEqual([["notify-send", [msg.title, msg.body]]]);
  });

  test("Windows shows a toast through PowerShell", async () => {
    const { run, calls } = recording();
    await makeNotifier("win32", run)("os", { title: "it's", body: "b" });
    expect(calls[0][0]).toBe("powershell");
    expect(calls[0][1].at(-1)).toContain("ToastNotificationManager");
    expect(calls[0][1].at(-1)).toContain("it''s");
  });

  test("a failing tool is an error for the caller to swallow", async () => {
    const { run } = recording(1);
    await expect(makeNotifier("linux", run)("os", msg)).rejects.toThrow("notify-send");
  });
});
