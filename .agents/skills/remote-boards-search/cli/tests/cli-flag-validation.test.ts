import { describe, expect, test } from "bun:test"
import { runCLI } from "./helpers"
import { parseFlags } from "../src/cli"

// Every case here fails validation before any network request is made.

function err(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr)
  } catch {
    return {}
  }
}

async function expectError(args: string[], code: string, msg?: RegExp) {
  const r = await runCLI(args)
  expect(r.exitCode).toBe(1)
  expect(r.stdout).toBe("")
  const e = err(r.stderr)
  expect(e.code).toBe(code)
  if (msg) expect(e.error).toMatch(msg)
}

describe("CLI validation", () => {
  test("unknown flag", () => expectError(["search", "-q", "llm", "--bogus", "x"], "UNKNOWN_FLAG", /--bogus/))
  test("unknown flag on detail", () => expectError(["detail", "remoteok:1", "--india-friendly"], "UNKNOWN_FLAG"))
  test("unknown command", () => expectError(["find"], "BAD_CMD"))
  test("bad --format", () => expectError(["search", "--format", "xml"], "BAD_ARG", /json\|table\|plain/))
  for (const name of ["jobage", "page", "limit", "timeout"]) {
    test(`--${name} must be a whole number >= 1`, async () => {
      await expectError(["search", `--${name}`, "1.5"], "BAD_ARG", new RegExp(name))
      await expectError(["search", `--${name}`, "0"], "BAD_ARG", new RegExp(name))
    })
  }
  test("bare -q", () => expectError(["search", "-q"], "BAD_ARG", /query/))
  test("empty --region", () => expectError(["search", "--region", ""], "BAD_ARG", /region/))
  test("unknown board", () => expectError(["search", "--source", "indeed"], "BAD_ARG", /indeed/))
  test("excluded board explains why", () => expectError(["search", "--source", "remotive"], "EXCLUDED_SOURCE", /robots\.txt/))
  test("--india-friendly takes no value", () => expectError(["search", "--india-friendly=yes"], "BAD_ARG"))
  test("--title-only needs a query", () => expectError(["search", "--title-only"], "BAD_ARG", /query/))
  test("stray positional on search", () => expectError(["search", "llm"], "BAD_ARG", /-q/))
  test("detail without id", () => expectError(["detail"], "NO_ID"))
  test("detail with a non-board URL", () => expectError(["detail", "https://boards.greenhouse.io/x/jobs/1"], "BAD_ID"))
  test("detail on Remotive", () => expectError(["detail", "remotive:123"], "EXCLUDED_SOURCE"))
  test("detail bad format", () => expectError(["detail", "remoteok:1", "--format", "table"], "BAD_ARG"))

  test("--help prints usage and exits 0", async () => {
    const r = await runCLI(["search", "--help"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("--india-friendly")
  })
})

describe("parseFlags", () => {
  test("boolean flags never swallow the next token", () => {
    const f = parseFlags(["search", "--india-friendly", "-q", "llm", "--title-only", "-n", "5"])
    expect(f).toEqual({ _: ["search"], "india-friendly": true, query: "llm", "title-only": true, limit: "5" })
  })
  test("--flag=value form", () => {
    expect(parseFlags(["search", "--source=himalayas,wwr"]).source).toBe("himalayas,wwr")
  })
})
