import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { startDashboard } from "../src/dashboard/server.ts"
import { addItem, openItems } from "../src/data/attention.ts"
import { readTracker } from "../src/data/tracker.ts"
import { readBank } from "../src/data/answers.ts"

const p = tmpWorkspace(
  [
    "2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,,cv/acme.tex,,https://e.com/a,",
    "2026-11-02,Beta,AI,ML Engineer,ML,portal,interview,,60,,,,https://e.com/b,",
    "2026-11-03,Gamma,AI,Analyst,ML,online,drafted,,60,,,,https://e.com/c,",
    "2025,Delta,Bank,Analyst,ML,online,no response,,40,,,,https://e.com/d",
  ],
  { a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 70, portal: "hirist-search" } },
)
writeFileSync(join(p.root, "cv", "acme.pdf"), TINY_PDF)
const h = startDashboard(p, 0)
afterAll(() => h.stop())
const base = h.url.replace(/\/$/, "")

describe("dashboard (DSH-1..7)", () => {
  test("page makes no external requests: no http(s) URLs to other hosts in the HTML", async () => {
    const html = await (await fetch(base + "/")).text()
    const ext = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)]
    expect(ext.length).toBe(0)
    expect(html).not.toMatch(/<link[^>]+stylesheet[^>]+http/i)
    expect(html).toContain('lang="en"')
  })
  test("counts match the tracker exactly (DSH-1)", async () => {
    const s = await (await fetch(base + "/api/state")).json()
    expect(s.buckets).toEqual({ Drafted: 1, Active: 1, Interview: 1, Offer: 0, Hired: 0, "Rejected/Closed": 1 })
    expect(s.totals.applications).toBe(3)
    expect(s.applications.find((a: { company: string }) => a.company === "Acme").cv_exists).toBe(true)
  })
  test("live update reaches the page within 5 s of a tracker change (DSH-2)", async () => {
    const res = await fetch(base + "/events")
    const reader = res.body!.getReader()
    await reader.read() // retry line
    const t0 = Date.now()
    setTimeout(() => appendFileSync(p.tracker, "2026-11-05,Epsilon,AI,Eng,E,portal,applied,,1,,,,https://e.com/e,\n"), 300)
    let got = ""
    while (!got.includes("change") && Date.now() - t0 < 5000) got += new TextDecoder().decode((await reader.read()).value)
    reader.cancel()
    expect(got).toContain("change")
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  test("writes need the session token; a foreign Host header is refused", async () => {
    addItem(p.attention, { id: "x1", kind: "other", title: "t", why: "", action: "" })
    const no = await fetch(base + "/api/attention/resolve", { method: "POST", body: JSON.stringify({ id: "x1" }), headers: { "content-type": "application/json" } })
    expect(no.status).toBe(403)
    const evil = await fetch(base + "/api/state", { headers: { host: "evil.example.com" } })
    expect(evil.status).toBe(403)
    const ok = await fetch(base + "/api/attention/resolve", { method: "POST", body: JSON.stringify({ id: "x1" }), headers: { "content-type": "application/json", "x-jobdesk-token": h.token } })
    expect(ok.status).toBe(200)
    expect(openItems(p.attention).length).toBe(0)
  })
  test("answering a question saves it to the bank and the profile", async () => {
    addItem(p.attention, { id: "q1", kind: "unknown_question", title: "Acme asks: Notice period", why: "", action: "", data: { question: "Notice period" } })
    const r = await fetch(base + "/api/attention/answer", { method: "POST", body: JSON.stringify({ id: "q1", answer: "30 days" }), headers: { "x-jobdesk-token": h.token } })
    expect(r.status).toBe(200)
    expect(readBank(p.answers).notice_period.answer).toBe("30 days")
  })
  test("confirming a rejection updates the tracker the /outcome way", async () => {
    addItem(p.attention, { id: "m1", kind: "other", title: "rej", why: "", action: "", data: { company: "Beta", confirm_status: "rejected" } })
    const r = await fetch(base + "/api/attention/confirm", { method: "POST", body: JSON.stringify({ id: "m1" }), headers: { "x-jobdesk-token": h.token } })
    expect(r.status).toBe(200)
    expect(readTracker(p.tracker).rows.find((x) => x.company === "Beta")?.status).toBe("rejected")
  })
  test("files are served only from document folders; traversal is refused", async () => {
    expect((await fetch(base + "/file?path=cv/acme.pdf")).status).toBe(200)
    expect((await fetch(base + "/file?path=../../etc/passwd")).status).toBe(404)
    expect((await fetch(base + "/file?path=wrapper-data/answer_bank.json")).status).toBe(404)
  })
  test("500 applications compute in under 2 s (DSH-7)", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => `2026-11-01,Co${i},AI,Role ${i},R,portal,applied,,50,,,,https://e.com/x${i},`)
    appendFileSync(p.tracker, rows.join("\n") + "\n")
    const t0 = performance.now()
    const s = await (await fetch(base + "/api/state")).json()
    expect(s.applications.length).toBeGreaterThan(500)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
