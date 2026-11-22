import { describe, expect, test } from "bun:test"
import { writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { buildKit, capCheck } from "../src/kit.ts"
import { setAnswer } from "../src/data/answers.ts"
import { readConfig } from "../src/data/config.ts"
import { triage, processInboxFolder } from "../src/inbox.ts"
import { openItems } from "../src/data/attention.ts"
import { dueFollowUps, refreshReminders } from "../src/followups.ts"
import { composeDigest } from "../src/digest.ts"
import { searchUrls, booleanQuery, matchReferrals, parseConnections } from "../src/linkedin.ts"
import { parseResults, heuristicFit } from "../src/scan.ts"
import { fetchX, isXUrl } from "../src/links.ts"
import { unzipEntry, docxText } from "../src/intake.ts"
import { runClaude, monthSpend } from "../src/lib/claude.ts"
import { deflateRawSync } from "node:zlib"
import { today } from "../src/lib/store.ts"

const T = today()

describe("application kit (APP-1, OUT-4)", () => {
  test("kit lists files, approved answers and the site's policy; private answers stay out", () => {
    const p = tmpWorkspace([`${T},Acme,AI,AI Engineer,AI,portal,drafted,,70,,cv/acme.tex,,https://www.linkedin.com/jobs/view/1,`])
    writeFileSync(join(p.root, "cv", "acme.pdf"), TINY_PDF)
    setAnswer(p.answers, { key: "notice_period", answer: "30 days" })
    setAnswer(p.answers, { key: "gender", answer: "private-value" })
    const k = buildKit(p, "https://www.linkedin.com/jobs/view/1")
    expect(k.files[0].exists).toBe(true)
    expect(k.text).toContain("Notice period: 30 days")
    expect(k.text).not.toContain("private-value")
    expect(k.policy.policy).toBe("assist")
    expect(existsSync(k.html_path)).toBe(true)
    expect(readFileSync(k.html_path, "utf8")).not.toMatch(/<script/)
  })
  test("daily cap explains itself", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `${T},C${i},AI,R,R,portal,drafted,,1,,,,https://e.com/${i},`)
    const p = tmpWorkspace(rows)
    const c = capCheck(p, readConfig(p.config))
    expect(c.ok).toBe(false)
    expect(c.message).toContain("daily limit of 5")
  })
})

describe("inbox (INB-1..3)", () => {
  test("an interview invite becomes a recruiter-reply item; a rejection asks to confirm", () => {
    const p = tmpWorkspace([`2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,,,,https://e.com/a,`])
    const r1 = triage(p, { id: "1", subject: "Interview for AI Engineer at Acme", body: "We'd like to schedule a call. Are you free on 20 November 2026?" })
    expect(r1.label).toBe("interview_invite")
    expect(r1.company).toBe("Acme")
    const r2 = triage(p, { id: "2", subject: "Your application at Acme", body: "Thank you for your time. We have decided to move forward with other candidates." })
    expect(r2.label).toBe("rejection")
    const items = openItems(p.attention)
    expect(items.find((i) => i.id === "mail:2")?.data?.confirm_status).toBe("rejected")
    expect(items[0].kind).toBe("recruiter_reply")
  })
  test("emails dropped in the inbox folder are processed once", async () => {
    const p = tmpWorkspace()
    writeFileSync(join(p.inbox, "a.eml"), "From: hr@acme.example.com\nSubject: HackerRank test\n\nPlease complete the HackerRank assessment link by 2026-11-30.")
    expect((await processInboxFolder(p)).map((x) => x.label)).toEqual(["assessment"])
    expect((await processInboxFolder(p)).length).toBe(0)
    expect(openItems(p.attention)[0].due).toBe("2026-11-30")
  })
})

describe("follow-ups and digest (OUT-2, MSG-6)", () => {
  test("open, sent, quiet 10+ days and fewer than two follow-ups", () => {
    const p = tmpWorkspace([
      "2026-10-01,Old,AI,R,R,portal,applied,,1,,,,https://e.com/1,",
      "2026-10-01,Twice,AI,R,R,portal,applied,,1,followed up 2026-10-12; followed up 2026-10-25,,,https://e.com/2,",
      "2026-10-01,Draft,AI,R,R,portal,drafted,,1,,,,https://e.com/3,",
      "2026-10-01,Done,AI,R,R,portal,rejected,,1,,,,https://e.com/4,",
    ])
    expect(dueFollowUps(p.tracker, readConfig(p.config), "2026-11-11").map((f) => f.row.company)).toEqual(["Old"])
    refreshReminders(p, readConfig(p.config), new Date("2026-11-11T09:00:00"))
    expect(openItems(p.attention).some((i) => i.kind === "followup_due")).toBe(true)
  })
  test("digest is plain and lists ranked jobs first", () => {
    const p = tmpWorkspace([], { a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 77 } })
    const d = composeDigest(p, readConfig(p.config))
    expect(d.text).toContain("1. AI Engineer at Acme (fit 77)")
  })
})

describe("LinkedIn assist and referrals (LEAD-8, OUT-3)", () => {
  test("boolean search URLs are built locally", () => {
    expect(booleanQuery(["AI Engineer", "LLM"])).toContain('("AI Engineer" OR LLM)')
    const u = searchUrls(["LLM"], "Hyderabad")
    expect(u[0].url.startsWith("https://www.linkedin.com/search/results/content/")).toBe(true)
    expect(u[1].url).toContain("location=Hyderabad")
  })
  test("connections export matches shortlisted companies", () => {
    const p = tmpWorkspace()
    const f = join(p.data, "Connections.csv")
    writeFileSync(f, "Notes:\n\"When exporting...\"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nAsha,Rao,https://linkedin.com/in/asha,,Acme Technologies Pvt Ltd,Engineer,01 Jan 2026\nRavi,K,https://linkedin.com/in/ravi,,Other Co,PM,01 Jan 2026\n")
    const m = matchReferrals(parseConnections(f), ["Acme", "Nobody"])
    expect(m.length).toBe(1)
    expect(m[0].people[0].name).toBe("Asha Rao")
  })
})

describe("scan helpers (LEAD-2, INC-1)", () => {
  test("parseResults keeps only real http(s) jobs", () => {
    const r = parseResults(JSON.stringify({ meta: {}, results: [{ title: "A", company: "B", url: "https://e.com" }, { title: "x", company: "y", url: "javascript:alert(1)" }] }))
    expect(r.length).toBe(1)
  })
  test("keyword fit without a model", () => {
    expect(heuristicFit("Python LLM RAG vLLM FastAPI Docker", ["python", "llm", "rag", "vllm", "fastapi", "docker"])).toBe("high")
    expect(heuristicFit("Sales role", ["python"])).toBe("low")
  })
})

describe("paste-a-link: X via oEmbed (MSG-5)", () => {
  test("reads one post through the official oEmbed endpoint", async () => {
    const calls: string[] = []
    const fake = async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ author_name: "A", author_url: "https://x.com/someone", html: '<blockquote><p>We are hiring an LLM engineer.<br>DM me.</p>&mdash; A</blockquote>' }))
    }
    const r = await fetchX("https://x.com/someone/status/123", fake as never)
    expect(calls[0]).toContain("publish.twitter.com/oembed")
    expect(r.company).toBe("@someone")
    expect(r.text).toContain("We are hiring an LLM engineer.")
    expect(isXUrl("https://x.com/a/status/1")).toBe(true)
  })
  test("an unreachable post is an error, never invented content", async () => {
    await expect(fetchX("https://x.com/a/status/1", (async () => new Response("", { status: 404 })) as never)).rejects.toThrow(/paste the text/)
  })
})

describe("resume intake (ONB-3)", () => {
  test("reads text from a .docx without dependencies", () => {
    const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p><w:p><w:r><w:t>Python &amp; ML</w:t></w:r></w:p></w:body></w:document>')
    const data = deflateRawSync(xml)
    const name = Buffer.from("word/document.xml")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
    const cdOff = local.length + name.length + data.length
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOff, 16)
    const zip = Buffer.concat([local, name, data, central, name, eocd])
    expect(unzipEntry(zip, "word/document.xml")?.toString()).toContain("Jane Doe")
    const p = tmpWorkspace()
    const f = join(p.data, "cv.docx")
    writeFileSync(f, zip)
    expect(docxText(f)).toBe("Jane Doe\nPython & ML")
  })
})

describe("tiers (INC-2)", () => {
  test("lite uses the cheapest model except for drafts; max uses the strongest everywhere", async () => {
    const { modelFor } = await import("../src/data/config.ts")
    expect(["rank", "evaluate", "chat"].map((t) => modelFor("lite", t as never))).toEqual(["haiku", "haiku", "haiku"])
    expect(modelFor("lite", "draft")).toBe("sonnet")
    expect(modelFor("standard", "evaluate")).toBe("sonnet")
    expect(modelFor("max", "rank")).toBe("opus")
  })
})

describe("Claude runs: budget and cost ledger (INC-2, INC-3)", () => {
  test("cost is recorded from Claude's own report; the tier picks the model", async () => {
    const p = tmpWorkspace()
    const cfg = { ...readConfig(p.config), tier: "lite" as const }
    let seen: string[] = []
    const r = await runClaude({ root: p.root, ledger: p.costs, cfg, task: "rank", prompt: "x", allowedTools: ["Read"], exec: async (a) => { seen = a; return { code: 0, stdout: JSON.stringify({ result: "ok", total_cost_usd: 0.012 }), stderr: "" } } })
    expect(r.usd).toBe(0.012)
    expect(seen[seen.indexOf("--model") + 1]).toBe("haiku")
    expect(seen).toContain("--max-budget-usd")
    expect(monthSpend(p.costs)).toBeCloseTo(0.012)
  })
  test("when the monthly budget is used up, model calls stop", async () => {
    const p = tmpWorkspace()
    const cfg = { ...readConfig(p.config), monthly_budget_usd: 0.01 }
    writeFileSync(p.costs, JSON.stringify({ at: new Date().toISOString(), task: "draft", model: "sonnet", usd: 0.02, ok: true }) + "\n")
    let called = false
    const r = await runClaude({ root: p.root, ledger: p.costs, cfg, task: "draft", prompt: "x", allowedTools: [], exec: async () => { called = true; return { code: 0, stdout: "{}", stderr: "" } } })
    expect(r.skipped).toBe("budget")
    expect(called).toBe(false)
  })
})
