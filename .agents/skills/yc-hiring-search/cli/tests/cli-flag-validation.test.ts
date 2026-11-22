import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Every case here fails validation before any request is made, so the suite is offline.

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
  test("unknown flag on detail is rejected", () => expectError(["detail", "circuithub", "--remote"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG"));
  test("bad --batch", () => expectError(["search", "--batch", "Q24"], "BAD_ARG"));
  test("one bad --batch in a list", () => expectError(["search", "--batch", "W24,nope"], "BAD_ARG"));
  test("bare --batch", () => expectError(["search", "--batch"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-q", ""], "BAD_ARG"));
  test("empty --location", () => expectError(["search", "-l", " "], "BAD_ARG"));
  test("--limit too large", () => expectError(["search", "--limit", "501"], "BAD_ARG"));
  test("--limit not an integer", () => expectError(["search", "--limit", "2.5"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "--page", "0"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "fintech"], "BAD_ARG"));
  test("detail without id", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-YC URL", () => expectError(["detail", "https://example.com/companies/foo"], "BAD_ID"));
  test("detail with a look-alike host", () => expectError(["detail", "https://www.ycombinator.com.evil.io/companies/foo"], "BAD_ID"));
  test("detail --format table is not supported", () => expectError(["detail", "circuithub", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--batch");
  });
});
