import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, utimesSync } from "fs";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { normalizeBatch } from "../src/helpers";
import { capture, freshCacheDir, instantTimers, restoreTimers } from "./helpers";

// Offline: fetch is stubbed to serve the recorded (trimmed) yc-oss responses.

const fx = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const HIRING = await fx("hiring.json");
const ALL = await fx("all.json");
const META = await fx("meta.json");

const originalFetch = globalThis.fetch;
let urls: string[] = [];
let cacheDir = "";

function stub(status = 200) {
  urls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (status !== 200) return new Response("", { status });
    if (url.endsWith("/companies/hiring.json")) return new Response(HIRING);
    if (url.endsWith("/companies/all.json")) return new Response(ALL);
    if (url.endsWith("/meta.json")) return new Response(META);
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

async function run(partial: Partial<SearchOpts>) {
  return capture(() => runSearch({ remote: false, refresh: false, page: 1, limit: 25, format: "json", ...partial }));
}

const ids = (out: string) => JSON.parse(out).results.map((r: { id: string }) => r.id);

beforeEach(() => {
  cacheDir = freshCacheDir();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreTimers();
});

describe("runSearch (offline)", () => {
  test("all hiring companies, newest batch first, contract fields present", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual([
      "conus", "hillstar", "pgdog", "claimsorted", "governgpt", "taktile", "zuddl", "razorpay", "circuithub", "y-combinator",
    ]);
    expect(data.meta.data_last_updated).toBe("2026-11-11T03:51:00.560Z");
    expect(data.meta.cache).toBe("fresh");
    for (const r of data.results) {
      for (const k of ["id", "title", "company", "location", "date", "posted_date", "url", "kind", "lead_type", "batch"]) expect(k in r).toBe(true);
      expect(r.title).toBe(`${r.company} is hiring`);
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.kind).toBe("lead");
      expect(r.lead_type).toBe("yc_hiring");
    }
  });

  test("-q matches name / one-liner / tags / industries", async () => {
    stub();
    expect(ids((await run({ query: "fintech" })).out)).toEqual(["claimsorted", "governgpt", "taktile", "razorpay", "y-combinator"]);
    expect(ids((await run({ query: "databases" })).out)).toEqual(["pgdog"]);
  });

  test("--batch (one or several, year allowed)", async () => {
    stub();
    expect(ids((await run({ batches: [normalizeBatch("F26")!] })).out)).toEqual(["conus", "hillstar"]);
    expect(ids((await run({ batches: [normalizeBatch("X25")!, normalizeBatch("W24")!] })).out)).toEqual(["pgdog", "governgpt"]);
    expect(ids((await run({ batches: [normalizeBatch("2020")!] })).out)).toEqual(["taktile", "zuddl"]);
  });

  test("--location and --remote", async () => {
    stub();
    expect(ids((await run({ location: "India" })).out)).toEqual(["zuddl", "razorpay"]);
    expect(ids((await run({ location: "germany", remote: true })).out)).toEqual(["taktile"]);
    expect(ids((await run({ remote: true, query: "fintech" })).out)).toEqual(["claimsorted", "taktile", "razorpay", "y-combinator"]);
  });

  test("paging and table", async () => {
    stub();
    const p = JSON.parse((await run({ limit: 4, page: 3 })).out);
    expect(p.meta.count).toBe(2);
    expect(p.meta.total).toBe(10);
    const { out } = await run({ limit: 3, format: "table" });
    expect(out.trim().split("\n")).toHaveLength(5);
  });
});

describe("24 h cache", () => {
  test("second run reads the cache: no download", async () => {
    stub();
    await run({});
    expect(urls.some((u) => u.endsWith("/companies/hiring.json"))).toBe(true);
    expect(readdirSync(cacheDir).sort()).toEqual(["companies_hiring.json", "meta.json"]);
    stub();
    const data = JSON.parse((await run({})).out);
    expect(urls).toEqual([]);
    expect(data.meta.cache).toBe("cache");
  });

  test("--refresh re-downloads", async () => {
    stub();
    await run({});
    stub();
    await run({ refresh: true });
    expect(urls.some((u) => u.endsWith("/companies/hiring.json"))).toBe(true);
  });

  test("an expired cache is re-downloaded", async () => {
    stub();
    await run({});
    const old = (Date.now() - 25 * 3600 * 1000) / 1000;
    for (const f of readdirSync(cacheDir)) utimesSync(join(cacheDir, f), old, old);
    stub();
    await run({});
    expect(urls.some((u) => u.endsWith("/companies/hiring.json"))).toBe(true);
  });

  test("download failing with an expired cache present serves it as stale", async () => {
    stub();
    await run({});
    const old = (Date.now() - 25 * 3600 * 1000) / 1000;
    for (const f of readdirSync(cacheDir)) utimesSync(join(cacheDir, f), old, old);
    instantTimers();
    stub(503);
    const { code, out } = await run({});
    expect(code).toBe(0);
    expect(JSON.parse(out).meta.cache).toBe("stale");
  });
});

describe("errors", () => {
  test("persistent 5xx and no cache -> SEARCH_FAILED JSON on stderr, exit 1", async () => {
    instantTimers();
    stub(503);
    const { code, out, err } = await run({});
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(JSON.parse(err)).toEqual({ error: "Request failed: HTTP 503", code: "SEARCH_FAILED" });
  });

  test("a 404 says the API moved", async () => {
    stub(404);
    const { code, err } = await run({});
    expect(code).toBe(1);
    expect(JSON.parse(err).code).toBe("NOT_FOUND");
  });
});

describe("runDetail (offline)", () => {
  test("a hiring company from the hiring list, by URL", async () => {
    stub();
    const { code, out } = await capture(() => runDetail({ id: "https://www.ycombinator.com/companies/taktile", format: "json", refresh: false }));
    expect(code).toBe(0);
    const d = JSON.parse(out);
    expect(d).toMatchObject({ id: "taktile", company: "Taktile", is_hiring: true, batch: "Summer 2020", source: "https://yc-oss.github.io/api/companies/hiring.json" });
    expect(d.description.length).toBeGreaterThan(40);
    expect(urls.some((u) => u.endsWith("/all.json"))).toBe(false);
  });

  test("a non-hiring company falls back to all.json", async () => {
    stub();
    const { code, out } = await capture(() => runDetail({ id: "hireart", format: "json", refresh: false }));
    expect(code).toBe(0);
    const d = JSON.parse(out);
    expect(d.is_hiring).toBe(false);
    expect(d.source).toBe("https://yc-oss.github.io/api/companies/all.json");
  });

  test("plain format", async () => {
    stub();
    const { out } = await capture(() => runDetail({ id: "razorpay", format: "plain", refresh: false }));
    expect(out).toStartWith("Razorpay (YC W15)");
    expect(out).toContain("Jobs: https://www.ycombinator.com/companies/razorpay/jobs");
  });

  test("unknown slug -> NOT_FOUND", async () => {
    stub();
    const { code, err } = await capture(() => runDetail({ id: "no-such-company-xyz", format: "json", refresh: false }));
    expect(code).toBe(1);
    expect(JSON.parse(err).code).toBe("NOT_FOUND");
  });
});
