// The whole journey a new user takes, in one test, the way they take it: a fresh checkout with the
// template profile -> setup in the dashboard -> a search finds jobs -> they're scored -> the
// assistant suggests one -> Yes -> CV and letter written -> review -> confirm -> one tap -> applied.
// Then the phone sees the same state. Every model call is a stand-in, so this costs nothing to run.

import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace } from "./helpers.ts"
import { startDashboard } from "../src/dashboard/server.ts"
import { readConfig, writeConfig } from "../src/data/config.ts"
import { readTracker } from "../src/data/tracker.ts"
import { upsertLead } from "../src/data/leads.ts"
import { Bot } from "../src/bridge/bot.ts"
import { Telegram, type TgUpdate } from "../src/bridge/telegram.ts"
import type { ClaudeExec } from "../src/lib/claude.ts"

const TEMPLATE = "---\nframework_version: 1.1.1\n---\n\n# Candidate Profile\n\n## Identity\n- **Name:** [YOUR_NAME]\n"
const RESUME = "Priya Nair\nKochi\nBackend engineer, 2 years at Finly: built payment APIs in Python and FastAPI, ran PostgreSQL.\nB.Tech Computer Science, 2022."
const GOOD = { key: "good", title: "Backend Engineer (Python)", company: "Bolt", url: "https://boards.greenhouse.io/bolt/1" }
const WEAK = { key: "weak", title: "Senior Sales Manager", company: "Cove", url: "https://e.com/cove" }

describe("a new user, start to finish", () => {
  const p = tmpWorkspace()
  writeFileSync(p.profile, TEMPLATE)
  const prompts: string[] = []
  const exec: ClaudeExec = async (args) => {
    const prompt = args[args.indexOf("-p") + 1]
    prompts.push(prompt.slice(0, 60))
    const ok = (result: string, usd = 0.002) => ({ code: 0, stdout: JSON.stringify({ result, total_cost_usd: usd }), stderr: "" })
    if (prompt.includes("Turn this person's resume into their candidate profile"))
      return ok("# Candidate Profile\n\n## Identity\n- **Name:** Priya Nair\n- **Location:** Kochi\n- **Email:** pending\n\n## Professional Experience\n\n### Backend Engineer - Finly (pending - pending)\n- Built payment APIs in Python and FastAPI, ran PostgreSQL.\n", 0.05)
    if (prompt.includes("Compare the MESSAGE with the PROFILE")) return ok('{"unsupported": []}')
    if (prompt.includes("You score job postings")) {
      const keys = [...prompt.matchAll(/<job key="([^"]+)">/g)].map((m) => m[1])
      return ok(JSON.stringify({ results: keys.map((key) => key === "good"
        ? { key, technical: 85, experience: 75, behavioral: 70, career: 85, location: "PASS", reason: "Python payment APIs, exactly your work.", gaps: ["Wants Kafka"] }
        : { key, technical: 10, experience: 20, behavioral: 50, career: 5, location: "PASS", reason: "A sales role." }) }))
    }
    if (prompt.includes("job-search mentor")) {
      const out = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.jobdesk.env.JOBDESK_AGENT_OUT
      appendFileSync(out, JSON.stringify({ type: "show", keys: ["good"] }) + "\n" + JSON.stringify({ type: "act", action: "apply good" }) + "\n")
      return ok("Bolt is worth it: Python payment APIs are your work. Tap Yes and I'll write the CV.")
    }
    if (prompt.startsWith("/apply https://boards.greenhouse.io/bolt/1")) {
      writeFileSync(join(p.root, "cv", "bolt.tex"), "\\begin{document}\n\\resumeItem{Payments}{Built payment APIs in Python and FastAPI for a fintech.}\n\\end{document}\n")
      appendFileSync(p.tracker, "2026-11-23,Bolt,Fintech,Backend Engineer (Python),Backend,portal,drafted,,82,,cv/bolt.tex,,https://boards.greenhouse.io/bolt/1,\n")
      return ok("Drafted.", 0.6)
    }
    return ok("")
  }
  const h = startDashboard(p, 0, { claudeExec: exec })
  afterAll(() => h.stop())
  const base = h.url.replace(/\/$/, "")
  const get = (path: string) => fetch(base + path).then((r) => r.json())
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-jobdesk-token": h.token }, body: JSON.stringify(body) }).then((r) => r.json())
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await Bun.sleep(15)
    }
    throw new Error("timed out")
  }
  const taskDone = (id: string) => until(async () => (await get("/api/state")).tasks.some((t: { id: string; status: string }) => t.id === id && t.status === "done"))

  test("1. setup in the dashboard: resume -> drafted profile -> saved; roles and places", async () => {
    expect((await get("/api/setup")).complete).toBe(false)
    const fd = new FormData()
    fd.append("file", new File([RESUME], "priya.txt"))
    const up = await (await fetch(base + "/api/setup/resume", { method: "POST", headers: { "x-jobdesk-token": h.token }, body: fd })).json()
    expect(up.ok).toBe(true)
    const { task } = await post("/api/setup/profile/draft", { file: up.file })
    await taskDone(task.id)
    const draft = (await get("/api/state")).tasks.find((t: { id: string }) => t.id === task.id).result
    expect(draft.markdown).toContain("Priya Nair")
    expect((await post("/api/setup/profile/save", { markdown: draft.markdown })).ok).toBe(true)
    expect((await post("/api/setup/looking-for", { queries: "Backend Engineer", locations: "Kochi, Remote" })).ok).toBe(true)
    expect((await get("/api/setup")).complete).toBe(true)
  })

  test("2. a search finds two jobs; scoring keeps only the one that fits", async () => {
    // What a search stores (the search itself is tested on its own): the jobs and their text.
    writeFileSync(p.seen, JSON.stringify({ seen: Object.fromEntries([GOOD, WEAK].map((j) => [j.key, { title: j.title, company: j.company, url: j.url, status: "new", first_seen: "2026-11-23" }])) }))
    for (const j of [GOOD, WEAK]) upsertLead(p.leads, { key: j.key, url: j.url, title: j.title, company: j.company, portal: "company-boards-search", kind: "job", fetch_method: "cli", guard_verdict: "clean", flags: { scam: [], discrimination: [] }, contact_routes: [], text_excerpt: `${j.title} at ${j.company}.` })
    let s = await get("/api/state")
    expect(s.scoring.unscored).toBe(2)
    expect(s.jobs.filter((j: { fresh: boolean }) => j.fresh)).toHaveLength(0) // nothing counts as a fit before it's scored
    const { task } = await post("/api/jobs/score")
    await taskDone(task.id)
    s = await get("/api/state")
    expect(s.scoring.unscored).toBe(0)
    expect(s.jobs.filter((j: { fresh: boolean }) => j.fresh).map((j: { key: string }) => j.key)).toEqual(["good"])
  })

  test("3. the assistant picks the job and asks before doing anything; Yes starts the CV", async () => {
    const r = await post("/api/agent/ask", { text: "anything good for me?" })
    expect(r.jobs.map((j: { key: string }) => j.key)).toEqual(["good"])
    expect(r.proposals[0].question).toContain("Write a CV and letter for Backend Engineer (Python) at Bolt?")
    expect(readTracker(p.tracker).rows).toHaveLength(0)
    await post("/api/agent/confirm", { id: r.proposals[0].id, yes: true })
    await until(async () => (await get("/api/state")).preparing.some((a: { key: string; stage: string }) => a.key === "good" && a.stage === "ready"))
  })

  test("4. review -> confirm -> one tap -> applied; nothing was sent along the way", async () => {
    const rv = await get("/api/apply/review?key=good")
    expect(rv.review.changes.some((c: { after?: string }) => c.after?.includes("payment APIs"))).toBe(true)
    expect(rv.review.checked).toBe(true)
    expect(readTracker(p.tracker).rows[0].status).toBe("drafted")
    const c = await post("/api/apply/confirm", { id: "good" })
    expect(c).toMatchObject({ how: "kit", kit: { url: GOOD.url } })
    expect((await post("/api/apply/applied", { id: "good" })).ok).toBe(true)
    expect(readTracker(p.tracker).rows[0].status).toBe("applied")
    const s = await get("/api/state")
    expect(s.totals.applications).toBe(1)
    expect(s.jobs.filter((j: { fresh: boolean }) => j.fresh)).toHaveLength(0)
  })

  test("5. the phone sees the same state: no repeats, the application is there", async () => {
    const c = readConfig(p.config)
    c.telegram.owner_chat_id = 7
    writeConfig(p.config, c)
    const sent: string[] = []
    const tg = new Telegram("1:x", (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"))
      if (b.text) sent.push(String(b.text))
      return new Response(JSON.stringify({ ok: true, result: true }))
    }) as never)
    const bot = new Bot({ paths: p, tg, pairCode: "1", claudeExec: exec })
    const msg = (text: string): TgUpdate => ({ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, text } })
    await bot.handle(msg("/jobs"))
    expect(sent.at(-1)).toContain("Nothing new that fits you")
    await bot.handle(msg("/status"))
    expect(sent.at(-1)).toContain("Sent, waiting: 1")
    // Model calls across the whole journey: profile, its check, 1 scoring batch, chat, CV, its check.
    expect(prompts.length).toBe(6)
  })
})
