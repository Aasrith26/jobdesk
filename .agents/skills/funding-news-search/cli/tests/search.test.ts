import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";
import { DEFAULT_FEEDS } from "../src/helpers";
import { capture, freshStateDir, instantTimers, restoreTimers } from "./helpers";

// Offline: fetch is stubbed to serve the recorded (trimmed) feeds in
// tests/fixtures and a permissive robots.txt.

const fx = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const FEEDS: Record<string, string> = {
  "https://inc42.com/buzz/feed/": await fx("inc42.xml"),
  "https://entrackr.com/rss": await fx("entrackr.xml"),
  "https://yourstory.com/tag/funding/feed": await fx("ys.xml"),
  "https://techcrunch.com/category/venture/feed/": await fx("tcv.xml"),
  "https://techcrunch.com/category/startups/feed/": await fx("tcs.xml"),
};

const originalFetch = globalThis.fetch;
let urls: string[] = [];
let robots: Record<string, Response | (() => Response)> = {};
let feedOverride: Record<string, () => Response> = {};

function stub() {
  urls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const u = new URL(url);
    if (u.pathname === "/robots.txt") {
      const r = robots[u.origin];
      if (r) return typeof r === "function" ? r() : r.clone();
      return new Response("User-agent: *\nDisallow: /wp-admin/\n");
    }
    if (feedOverride[url]) return feedOverride[url]();
    if (FEEDS[url]) return new Response(FEEDS[url], { headers: { "content-type": "application/rss+xml" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function run(partial: Partial<SearchOpts>) {
  return capture(() => runSearch({ keepUnparsed: false, page: 1, limit: 100, format: "json", ...partial }));
}

beforeEach(() => {
  freshStateDir();
  robots = {};
  feedOverride = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreTimers();
});

describe("runSearch (offline)", () => {
  test("reads every default feed, keeps announcements, contract fields present", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.meta.feeds.map((f: { status: string }) => f.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(data.meta.scanned).toBe(26);
    const companies = data.results.map((r: { company: string }) => r.company);
    expect(companies).toEqual(
      expect.arrayContaining([
        "Kissht", "Froncort.AI", "Cosmoserve Space", "Ottonomy", "Peppermint Robotics", "Armatrix",
        "WillJini", "The Pant Project", "Tonbo Imaging", "IIFL Finance", "Bakingo", "Dream", "Trajectory", "Harbinger",
      ]),
    );
    expect(companies).toHaveLength(14);
    expect(data.meta.skipped.roundup).toBe(1);
    expect(data.meta.skipped.vc_fund).toBe(3);
    for (const r of data.results) {
      expect(r.kind).toBe("lead");
      expect(r.lead_type).toBe("funded_startup");
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const k of ["id", "title", "company", "location", "date", "posted_date", "url", "amount", "round", "source"]) expect(k in r).toBe(true);
    }
    // newest first
    const dates = data.results.map((r: { date: string }) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test("the same raise from two outlets is one lead with also_reported", async () => {
    stub();
    const data = JSON.parse((await run({})).out);
    const pep = data.results.filter((r: { company: string }) => r.company === "Peppermint Robotics");
    expect(pep).toHaveLength(1);
    expect(pep[0].also_reported).toHaveLength(1);
    expect(data.meta.skipped.duplicate).toBe(1);
  });

  test("robots.txt is fetched once per origin before the feeds", async () => {
    stub();
    await run({});
    const robotsUrls = urls.filter((u) => u.endsWith("/robots.txt"));
    expect(robotsUrls.sort()).toEqual([
      "https://entrackr.com/robots.txt",
      "https://inc42.com/robots.txt",
      "https://techcrunch.com/robots.txt",
      "https://yourstory.com/robots.txt",
    ]);
    // cached for the next run
    stub();
    await run({});
    expect(urls.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(0);
  });

  test("a feed robots.txt disallows is skipped, not fetched", async () => {
    robots["https://entrackr.com"] = new Response("User-agent: *\nDisallow: /rss\n");
    stub();
    const data = JSON.parse((await run({})).out);
    const st = data.meta.feeds.find((f: { name: string }) => f.name === "Entrackr");
    expect(st.status).toBe("robots-disallowed");
    expect(urls).not.toContain("https://entrackr.com/rss");
  });

  test("robots.txt answering 403 leaves permission unconfirmed: the feed is skipped", async () => {
    robots["https://inc42.com"] = () => new Response("<html>challenge</html>", { status: 403 });
    stub();
    const data = JSON.parse((await run({})).out);
    expect(data.meta.feeds[0]).toMatchObject({ name: "Inc42", status: "robots-unconfirmed", items: 0 });
    expect(urls).not.toContain("https://inc42.com/buzz/feed/");
  });

  test("robots.txt 404 means no policy: allowed", async () => {
    robots["https://entrackr.com"] = () => new Response("nope", { status: 404 });
    stub();
    const data = JSON.parse((await run({})).out);
    expect(data.meta.feeds[1].status).toBe("ok");
  });

  test("a challenge page instead of a feed is reported as not-a-feed", async () => {
    feedOverride["https://inc42.com/buzz/feed/"] = () => new Response("<!DOCTYPE html><html><body>Just a moment...</body></html>");
    stub();
    const data = JSON.parse((await run({})).out);
    expect(data.meta.feeds[0].status).toBe("not-a-feed");
    expect(data.results.length).toBeGreaterThan(0);
  });

  test("--feeds overrides the defaults; names come from the host", async () => {
    stub();
    const data = JSON.parse((await run({ feeds: ["https://entrackr.com/rss"] })).out);
    expect(data.meta.feeds).toHaveLength(1);
    expect(data.meta.feeds[0].name).toBe("entrackr.com");
    expect(data.results.every((r: { source: string }) => r.source === "entrackr.com")).toBe(true);
    expect(urls.some((u) => u.includes("techcrunch"))).toBe(false);
  });

  test("-q filters client-side (all words)", async () => {
    stub();
    const data = JSON.parse((await run({ query: "seed round" })).out);
    expect(data.results.map((r: { company: string }) => r.company).sort()).toEqual(["Armatrix", "Cosmoserve Space", "Ottonomy"]);
  });

  test("--keep-unparsed keeps funding items without an extractable name", async () => {
    feedOverride["https://entrackr.com/rss"] = () =>
      new Response('<rss><channel><item><title>Startup raises $5M in seed round</title><link>https://entrackr.com/a</link><pubDate>Wed, 11 Nov 2026 10:00:00 +0530</pubDate></item></channel></rss>');
    stub();
    const dropped = JSON.parse((await run({ feeds: ["https://entrackr.com/rss"] })).out);
    expect(dropped.results).toHaveLength(0);
    expect(dropped.meta.skipped.no_company).toBe(1);
    const kept = JSON.parse((await run({ feeds: ["https://entrackr.com/rss"], keepUnparsed: true })).out);
    expect(kept.results[0].company).toBeNull();
  });

  test("--page/--limit page client-side; table has one row per result", async () => {
    stub();
    const p = JSON.parse((await run({ limit: 5, page: 3 })).out);
    expect(p.meta.count).toBe(4);
    expect(p.meta.total).toBe(14);
    const { out } = await run({ limit: 3, format: "table" });
    expect(out.trim().split("\n")).toHaveLength(5);
  });

  test("every feed failing -> FEEDS_FAILED JSON on stderr, exit 1", async () => {
    instantTimers();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("bad", { status: 503 });
    }) as typeof fetch;
    const { code, out, err } = await run({});
    expect(code).toBe(1);
    expect(out).toBe("");
    const e = JSON.parse(err);
    expect(e.code).toBe("FEEDS_FAILED");
    expect(e.error).toContain("Inc42 (error: Request failed: HTTP 503)");
  });

  test("default feed list is the verified one", () => {
    expect(DEFAULT_FEEDS.map((f) => f.url)).toEqual(Object.keys(FEEDS));
  });
});
