import { describe, expect, test } from "vitest";
import { runsOutsideCheckout } from "@norn/cli";

describe("commands outside a git checkout", () => {
  test("doctor, --version and --help (or -h, after any command) run; the rest need a checkout", () => {
    for (const argv of [["doctor"], ["--version"], ["--help"], ["-h"], ["take", "12", "--help"], ["dashboard", "-h"]]) {
      expect(runsOutsideCheckout(argv)).toBe(true);
    }
    for (const argv of [[], ["init"], ["take", "12"], ["status", "3", "--json"]]) expect(runsOutsideCheckout(argv)).toBe(false);
  });
});
