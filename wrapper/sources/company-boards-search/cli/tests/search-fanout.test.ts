import { afterEach, describe, expect, test } from "bun:test";
import { runSearch, type SearchOpts } from "../src/commands/search";
import type { Company } from "../src/helpers";
import { capture, fixtureCompanies, restoreFetch, stubFetch } from "./stub";

const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  restoreFetch();
  globalThis.setTimeout = originalSetTimeout;
});

function opts(over: Partial<SearchOpts> = {}): SearchOpts {
  return { companies: fixtureCompanies(), page: 1, limit: 50, format: "json", ...over };
}

describe("search fan-out (offline)", () => {
  test("reads every board once and emits the contract shape with nulls kept", async () => {
    const log = stubFetch();
    const { code, stdout, stderr } = await capture(() => runSearch(opts()));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(log.urls).toHaveLength(5);
    const out = JSON.parse(stdout);
    expect(out.meta).toMatchObject({ count: 8, page: 1, limit: 50, total: 8, companies: 5, errors: [] });
    for (const r of out.results) {
      for (const k of ["id", "title", "company", "location", "date", "url", "ats", "department", "remote"]) {
        expect(k in r).toBe(true);
      }
      expect(r.description).toBeUndefined();
    }
    // Newest first.
    const dates = out.results.map((r: { date: string | null }) => r.date ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test("one failing board is reported in meta.errors and as a stderr warning; the run still succeeds", async () => {
    globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    stubFetch({
      "https://api.lever.co/v0/postings/examplelever?mode=json": () => new Response("", { status: 503 }),
    });
    const companies: Company[] = [...fixtureCompanies(), { name: "Gone", ats: "ashby", token: "gone", tags: [] }];
    const { code, stdout, stderr } = await capture(() => runSearch(opts({ companies })));
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.meta.errors.map((e: { company: string }) => e.company).sort()).toEqual(["Example Lever", "Gone"]);
    expect(out.meta.errors.find((e: { company: string }) => e.company === "Gone").error).toMatch(/404/);
    expect(out.results.some((r: { ats: string }) => r.ats === "lever")).toBe(false);
    expect(JSON.parse(stderr.trim()).code).toBe("PARTIAL_RESULTS");
  });

  test("every board failing exits 1 with a JSON error on stderr and nothing on stdout", async () => {
    stubFetch();
    const { code, stdout, stderr } = await capture(() =>
      runSearch(opts({ companies: [{ name: "Gone", ats: "greenhouse", token: "gone", tags: [] }] })),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr.trim()).code).toBe("ALL_BOARDS_FAILED");
  });

  test("concurrency stays bounded at 6", async () => {
    const many: Company[] = Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, ats: "ashby", token: `c${i}`, tags: [] }));
    const overrides = Object.fromEntries(
      many.map((c) => [`https://api.ashbyhq.com/posting-api/job-board/${c.token}?includeCompensation=true`, () => new Response('{"jobs":[]}')]),
    );
    const log = stubFetch(overrides, 5);
    const { code } = await capture(() => runSearch(opts({ companies: many })));
    expect(code).toBe(0);
    expect(log.urls).toHaveLength(20);
    expect(log.maxInFlight).toBeLessThanOrEqual(6);
    expect(log.maxInFlight).toBeGreaterThan(1);
  });

  test("filters, paging and --with-description", async () => {
    stubFetch();
    const p1 = JSON.parse((await capture(() => runSearch(opts({ location: "India", limit: 2 })))).stdout);
    expect(p1.meta).toMatchObject({ count: 2, page: 1, total: 4 });
    const p2 = JSON.parse((await capture(() => runSearch(opts({ location: "India", limit: 2, page: 2 })))).stdout);
    expect(p2.meta.count).toBe(2);
    const ids = [...p1.results, ...p2.results].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(4);

    const voice = JSON.parse(
      (await capture(() => runSearch(opts({ query: "webrtc", inDescription: true, withDescription: true })))).stdout,
    );
    expect(voice.results.map((r: { title: string }) => r.title).sort()).toEqual(["AI Agent Engineer", "Voice AI Engineer"]);
    expect(voice.results[0].description).toContain("WebRTC");
  });

  test("table and plain formats render rows", async () => {
    stubFetch();
    const table = await capture(() => runSearch(opts({ query: "inference", format: "table" })));
    expect(table.stdout).toContain("Inference Engineer");
    expect(table.stdout).toContain("ashby:exampleashby:11111111-aaaa-bbbb-cccc-000000000001");
    const plain = await capture(() => runSearch(opts({ query: "nomatchxyz", format: "plain" })));
    expect(plain.stdout.trim()).toBe("No results.");
  });
});
