import { describe, expect, test } from "vitest";
import { sessionId } from "../src/env.js";

describe("session id", () => {
  test("PSDD_SESSION wins, then the Claude Code session, then host and directory", () => {
    expect(sessionId({ PSDD_SESSION: "p", CLAUDE_CODE_SESSION_ID: "c" }, "host", "/w")).toBe("p");
    expect(sessionId({ CLAUDE_CODE_SESSION_ID: "c" }, "host", "/w")).toBe("c");
    expect(sessionId({}, "host", "/w")).toBe("host:/w");
  });
});
