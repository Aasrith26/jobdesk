import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIN_INTERVAL_MS, UA, resetRateLimit, textFetch } from "../src/helpers";

// The portal contract requires backoff on 429/5xx and a timeout on every
// request; this source also promises at most one request every 2 s. Pinned
// offline: a stubbed fetch counts attempts and a stubbed setTimeout records
// the requested delay and fires immediately.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let delays: number[] = [];

beforeEach(() => {
  resetRateLimit();
  delays = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout;
}

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

describe("textFetch", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 429 }), () => new Response("<feed></feed>")]);
    expect(await textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25")).toBe("<feed></feed>");
    expect(state.calls).toBe(2);
  });

  test("honours a numeric Retry-After on 429", async () => {
    instantTimers();
    stubFetch([() => new Response("", { status: 429, headers: { "Retry-After": "3" } }), () => new Response("ok")]);
    await textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25");
    expect(delays).toContain(3000);
  });

  test("returns null on 404 without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);
    expect(await textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25")).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);
    await expect(textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25")).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });

  test("a non-retryable 403 throws immediately", async () => {
    const state = stubFetch([() => new Response("", { status: 403 })]);
    await expect(textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25")).rejects.toThrow(/403/);
    expect(state.calls).toBe(1);
  });

  test("spaces consecutive requests at least MIN_INTERVAL_MS apart", async () => {
    instantTimers();
    stubFetch([() => new Response("a")]);
    await textFetch("https://www.reddit.com/r/forhire/new/.rss");
    expect(delays).toEqual([]);
    await textFetch("https://www.reddit.com/r/remotejs/new/.rss");
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThan(MIN_INTERVAL_MS - 200);
    expect(delays[0]).toBeLessThanOrEqual(MIN_INTERVAL_MS);
  });

  test("sends the descriptive UA (no contact details) and an AbortSignal timeout", async () => {
    const state = stubFetch([() => new Response("{}")]);
    await textFetch("https://www.reddit.com/r/forhire/new/.rss?limit=25");
    const ua = (state.init?.headers as Record<string, string>)["User-Agent"];
    expect(ua).toBe(UA);
    expect(ua).toContain("ai-job-search-reddit-cli/1.0");
    expect(ua).not.toMatch(/@/);
    expect(state.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
