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
  test("unknown flag on detail is rejected", () => expectError(["detail", "1", "--remote"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG"));
  test("--months out of range", () => expectError(["search", "--months", "0"], "BAD_ARG"));
  test("--months not an integer", () => expectError(["search", "--months", "1.5"], "BAD_ARG"));
  test("--thread not numeric", () => expectError(["search", "--thread", "abc"], "BAD_ARG"));
  test("--thread with --months", () => expectError(["search", "--thread", "1", "--months", "2"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-q", ""], "BAD_ARG"));
  test("bare --query", () => expectError(["search", "-q"], "BAD_ARG"));
  test("bad --jobage", () => expectError(["search", "--jobage", "0"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "--page", "-1"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "llm"], "BAD_ARG"));
  test("detail without id", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-HN URL", () => expectError(["detail", "https://jobs.example.com/item?id=5"], "BAD_ID"));
  test("detail --format table is not supported", () => expectError(["detail", "1", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--india-friendly");
  });
});
