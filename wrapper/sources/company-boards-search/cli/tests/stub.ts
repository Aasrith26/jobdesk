// Offline test plumbing: a fetch stub that serves the fixture boards by URL,
// plus stdout/stderr capture for in-process command runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCompanies, type Company } from "../src/helpers";
import type { CLIResult } from "./helpers";

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export function fixtureCompanies(): Company[] {
  return parseCompanies(JSON.parse(fixture("companies.json")));
}

/** Board list URL -> fixture file, matching the boards in fixtures/companies.json. */
const ROUTES: Array<[RegExp, string]> = [
  [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/examplevoice\/jobs\?content=true$/, "greenhouse.json"],
  [/^https:\/\/api\.lever\.co\/v0\/postings\/examplelever\?mode=json$/, "lever.json"],
  [/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/exampleashby\?includeCompensation=true$/, "ashby.json"],
  [/^https:\/\/api\.smartrecruiters\.com\/v1\/companies\/ExampleSR\/postings\?limit=100&offset=0$/, "smartrecruiters.json"],
  [/^https:\/\/apply\.workable\.com\/api\/v1\/widget\/accounts\/exampleworkable\?details=true$/, "workable.json"],
];

export interface FetchLog {
  urls: string[];
  inits: Array<RequestInit | undefined>;
  maxInFlight: number;
}

const originalFetch = globalThis.fetch;

/**
 * Replace fetch: fixture routes answer 200, `overrides` (exact URL -> response
 * factory) win over routes, anything else is a 404. Returns a call log.
 */
export function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}, delayMs = 0): FetchLog {
  const log: FetchLog = { urls: [], inits: [], maxInFlight: 0 };
  let inFlight = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    log.urls.push(url);
    log.inits.push(init);
    inFlight++;
    log.maxInFlight = Math.max(log.maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (overrides[url]) return await overrides[url]();
      const route = ROUTES.find(([re]) => re.test(url));
      if (route) return new Response(fixture(route[1]), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("Not Found", { status: 404 });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return log;
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Run fn with stdout/stderr captured. */
export async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = process.stdout.write;
  const err = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += c.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += c.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const CLI_PATH = join(import.meta.dir, "../src/cli.ts");

/**
 * runCLI (tests/helpers.ts) with an explicit environment. Bun.spawn does not
 * pick up process.env assignments made inside a test, so a companies-file
 * override must be passed here.
 */
export async function runCLIEnv(args: string[], env: Record<string, string | undefined>): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
