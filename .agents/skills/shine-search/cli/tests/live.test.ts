// Small live smoke test against shine.com: one search, one detail. Keep it
// that way - two requests per run. Set SKIP_LIVE_TESTS=1 to run offline only.
import { describe, test, expect } from "bun:test";
import { parseJSON, runCLI } from "./helpers";

const skip = process.env.SKIP_LIVE_TESTS === "1";

describe.skipIf(skip)("live smoke test", () => {
  test("search returns real cards, and detail reads one of them", async () => {
    const r = await runCLI(["search", "-q", "machine learning engineer", "-l", "Hyderabad", "--limit", "3"]);
    const out = parseJSON<{ meta: { count: number }; results: Array<{ id: string | null; title: string | null; url: string | null }> }>(r);
    expect(out.meta.count).toBeGreaterThanOrEqual(1);
    for (const job of out.results) {
      expect(job.id).toMatch(/^\d+$/);
      expect(job.title).toBeTruthy();
      expect(job.url).toMatch(/^https:\/\/www\.shine\.com\/jobs\/[^/]+\/[^/]+\/\d+$/);
    }

    const d = await runCLI(["detail", out.results[0].id!]);
    const job = parseJSON<{ id: string; title: string; description: string | null }>(d);
    expect(job.id).toBe(out.results[0].id!);
    expect(job.title).not.toBe("(untitled)");
    expect((job.description ?? "").length).toBeGreaterThan(50);
  });
});
