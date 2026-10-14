import { describe, expect, test } from "vitest";
import { ghFailureMessage } from "../src/cli.js";

describe("the message when a gh call fails partway", () => {
  test("says changes may be applied, and how to check and retry the command on its issue", () => {
    const msg = ghFailureMessage(["done", "131", "request-changes", "Still flaky"], "gh api failed: HTTP 502");

    expect(msg).not.toContain("nothing more was done");
    expect(msg.split("\n")).toEqual([
      "GitHub refused a call. Some changes from this command may already be applied.",
      "gh api failed: HTTP 502",
      "See where things stand with: psdd status 131 (for a slice, psdd status <its story> shows the whole story)",
      "Check gh auth status and that you are inside the repository, then retry: psdd done 131 request-changes 'Still flaky'",
    ]);
  });

  test("the retry command quotes a note so the shell cannot expand it", () => {
    const msg = ghFailureMessage(["escalate", "131", "it's $HOME"], "x");
    expect(msg).toContain(`then retry: psdd escalate 131 'it'\\''s $HOME'`);
  });

  test("without an issue number it only says to retry", () => {
    const msg = ghFailureMessage(["init"], "gh label create failed");
    expect(msg).toContain("may already be applied");
    expect(msg).not.toContain("psdd status");
    expect(msg).toContain("then retry the command.");
  });
});
