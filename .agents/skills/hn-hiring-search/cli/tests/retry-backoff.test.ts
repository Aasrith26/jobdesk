import { afterEach, describe, expect, test } from "bun:test";
import { jsonFetch } from "../src/helpers";

// The portal contract requires backoff on 429/5xx and a timeout on every
// request. Pinned offline: a stubbed fetch counts attempts and a stubbed
// setTimeout fires immediately.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
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

describe("jsonFetch", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 429 }), () => new Response('{"ok":true}')]);
    expect(await jsonFetch("https://hn.algolia.com/api/v1/x")).toEqual({ ok: true });
    expect(state.calls).toBe(2);
  });

  test("returns null on 404 without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);
    expect(await jsonFetch("https://hn.algolia.com/api/v1/x")).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("Firebase's literal null body is null", async () => {
    stubFetch([() => new Response("null")]);
    expect(await jsonFetch("https://hacker-news.firebaseio.com/v0/item/1.json")).toBeNull();
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);
    await expect(jsonFetch("https://hn.algolia.com/api/v1/x")).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });

  test("sends the honest UA and an AbortSignal timeout", async () => {
    const state = stubFetch([() => new Response("{}")]);
    await jsonFetch("https://hn.algolia.com/api/v1/x");
    expect((state.init?.headers as Record<string, string>)["User-Agent"]).toBe("Mozilla/5.0 (compatible; hn-hiring-cli/1.0)");
    expect(state.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
