import { describe, expect, test } from "vitest";
import { sessionId } from "@norn/cli";

describe("session id", () => {
  test("NORN_SESSION wins, then the Claude Code session, then the herdr pane, then host and repository root", () => {
    expect(sessionId({ NORN_SESSION: "p", CLAUDE_CODE_SESSION_ID: "c", HERDR_PANE_ID: "h" }, "host", "/repo")).toBe("p");
    expect(sessionId({ CLAUDE_CODE_SESSION_ID: "c", HERDR_PANE_ID: "h" }, "host", "/repo")).toBe("c");
    expect(sessionId({ HERDR_PANE_ID: "h" }, "host", "/repo")).toBe("herdr:h");
    expect(sessionId({}, "host", "/repo")).toBe("host:/repo");
  });
});
