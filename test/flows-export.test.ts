import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

function project() {
  const w = setup();
  const cwd = mkdtempSync(join(tmpdir(), "norn-flows-"));
  return { w, cwd, norn: w.withDeps({ cwd }) };
}

describe("norn flows export", () => {
  test("writes the built-in story flow to .agents/flows/story.json as JSON a person can edit", async () => {
    const { cwd, norn } = project();

    const res = await norn("flows", "export", "story");

    expect(res.exitCode).toBe(0);
    const text = readFileSync(join(cwd, ".agents", "flows", "story.json"), "utf8");
    expect(text.startsWith('{\n  "description": ')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    const flow = JSON.parse(text);
    expect(flow.start).toBe("needs-refinement");
    expect(flow.workspace).toBe("own");
    expect(flow.states["needs-slicing"].behaviours).toEqual({ slices: { type: "slice" } });
    expect(res.stdout).toContain("Wrote .agents/flows/story.json, a copy of the built-in story flow.");
  });

  test("writes the slice flow next to an existing story flow", async () => {
    const { cwd, norn } = project();
    await norn("flows", "export", "story");

    const res = await norn("flows", "export", "slice");

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, ".agents", "flows", "slice.json"), "utf8")).workspace).toBe("parent");
  });

  test("refuses when the file exists and leaves it as it is", async () => {
    const { cwd, norn } = project();
    mkdirSync(join(cwd, ".agents", "flows"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "flows", "story.json"), "ours\n");

    const res = await norn("flows", "export", "story");

    expect(res.exitCode).toBe(1);
    expect(readFileSync(join(cwd, ".agents", "flows", "story.json"), "utf8")).toBe("ours\n");
    expect(res.stdout).toContain(".agents/flows/story.json already exists");
  });

  test("refuses a name norn has no built-in flow of, naming the ones it has", async () => {
    const { cwd, norn } = project();

    const res = await norn("flows", "export", "bug");

    expect(res.exitCode).toBe(1);
    expect(existsSync(join(cwd, ".agents", "flows", "bug.json"))).toBe(false);
    expect(res.stdout).toContain('norn has no built-in flow "bug". Built-in flows: story, slice.');
  });

  test("without export and a name, says how to call it", async () => {
    const { norn } = project();

    const [bare, noName] = [await norn("flows"), await norn("flows", "export")];

    expect(bare.exitCode).toBe(2);
    expect(bare.stdout).toContain("Usage: norn flows export <name>");
    expect(noName.exitCode).toBe(2);
  });

  test("--json gives the flow and the file", async () => {
    const { norn } = project();

    const res = JSON.parse((await norn("flows", "export", "story", "--json")).stdout);

    expect(res).toMatchObject({ ok: true, flow: "story", file: ".agents/flows/story.json" });
  });
});

describe("an exported flow, unchanged", () => {
  type World = ReturnType<typeof setup>;

  /** A story from new issue to its owner's merge, with an afk and a hil slice: everything each command printed, and GitHub after. */
  async function storyRun(w: World) {
    const gh = w.github;
    gh.seedIssue({ number: 123, title: "Rate limiting" });
    const out: string[] = [];
    const step = async (...argv: string[]) => {
      const r = await w.norn(...argv);
      expect(r.exitCode, `${argv.join(" ")}\n${r.stdout}`).toBe(0);
      out.push(`$ norn ${argv.join(" ")}\n${r.stdout}`);
      return r.stdout;
    };
    for (const word of ["story", "questions", "answered", ""]) {
      await step("take", "123");
      await step(...["done", "123", word].filter(Boolean));
    }
    await step("take", "123");
    await step("add-slice", "123", "Redis store", "--mode", "afk");
    const [redis] = gh.subIssueNumbers(123);
    await step("add-slice", "123", "Per-key limits", "--mode", "hil", "--blocked-by", String(redis));
    const [, perKey] = gh.subIssueNumbers(123);
    await step("done", "123");
    await step("next", "123");
    for (const [n, hil] of [
      [redis, false],
      [perKey, true],
    ] as const) {
      await step("take", String(n));
      gh.prs.push({ number: n + 5000, head: `123-rate-limiting-${n}`, base: "123-rate-limiting", state: "open" });
      for (const outcome of [[], ["approve"], ["pass", "Behaviour 1: passed"]]) {
        await step("done", String(n), ...outcome);
        await step("take", String(n));
      }
      if (hil) {
        await step("next", "123");
        await step("done", String(n), "pass");
        await step("take", String(n));
      }
      gh.prs.at(-1)!.state = "merged";
      await step("done", String(n));
    }
    for (const outcome of [["approve"], ["pass", "Behaviour 1: passed"], ["pass"]]) {
      await step("take", "123");
      await step("done", "123", ...outcome);
      await step("next", "123");
    }
    await step("status", "123");
    const numbers = [123, redis, perKey];
    return {
      out,
      labels: numbers.map((n) => gh.labels(n).sort()),
      comments: numbers.map((n) => gh.comments(n)),
      labelDefs: [...gh.labelDefs.entries()].sort(),
      prs: gh.prs,
    };
  }

  test("runs a story and its slices exactly like the built-in flows", async () => {
    const { cwd, norn } = project();
    await norn("flows", "export", "story");
    await norn("flows", "export", "slice");
    const exported = setup();
    for (const name of ["story", "slice"]) {
      exported.github.seedFlow(name, readFileSync(join(cwd, ".agents", "flows", `${name}.json`), "utf8"));
    }

    const [builtIn, fromFiles] = [await storyRun(setup()), await storyRun(exported)];

    expect(fromFiles).toEqual(builtIn);
    expect(builtIn.labels[0]).toEqual(["merge-queue", "type:story"]);
  });
});
