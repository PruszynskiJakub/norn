import { describe, expect, test } from "vitest";
import { makeNotifier } from "../src/notifier.js";
import type { Run } from "../src/local-workspace.js";

function recording(code = 0) {
  const calls: [string, string[]][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const run: Run = async (cmd, args, env) => {
    calls.push([cmd, args]);
    envs.push(env);
    return { code, stdout: "", stderr: "boom" };
  };
  return { run, calls, envs };
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

  test("Windows shows a toast through PowerShell, with the text kept out of the script", async () => {
    const { run, calls, envs } = recording();
    const body = "can\u2018t \u2019; Remove-Item x; \u201a\u201b 'quoted'";
    await makeNotifier("win32", run)("os", { title: "it's", body });
    expect(calls[0][0]).toBe("powershell");
    const script = calls[0][1].at(-1)!;
    expect(script).toContain("ToastNotificationManager");
    expect(script).toContain("$env:PSDD_BODY");
    for (const ch of ["\u2018", "\u2019", "\u201a", "\u201b", "it's", "Remove-Item"]) expect(script).not.toContain(ch);
    expect(envs[0]).toEqual({ PSDD_TITLE: "it's", PSDD_BODY: body });
  });

  test("a failing tool is an error for the caller to swallow", async () => {
    const { run } = recording(1);
    await expect(makeNotifier("linux", run)("os", msg)).rejects.toThrow("notify-send");
  });
});
