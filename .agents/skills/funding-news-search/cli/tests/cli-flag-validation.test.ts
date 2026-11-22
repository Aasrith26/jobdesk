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
  test("unknown flag on detail is rejected", () => expectError(["detail", "https://x.example/a", "--days", "2"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG"));
  test("--feeds with a non-http URL", () => expectError(["search", "--feeds", "file:///etc/passwd"], "BAD_ARG"));
  test("--feeds with junk", () => expectError(["search", "--feeds", "https://ok.example/feed,notaurl"], "BAD_ARG"));
  test("--feeds with userinfo", () => expectError(["search", "--feeds", "https://user:pw@x.example/feed"], "BAD_ARG"));
  test("empty --feeds", () => expectError(["search", "--feeds", ""], "BAD_ARG"));
  test("--days out of range", () => expectError(["search", "--days", "0"], "BAD_ARG"));
  test("--days not an integer", () => expectError(["search", "--days", "2.5"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-q", ""], "BAD_ARG"));
  test("--limit too large", () => expectError(["search", "--limit", "501"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "--page", "0"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "fintech"], "BAD_ARG"));
  test("detail without url", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-http url", () => expectError(["detail", "ftp://x.example/a"], "BAD_URL"));
  test("detail with junk", () => expectError(["detail", "not a url"], "BAD_URL"));
  test("detail --max-chars too small", () => expectError(["detail", "https://x.example/a", "--max-chars", "5"], "BAD_ARG"));
  test("detail --format table is not supported", () => expectError(["detail", "https://x.example/a", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage with the default feeds and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("https://entrackr.com/rss");
  });
});
