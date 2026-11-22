import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpWorkspace, HEADER } from "./helpers.ts"
import { readTracker, bucketOf, updateStatus, appendRow, safeNote, followUpsSent } from "../src/data/tracker.ts"
import { parseCsv } from "../src/data/csv.ts"
import { addItem, openItems, resolveItem } from "../src/data/attention.ts"
import { lookup, setAnswer, seedFromProfile, writeBackToProfile, readBank } from "../src/data/answers.ts"
import { upsertLead, publishedContactRoutes } from "../src/data/leads.ts"
import { readSeen, shortlist } from "../src/data/seen.ts"

const ROW_A = "2026-11-01,Acme,AI,AI Engineer,AI Engineer,portal,applied,,70,sent,cv/a.tex,cover_letters/a.tex,https://example.com/a,"
const ROW_B = "2026-11-10,Beta,AI,ML Engineer,ML,portal,drafted,,60,drafted,cv/b.tex,cover_letters/b.tex,https://example.com/b,2026-11-20"
const ROW_C = "2025,Gamma,Bank,Analyst,Analyst,online,no response,,50,,,,https://example.com/c"

describe("tracker (C-4, DSH-1)", () => {
  test("reads 13- and 14-field rows and legacy statuses", () => {
    const p = tmpWorkspace([ROW_A, ROW_B, ROW_C])
    const t = readTracker(p.tracker)
    expect(t.rows.length).toBe(3)
    expect(t.rows[2].deadline).toBe("")
    expect(bucketOf(t.rows[2].status).bucket).toBe("Rejected/Closed")
    expect(bucketOf("drafted").bucket).toBe("Drafted")
    expect(bucketOf("weird").unknown).toBe(true)
  })

  test("status update touches only that row's status/notes; leaving drafted sets the real date", () => {
    const p = tmpWorkspace([ROW_A, ROW_B, ROW_C])
    const before = readFileSync(p.tracker, "utf8").split("\n")
    updateStatus(p.tracker, { company: "Beta" }, "applied", "sent, via portal", "2026-11-12")
    const after = readFileSync(p.tracker, "utf8").split("\n")
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[3]).toBe(before[3])
    const b = readTracker(p.tracker).rows[1]
    expect(b.status).toBe("applied")
    expect(b.date).toBe("2026-11-12")
    expect(b.deadline).toBe("2026-11-20")
    expect(b.notes).not.toContain(",")
    expect(parseCsv(after[2])[0].length).toBe(14)
  })

  test("notes never carry commas, quotes or line breaks", () => {
    expect(safeNote('rejected, no "feedback"\ngiven')).toBe("rejected - no 'feedback' given")
    expect(followUpsSent("followed up 2026-11-01; followed up 2026-11-09")).toBe(2)
  })

  test("refuses to rewrite a tracker with multi-line fields", () => {
    const p = tmpWorkspace()
    writeFileSync(p.tracker, `${HEADER}\n2026-11-01,Acme,AI,Role,R,portal,applied,,1,"two\nlines",,,https://e.com/a,\n`)
    expect(() => updateStatus(p.tracker, { company: "Acme" }, "interview", "x")).toThrow(/line break/)
  })

  test("appendRow writes a parseable row", () => {
    const p = tmpWorkspace([ROW_A])
    appendRow(p.tracker, { date: "2026-11-11", company: "Delta, Inc", role: "Eng", status: "applied", notes: "a, b", source: "https://e.com/d" })
    const t = readTracker(p.tracker)
    expect(t.rows[1].company).toBe("Delta  Inc")
    expect(t.rows[1].notes).toBe("a - b")
  })
})

describe("attention queue (ATT-1..4)", () => {
  test("priority order: deadlines, recruiter replies, blocked applications, the rest", () => {
    const p = tmpWorkspace()
    addItem(p.attention, { id: "o", kind: "other", title: "o", why: "", action: "" })
    addItem(p.attention, { id: "q", kind: "unknown_question", title: "q", why: "", action: "" })
    addItem(p.attention, { id: "r", kind: "recruiter_reply", title: "r", why: "", action: "" })
    addItem(p.attention, { id: "d", kind: "deadline", title: "d", why: "", action: "", due: "2026-11-20" })
    expect(openItems(p.attention).map((i) => i.id)).toEqual(["d", "r", "q", "o"])
  })
  test("re-adding an open item updates it instead of duplicating; resolved items stay recorded", () => {
    const p = tmpWorkspace()
    addItem(p.attention, { id: "x", kind: "other", title: "one", why: "", action: "" })
    addItem(p.attention, { id: "x", kind: "other", title: "two", why: "", action: "" })
    expect(openItems(p.attention).length).toBe(1)
    expect(openItems(p.attention)[0].title).toBe("two")
    resolveItem(p.attention, "x", "done")
    expect(openItems(p.attention).length).toBe(0)
  })
})

describe("answer bank (APP-3, SAFE-4)", () => {
  test("built-in questions match; unknown ones return nothing (never invented)", () => {
    const p = tmpWorkspace()
    seedFromProfile(p.answers, p.profile)
    const bank = readBank(p.answers)
    expect(lookup(bank, "Email address *").answer?.answer).toBe("test.person@example.com")
    expect(lookup(bank, "LinkedIn Profile").answer?.answer).toBe("https://linkedin.com/in/test-person")
    expect(lookup(bank, "Why do you want to work here?").answer).toBeNull()
    expect(lookup(bank, "Notice period").reason).toBe("unknown")
  })
  test("full name is seeded but never split into first/last (name order varies)", () => {
    const p = tmpWorkspace()
    seedFromProfile(p.answers, p.profile)
    const bank = readBank(p.answers)
    expect(bank.full_name.answer).toBe("Test Person")
    expect(bank.first_name).toBeUndefined()
    expect(bank.last_name).toBeUndefined()
  })
  test("sensitive answers are not used unless explicitly allowed", () => {
    const p = tmpWorkspace()
    setAnswer(p.answers, { key: "disability", answer: "Yes" })
    expect(lookup(readBank(p.answers), "Do you have a disability?").reason).toBe("sensitive_not_allowed")
    setAnswer(p.answers, { key: "disability", answer: "Yes", allow_in_applications: true })
    expect(lookup(readBank(p.answers), "Do you have a disability?").answer?.answer).toBe("Yes")
  })
  test("custom questions are remembered by their wording", () => {
    const p = tmpWorkspace()
    setAnswer(p.answers, { question: "Are you comfortable with rotational night shifts?", answer: "Yes" })
    expect(lookup(readBank(p.answers), "Are you comfortable with rotational night shifts").answer?.answer).toBe("Yes")
  })
  test("confirmed facts are written back to the profile; sensitive ones never are", () => {
    const p = tmpWorkspace()
    const a = setAnswer(p.answers, { key: "notice_period", answer: "30 days" })
    expect(writeBackToProfile(p.profile, a)).toBe(true)
    writeBackToProfile(p.profile, setAnswer(p.answers, { key: "notice_period", answer: "45 days" }))
    const text = readFileSync(p.profile, "utf8")
    expect(text).toContain("**Notice period:** 45 days")
    expect(text).not.toContain("30 days")
    expect(writeBackToProfile(p.profile, setAnswer(p.answers, { key: "gender", answer: "x" }))).toBe(false)
  })
})

describe("leads (LEAD-2, LEAD-6)", () => {
  test("a lead without a fetched URL or fetch record is rejected", () => {
    const p = tmpWorkspace()
    const base = { key: "k", title: "t", company: "c", portal: "x", kind: "lead" as const, guard_verdict: "clean", flags: { scam: [], discrimination: [] }, contact_routes: [] }
    expect(() => upsertLead(p.leads, { ...base, url: "", fetch_method: "x" })).toThrow()
    expect(() => upsertLead(p.leads, { ...base, url: "https://e.com", fetch_method: "" })).toThrow()
  })
  test("contact routes are only ones published in the text", () => {
    const r = publishedContactRoutes("Email jobs@acme.example.com or apply at https://jobs.lever.co/acme/1. DM @founder_x")
    expect(r).toContain("jobs@acme.example.com")
    expect(r).toContain("https://jobs.lever.co/acme/1.")
    expect(r).toContain("@founder_x")
  })
})

describe("seen jobs", () => {
  test("shortlist orders ranked jobs by score", () => {
    const p = tmpWorkspace([], {
      a: { title: "A", company: "X", url: "https://e.com/a", status: "ranked", rank_score: 50 },
      b: { title: "B", company: "Y", url: "https://e.com/b", status: "ranked", rank_score: 80 },
      c: { title: "C", company: "Z", url: "https://e.com/c", status: "new" },
    })
    expect(shortlist(readSeen(p.seen)).map((j) => j.key)).toEqual(["b", "a"])
  })
})
