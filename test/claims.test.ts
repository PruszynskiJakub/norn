import { describe, expect, test } from "vitest";
import { acquire } from "@psdd/core";
import { FakeGitHub } from "@psdd/testing";

const now = new Date("2026-10-13T15:00:00Z");
const twoHours = 2 * 3_600_000;
const record = (session: string) => ({ holder: "alice", session, since: now.toISOString() });

describe("stale-claim takeover", () => {
  test("of two sessions taking over the same stale claim at once, only one wins", async () => {
    const gh = new FakeGitHub("alice");
    await gh.createClaim(131, { holder: "bob", session: "crashed", since: "2026-10-13T10:00:00Z" });
    // B reads the stale claim; before B acts on it, A takes it over completely.
    const read = gh.readClaim.bind(gh);
    let raced = false;
    gh.readClaim = async (n) => {
      const held = await read(n);
      if (!raced) {
        raced = true;
        expect(await acquire(gh, n, record("a"), now, twoHours)).toMatchObject({ ok: true, tookOver: { session: "crashed" } });
      }
      return held;
    };

    const b = await acquire(gh, 131, record("b"), now, twoHours);

    expect(b).toMatchObject({ ok: false, held: { session: "a" } });
    expect(gh.claim(131)?.session).toBe("a");
  });

  test("takeover takes a fresh claim of the same holder only", async () => {
    const gh = new FakeGitHub("alice");
    await gh.createClaim(131, { holder: "alice", session: "stopped", since: now.toISOString() });
    await gh.createClaim(132, { holder: "bob", session: "running", since: now.toISOString() });

    expect(await acquire(gh, 131, record("a"), now, twoHours)).toMatchObject({ ok: false });
    expect(await acquire(gh, 131, record("a"), now, twoHours, { takeover: true })).toMatchObject({
      ok: true,
      ownTakeover: true,
      tookOver: { session: "stopped" },
    });
    expect(await acquire(gh, 132, record("a"), now, twoHours, { takeover: true })).toMatchObject({ ok: false, held: { holder: "bob" } });
    expect(gh.claim(132)?.session).toBe("running");
  });

  test("a stale claim is taken over and reported without its commit sha", async () => {
    const gh = new FakeGitHub("alice");
    await gh.createClaim(131, { holder: "bob", session: "crashed", since: "2026-10-13T10:00:00Z" });

    const got = await acquire(gh, 131, record("a"), now, twoHours);

    expect(got).toEqual({ ok: true, tookOver: { holder: "bob", session: "crashed", since: "2026-10-13T10:00:00Z" } });
    expect(gh.claim(131)?.session).toBe("a");
  });
});
