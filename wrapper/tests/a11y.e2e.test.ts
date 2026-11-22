// DSH-6: axe-core (WCAG 2.0/2.1/2.2 A and AA rules) in a real headless Chrome/Edge on every dashboard
// page, the application review panel, the one-tap kit panel, and a kit file. Also checks the keyboard
// path through the sidebar and that phone width never scrolls sideways.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { startDashboard, type DashboardHandle } from "../src/dashboard/server.ts"
import { findBrowser } from "../src/doctor.ts"
import { launchBrowser, pageSession, evaluate, type Browser, type CDP } from "../src/fill/cdp.ts"
import { addItem } from "../src/data/attention.ts"
import { buildKit } from "../src/kit.ts"
import { setAnswer } from "../src/data/answers.ts"
import { saveScores } from "../src/data/scores.ts"
import { reviewFile, type ApplicationReview } from "../src/review.ts"
import { writeJson } from "../src/lib/store.ts"

const exe = findBrowser()
const axePath = join(import.meta.dir, "..", "node_modules", "axe-core", "axe.min.js")
const ready = !!exe && existsSync(axePath)

let h: DashboardHandle
let b: Browser
let c: CDP
let kitPath = ""
const PAGES = ["overview", "jobs", "applications", "assistant", "inbox", "insights", "settings"]

beforeAll(async () => {
  if (!ready) return
  const p = tmpWorkspace(
    ["2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,sent,cv/acme.tex,,https://e.com/a,", "2026-11-02,Beta,AI,ML Engineer,ML,portal,drafted,,60,,cv/beta.tex,,https://boards.greenhouse.io/beta/1,2026-11-20"],
    {
      a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 70, portal: "hirist-search" },
      b: { title: "ML Engineer", company: "Beta", url: "https://boards.greenhouse.io/beta/1", status: "new", portal: "company-boards-search" },
      c: { title: "Voice AI Engineer", company: "Cove", url: "https://e.com/c", status: "new", portal: "linkedin-search", location: "Remote" },
    },
  )
  saveScores(p.scores, { c: { score: 78, verdict: "Strong Fit", reason: "Strong on voice agents.", strengths: [], gaps: ["Wants Go"], location: "PASS", basis: "posting excerpt", date: "2026-11-20", model: "haiku" } })
  writeFileSync(join(p.root, "cv", "acme.pdf"), TINY_PDF)
  addItem(p.attention, { id: "q1", kind: "unknown_question", title: "Acme asks: Notice period", why: "Not in your answer bank.", action: "Type your answer.", data: { question: "Notice period" } })
  addItem(p.attention, { id: "d1", kind: "deadline", title: "Deadline soon: Beta", why: "Closes soon.", action: "Submit.", due: "2026-11-20" })
  setAnswer(p.answers, { question: "Email", answer: "a@example.com" })
  kitPath = buildKit(p, "https://e.com/a").html_path
  // A prepared application waiting for review.
  const review: ApplicationReview = {
    key: "b", url: "https://boards.greenhouse.io/beta/1", company: "Beta", role: "ML Engineer", site: "Greenhouse", how: "kit", how_note: "You apply on Greenhouse yourself.",
    cv: { tex: "cv/beta.tex", pdf: "cv/beta.pdf", pdf_exists: false }, letter: { tex: "", pdf: "", pdf_exists: false, text: "Dear team,\n\nI build voice agents." },
    base: "documents/cv/resume.pdf", changes: [{ kind: "new", after: "Built a RAG pipeline." }, { kind: "reworded", before: "Did voice.", after: "Shipped a voice agent." }, { kind: "dropped", before: "Old line." }],
    unchanged: 9, fields: [{ label: "Email", value: "a@example.com", source: "your saved answers" }], unsupported: ["Team lead"], checked: true, warnings: [], created: "2026-11-20T00:00:00Z", usd: 0,
  }
  mkdirSync(join(p.reviews, "applications"), { recursive: true })
  writeJson(reviewFile(p, "b"), review)
  writeJson(join(p.data, "applications.json"), { b: { key: "b", url: review.url, company: "Beta", role: "ML Engineer", stage: "ready", started: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z" } })
  h = startDashboard(p, 0)
  b = await launchBrowser(exe!, mkdtempSync(join(tmpdir(), "a11y-")), { headless: true })
  c = await pageSession(b)
  await c.send("Page.enable")
})
afterAll(async () => {
  c?.close()
  await b?.close()
  h?.stop()
})

let nav = 0
async function load(url: string, width = 1280) {
  await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
  const loaded = c.waitFor("Page.loadEventFired", 30_000)
  // A unique query each time: a change of #hash alone is not a page load.
  const [base, hash] = url.split("#")
  await c.send("Page.navigate", { url: `${base}${base.includes("?") ? "&" : "?"}n=${++nav}${hash ? `#${hash}` : ""}` })
  await loaded
  await Bun.sleep(700)
}

async function axe(): Promise<{ id: string; impact: string; nodes: number; help: string }[]> {
  await evaluate(c, readFileSync(axePath, "utf8") + ";true")
  return evaluate(c, `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help + ' @ ' + v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ') })))`)
}

describe.skipIf(!ready)("accessibility (DSH-6)", () => {
  test("every page: 0 axe violations", async () => {
    await load(h.url)
    const all: string[] = []
    for (const pg of PAGES) {
      await evaluate(c, `(() => { document.getElementById('nav-${pg}').click(); return true })()`)
      await Bun.sleep(350)
      expect(await evaluate<boolean>(c, `!document.getElementById('p-${pg}').hidden`)).toBe(true)
      for (const v of await axe()) all.push(`${pg}: ${v.id} (${v.impact}, ${v.nodes}) ${v.help}`)
    }
    expect(all).toEqual([])
  }, 90_000)
  test("review panel and one-tap kit panel: 0 axe violations, and they show what changed", async () => {
    await load(`${h.url}#applications`)
    await evaluate(c, `(() => { document.querySelector('[data-review="b"]').click(); return true })()`)
    await Bun.sleep(500)
    const text = await evaluate<string>(c, "document.getElementById('rv').innerText")
    expect(text).toContain("Shipped a voice agent.")
    expect(text).toContain("Team lead")
    expect((await axe()).map((v) => `${v.id}: ${v.help}`)).toEqual([])
    await evaluate(c, `(() => { document.querySelector('[data-confirm-apply="b"]').click(); return true })()`)
    await Bun.sleep(600)
    expect(await evaluate<string>(c, "document.getElementById('rv').innerText")).toContain("Open the application page")
    expect((await axe()).map((v) => `${v.id}: ${v.help}`)).toEqual([])
  }, 60_000)
  test("kit page: 0 axe violations", async () => {
    await load(`${h.url}file?path=${encodeURIComponent(kitPath)}`)
    expect((await axe()).map((v) => `${v.id}: ${v.help}`)).toEqual([])
  }, 60_000)
  test("keyboard: the sidebar is reachable and marks the current page", async () => {
    await load(`${h.url}#jobs`)
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
    expect(await evaluate<string>(c, "document.activeElement.id")).toBe("nav-overview")
    expect(await evaluate<string>(c, "document.querySelector('nav a[aria-current=page]').id")).toBe("nav-jobs")
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await Bun.sleep(300)
    expect(await evaluate<boolean>(c, "!document.getElementById('p-overview').hidden")).toBe(true)
  }, 60_000)
  test("phone width: no page scrolls sideways", async () => {
    const wide: string[] = []
    for (const pg of PAGES) {
      await load(`${h.url}#${pg}`, 390)
      const over = await evaluate<number>(c, "document.documentElement.scrollWidth - window.innerWidth")
      if (over > 0) wide.push(`${pg}: ${over}px`)
    }
    expect(wide).toEqual([])
  }, 90_000)
})
