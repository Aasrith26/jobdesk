import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCLI } from "./helpers";

// Every case here fails validation before any request is made, so the suite is offline.
// TELEGRAM_CHANNELS_CONFIG points at a temp file so the user's own config is never read.

const dir = mkdtempSync(join(tmpdir(), "tg-cli-test-"));
const missing = join(dir, "missing.json");
const malformed = join(dir, "malformed.json");
const emptyList = join(dir, "empty.json");
writeFileSync(malformed, JSON.stringify({ telegram_channels: "not-an-array" }));
writeFileSync(emptyList, JSON.stringify({ telegram_channels: [] }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function expectError(args: string[], code: string, env: Record<string, string> = { TELEGRAM_CHANNELS_CONFIG: missing }) {
  const r = await runCLI(args, env);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe("");
  const err = JSON.parse(r.stderr);
  expect(err.code).toBe(code);
  expect(typeof err.error).toBe("string");
}

describe("CLI validation", () => {
  test("unknown flag is rejected", () => expectError(["search", "-c", "somechannel", "--bogus", "x"], "UNKNOWN_FLAG"));
  test("unknown flag on detail is rejected", () => expectError(["detail", "somechannel/1", "--remote"], "UNKNOWN_FLAG"));
  test("bad --format", () => expectError(["search", "-c", "somechannel", "--format", "xml"], "BAD_ARG"));
  test("empty --query", () => expectError(["search", "-c", "somechannel", "-q", ""], "BAD_ARG"));
  test("bare --channels", () => expectError(["search", "--channels"], "BAD_ARG"));
  test("invalid channel name", () => expectError(["search", "-c", "ok_channel,bad name!"], "BAD_ARG"));
  test("too-short channel name", () => expectError(["search", "-c", "abc"], "BAD_ARG"));
  test("bad --jobage", () => expectError(["search", "-c", "somechannel", "--jobage", "0"], "BAD_ARG"));
  test("bad --page", () => expectError(["search", "-c", "somechannel", "--page", "-1"], "BAD_ARG"));
  test("--limit out of range", () => expectError(["search", "-c", "somechannel", "--limit", "5000"], "BAD_ARG"));
  test("stray positional on search", () => expectError(["search", "python"], "BAD_ARG"));
  test("no channels and no config file", () => expectError(["search", "-q", "python"], "NO_CHANNELS"));
  test("config with an empty channel list", () => expectError(["search"], "NO_CHANNELS", { TELEGRAM_CHANNELS_CONFIG: emptyList }));
  test("malformed telegram_channels in config", () => expectError(["search"], "BAD_CONFIG", { TELEGRAM_CHANNELS_CONFIG: malformed }));
  test("detail without id", () => expectError(["detail"], "NO_ID"));
  test("detail with a non-Telegram URL", () => expectError(["detail", "https://jobs.example.com/somechannel/5"], "BAD_ID"));
  test("detail with a look-alike host", () => expectError(["detail", "https://t.me.evil.example/somechannel/5"], "BAD_ID"));
  test("detail with a private t.me/c link", () => expectError(["detail", "https://t.me/c/123456/7"], "BAD_ID"));
  test("detail --format table is not supported", () => expectError(["detail", "somechannel/1", "--format", "table"], "BAD_ARG"));
  test("unknown command", () => expectError(["frobnicate"], "BAD_CMD"));

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--channels");
  });
});
