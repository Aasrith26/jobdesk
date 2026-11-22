import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Opt-in live smoke test (REDDIT_SEARCH_LIVE=1). CI makes no live portal requests.
// reddit.com's robots.txt currently disallows every path for every agent, so the
// expected live outcome today is ROBOTS_DISALLOWED with no feed request made; if
// Reddit ever allows the feed paths, the same test checks real results instead.

const live = process.env.REDDIT_SEARCH_LIVE ? describe : describe.skip;

live("live smoke", () => {
  test("search either returns posts or stops at the robots gate", async () => {
    const r = await runCLI(["search", "-s", "forhire", "--per-sub", "10", "--limit", "3"]);
    if (r.exitCode === 1) {
      const err = JSON.parse(r.stderr);
      expect(err.code).toBe("ROBOTS_DISALLOWED");
      expect(r.stdout).toBe("");
      return;
    }
    const data = JSON.parse(r.stdout);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    for (const p of data.results) expect(p.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/forhire\/comments\//);
  });
});
