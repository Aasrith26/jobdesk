import { describe, expect, test } from "bun:test"
import { extractJobPosting, fixMojibake, formatSalary, htmlToText, parseRss, toIsoDate } from "../src/helpers"
import { jobFromJsonLd, mapHimalayas, mapJobicy, mapRemoteOk, mapWorkingNomads, mapWwr, remoteOkTag, tzRuns } from "../src/sources"
import { himalayasSearch, jobicyFeed, jobPostingPage, remoteOkFeed, workingNomadsFeed, wwrRss } from "./fixtures/boards"

describe("Remote OK mapping", () => {
  test("skips the legal-notice element and normalizes a posting", () => {
    const jobs = remoteOkFeed.map((j) => mapRemoteOk(j as Record<string, unknown>)).filter(Boolean)
    expect(jobs).toHaveLength(2)
    const j = jobs[0]!
    expect(j.id).toBe("remoteok:1000001")
    expect(j.title).toBe("LLM Inference Engineer")
    expect(j.company).toBe("Acme AI")
    expect(j.url).toBe("https://remoteok.com/remote-jobs/remote-llm-inference-engineer-acme-1000001")
    expect(j.date).toBe("2026-11-07")
    expect(j.region).toBe("Anywhere in the World")
    expect(j.salary).toBe("USD 60000–90000/year")
    expect(j.description).toContain("- Latency")
  })

  test("zero salary is null and Latin-1 mojibake is repaired", () => {
    const j = mapRemoteOk(remoteOkFeed[2] as Record<string, unknown>)!
    expect(j.salary).toBeNull()
    expect(j.region).toContain("España")
  })

  test("query becomes a hyphenated tag", () => {
    expect(remoteOkTag("Machine Learning")).toBe("machine-learning")
    expect(remoteOkTag("llm OR rag")).toBe("llm")
  })
})

describe("Himalayas mapping", () => {
  test("India-restricted job is structurally eligible", () => {
    const j = mapHimalayas(himalayasSearch.jobs[0] as Record<string, unknown>)!
    expect(j.id).toBe("himalayas:gamma/voice-ai-engineer")
    expect(j.url).toBe("https://himalayas.app/companies/gamma/jobs/voice-ai-engineer")
    expect(j.applyUrl).toContain("utm_source=api")
    expect(j.region).toBe("India")
    expect(j.eligibility).toBe("friendly")
    expect(j.salary).toBe("USD 30000–50000/year")
    expect(j.tags).toContain("Machine Learning Engineer")
  })

  test("US job with US timezones is restricted and shows the timezone window", () => {
    const j = mapHimalayas(himalayasSearch.jobs[1] as Record<string, unknown>)!
    expect(j.eligibility).toBe("restricted")
    expect(j.region).toBe("United States (timezones UTC-10..UTC-5, UTC+14)")
  })

  test("no location restriction reads as Worldwide", () => {
    const j = mapHimalayas(himalayasSearch.jobs[2] as Record<string, unknown>)!
    expect(j.region).toBe("Worldwide")
    expect(j.eligibility).toBe("friendly")
  })

  test("tzRuns collapses consecutive offsets", () => {
    expect(tzRuns([5.5])).toBe("UTC+5:30")
    expect(tzRuns([1, 0, -1])).toBe("UTC-1..UTC+1")
  })

  test("long country lists are shortened but say whether India is in them", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Country${i}`).concat("India")
    const j = mapHimalayas({ ...himalayasSearch.jobs[0], locationRestrictions: many } as Record<string, unknown>)!
    expect(j.region).toMatch(/\+18 more countries \(incl\. India\)$/)
  })
})

describe("Jobicy mapping", () => {
  test("normalizes jobGeo, tags and salary", () => {
    const j = mapJobicy(jobicyFeed.jobs[0] as Record<string, unknown>)!
    expect(j.id).toBe("jobicy:200001")
    expect(j.region).toBe("APAC")
    expect(j.tags).toEqual(["Data Science & Analytics", "Full-Time", "Midweight"])
    expect(j.salary).toBe("USD 40000–60000/year")
    expect(j.url).toBe("https://jobicy.com/jobs/200001-rag-engineer")
  })
})

describe("We Work Remotely RSS", () => {
  const items = parseRss(wwrRss)

  test("chunked parsing keeps good items despite a broken one", () => {
    // The unterminated <title> item is skipped on its own; its neighbours survive.
    expect(items.map((i) => i.title)).toEqual([
      "Eta Labs: Senior AI Engineer",
      "Theta: Applied AI Engineer",
      "Iota: Hybrid ML Engineer",
    ])
    const jobs = items.map(mapWwr).filter(Boolean)
    expect(jobs).toHaveLength(3)
  })

  test("splits 'Company: Title', decodes the escaped description, reads skills", () => {
    const j = mapWwr(items[0])!
    expect(j.id).toBe("weworkremotely:eta-labs-senior-ai-engineer")
    expect(j.company).toBe("Eta Labs")
    expect(j.title).toBe("Senior AI Engineer")
    expect(j.description).toBe("Build LLM apps.")
    expect(j.tags).toEqual(["Back-End Programming", "Full-Time", "Python", "LLM", "RAG"])
    expect(j.region).toBe("Anywhere in the World")
    expect(j.date).toBe("2026-11-08")
  })

  test("a <country> list overrides the coarse <region>", () => {
    const j = mapWwr(items[1])!
    expect(j.region).toBe("Brazil, Chile, Uruguay")
  })
})

describe("Working Nomads mapping", () => {
  test("id from the /job/go/ URL, tags from category + tags", () => {
    const j = mapWorkingNomads(workingNomadsFeed[0] as Record<string, unknown>)!
    expect(j.id).toBe("workingnomads:3000001")
    expect(j.tags).toEqual(["Development", "llm", "python"])
    expect(j.region).toBe("Time zone: CET (+/- 3 hours)")
    expect(j.date).toBe("2026-11-09")
  })
})

describe("JSON-LD", () => {
  test("finds the JobPosting despite raw newlines and maps it", () => {
    const ld = extractJobPosting(jobPostingPage)!
    expect(ld.title).toBe("RAG Engineer")
    const d = jobFromJsonLd(ld, "jobicy", "200001", "https://jobicy.com/jobs/200001")
    expect(d.company).toBe("Epsilon")
    expect(d.region).toBe("India, Singapore")
    expect(d.salary).toBe("USD 40000–60000/year")
    expect(d.description).toBe("Retrieval work.\n\n- Embeddings")
    expect(d.validThrough).toBe("2099-12-01")
    expect(d.status).toBe("unknown")
  })
})

describe("small helpers", () => {
  test("toIsoDate handles ISO, RFC-822 and unix seconds", () => {
    expect(toIsoDate("2026-11-09T08:52:38-05:00")).toBe("2026-11-09")
    expect(toIsoDate("Sun, 08 Nov 2026 07:31:05 +0000")).toBe("2026-11-08")
    expect(toIsoDate(1794100000)).toBe("2026-11-08")
    expect(toIsoDate("garbage")).toBeNull()
  })

  test("formatSalary", () => {
    expect(formatSalary(0, 0, "USD")).toBeNull()
    expect(formatSalary(50000, null, "INR", "monthly")).toBe("INR 50000/month")
  })

  test("fixMojibake leaves clean text alone", () => {
    expect(fixMojibake("Hyderabad, India")).toBe("Hyderabad, India")
    expect(fixMojibake("CÃ³rdoba")).toBe("Córdoba")
  })

  test("htmlToText keeps paragraph and list structure", () => {
    expect(htmlToText("<p>A &amp; B</p><ul><li>one</li><li>two</li></ul>")).toBe("A & B\n\n- one\n- two")
  })
})
