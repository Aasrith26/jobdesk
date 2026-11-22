import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";
import { capture, freshStateDir, instantTimers, restoreTimers } from "./helpers";

// Offline: fetch is stubbed to serve the recorded (trimmed) GitHub responses in
// tests/fixtures, so these tests pin parsing + filtering + paging without the network.

const fx = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const labelHits = await fx("search-issues-label.json");
const keywordHits = await fx("search-issues-keyword.json");
const repoHits = await fx("search-repos.json");

const STARS: Record<string, number> = {
  "cvas22/docxforge": 3,
  "Douglas-Strey/repolens-cli": 120,
  "patsypppe/meridian": 2,
  "andrewsiah/agentswarm-data-tasks": 0,
  "example-org/widget": 800,
  "example-co/infra": 45,
};

const originalFetch = globalThis.fetch;
let urls: string[] = [];
let inits: RequestInit[] = [];

function stub(opts: { searchStatus?: number } = {}) {
  urls = [];
  inits = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    inits.push(init ?? {});
    const headers = { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) };
    if (url.includes("/search/") && opts.searchStatus) return new Response("{}", { status: opts.searchStatus, headers });
    if (url.includes("/search/issues")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      return new Response(q.includes('label:"help wanted"') ? labelHits : keywordHits, { headers });
    }
    if (url.includes("/search/repositories")) return new Response(repoHits, { headers });
    const m = /\/repos\/([^/]+\/[^/?]+)$/.exec(url);
    if (m && m[1] in STARS) {
      return new Response(JSON.stringify({ full_name: m[1], stargazers_count: STARS[m[1]], owner: { login: m[1].split("/")[0], type: "User" } }), { headers });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

async function run(partial: Partial<SearchOpts>) {
  return capture(() =>
    runSearch({ mode: "issues", days: 30, noStars: false, page: 1, limit: 25, format: "json", query: "python", ...partial }),
  );
}

beforeEach(() => {
  freshStateDir();
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreTimers();
  delete process.env.GITHUB_TOKEN;
});

describe("runSearch issues mode (offline)", () => {
  test("merges both queries, drops noise and duplicates, newest update first", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual([
      "andrewsiah/agentswarm-data-tasks#131",
      "andrewsiah/agentswarm-data-tasks#109",
      "example-org/widget#7",
      "example-co/infra#42",
      "cvas22/docxforge#77",
      "patsypppe/meridian#31",
      "Douglas-Strey/repolens-cli#7",
    ]);
    expect(data.meta.dropped_no_lead_signal).toBe(3);
    expect(data.meta.total).toBe(7);
    expect(data.meta.github_total_count).toEqual([3711, 17267]);
    for (const r of data.results) {
      for (const k of ["id", "title", "company", "location", "date", "posted_date", "url", "kind", "repo_stars", "labels", "match"]) {
        expect(k in r).toBe(true);
      }
      expect(r.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
      expect(r.kind).toBe("lead");
      expect(r.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const bounty = data.results.find((r: { id: string }) => r.id === "example-org/widget#7");
    expect(bounty).toMatchObject({ company: "example-org", repo_stars: 800, title: "[Bounty $200] Add streaming support to the Python client" });
    expect(bounty.match).toEqual(["label:💎 Bounty", "title:bounty"]);
    const paid = data.results.find((r: { id: string }) => r.id === "example-co/infra#42");
    expect(paid.match).toEqual(["body:this is a paid"]);
  });

  test("sends the label query plain and the keyword query with advanced_search", async () => {
    stub();
    await run({ query: "llm", days: 7 });
    const searches = urls.filter((u) => u.includes("/search/issues")).map((u) => new URL(u).searchParams);
    expect(searches).toHaveLength(2);
    expect(searches[0].get("q")).toMatch(/^llm is:issue is:open archived:false label:"help wanted" updated:>=\d{4}-\d{2}-\d{2}$/);
    expect(searches[0].get("advanced_search")).toBeNull();
    expect(searches[1].get("q")).toContain("(hiring OR paid OR bounty OR contract)");
    expect(searches[1].get("advanced_search")).toBe("true");
    expect(searches[0].get("per_page")).toBe("100");
  });

  test("stars are looked up for the page only, once per repo", async () => {
    stub();
    const data = JSON.parse((await run({ limit: 3 })).out);
    expect(data.results.map((r: { repo_stars: number }) => r.repo_stars)).toEqual([0, 0, 800]);
    expect(urls.filter((u) => /\/repos\/[^/]+\/[^/]+$/.test(u))).toHaveLength(2);
    expect(data.meta.repo_lookups).toBe(2);
  });

  test("stars come from the 24 h cache on the second run", async () => {
    stub();
    await run({ limit: 3 });
    stub();
    await run({ limit: 3 });
    expect(urls.filter((u) => /\/repos\/[^/]+\/[^/]+$/.test(u))).toHaveLength(0);
  });

  test("--no-stars skips repo lookups", async () => {
    stub();
    const data = JSON.parse((await run({ noStars: true })).out);
    expect(urls.some((u) => /\/repos\//.test(u))).toBe(false);
    expect(data.results.every((r: { repo_stars: null }) => r.repo_stars === null)).toBe(true);
  });

  test("--min-stars filters on looked-up stars", async () => {
    stub();
    const data = JSON.parse((await run({ minStars: 40 })).out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual(["example-org/widget#7", "example-co/infra#42", "Douglas-Strey/repolens-cli#7"]);
    expect(data.meta.stars_unresolved_dropped).toBe(true);
  });

  test("--page/--limit page client-side; --limit 0 emits nothing", async () => {
    stub();
    const p2 = JSON.parse((await run({ limit: 3, page: 3, noStars: true })).out);
    expect(p2.results.map((r: { id: string }) => r.id)).toEqual(["Douglas-Strey/repolens-cli#7"]);
    const zero = JSON.parse((await run({ limit: 0 })).out);
    expect(zero.results).toEqual([]);
  });

  test("table format has one row per result", async () => {
    stub();
    const { out } = await run({ format: "table", limit: 2, noStars: true });
    expect(out.trim().split("\n")).toHaveLength(4);
  });
});

describe("runSearch repos mode (offline)", () => {
  test("one README search; owner is the company; stars from the search hit", async () => {
    stub();
    const data = JSON.parse((await run({ mode: "repos", query: undefined, minStars: 10 })).out);
    expect(urls).toHaveLength(1);
    const q = new URL(urls[0]).searchParams.get("q")!;
    expect(q).toMatch(/^"we're hiring" in:readme archived:false pushed:>=\d{4}-\d{2}-\d{2} stars:>=10$/);
    expect(data.results[0]).toMatchObject({
      id: "langfuse/langfuse",
      title: "langfuse is hiring (README of langfuse/langfuse)",
      company: "langfuse",
      url: "https://github.com/langfuse/langfuse",
      kind: "lead",
      lead_type: "github_repo_hiring",
      repo_stars: 37280,
      posted_date: null,
    });
    expect(data.results).toHaveLength(4);
  });
});

describe("errors", () => {
  test("persistent 5xx -> SEARCH_FAILED JSON on stderr, exit 1, nothing on stdout", async () => {
    instantTimers();
    stub({ searchStatus: 502 });
    const { code, out, err } = await run({});
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(JSON.parse(err)).toEqual({ error: "Request failed: HTTP 502", code: "SEARCH_FAILED" });
  });

  test("422 (bad query) -> BAD_QUERY", async () => {
    stub();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })) as unknown as typeof fetch;
    const { code, err } = await run({});
    expect(code).toBe(1);
    expect(JSON.parse(err)).toEqual({ error: "GitHub API 422: Validation Failed", code: "BAD_QUERY" });
  });

  test("GITHUB_TOKEN is sent as a header and never printed", async () => {
    process.env.GITHUB_TOKEN = "ghp_SECRETTOKEN123";
    stub();
    const { out } = await run({ limit: 2 });
    expect((inits[0].headers as Record<string, string>).Authorization).toBe("Bearer ghp_SECRETTOKEN123");
    expect(urls.join(" ")).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("SECRETTOKEN");
    expect(JSON.parse(out).meta.authenticated).toBe(true);
    // An error message that somehow echoed the token is redacted too.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "bad credentials ghp_SECRETTOKEN123" }), { status: 401 })) as unknown as typeof fetch;
    const r = await run({});
    expect(r.err).not.toContain("SECRETTOKEN");
    expect(r.err).toContain("[redacted]");
  });
});
