import { afterEach, describe, expect, test } from "bun:test";
import { fetchText, UA } from "../src/helpers";
import { instantTimers, restoreTimers } from "./helpers";

// The portal contract requires backoff on 429/5xx and a timeout on every
// request. Pinned offline: a stubbed fetch counts attempts and a stubbed
// setTimeout fires immediately while recording the requested delay.

const originalFetch = globalThis.fetch;

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

const URL_ = "https://yc-oss.github.io/api/companies/hiring.json";

describe("fetchText", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    const delays = instantTimers();
    const state = stubFetch([() => new Response("", { status: 429 }), () => new Response("[]")]);
    expect(await fetchText(URL_)).toBe("[]");
    expect(state.calls).toBe(2);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
  });

  test("backoff doubles between retries", async () => {
    const delays = instantTimers();
    stubFetch([() => new Response("", { status: 500 }), () => new Response("", { status: 502 }), () => new Response("[]")]);
    await fetchText(URL_);
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);
    await expect(fetchText(URL_)).rejects.toThrow(/HTTP 503/);
    expect(state.calls).toBe(7);
  });

  test("404 -> null without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);
    expect(await fetchText(URL_)).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("sends the honest UA (no email) and an AbortSignal timeout", async () => {
    const state = stubFetch([() => new Response("[]")]);
    await fetchText(URL_);
    expect((state.init?.headers as Record<string, string>)["User-Agent"]).toBe(UA);
    expect(UA).toBe("ai-job-search-yc-hiring-cli/1.0");
    expect(state.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
