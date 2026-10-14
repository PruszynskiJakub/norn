import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

describe("slice implementation", () => {
  test.each(["ready-for-agent", "changes-requested", "qa-failed"])(
    "taking a slice in %s moves it to implementation and briefs implement",
    async (state) => {
      const w = setup();
      w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", state] });

      const res = await w.psdd("take", "131");

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Invoke the skill: implement");
      expect(res.stdout).toContain("  psdd done 131\n");
      expect(w.github.labels(131).sort()).toEqual(["implementation", "in-progress", "mode:afk", "type:slice"]);
    },
  );

  test("done after implement moves the slice to needs-review", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    await w.psdd("take", "131");

    await w.psdd("done", "131");

    expect(w.github.labels(131).sort()).toEqual(["mode:afk", "needs-review", "type:slice"]);
    expect(w.github.claim(131)).toBeNull();
  });
});
