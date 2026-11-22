import { describe, expect, test } from "bun:test"
import { fetchText } from "../src/helpers"
import { instantTimers } from "./stub"

// The portal contract requires backoff on 429/5xx, "" on 404, and a timeout on
// every request. A stubbed fetch counts attempts; instant timers skip the sleeps.

function stubFetch(responses: Array<() => Response>) {
  const state = { calls: 0, init: undefined as RequestInit | undefined }
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    state.init = init
    const i = Math.min(state.calls, responses.length - 1)
    state.calls++
    return responses[i]()
  }) as unknown as typeof fetch
  return state
}

describe("fetchText", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers()
    const s = stubFetch([() => new Response("", { status: 429 }), () => new Response("ok")])
    expect(await fetchText("https://remoteok.com/api")).toBe("ok")
    expect(s.calls).toBe(2)
  })

  test("404 returns empty string without retrying", async () => {
    const s = stubFetch([() => new Response("", { status: 404 })])
    expect(await fetchText("https://remoteok.com/api")).toBe("")
    expect(s.calls).toBe(1)
  })

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers()
    const s = stubFetch([() => new Response("", { status: 503 })])
    await expect(fetchText("https://remoteok.com/api")).rejects.toThrow(/503/)
    expect(s.calls).toBe(7)
  })

  test("a 403 fails at once (not retried)", async () => {
    const s = stubFetch([() => new Response("", { status: 403 })])
    await expect(fetchText("https://remoteok.com/api")).rejects.toThrow(/403/)
    expect(s.calls).toBe(1)
  })

  test("sends an AbortSignal timeout and the honest User-Agent", async () => {
    const s = stubFetch([() => new Response("ok")])
    await fetchText("https://himalayas.app/jobs/api")
    expect(s.init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(s.init?.headers).get("user-agent")).toBe("Mozilla/5.0 (compatible; remote-boards-cli/1.0)")
  })
})
