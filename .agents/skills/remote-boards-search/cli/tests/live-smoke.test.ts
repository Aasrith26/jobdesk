import { describe, expect, test } from "bun:test"
import { parseJSON, runCLI } from "./helpers"

// One small live request per run (two boards), to catch upstream shape changes.
// The boards ask not to be hammered: keep this to a single search.
// Set REMOTE_BOARDS_SKIP_LIVE=1 to skip it (e.g. offline).
const live = process.env.REMOTE_BOARDS_SKIP_LIVE ? test.skip : test

describe("live smoke", () => {
  live("search returns real results with id/title/url", async () => {
    const r = await runCLI(["search", "-q", "engineer", "--source", "himalayas,weworkremotely", "--limit", "5"])
    const doc = parseJSON<{
      meta: { count: number; errors: unknown[] }
      results: { id: string; title: string; url: string; source: string }[]
    }>(r)
    expect(doc.meta.count).toBeGreaterThanOrEqual(1)
    for (const j of doc.results) {
      expect(j.id).toBeTruthy()
      expect(j.title).toBeTruthy()
      expect(j.url).toMatch(/^https:\/\/(himalayas\.app|weworkremotely\.com)\//)
    }
  })
})
