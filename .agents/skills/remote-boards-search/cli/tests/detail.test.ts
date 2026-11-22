import { describe, expect, test } from "bun:test"
import { parseId, runDetail } from "../src/commands/detail"
import { himalayasSearch, jobPostingPage, remoteOkFeed, workingNomadsFeed } from "./fixtures/boards"
import { capture, json, routeFetch, text } from "./stub"

describe("parseId", () => {
  const ok = (input: string) => {
    const p = parseId(input)
    return p.ok ? `${p.source}:${p.nativeId}` : `ERR ${p.code}`
  }
  test("source:id forms", () => {
    expect(ok("remoteok:1137690")).toBe("remoteok:1137690")
    expect(ok("himalayas:linear/senior-product-engineer")).toBe("himalayas:linear/senior-product-engineer")
    expect(ok("wwr:acme-engineer")).toBe("weworkremotely:acme-engineer")
    expect(ok("jobicy:160069")).toBe("jobicy:160069")
    expect(ok("nope:1")).toBe("ERR BAD_ID")
    expect(ok("himalayas:../../etc")).toBe("ERR BAD_ID")
    expect(ok("remotive:123")).toBe("ERR EXCLUDED_SOURCE")
    expect(ok("just-text")).toBe("ERR BAD_ID")
  })
  test("board URLs", () => {
    expect(ok("https://remoteok.com/remote-jobs/remote-ml-engineer-acme-1137690")).toBe("remoteok:1137690")
    expect(ok("https://himalayas.app/companies/linear/jobs/senior-product-engineer?utm_source=api")).toBe(
      "himalayas:linear/senior-product-engineer",
    )
    expect(ok("https://jobicy.com/jobs/160069-llm-applied-data-scientist")).toBe("jobicy:160069")
    expect(ok("weworkremotely.com/remote-jobs/alloy-founding-engineer")).toBe("weworkremotely:alloy-founding-engineer")
    expect(ok("https://www.workingnomads.com/job/go/2007975/")).toBe("workingnomads:2007975")
  })
  test("other hosts and look-alikes are rejected before any request", () => {
    expect(ok("https://boards.greenhouse.io/acme/jobs/123")).toBe("ERR BAD_ID")
    expect(ok("https://remoteok.com.evil.io/remote-jobs/x-123")).toBe("ERR BAD_ID")
    expect(ok("https://remoteok.com@evil.io/remote-jobs/x-123")).toBe("ERR BAD_ID")
    expect(ok("https://remotive.com/remote-jobs/software-dev/x-123")).toBe("ERR EXCLUDED_SOURCE")
  })
})

async function detail(id: string, routes: Parameters<typeof routeFetch>[0], format: "json" | "plain" = "json") {
  const seen = routeFetch(routes)
  const io = capture()
  const code = await runDetail({ id, format, timeoutMs: 5000 })
  return { code, seen, out: io.out(), err: io.err() }
}

describe("detail command (stubbed)", () => {
  test("Himalayas uses the single-job API and reports it open", async () => {
    const { code, seen, out } = await detail("himalayas:gamma/voice-ai-engineer", {
      "himalayas.app": () => json({ job: himalayasSearch.jobs[0] }),
    })
    expect(code).toBe(0)
    expect(seen[0].url).toBe("https://himalayas.app/jobs/api/companies/gamma/jobs/voice-ai-engineer")
    const d = JSON.parse(out)
    expect(d.status).toBe("open")
    expect(d.indiaFriendly).toBe(true)
    expect(d.description).toBe("Build real-time voice agents.")
    expect(d.attribution).toMatch(/Himalayas/)
  })

  test("Himalayas 410 means the posting closed", async () => {
    const { code, out } = await detail("himalayas:gamma/old-job", { "himalayas.app": () => json({ expiryDate: 1 }, 410) })
    expect(code).toBe(0)
    expect(JSON.parse(out).status).toBe("closed")
  })

  test("Jobicy reads the posting page's JSON-LD", async () => {
    const { code, seen, out } = await detail("jobicy:200001", { "jobicy.com": () => text(jobPostingPage) })
    expect(code).toBe(0)
    expect(seen[0].url).toBe("https://jobicy.com/jobs/200001")
    const d = JSON.parse(out)
    expect(d.title).toBe("RAG Engineer")
    expect(d.region).toBe("India, Singapore")
    expect(d.indiaFriendly).toBe(true)
  })

  test("Remote OK finds the posting in the feed", async () => {
    const { code, out } = await detail("remoteok:1000001", { "remoteok.com": () => json(remoteOkFeed) }, "plain")
    expect(code).toBe(0)
    expect(out).toContain("LLM Inference Engineer")
    expect(out).toContain("India-friendly: yes")
    expect(out).toContain("Source: Remote OK")
  })

  test("Working Nomads id missing from the feed is NOT_FOUND on stderr", async () => {
    const { code, out, err } = await detail("workingnomads:999", { "www.workingnomads.com": () => json(workingNomadsFeed) })
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(JSON.parse(err).code).toBe("NOT_FOUND")
  })

  test("a board error becomes DETAIL_FAILED", async () => {
    const { code, err } = await detail("jobicy:1", { "jobicy.com": () => text("forbidden", 403) })
    expect(code).toBe(1)
    expect(JSON.parse(err).code).toBe("DETAIL_FAILED")
  })
})
