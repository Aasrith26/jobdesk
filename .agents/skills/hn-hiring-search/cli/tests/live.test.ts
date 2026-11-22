import { describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";

// Small live smoke test against the real Algolia + Firebase APIs (3-4 requests).
// Set HN_HIRING_SKIP_LIVE=1 to skip it when offline.

const live = process.env.HN_HIRING_SKIP_LIVE ? describe.skip : describe;

interface SearchOut {
  meta: { count: number; page: number; threads: { id: string; title: string }[] };
  results: { id: string; title: string | null; url: string; header: string }[];
}

live("live smoke", () => {
  let firstId = "";

  test("search returns >=1 job post from the latest hiring thread", async () => {
    const data = parseJSON<SearchOut>(await runCLI(["search", "-q", "engineer", "--limit", "3"]));
    expect(data.meta.threads).toHaveLength(1);
    expect(data.meta.threads[0].title).toMatch(/^Ask HN: Who is hiring\?/);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    for (const r of data.results) {
      expect(r.id).toMatch(/^\d+$/);
      expect(r.url).toBe(`https://news.ycombinator.com/item?id=${r.id}`);
      expect(r.header.length).toBeGreaterThan(0);
    }
    expect(data.results.some((r) => r.title !== null)).toBe(true);
    firstId = data.results[0].id;
  });

  test("detail returns the full comment text", async () => {
    expect(firstId).not.toBe("");
    const job = parseJSON<{ id: string; description: string; top_level: boolean }>(await runCLI(["detail", firstId]));
    expect(job.id).toBe(firstId);
    expect(job.top_level).toBe(true);
    expect(job.description.length).toBeGreaterThan(40);
    expect(job.description).not.toMatch(/<p>|&#x2F;/);
  });
});
