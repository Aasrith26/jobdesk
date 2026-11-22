// In-process test utilities: a host-routed fetch stub and stdout/stderr capture.
import { afterEach } from "bun:test"

const originalFetch = globalThis.fetch
const originalStdout = process.stdout.write
const originalStderr = process.stderr.write
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stdout.write = originalStdout
  process.stderr.write = originalStderr
  globalThis.setTimeout = originalSetTimeout
})

export interface Seen {
  url: string
  headers: Record<string, string>
}

export type Route = (url: URL) => Response | Promise<Response>

/** Route stubbed requests by hostname; unknown hosts get a 599 so a stray request fails loudly. */
export function routeFetch(routes: Record<string, Route>): Seen[] {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    seen.push({ url: href, headers })
    const u = new URL(href)
    const route = routes[u.hostname]
    if (!route) return new Response("no route", { status: 599 })
    return route(u)
  }) as unknown as typeof fetch
  return seen
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
export const text = (body: string, status = 200) => new Response(body, { status })

export function capture(): { out: () => string; err: () => string } {
  let out = ""
  let err = ""
  process.stdout.write = ((c: string | Uint8Array) => ((out += c.toString()), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string | Uint8Array) => ((err += c.toString()), true)) as typeof process.stderr.write
  return { out: () => out, err: () => err }
}

/** Make backoff sleeps instant. */
export function instantTimers(): void {
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout
}
