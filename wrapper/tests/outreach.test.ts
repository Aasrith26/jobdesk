import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { tmpWorkspace } from "./helpers.ts"
import { draftDm, wordCount, DM_MAX_WORDS, interviewsTomorrow, compareOffers } from "../src/outreach.ts"
import { upsertLead } from "../src/data/leads.ts"
import { addItem } from "../src/data/attention.ts"
import { readConfig } from "../src/data/config.ts"

const lead = (p: ReturnType<typeof tmpWorkspace>) =>
  upsertLead(p.leads, { key: "lead1", url: "https://t.me/ch/1", title: "Need a voice AI dev", company: "@ch", portal: "telegram-channels-search", kind: "lead", fetch_method: "cli", guard_verdict: "posting_guard: clean", flags: { scam: [], discrimination: [] }, contact_routes: [], text_excerpt: "We need a contractor to build a Hindi voice agent on WebRTC. DM me." })

describe("lead DMs (LEAD-7)", () => {
  test("draft is capped at 80 words, uses no tools, and is checked against the profile", async () => {
    const p = tmpWorkspace()
    lead(p)
    const calls: string[][] = []
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about the Hindi voice agent.`).join(" ")
    const r = await draftDm(p, readConfig(p.config), "lead1", async (a) => {
      calls.push(a)
      const isCheck = a[a.indexOf("-p") + 1].startsWith("Compare the MESSAGE")
      return { code: 0, stdout: JSON.stringify({ result: isCheck ? '{"unsupported": []}' : long, total_cost_usd: 0.01 }), stderr: "" }
    })
    expect(r.ok).toBe(true)
    expect(wordCount(r.text)).toBeLessThanOrEqual(DM_MAX_WORDS)
    expect(calls.length).toBe(2)
    expect(calls[0]).not.toContain("--allowedTools")
    expect(calls[0][calls[0].indexOf("-p") + 1]).toContain("Hindi voice agent on WebRTC")
    expect(calls[0][calls[0].indexOf("-p") + 1]).toContain("Test Person")
  })
  test("an unsupported claim triggers one rewrite without it; if it persists, no draft", async () => {
    const p = tmpWorkspace()
    lead(p)
    let n = 0
    const fixed = await draftDm(p, readConfig(p.config), "lead1", async (a) => {
      const prompt = a[a.indexOf("-p") + 1]
      if (prompt.startsWith("Compare the MESSAGE")) return { code: 0, stdout: JSON.stringify({ result: n++ === 0 ? '{"unsupported": ["10 years of Kubernetes"]}' : '{"unsupported": []}' }), stderr: "" }
      return { code: 0, stdout: JSON.stringify({ result: prompt.includes("10 years of Kubernetes") ? "Hi, I build Python apps. Can we talk?" : "Hi, I have 10 years of Kubernetes. Can we talk?" }), stderr: "" }
    })
    expect(fixed.ok).toBe(true)
    expect(fixed.text).not.toContain("Kubernetes")
    const stuck = await draftDm(p, readConfig(p.config), "lead1", async (a) => {
      const prompt = a[a.indexOf("-p") + 1]
      if (prompt.startsWith("Compare the MESSAGE")) return { code: 0, stdout: JSON.stringify({ result: '{"unsupported": ["invented award"]}' }), stderr: "" }
      return { code: 0, stdout: JSON.stringify({ result: "Hi, I won an award. Can we talk?" }), stderr: "" }
    })
    expect(stuck.ok).toBe(false)
    expect(stuck.text).toBe("")
  })
  test("the model can refuse unsuitable posts; nothing is drafted", async () => {
    const p = tmpWorkspace()
    lead(p)
    const r = await draftDm(p, readConfig(p.config), "lead1", async () => ({ code: 0, stdout: JSON.stringify({ result: "NOT_SUITABLE" }), stderr: "" }))
    expect(r.ok).toBe(false)
  })
  test("an unfilled profile means no draft, and no model call is spent", async () => {
    const p = tmpWorkspace()
    lead(p)
    writeFileSync(p.profile, "# Candidate Profile\n\n## Identity\n- **Name:** [YOUR_NAME]\n")
    let called = false
    const r = await draftDm(p, readConfig(p.config), "lead1", async () => { called = true; return { code: 0, stdout: "{}", stderr: "" } })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
  test("a reply about the task itself is never returned as a message", async () => {
    const p = tmpWorkspace()
    lead(p)
    const r = await draftDm(p, readConfig(p.config), "lead1", async () => ({ code: 0, stdout: JSON.stringify({ result: "The candidate profile is unpopulated, so I cannot write an accurate message." }), stderr: "" }))
    expect(r.ok).toBe(false)
  })
  test("no post text means no draft (never invented)", async () => {
    const p = tmpWorkspace()
    const r = await draftDm(p, readConfig(p.config), "missing", async () => ({ code: 0, stdout: "{}", stderr: "" }))
    expect(r.ok).toBe(false)
  })
})

describe("interview prep and offers (INB-4, INB-5)", () => {
  test("finds interviews due tomorrow", () => {
    const p = tmpWorkspace()
    addItem(p.attention, { id: "mail:1", kind: "recruiter_reply", title: "Interview invite from Acme", why: "", action: "", due: "2026-11-12", data: { label: "interview_invite", company: "Acme" } })
    expect(interviewsTomorrow(p, new Date("2026-11-11T19:00:00")).map((x) => x.company)).toEqual(["Acme"])
    expect(interviewsTomorrow(p, new Date("2026-11-10T19:00:00")).length).toBe(0)
  })
  test("offers list known pay and say 'unknown' otherwise", async () => {
    const p = tmpWorkspace(["2026-11-01,Acme,AI,AI Engineer,AI,portal,offer,,70,offer 18 LPA,,,https://e.com/a,", "2026-11-01,Beta,AI,ML Engineer,AI,portal,offer,,60,,,,https://e.com/b,"])
    const t = await compareOffers(p)
    expect(t).toContain("Acme, AI Engineer: pay 18 LPA")
    expect(t).toContain("Beta, ML Engineer: pay unknown")
  })
})

describe("OUT-1: nothing in jobdesk sends messages or applications on its own", () => {
  const SRC = join(import.meta.dir, "..", "src")
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []))
  test("no email, DM or social-posting code anywhere", () => {
    const banned = /\b(nodemailer|smtp|sendmail|mailto:|api\.twitter\.com|api\.x\.com\/2\/(tweets|dm)|reddit\.com\/api\/(submit|comment|compose)|linkedin\.com\/voyager|graph\.facebook\.com|messages\.send)\b/i
    for (const f of files(SRC)) expect([relative(SRC, f), banned.test(readFileSync(f, "utf8"))]).toEqual([relative(SRC, f), false])
  })
  test("only the approval-gated fill runner can click submit", () => {
    const users = files(SRC).filter((f) => /CLICK_SUBMIT_SCRIPT/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f).replace(/\\/g, "/"))
    expect(users.sort()).toEqual(["fill/forms.ts", "fill/runner.ts"])
  })
  test("Telegram sends only go to the paired owner's chat", () => {
    const bot = readFileSync(join(SRC, "bridge", "bot.ts"), "utf8")
    const sends = [...bot.matchAll(/this\.(?:tg\.send(?:File)?|say)\((\w+)/g)].map((m) => m[1])
    expect(new Set(sends)).toEqual(new Set(["chatId", "owner"]))
  })
})
