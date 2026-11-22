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
  test("unknown flag on detail is rejected", () => expectError(["detail", "a/b#1", "--days", "3"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG"));
  test("bad --mode", () => expectError(["search", "--mode", "users"], "BAD_ARG"));
  test("--days out of range", () => expectError(["search", "--days", "0"], "BAD_ARG"));
  test("--days too large", () => expectError(["search", "--days", "400"], "BAD_ARG"));
  test("--days not an integer", () => expectError(["search", "--days", "1.5"], "BAD_ARG"));
  test("--min-stars negative", () => expectError(["search", "--min-stars", "-3"], "BAD_ARG"));
  test("--no-stars with --min-stars", () => expectError(["search", "--no-stars", "--min-stars", "5"], "BAD_ARG"));
  test("--no-stars in repos mode", () => expectError(["search", "--mode", "repos", "--no-stars"], "BAD_ARG"));
  test("bad --language", () => expectError(["search", "--language", "py;rm"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-q", ""], "BAD_ARG"));
  test("bare --query", () => expectError(["search", "-q"], "BAD_ARG"));
  test("--limit over 100", () => expectError(["search", "--limit", "101"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "--page", "0"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "python"], "BAD_ARG"));
  test("detail without target", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-GitHub URL", () => expectError(["detail", "https://gitlab.com/a/b/-/issues/1"], "BAD_URL"));
  test("detail with a look-alike host", () => expectError(["detail", "https://github.com.evil.io/a/b/issues/1"], "BAD_URL"));
  test("detail --format table is not supported", () => expectError(["detail", "a/b#1", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--mode issues|repos");
  });
});
