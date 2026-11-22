import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Every case here fails validation before any request (or robots check) is made, so the suite is offline.

async function expectError(args: string[], code: string) {
  const r = await runCLI(args);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe("");
  const err = JSON.parse(r.stderr);
  expect(err.code).toBe(code);
  expect(typeof err.error).toBe("string");
}

describe("CLI validation", () => {
  test("unknown flag is rejected", () => expectError(["search", "--bogus", "x"], "UNKNOWN_FLAG"));
  test("unknown flag on detail is rejected", () => expectError(["detail", "1ofh001", "--remote"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-q", ""], "BAD_ARG"));
  test("bare --query", () => expectError(["search", "-q"], "BAD_ARG"));
  test("bare --subreddits", () => expectError(["search", "--subreddits"], "BAD_ARG"));
  test("invalid subreddit name", () => expectError(["search", "-s", "forhire,not a sub!"], "BAD_ARG"));
  test("--per-sub out of range", () => expectError(["search", "--per-sub", "101"], "BAD_ARG"));
  test("--per-sub not an integer", () => expectError(["search", "--per-sub", "2.5"], "BAD_ARG"));
  test("bad --jobage", () => expectError(["search", "--jobage", "0"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "--page", "-1"], "BAD_ARG"));
  test("--limit out of range", () => expectError(["search", "--limit", "5000"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "python"], "BAD_ARG"));
  test("detail without id", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-Reddit URL", () => expectError(["detail", "https://jobs.example.com/r/forhire/comments/abc123/x/"], "BAD_ID"));
  test("detail with a look-alike host", () => expectError(["detail", "https://reddit.com.evil.example/r/forhire/comments/abc123/x/"], "BAD_ID"));
  test("detail with a subreddit URL instead of a post", () => expectError(["detail", "https://www.reddit.com/r/forhire/"], "BAD_ID"));
  test("detail --format table is not supported", () => expectError(["detail", "1ofh001", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--include-for-hire");
    expect(r.stdout).toContain("forhire,developersIndia,MachineLearningJobs,remotejs,jobbit,PythonJobs");
  });
});
