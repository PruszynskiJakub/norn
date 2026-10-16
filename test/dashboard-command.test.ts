import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

describe("norn dashboard", () => {
  test("starts the dashboard on the default port and interval, opens the browser and says where", async () => {
    const w = setup();

    const res = await w.norn("dashboard");

    expect(res.exitCode).toBe(0);
    expect(w.launches).toEqual([{ root: "/repo", port: 4477, explicitPort: false, intervalMs: 120_000, open: true }]);
    expect(res.stdout).toBe(
      ["norn dashboard is running at http://127.0.0.1:4477 and reads GitHub every 2m.", "Opened it in your browser. Stop it with Ctrl-C."].join("\n"),
    );
  });

  test("takes the port, interval and --no-open from the flags", async () => {
    const w = setup();
    w.launchAnswer = { kind: "started", url: "http://127.0.0.1:5000", port: 5000, opened: false };

    const res = await w.norn("dashboard", "--port", "5000", "--interval", "45s", "--no-open");

    expect(w.launches).toEqual([{ root: "/repo", port: 5000, explicitPort: true, intervalMs: 45_000, open: false }]);
    expect(res.stdout).toBe(
      ["norn dashboard is running at http://127.0.0.1:5000 and reads GitHub every 45s.", "Open it in your browser. Stop it with Ctrl-C."].join("\n"),
    );
  });

  test("takes my preferred port and interval from my local config, not the team's", async () => {
    const w = setup();
    w.workspace.files.set(".agents/norn.config.local.json", JSON.stringify({ dashboard: { port: 4600, interval: "1m" } }));

    await w.norn("dashboard");

    expect(w.launches).toEqual([{ root: "/repo", port: 4600, explicitPort: false, intervalMs: 60_000, open: true }]);

    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ dashboard: { port: 4600 } }));
    const res = await w.norn("dashboard");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(".agents/norn.config.json: dashboard is each developer's own; set it in .agents/norn.config.local.json");
    expect(w.launches).toHaveLength(1);
  });

  test("an interval below 30s is raised to 30s, with a warning", async () => {
    const w = setup();

    const res = await w.norn("dashboard", "--interval", "10s");

    expect(w.launches[0].intervalMs).toBe(30_000);
    expect(res.stdout.split("\n")[0]).toBe("norn warning: --interval 10s is below the 30s floor, so the dashboard reads GitHub every 30s.");
  });

  test("a taken default port moves on and says so", async () => {
    const w = setup();
    w.launchAnswer = { kind: "started", url: "http://127.0.0.1:4479", port: 4479, opened: true };

    const res = await w.norn("dashboard");

    expect(res.stdout.split("\n")[0]).toBe("Port 4477 is taken, so norn dashboard is running at http://127.0.0.1:4479 and reads GitHub every 2m.");
  });

  test("a second dashboard of the same repository points at the first", async () => {
    const w = setup();
    w.launchAnswer = { kind: "already-running", url: "http://127.0.0.1:4477" };

    const res = await w.norn("dashboard");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("norn dashboard is already running for this repository at http://127.0.0.1:4477.");
  });

  test("an explicit port that is taken fails", async () => {
    const w = setup();
    w.launchAnswer = { kind: "port-taken", port: 5000 };

    const res = await w.norn("dashboard", "--port", "5000");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("Port 5000 is taken. Pick another with --port, or leave it out to use the next free one.");
  });

  test("a port or interval norn cannot read is a usage error", async () => {
    const w = setup();

    expect((await w.norn("dashboard", "--port", "http")).exitCode).toBe(2);
    expect((await w.norn("dashboard", "--interval", "soon")).stdout).toBe("--interval takes a duration such as 30s, 2m or 1h.");
    expect(w.launches).toEqual([]);
  });
});
