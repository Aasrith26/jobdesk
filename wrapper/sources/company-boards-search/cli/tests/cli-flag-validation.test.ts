import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "../src/cli";
import { parseJSON } from "./helpers";
import { FIXTURES, runCLIEnv } from "./stub";

// Every case here fails before any network request (or never makes one), so
// the suite is offline. The CLI is pointed at the fixture companies list.

const FIXTURE_LIST = join(FIXTURES, "companies.json");
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "company-boards-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCLI(args: string[], file = FIXTURE_LIST) {
  return runCLIEnv(args, { ...process.env, COMPANY_BOARDS_FILE: file });
}

async function expectError(args: string[], code: string, message?: RegExp, file?: string) {
  const r = await runCLI(args, file);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe("");
  const err = JSON.parse(r.stderr);
  expect(err.code).toBe(code);
  if (message) expect(err.error).toMatch(message);
}

describe("parseFlags", () => {
  test("aliases, --flag=value, and boolean flags that never swallow the next word", () => {
    const f = parseFlags(["search", "-q", "voice", "-l=India", "--remote", "-n", "5", "--in-description"]);
    expect(f).toMatchObject({ _: ["search"], query: "voice", location: "India", remote: true, limit: "5", "in-description": true });
    expect(parseFlags(["search", "--remote", "yes"])._).toEqual(["search", "yes"]);
  });
});

describe("CLI validation (offline)", () => {
  test("unknown flags are rejected, never ignored", async () => {
    await expectError(["search", "--bogus", "1"], "UNKNOWN_FLAG", /--bogus/);
    await expectError(["detail", "ashby:a:b", "--location", "x"], "UNKNOWN_FLAG");
    await expectError(["companies", "--query", "x"], "UNKNOWN_FLAG");
  });

  test("bad values exit 1 with BAD_ARG", async () => {
    await expectError(["search", "--format", "xml"], "BAD_ARG", /json\|table\|plain/);
    await expectError(["search", "--jobage", "0.5"], "BAD_ARG", /whole number/);
    await expectError(["search", "--page", "0"], "BAD_ARG");
    await expectError(["search", "--limit", "ten"], "BAD_ARG");
    await expectError(["search", "--timeout"], "BAD_ARG");
    await expectError(["search", "-q"], "BAD_ARG", /non-empty/);
    await expectError(["search", "-q", "  "], "BAD_ARG");
    await expectError(["search", "-l"], "BAD_ARG");
    await expectError(["search", "--remote=yes"], "BAD_ARG", /takes no value/);
    await expectError(["search", "--remote", "remote"], "BAD_ARG", /unexpected argument/);
    await expectError(["search", "--ats", "bamboohr"], "BAD_ARG", /greenhouse/);
    await expectError(["search", "--in-description"], "BAD_ARG", /needs --query/);
    await expectError(["search", "--with-description", "--format", "table"], "BAD_ARG");
    await expectError(["detail", "ashby:a:b", "--format", "table"], "BAD_ARG");
  });

  test("selectors that match no configured company exit 1 with NO_COMPANIES", async () => {
    await expectError(["search", "--company", "nosuchco"], "NO_COMPANIES");
    await expectError(["search", "--tag", "nosuchtag"], "NO_COMPANIES");
  });

  test("detail needs a parseable id or ATS URL", async () => {
    await expectError(["detail"], "NO_ID");
    await expectError(["detail", "https://example.com/jobs/1"], "BAD_ID");
    await expectError(["detail", "https://www.observe.ai/position?gh_jid=1"], "BAD_ID");
  });

  test("unknown command is BAD_CMD; no command prints help and exits 1", async () => {
    await expectError(["frob"], "BAD_CMD");
    const r = await runCLI([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("USAGE");
    const help = await runCLI(["search", "--help"]);
    expect(help.exitCode).toBe(0);
  });

  test("an invalid companies file is CONFIG_ERROR", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ companies: [{ name: "X", ats: "bamboo", token: "x" }] }));
    await expectError(["companies"], "CONFIG_ERROR", /ats must be one of/, bad);
    writeFileSync(bad, JSON.stringify({ companies: [{ name: "X", ats: "lever", token: "../x" }] }));
    await expectError(["companies"], "CONFIG_ERROR", /board slug/, bad);
    writeFileSync(bad, "{not json");
    await expectError(["companies"], "CONFIG_ERROR", /not valid JSON/, bad);
    await expectError(["search"], "CONFIG_ERROR", /cannot read/, join(dir, "missing.json"));
  });

  test("companies lists the configured boards (no network without --check)", async () => {
    const out = parseJSON<{ meta: { count: number }; results: Array<{ name: string; boardUrl: string }> }>(
      await runCLI(["companies", "--tag", "voice"]),
    );
    expect(out.meta.count).toBe(2);
    expect(out.results.map((r) => r.boardUrl)).toEqual([
      "https://job-boards.greenhouse.io/examplevoice",
      "https://apply.workable.com/exampleworkable/",
    ]);
    const table = await runCLI(["companies", "--format", "table"]);
    expect(table.exitCode).toBe(0);
    expect(table.stdout).toContain("Example SR");
  });
});
