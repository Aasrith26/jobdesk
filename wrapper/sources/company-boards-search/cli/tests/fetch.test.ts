import { afterEach, describe, expect, test } from "bun:test";
import { jsonFetch, UA } from "../src/helpers";

// The portal contract requires backoff on 429/5xx, null on 404, an honest UA
// and a request timeout. A stubbed fetch counts attempts and a stubbed
// setTimeout fires immediately so exhaustion does not sleep through the real
// 500ms -> 8s schedule.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
}

function stub(responses: Array<() => Response>): { calls: number; init?: RequestInit } {
  const state: { calls: number; init?: RequestInit } = { calls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
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
    const state = stub([() => new Response("", { status: 429 }), () => new Response('{"ok":true}')]);
    expect(await jsonFetch("https://api.lever.co/v0/postings/x")).toEqual({ ok: true });
    expect(state.calls).toBe(2);
  });

  test("returns null on 404 without retrying", async () => {
    const state = stub([() => new Response("", { status: 404 })]);
    expect(await jsonFetch("https://api.lever.co/v0/postings/x")).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stub([() => new Response("", { status: 502 })]);
    await expect(jsonFetch("https://api.lever.co/v0/postings/x")).rejects.toThrow(/502/);
    expect(state.calls).toBe(7);
  });

  test("a 4xx other than 404/429 fails without retry", async () => {
    const state = stub([() => new Response("", { status: 403 })]);
    await expect(jsonFetch("https://api.lever.co/v0/postings/x")).rejects.toThrow(/403/);
    expect(state.calls).toBe(1);
  });

  test("non-JSON bodies are an error naming the host", async () => {
    stub([() => new Response("<html>")]);
    await expect(jsonFetch("https://api.lever.co/v0/postings/x")).rejects.toThrow(/api\.lever\.co/);
  });

  test("sends the honest tool UA and an AbortSignal timeout", async () => {
    const state = stub([() => new Response("{}")]);
    await jsonFetch("https://api.lever.co/v0/postings/x", { timeoutMs: 1000 });
    expect(UA).toBe("Mozilla/5.0 (compatible; company-boards-cli/1.0)");
    expect((state.init?.headers as Record<string, string>)["User-Agent"]).toBe(UA);
    expect(state.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
