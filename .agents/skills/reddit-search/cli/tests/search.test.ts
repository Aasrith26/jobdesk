import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { resetRateLimit, setRobotsChecker } from "../src/helpers";

// Offline: fetch is stubbed to serve the synthetic feed fixtures, the robots
// gate is stubbed (reddit.com's real robots.txt disallows everything, see
// SKILL.md), and timers fire immediately.

const forhire = await Bun.file(join(import.meta.dir, "fixtures/forhire-new.rss")).text();
const devindia = await Bun.file(join(import.meta.dir, "fixtures/developersindia-new.rss")).text();
const postFeed = await Bun.file(join(import.meta.dir, "fixtures/post.rss")).text();

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalWrite = process.stdout.write;
const originalErr = process.stderr.write;
let urls: string[] = [];
let robotsAsked: string[] = [];

function stub(robots: (url: string) => boolean = () => true) {
  urls = [];
  robotsAsked = [];
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
  setRobotsChecker((url) => {
    robotsAsked.push(url);
    const ok = robots(url);
    return { allowed: ok, message: ok ? "ALLOWED - stub" : "DISALLOWED for Claude-User - stub" };
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.startsWith("https://www.reddit.com/r/forhire/new/.rss")) return new Response(forhire);
    if (url.startsWith("https://www.reddit.com/r/developersIndia/new/.rss")) return new Response(devindia);
    if (url === "https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react_developer_remote_60hr/.rss") return new Response(postFeed);
    if (url === "https://www.reddit.com/comments/1ofh001/.rss") return new Response(postFeed);
    if (url.startsWith("https://www.reddit.com/r/brokensub/")) return new Response("", { status: 403 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErr;
  }
}

function run(partial: Partial<SearchOpts>) {
  return capture(() =>
    runSearch({
      subreddits: ["forhire", "developersIndia"],
      includeForHire: false,
      perSub: 25,
      remote: false,
      indiaFriendly: false,
      page: 1,
      limit: 25,
      format: "json",
      ...partial,
    }),
  );
}

const ids = (out: string) => JSON.parse(out).results.map((r: { id: string }) => r.id);

beforeEach(() => resetRateLimit());
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  process.stdout.write = originalWrite;
  process.stderr.write = originalErr;
  setRobotsChecker(null);
});

describe("runSearch (offline)", () => {
  test("r/forhire keeps only [Hiring] posts by default; other subs keep everything; newest first", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual(["1ofh001", "1odi001", "1ofh003", "1odi002", "1ofh004", "1ofh006"]);
    expect(data.meta.skipped_not_hiring).toBe(2);
    expect(data.meta.subreddits.map((s: { subreddit: string; status: string; entries: number }) => [s.subreddit, s.status, s.entries])).toEqual([
      ["forhire", "ok", 6],
      ["developersIndia", "ok", 2],
    ]);
    for (const r of data.results) {
      expect(typeof r.title).toBe("string");
      expect(typeof r.company).toBe("string");
      expect(r.url).toMatch(/^https:\/\/www\.reddit\.com\//);
      expect(r.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["job", "lead"]).toContain(r.kind);
    }
    // robots consulted for each feed, before each request, with ?limit=
    expect(robotsAsked).toEqual([
      "https://www.reddit.com/r/forhire/new/.rss?limit=25",
      "https://www.reddit.com/r/developersIndia/new/.rss?limit=25",
    ]);
    expect(urls).toEqual(robotsAsked);
  });

  test("--include-for-hire keeps [For Hire] and untagged r/forhire posts", async () => {
    stub();
    const data = JSON.parse((await run({ subreddits: ["forhire"], includeForHire: true })).out);
    expect(data.meta.total).toBe(6);
    expect(data.meta.skipped_not_hiring).toBe(0);
  });

  test("-q filters client-side on title + body, all words must match", async () => {
    stub();
    expect(ids((await run({ query: "python" })).out)).toEqual(["1odi001", "1ofh003"]);
    expect(ids((await run({ query: "react tailwind" })).out)).toEqual(["1ofh001"]);
    expect(ids((await run({ query: "PUNE" })).out)).toEqual(["1odi001"]);
    expect(JSON.parse((await run({ query: "cobol" })).out).meta.total).toBe(0);
  });

  test("--remote, --india-friendly and --jobage", async () => {
    stub();
    expect(ids((await run({ remote: true })).out)).toEqual(["1ofh001", "1ofh004"]);
    expect(ids((await run({ indiaFriendly: true })).out)).toEqual(["1odi001", "1ofh003", "1ofh004"]);
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-11-11T06:00:00Z");
    try {
      expect(ids((await run({ jobage: 1 })).out)).toEqual(["1ofh001", "1odi001"]);
    } finally {
      Date.now = realNow;
    }
  });

  test("--per-sub is passed as the feed's limit parameter", async () => {
    stub();
    await run({ subreddits: ["forhire"], perSub: 5 });
    expect(urls).toEqual(["https://www.reddit.com/r/forhire/new/.rss?limit=5"]);
  });

  test("paging, table and plain", async () => {
    stub();
    const p2 = JSON.parse((await run({ limit: 4, page: 2 })).out);
    expect(p2.meta.count).toBe(2);
    expect(p2.results[0].id).toBe("1ofh004");
    expect((await run({ format: "table" })).out).toContain("KIND");
    expect((await run({ format: "plain", limit: 1 })).out).toContain("Brightloop Labs (job)");
  });

  test("robots disallow -> no request at all, ROBOTS_DISALLOWED on stderr, exit 1", async () => {
    stub(() => false);
    const r = await run({});
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    const err = JSON.parse(r.err);
    expect(err.code).toBe("ROBOTS_DISALLOWED");
    expect(err.error).toContain("nothing was fetched");
    expect(urls).toEqual([]);
  });

  test("mixed outcomes are reported per subreddit; readable ones still return", async () => {
    stub((u) => !u.includes("/r/remotejs/"));
    const { code, out } = await run({ subreddits: ["forhire", "remotejs", "missingsub", "brokensub"] });
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.meta.subreddits.map((s: { status: string }) => s.status)).toEqual(["ok", "robots_disallowed", "not_found", "error"]);
    expect(urls.some((u) => u.includes("remotejs"))).toBe(false);
  });

  test("nothing readable -> SEARCH_FAILED", async () => {
    stub();
    const r = await run({ subreddits: ["missingsub"] });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).code).toBe("SEARCH_FAILED");
  });
});

describe("runDetail (offline)", () => {
  test("fetches <permalink>.rss and returns the post's cleaned text", async () => {
    stub();
    const r = await capture(() =>
      runDetail({ id: "https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react_developer_remote_60hr/", format: "json" }),
    );
    expect(r.code).toBe(0);
    expect(urls).toEqual(["https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react_developer_remote_60hr/.rss"]);
    const job = JSON.parse(r.out);
    expect(job).toMatchObject({ id: "1ofh001", company: "Brightloop Labs", kind: "job", comment_count_in_feed: 2 });
    expect(job.description).toContain("We need a senior React + TypeScript developer");
    expect(job.description).not.toContain("Is this open to contractors"); // comments are not included
    expect(job.links).toEqual(["https://jobs.example.com/brightloop/react?ref=reddit&src=rss"]);
    expect("snippet" in job).toBe(false);
  });

  test("bare id and plain format", async () => {
    stub();
    const r = await capture(() => runDetail({ id: "1ofh001", format: "plain" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("URL: https://www.reddit.com/r/forhire/comments/1ofh001/");
    expect(r.out).toContain("Posted in r/forhire by u/example_user_1");
  });

  test("NOT_FOUND and ROBOTS_DISALLOWED", async () => {
    stub();
    const nf = await capture(() => runDetail({ id: "zzz999", format: "json" }));
    expect(nf.code).toBe(1);
    expect(JSON.parse(nf.err).code).toBe("NOT_FOUND");
    stub(() => false);
    const rb = await capture(() => runDetail({ id: "1ofh001", format: "json" }));
    expect(rb.code).toBe(1);
    expect(JSON.parse(rb.err).code).toBe("ROBOTS_DISALLOWED");
    expect(urls).toEqual([]);
  });
});
