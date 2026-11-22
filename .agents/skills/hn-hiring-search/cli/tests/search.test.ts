import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";

// Offline: fetch is stubbed to serve a synthetic thread list and the fixture's
// comments, so these tests pin parsing + filtering + paging without the network.

const fixture = await Bun.file(join(import.meta.dir, "fixtures/thread-comments.json")).text();

const threads = JSON.stringify({
  hits: [
    { objectID: "9000000", title: "Ask HN: Who is hiring? (November 2026)", created_at: "2026-11-02T16:00:00Z" },
    { objectID: "8999999", title: "Ask HN: Who wants to be hired? (November 2026)", created_at: "2026-11-02T16:00:00Z" },
    { objectID: "8999998", title: "Ask HN: Freelancer? Seeking freelancer? (November 2026)", created_at: "2026-11-02T16:00:00Z" },
  ],
  nbPages: 1,
});

const originalFetch = globalThis.fetch;
const originalWrite = process.stdout.write;
let urls: string[] = [];

function stub() {
  urls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("author_whoishiring")) return new Response(threads);
    if (url.includes("story_9000000")) return new Response(fixture);
    if (url.includes("firebaseio.com/v0/item/9000000.json")) {
      return new Response(JSON.stringify({ id: 9000000, type: "story", title: "Ask HN: Who is hiring? (November 2026)", time: 1793635200 }));
    }
    return new Response(JSON.stringify({ hits: [], nbPages: 0 }));
  }) as typeof fetch;
}

async function run(partial: Partial<SearchOpts>): Promise<{ code: number; out: string }> {
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runSearch({
      months: 1,
      remote: false,
      indiaFriendly: false,
      page: 1,
      limit: 25,
      format: "json",
      ...partial,
    });
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalWrite;
});

describe("runSearch (offline)", () => {
  test("returns only top-level job posts with the contract shape", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.meta.count).toBe(7); // 9 hits - 1 reply - 1 "wants to be hired" template
    expect(data.meta.page).toBe(1);
    expect(data.meta.skipped_non_job).toBe(1);
    expect(data.meta.threads).toEqual([{ id: "9000000", title: "Ask HN: Who is hiring? (November 2026)", date: "2026-11-02" }]);
    const ids = data.results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain("9000009");
    expect(ids).not.toContain("9000006");
    for (const r of data.results) {
      for (const k of ["id", "title", "company", "location", "date", "url", "apply_url", "remote", "header"]) {
        expect(k in r).toBe(true);
      }
      expect(r.url).toBe(`https://news.ycombinator.com/item?id=${r.id}`);
    }
    const acme = data.results.find((r: { id: string }) => r.id === "9000001");
    expect(acme).toMatchObject({
      company: "Acme Voice (YC W26)",
      title: "Senior AI Engineer, Voice Agents",
      location: "REMOTE (Worldwide)",
      remote: true,
      india_friendly: true,
      india_reason: "global",
      apply_url: "https://acme.example/jobs",
      date: "2026-11-02",
      thread_id: "9000000",
    });
  });

  test("requests only top-level comments of the chosen thread, with the query", async () => {
    stub();
    await run({ query: "voice agents" });
    const commentUrl = urls.find((u) => u.includes("story_9000000"))!;
    const params = new URL(commentUrl).searchParams;
    expect(new URL(commentUrl).pathname).toBe("/api/v1/search");
    expect(params.get("numericFilters")).toBe("parent_id=9000000");
    expect(params.get("query")).toBe("voice agents");
    expect(params.get("tags")).toBe("comment,story_9000000");
  });

  test("no query uses search_by_date", async () => {
    stub();
    await run({});
    expect(urls.some((u) => u.includes("/search_by_date?tags=comment"))).toBe(true);
  });

  test("--remote keeps only posts whose header mentions remote", async () => {
    stub();
    const data = JSON.parse((await run({ remote: true })).out);
    expect(data.results.map((r: { id: string }) => r.id).sort()).toEqual(["9000001", "9000002", "9000004", "9000005", "9000008"]);
  });

  test("--india-friendly is conservative", async () => {
    stub();
    const data = JSON.parse((await run({ indiaFriendly: true })).out);
    const got = Object.fromEntries(data.results.map((r: { id: string; india_reason: string }) => [r.id, r.india_reason]));
    expect(got).toEqual({
      "9000001": "global", // REMOTE (Worldwide)
      "9000003": "explicit", // Bengaluru, India
      "9000004": "remote-unrestricted", // bare REMOTE, unrestricted body
    });
  });

  test("--location is a case-insensitive header substring", async () => {
    stub();
    const data = JSON.parse((await run({ location: "bengaluru" })).out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual(["9000003"]);
  });

  test("--page/--limit page client-side", async () => {
    stub();
    const p1 = JSON.parse((await run({ limit: 3, page: 1 })).out);
    const p3 = JSON.parse((await run({ limit: 3, page: 3 })).out);
    expect(p1.meta.count).toBe(3);
    expect(p1.meta.total).toBe(7);
    expect(p3.meta.count).toBe(1);
    expect(p3.results[0].id).not.toBe(p1.results[0].id);
  });

  test("--limit 0 emits zero results", async () => {
    stub();
    const data = JSON.parse((await run({ limit: 0 })).out);
    expect(data.results).toHaveLength(0);
  });

  test("--jobage adds a created_at_i filter", async () => {
    stub();
    await run({ jobage: 3 });
    const commentUrl = urls.find((u) => u.includes("story_9000000"))!;
    expect(new URL(commentUrl).searchParams.get("numericFilters")).toMatch(/^parent_id=9000000,created_at_i>\d+$/);
  });

  test("--thread resolves the story via Firebase instead of listing threads", async () => {
    stub();
    const data = JSON.parse((await run({ thread: "9000000" })).out);
    expect(urls.some((u) => u.includes("author_whoishiring"))).toBe(false);
    expect(data.meta.threads[0].id).toBe("9000000");
  });

  test("table format has one row per result", async () => {
    stub();
    const { out } = await run({ format: "table", limit: 2 });
    expect(out.trim().split("\n")).toHaveLength(4);
  });
});
