import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { CliError, ghFetch, readRateState, SEARCH_BUDGET, throttle, UA } from "../src/helpers";
import { freshStateDir, instantTimers, restoreTimers } from "./helpers";

// The portal contract requires backoff on 429/5xx and a timeout on every
// request; GitHub additionally needs its rate-limit headers honoured. Pinned
// offline: a stubbed fetch counts attempts and a stubbed setTimeout fires
// immediately while recording the requested delay.

const originalFetch = globalThis.fetch;
let stateDir = "";

beforeEach(() => {
  stateDir = freshStateDir();
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreTimers();
});

function stubFetch(responses: Array<() => Response>): { calls: number; init?: RequestInit } {
  const state: { calls: number; init?: RequestInit } = { calls: 0 };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    state.init = init;
    const i = Math.min(state.calls, responses.length - 1);
    state.calls++;
    return responses[i]();
  }) as unknown as typeof fetch;
  return state;
}

const API = "https://api.github.com/repos/o/r";

describe("ghFetch retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    const delays = instantTimers();
    const state = stubFetch([() => new Response("", { status: 429 }), () => new Response('{"ok":true}')]);
    expect((await ghFetch(API, { resource: "core" }))!.data).toEqual({ ok: true });
    expect(state.calls).toBe(2);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
  });

  test("backoff doubles between 5xx retries", async () => {
    const delays = instantTimers();
    stubFetch([() => new Response("", { status: 500 }), () => new Response("", { status: 503 }), () => new Response("{}")]);
    await ghFetch(API, { resource: "core" });
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeLessThan(1500);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);
    await expect(ghFetch(API, { resource: "core" })).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });

  test("returns null on 404 without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);
    expect(await ghFetch(API, { resource: "core" })).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("a 403 rate limit with a near reset waits for the reset, then retries", async () => {
    const delays = instantTimers();
    const reset = Math.floor(Date.now() / 1000) + 20;
    const state = stubFetch([
      () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }),
      () => new Response('{"ok":1}', { headers: { "x-ratelimit-remaining": "8" } }),
    ]);
    expect((await ghFetch(API, { resource: "search" }))!.data).toEqual({ ok: 1 });
    expect(state.calls).toBe(2);
    expect(Math.max(...delays)).toBeGreaterThan(15_000);
  });

  test("a 403 rate limit with a far reset fails fast with RATE_LIMITED", async () => {
    instantTimers();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    stubFetch([() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })]);
    const err = await ghFetch(API, { resource: "core" }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("RATE_LIMITED");
  });

  test("a secondary rate limit (retry-after) is honoured", async () => {
    const delays = instantTimers();
    const state = stubFetch([() => new Response("{}", { status: 403, headers: { "retry-after": "7" } }), () => new Response("{}")]);
    await ghFetch(API, { resource: "core" });
    expect(state.calls).toBe(2);
    expect(delays).toContain(7250);
  });

  test("remaining 0 on a success blocks the next call until the reset", async () => {
    const delays = instantTimers();
    const reset = Math.floor(Date.now() / 1000) + 30;
    stubFetch([() => new Response("{}", { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })]);
    await ghFetch(API, { resource: "search" });
    expect(readRateState().blocked_until.search).toBe(reset * 1000);
    await ghFetch(API, { resource: "search" });
    expect(Math.max(...delays)).toBeGreaterThan(25_000);
  });

  test("sends the honest UA, the API version and an AbortSignal timeout; no auth header without a token", async () => {
    const state = stubFetch([() => new Response("{}")]);
    await ghFetch(API, { resource: "core" });
    const h = state.init?.headers as Record<string, string>;
    expect(h["User-Agent"]).toBe(UA);
    expect(UA).toBe("ai-job-search-github-helpwanted-cli/1.0");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(h.Authorization).toBeUndefined();
    expect(state.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("search throttle (cross-invocation budget)", () => {
  test("under the budget: no wait", async () => {
    const delays = instantTimers();
    await throttle("search");
    expect(delays).toEqual([]);
    expect(readRateState().search_calls).toHaveLength(1);
  });

  test(`at ${SEARCH_BUDGET.anon} calls in the last minute (anonymous) it waits for the oldest to age out`, async () => {
    const delays = instantTimers();
    const now = Date.now();
    const calls = Array.from({ length: SEARCH_BUDGET.anon }, (_, i) => now - 50_000 + i * 1000);
    writeFileSync(join(stateDir, "ratelimit.json"), JSON.stringify({ search_calls: calls, blocked_until: {} }));
    await throttle("search", () => now);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(9_000);
    expect(delays[0]).toBeLessThan(11_000);
  });

  test("a token raises the budget", async () => {
    process.env.GITHUB_TOKEN = "t";
    const delays = instantTimers();
    const now = Date.now();
    const calls = Array.from({ length: SEARCH_BUDGET.anon }, () => now - 1000);
    writeFileSync(join(stateDir, "ratelimit.json"), JSON.stringify({ search_calls: calls, blocked_until: {} }));
    await throttle("search", () => now);
    expect(delays).toEqual([]);
    delete process.env.GITHUB_TOKEN;
  });
});
