import { describe, expect, test } from "bun:test";
import { parseJSON } from "./helpers";
import { runCLIEnv } from "./stub";

// Live smoke test against the real boards in ../../companies.json: ONE fan-out
// (the india-tagged companies) plus one detail on its first hit. Skip it with
// COMPANY_BOARDS_SKIP_LIVE=1 when offline.

const skip = process.env.COMPANY_BOARDS_SKIP_LIVE === "1";

interface Result {
  id: string | null;
  title: string | null;
  company: string | null;
  url: string | null;
  ats: string;
}

describe.skipIf(skip)("live smoke test", () => {
  test(
    "search -q engineer -l India --tag india returns real results, and detail reads the first",
    async () => {
      // The shipped companies.json, whatever the caller's environment says.
      const env = { ...process.env, COMPANY_BOARDS_FILE: undefined };
      const runCLI = (args: string[]) => runCLIEnv(args, env);
      {
        const out = parseJSON<{ meta: { count: number; total: number; errors: unknown[] }; results: Result[] }>(
          await runCLI(["search", "-q", "engineer", "-l", "India", "--tag", "india", "--limit", "5"]),
        );
        expect(out.meta.count).toBeGreaterThanOrEqual(1);
        for (const r of out.results) {
          expect(r.id).toBeTruthy();
          expect(r.title).toBeTruthy();
          expect(r.url).toBeTruthy();
          expect(r.company).toBeTruthy();
        }
        const first = out.results[0];
        const detail = parseJSON<{ id: string; title: string; description: string | null }>(
          await runCLI(["detail", first.id!]),
        );
        expect(detail.id).toBe(first.id!);
        expect(detail.title).toBe(first.title!);
        expect((detail.description ?? "").length).toBeGreaterThan(100);
      }
    },
    120000,
  );
});
