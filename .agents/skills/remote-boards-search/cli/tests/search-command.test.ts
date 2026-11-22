import { describe, expect, test } from "bun:test"
import { filterAndRank, runSearch, type SearchOpts } from "../src/commands/search"
import { SOURCE_NAMES, type RawJob } from "../src/sources"
import { himalayasSearch, jobicyFeed, remoteOkFeed, workingNomadsFeed, wwrRss } from "./fixtures/boards"
import { capture, json, routeFetch, text } from "./stub"

const allRoutes = {
  "remoteok.com": () => json(remoteOkFeed),
  "himalayas.app": () => json(himalayasSearch),
  "jobicy.com": () => json(jobicyFeed),
  "weworkremotely.com": () => text(wwrRss),
  "www.workingnomads.com": () => json(workingNomadsFeed),
}

const base: SearchOpts = {
  sources: [...SOURCE_NAMES],
  regions: [],
  indiaFriendly: false,
  page: 1,
  limit: 25,
  format: "json",
  timeoutMs: 5000,
}

async function search(opts: Partial<SearchOpts>, routes = allRoutes) {
  const seen = routeFetch(routes)
  const io = capture()
  const code = await runSearch({ ...base, ...opts })
  return { code, seen, out: io.out(), err: io.err() }
}

describe("search command (stubbed boards)", () => {
  test("queries every board once with an honest UA and emits the contract shape", async () => {
    const { code, seen, out } = await search({ query: "llm" })
    expect(code).toBe(0)
    expect(seen).toHaveLength(5)
    for (const s of seen) expect(s.headers["user-agent"]).toBe("Mozilla/5.0 (compatible; remote-boards-cli/1.0)")
    const doc = JSON.parse(out)
    expect(doc.meta.errors).toEqual([])
    expect(doc.meta.attribution).toHaveLength(5)
    for (const r of doc.results) {
      for (const k of ["id", "title", "company", "location", "date", "url", "source", "region", "tags", "salary"]) {
        expect(r).toHaveProperty(k) // present, possibly null - never omitted
      }
    }
  })

  test("request shapes: Remote OK tag, Himalayas search page 1 with country=IN, Jobicy tag", async () => {
    const { seen } = await search({ query: "machine learning", indiaFriendly: true })
    const urls = seen.map((s) => new URL(s.url))
    const rok = urls.find((u) => u.hostname === "remoteok.com")!
    expect(rok.searchParams.get("tag")).toBe("machine-learning")
    const him = urls.find((u) => u.hostname === "himalayas.app")!
    expect(him.pathname).toBe("/jobs/api/search")
    expect(him.searchParams.get("country")).toBe("IN")
    expect(him.searchParams.has("page")).toBe(false) // robots.txt disallows search paging
    const jb = urls.find((u) => u.hostname === "jobicy.com")!
    expect(jb.pathname).toBe("/api/jobs")
    expect(jb.searchParams.get("tag")).toBe("machine learning")
  })

  test("one failing board is reported in meta.errors, the run still succeeds", async () => {
    const { code, out } = await search({ query: "llm" }, { ...allRoutes, "jobicy.com": () => text("boom", 403) })
    expect(code).toBe(0)
    const doc = JSON.parse(out)
    expect(doc.meta.errors).toEqual([{ source: "jobicy", error: expect.stringContaining("403"), code: "SOURCE_FAILED" }])
    expect(doc.results.length).toBeGreaterThan(0)
  })

  test("table format warns about a failed board on stderr and prints attribution", async () => {
    const { code, out, err } = await search({ query: "llm", format: "table" }, { ...allRoutes, "jobicy.com": () => text("x", 403) })
    expect(code).toBe(0)
    expect(out).toContain("Sources (link back / credit required)")
    expect(JSON.parse(err.trim().split("\n")[0]).code).toBe("SOURCE_FAILED")
  })

  test("every board failing exits 1 with a JSON error on stderr", async () => {
    const down = Object.fromEntries(Object.keys(allRoutes).map((h) => [h, () => text("x", 403)]))
    const { code, out, err } = await search({ query: "llm" }, down)
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(JSON.parse(err).code).toBe("SEARCH_FAILED")
  })

  test("--india-friendly keeps India/APAC/worldwide, drops US/LATAM/CET and hybrid", async () => {
    const { out } = await search({ query: "llm", indiaFriendly: true, limit: 50 })
    const ids = JSON.parse(out).results.map((r: { id: string }) => r.id)
    expect(ids).toContain("weworkremotely:eta-labs-senior-ai-engineer") // Anywhere
    expect(ids).toContain("workingnomads:3000002") // ... APAC ...
    expect(ids).not.toContain("weworkremotely:theta-applied-ai-engineer") // Brazil, Chile, Uruguay
    expect(ids).not.toContain("weworkremotely:iota-hybrid-ml-engineer") // onsite 3 days a week
    expect(ids).not.toContain("workingnomads:3000001") // CET +/- 3h
    expect(ids).not.toContain("jobicy:200002") // USA
  })

  test("dedupes identical company+title across boards and records the other listing", async () => {
    const { out } = await search({ query: "llm inference engineer" })
    const doc = JSON.parse(out)
    const acme = doc.results.filter((r: { company: string }) => r.company === "Acme AI")
    expect(acme).toHaveLength(1)
    expect(acme[0].alsoOn.map((a: { id: string }) => a.id)).toEqual(["himalayas:acme-ai/llm-inference-engineer"])
    expect(doc.meta.filtered.duplicates).toBe(1)
  })

  test("--page/--limit page over the merged list", async () => {
    const p1 = JSON.parse((await search({ query: "llm", limit: 2, page: 1 })).out)
    const p2 = JSON.parse((await search({ query: "llm", limit: 2, page: 2 })).out)
    expect(p1.results).toHaveLength(2)
    expect(p1.meta.hasMore).toBe(true)
    expect(p2.meta.page).toBe(2)
    expect(p2.results[0].id).not.toBe(p1.results[0].id)
  })

  test("--source restricts which boards are called", async () => {
    const { seen } = await search({ query: "llm", sources: ["himalayas", "jobicy"] })
    expect(seen.map((s) => new URL(s.url).hostname).sort()).toEqual(["himalayas.app", "jobicy.com"])
  })
})

describe("filterAndRank", () => {
  const job = (o: Partial<RawJob>): RawJob => ({
    id: "x:1",
    title: "Engineer",
    company: "C",
    date: "2026-11-01",
    url: "https://example.org",
    applyUrl: null,
    source: "jobicy",
    region: "Worldwide",
    tags: [],
    salary: null,
    description: null,
    ...o,
  })
  const opts = { regions: [] as string[], indiaFriendly: false }

  test("phrase match, plural, OR alternatives, title-only", () => {
    const jobs = [
      job({ id: "a:1", title: "LLMs Engineer" }),
      job({ id: "a:2", title: "Backend", description: "We use machine-learning daily" }),
      job({ id: "a:3", title: "Learning machine", company: "D" }),
      job({ id: "a:4", title: "RAG dev", company: "E" }),
    ]
    const ids = (q: string, titleOnly = false) => filterAndRank(jobs, { ...opts, query: q, titleOnly }).results.map((r) => r.id)
    expect(ids("llm")).toEqual(["a:1"])
    expect(ids("machine learning")).toEqual(["a:2"])
    expect(ids("machine learning", true)).toEqual([])
    expect(ids("llm OR rag").sort()).toEqual(["a:1", "a:4"])
  })

  test("title hits rank before description hits, then newest first", () => {
    const jobs = [
      job({ id: "d:1", title: "Backend", company: "A", description: "llm stuff", date: "2026-11-09" }),
      job({ id: "t:old", title: "LLM Engineer", company: "B", date: "2026-10-01" }),
      job({ id: "t:new", title: "LLM Lead", company: "C", date: "2026-11-05" }),
    ]
    expect(filterAndRank(jobs, { ...opts, query: "llm" }).results.map((r) => r.id)).toEqual(["t:new", "t:old", "d:1"])
  })

  test("--region substring and worldwide aliases; --jobage drops old and undated", () => {
    const jobs = [
      job({ id: "r:1", region: "APAC", company: "A" }),
      job({ id: "r:2", region: "Anywhere in the World", company: "B" }),
      job({ id: "r:3", region: "USA Only", company: "C", date: null }),
    ]
    expect(filterAndRank(jobs, { ...opts, regions: ["apac"] }).results.map((r) => r.id)).toEqual(["r:1"])
    expect(filterAndRank(jobs, { ...opts, regions: ["worldwide"] }).results.map((r) => r.id)).toEqual(["r:2"])
    const now = Date.parse("2026-11-09T00:00:00Z")
    expect(filterAndRank(jobs, { ...opts, jobage: 30 }, now).results).toHaveLength(2)
    expect(filterAndRank(jobs, { ...opts, jobage: 3 }, now).results).toHaveLength(0)
  })
})

describe("OR queries", () => {
  test("Himalayas gets the first alternative; Remote OK and Jobicy drop their server-side filter", async () => {
    const seen = routeFetch(allRoutes)
    capture()
    await runSearch({ ...base, query: "llm OR rag" })
    const urls = seen.map((s) => new URL(s.url))
    expect(urls.find((u) => u.hostname === "himalayas.app")!.searchParams.get("q")).toBe("llm")
    expect(urls.find((u) => u.hostname === "remoteok.com")!.searchParams.has("tag")).toBe(false)
    const jb = urls.find((u) => u.hostname === "jobicy.com")!
    expect(jb.searchParams.has("tag")).toBe(false)
    expect(jb.searchParams.get("count")).toBe("100")
  })
})
