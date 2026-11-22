import { describe, test, expect } from "bun:test";
import { fixture, parseJSON, parsedStderr, runCLI, runCLIWithFixture } from "./helpers";

const SEARCH = fixture("search.html");
const DETAIL = fixture("detail.html");

type SearchOut = {
  meta: Record<string, unknown> & { count: number; page: number };
  results: Array<Record<string, unknown>>;
};

describe("flag validation (offline, no network)", () => {
  const cases: Array<[string, string[], string]> = [
    ["unknown long flag", ["search", "-q", "python", "--bogus", "1"], "UNKNOWN_FLAG"],
    ["unknown short flag", ["search", "-q", "python", "-x", "1"], "UNKNOWN_FLAG"],
    ["negative number", ["search", "-q", "python", "--page", "-1"], "UNKNOWN_FLAG"],
    ["no query or location", ["search", "--limit", "3"], "MISSING_REQUIRED"],
    ["empty query", ["search", "-q", ""], "BAD_ARG"],
    ["bare --jobage", ["search", "-q", "python", "--jobage"], "BAD_ARG"],
    ["fractional page", ["search", "-q", "python", "--page", "1.5"], "BAD_ARG"],
    ["zero limit", ["search", "-q", "python", "--limit", "0"], "BAD_ARG"],
    ["non-numeric jobage", ["search", "-q", "python", "--jobage", "week"], "BAD_ARG"],
    ["bad format", ["search", "-q", "python", "--format", "xml"], "BAD_ARG"],
    ["bad sort", ["search", "-q", "python", "--sort", "salary"], "BAD_ARG"],
    ["stray positional", ["search", "python"], "BAD_ARG"],
    ["detail without id", ["detail"], "NO_ID"],
    ["detail foreign url", ["detail", "https://example.com/jobs/a/b/20011124"], "BAD_ID"],
    ["detail table format", ["detail", "20011124", "--format", "table"], "BAD_ARG"],
    ["detail unknown flag", ["detail", "20011124", "--jobage", "3"], "UNKNOWN_FLAG"],
    ["unknown command", ["apply", "-q", "x"], "BAD_CMD"],
  ];
  for (const [name, args, code] of cases) {
    test(`${name} -> exit 1, ${code} on stderr, nothing on stdout`, async () => {
      const r = await runCLI(args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(parsedStderr(r.stderr).code).toBe(code);
    });
  }

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/USAGE/);
  });
});

describe("search against a saved page", () => {
  test("JSON shape, nulls kept, request URL built from flags", async () => {
    const { result, requests } = await runCLIWithFixture(
      ["search", "-q", "machine learning engineer", "-l", "Hyderabad, Telangana", "--page", "2", "--sort", "date"],
      { body: SEARCH },
    );
    const out = parseJSON<SearchOut>(result);
    expect(requests).toEqual(["https://www.shine.com/job-search/machine-learning-engineer-jobs-in-hyderabad-2?sort=1"]);
    expect(out.meta.count).toBe(3);
    expect(out.meta.page).toBe(2);
    expect(out.meta.total).toBe(3465);
    for (const r of out.results) {
      for (const k of ["id", "title", "company", "location", "date", "url"]) expect(k in r).toBe(true);
    }
    // The card with a bad postedAt keeps date as an explicit null.
    expect(out.results[2].date).toBeNull();
  });

  test("invisible characters are stripped at the output boundary", async () => {
    const { result } = await runCLIWithFixture(["search", "-q", "ai engineer"], { body: SEARCH });
    const out = parseJSON<SearchOut>(result);
    expect(out.results[2].title).toBe("AI Engineer (LLM)");
    expect(result.stdout).not.toMatch(/​|IGNORE PREVIOUS|SECRET/);
  });

  test("--limit caps results", async () => {
    const { result } = await runCLIWithFixture(["search", "-q", "ai engineer", "--limit", "1"], { body: SEARCH });
    expect(parseJSON<SearchOut>(result).results).toHaveLength(1);
  });

  test("--jobage filters client-side and keeps relevance sort", async () => {
    const recent = await runCLIWithFixture(["search", "-q", "ai engineer", "--jobage", "1"], { body: SEARCH });
    const r1 = parseJSON<SearchOut>(recent.result);
    expect(r1.meta.count).toBe(0); // fixture postings are from Oct 2026
    expect(recent.requests[0]).not.toContain("sort=1");
    const all = await runCLIWithFixture(["search", "-q", "ai engineer", "--jobage", "100000"], { body: SEARCH });
    expect(parseJSON<SearchOut>(all.result).meta.count).toBe(3);
  });

  test("a 404 search page (Shine's answer to an unknown keyword) is an empty result", async () => {
    const { result } = await runCLIWithFixture(["search", "-q", "qzxqzxnonsense"], { status: 404 });
    const out = parseJSON<SearchOut>(result);
    expect(out.meta.count).toBe(0);
    expect(out.results).toEqual([]);
  });

  test("table and plain formats", async () => {
    const table = await runCLIWithFixture(["search", "-q", "ml", "--format", "table"], { body: SEARCH });
    expect(table.result.exitCode).toBe(0);
    expect(table.result.stdout).toMatch(/^ID\s+TITLE\s+COMPANY/);
    expect(table.result.stdout).toContain("19932727");
    const plain = await runCLIWithFixture(["search", "-q", "ml", "--format", "plain"], { body: SEARCH });
    expect(plain.result.stdout).toContain("https://www.shine.com/jobs/machine-learning-engineer/careerguide/19932727");
  });
});

describe("detail against a saved page", () => {
  test("by id: JSON with description, placeholder-slug request", async () => {
    const { result, requests } = await runCLIWithFixture(["detail", "19932727"], { body: DETAIL });
    const job = parseJSON<Record<string, unknown>>(result);
    expect(requests).toEqual(["https://www.shine.com/jobs/job/company/19932727"]);
    expect(job.title).toBe("Machine Learning Engineer");
    expect(job.company).toBe("CAREERGUIDE");
    expect(String(job.description)).toMatch(/Key Responsibilities:/);
    expect(String(job.description)).not.toMatch(/Ignore all prior/);
  });

  test("by URL: query string dropped, plain format readable", async () => {
    const { result, requests } = await runCLIWithFixture(
      ["detail", "https://www.shine.com/jobs/machine-learning-engineer/careerguide/19932727?jobtype=rs&position_in_results=12", "--format", "plain"],
      { body: DETAIL },
    );
    expect(requests).toEqual(["https://www.shine.com/jobs/machine-learning-engineer/careerguide/19932727"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Machine Learning Engineer\nCAREERGUIDE · Bangalore/);
    expect(result.stdout).toMatch(/URL: https:\/\/www\.shine\.com\/jobs\//);
  });

  test("404 -> NOT_FOUND on stderr, exit 1", async () => {
    const { result } = await runCLIWithFixture(["detail", "10000001"], { status: 404 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(parsedStderr(result.stderr).code).toBe("NOT_FOUND");
  });
});
