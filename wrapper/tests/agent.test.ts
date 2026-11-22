import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpWorkspace } from "./helpers.ts"
import { callTool, TOOL_DEFS, readOutput } from "../src/agent/tools.ts"
import { readNotes, recentTurns } from "../src/agent/memory.ts"
import { texLines, resumeLines, compareLines, similarity, buildReview, readReview } from "../src/review.ts"
import { prepare, readApps, confirm, markApplied } from "../src/apply.ts"
import { readConfig, writeConfig } from "../src/data/config.ts"
import { readTracker } from "../src/data/tracker.ts"
import { saveScores } from "../src/data/scores.ts"
import { readShown } from "../src/data/recommended.ts"
import { startDashboard } from "../src/dashboard/server.ts"
import { setAnswer } from "../src/data/answers.ts"
import { pdfText } from "../src/intake.ts"
import type { ClaudeExec } from "../src/lib/claude.ts"

const SEEN = {
  v1: { title: "Voice AI Engineer", company: "Bolt", url: "https://boards.greenhouse.io/bolt/1", status: "new", portal: "company-boards-search", first_seen: "2026-11-20" },
  r1: { title: "Sales Lead", company: "Cove", url: "https://e.com/c", status: "new", first_seen: "2026-11-20" },
}
const ok = (result: string, usd = 0.001) => ({ code: 0, stdout: JSON.stringify({ result, total_cost_usd: usd }), stderr: "" })
const promptOf = (args: string[]) => args[args.indexOf("-p") + 1]
/** The file the agent's tool server writes to, as the real server would get it from --mcp-config. */
const outOf = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.jobdesk.env.JOBDESK_AGENT_OUT as string

function ws() {
  const p = tmpWorkspace([], SEEN)
  saveScores(p.scores, { v1: { score: 80, verdict: "Strong Fit", reason: "Voice agents, exactly your work.", strengths: [], gaps: [], location: "PASS", basis: "posting excerpt", date: "2026-11-20", model: "haiku" } })
  return p
}

describe("the agent's tools", () => {
  test("every tool has a schema; looking up is free; show/act/remember only leave requests", () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(["act", "find_jobs", "job_details", "my_applications", "my_profile", "needs_me", "remember", "settings", "show_jobs"])
    const p = ws()
    const out = join(p.data, "out.jsonl")
    const found = JSON.parse(callTool({ p, out }, "find_jobs", {}))
    expect(found.jobs.map((j: { key: string }) => j.key)).toEqual(["v1"])
    expect(found.not_scored_yet).toBe(1)
    expect(JSON.parse(callTool({ p, out }, "job_details", { job: "Bolt" }))).toMatchObject({ key: "v1", fit: 80, how_they_apply: expect.stringContaining("Greenhouse") })
    expect(callTool({ p, out }, "my_profile", {})).not.toContain("test.person@example.com")
    expect(callTool({ p, out }, "show_jobs", { keys: ["v1", "nope"] })).toContain("1 job")
    expect(callTool({ p, out }, "act", { action: "apply v1" })).toContain("Yes/No")
    expect(callTool({ p, out }, "act", { action: "rm -rf /" })).toContain("isn't something")
    callTool({ p, out }, "remember", { note: "No sales roles" })
    callTool({ p, out }, "remember", { note: "no sales roles" })
    expect(readNotes(p)).toEqual(["No sales roles"])
    const got = readOutput(readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)))
    expect(got).toEqual({ show: ["v1"], actions: ["apply v1"], remembered: ["No sales roles", "no sales roles"] })
    // Nothing was applied, marked or changed by the tools themselves.
    expect(readTracker(p.tracker).rows.length).toBe(0)
    expect(readApps(p)).toEqual({})
  })
  test("the real tool server answers MCP over stdio", async () => {
    const p = ws()
    const out = join(p.data, "out.jsonl")
    const proc = Bun.spawn(["bun", "run", resolve(import.meta.dir, "..", "bin", "jobdesk-mcp.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, JOBDESK_ROOT: p.root, JOBDESK_DATA: p.data, JOBDESK_AGENT_OUT: out },
    })
    const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + "\n")
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "act", arguments: { action: "skip r1" } } })
    send({ jsonrpc: "2.0", id: 4, method: "nope" })
    proc.stdin.end()
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.find((l) => l.id === 1).result.serverInfo.name).toBe("jobdesk")
    expect(lines.find((l) => l.id === 2).result.tools.length).toBe(TOOL_DEFS.length)
    expect(lines.find((l) => l.id === 3).result.content[0].text).toContain("Yes/No")
    expect(lines.find((l) => l.id === 4).error.code).toBe(-32601)
    expect(readFileSync(out, "utf8")).toContain("skip r1")
  }, 30_000)
})

describe("what changed in the CV", () => {
  const tex = `\\documentclass{article}\\begin{document}
\\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}r}
  \\textbf{\\LARGE Asha Rao} & Email: \\href{mailto:a@x.com}{a@x.com}\\\\
\\end{tabular*}
\\section{Experience}
\\resumeItem{Voice Agent}{Shipped a \\textbf{voice agent} with barge-in, cutting latency \\textbf{21\\%}.}
\\resumeItem{RAG}{Built hybrid retrieval on pgvector for a multi-tenant platform.}
\\resumeItem{Prompting}{Wrote prompt-engineered dialogue flows for clinics.}
\\end{document}`
  const resume = "Asha Rao Email: a@x.com\nExperience\n• Voice Agent: Shipped a voice agent with barge-in, cutting latency 21%.\n• RAG: Built hybrid retrieval on pgvector\nfor a multi-tenant government assistant.\n• Telemetry: Ran Grafana dashboards for on-call."
  test("LaTeX and resume text become comparable lines", () => {
    const t = texLines(tex)
    expect(t).toContain("Voice Agent: Shipped a voice agent with barge-in, cutting latency 21%.")
    expect(t.join(" ")).not.toMatch(/tabular|extracolsep|\\\\/)
    const r = resumeLines(resume)
    expect(r).toContain("RAG: Built hybrid retrieval on pgvector for a multi-tenant government assistant.")
    expect(r.some((l) => l.startsWith("Experience"))).toBe(false)
  })
  test("same, reworded, new and left out", () => {
    const { changes, same } = compareLines(resumeLines(resume), texLines(tex))
    expect(same).toBe(2)
    expect(changes.find((c) => c.kind === "reworded")?.after).toContain("multi-tenant platform")
    expect(changes.find((c) => c.kind === "new")?.after).toContain("prompt-engineered")
    expect(changes.find((c) => c.kind === "dropped")?.before).toContain("Grafana")
    expect(similarity("a b c", "x y z")).toBe(0)
  })
})

describe("applying: prepare, review, confirm, one tap, applied", () => {
  function drafting(p: ReturnType<typeof ws>, grounding = '{"unsupported": ["Led a team of 5"]}'): ClaudeExec {
    return async (args) => {
      const prompt = promptOf(args)
      if (prompt.includes("Compare the MESSAGE with the PROFILE")) return ok(grounding)
      if (prompt.startsWith("/apply https://e.com/c")) return ok("Weak fit (41/100): it's a sales role. I stopped before drafting.")
      writeFileSync(join(p.root, "cv", "bolt.tex"), "\\begin{document}\n\\resumeItem{Voice}{Built a voice agent with Python, LLM and RAG for a clinic.}\n\\end{document}\n")
      writeFileSync(join(p.root, "cv", "bolt-letter.tex"), "\\begin{document}\n\\lettercontent{I led a team of 5 building voice agents.}\n\\end{document}\n")
      appendFileSync(p.tracker, "2026-11-20,Bolt,AI,Voice AI Engineer,AI,portal,drafted,,80,,cv/bolt.tex,cv/bolt-letter.tex,https://boards.greenhouse.io/bolt/1,\n")
      return ok("Drafted.", 0.5)
    }
  }
  test("/apply is told up front that drafting is approved (it can't ask mid-run), and must still stop on a weak fit", async () => {
    const { DRAFT_PROMPT } = await import("../src/apply.ts")
    const prompt = DRAFT_PROMPT("https://e.com/x")
    expect(prompt.startsWith("/apply https://e.com/x")).toBe(true)
    expect(prompt).toContain("already answered Step 1's question")
    expect(prompt).toContain("Do not ask it")
    expect(prompt).toContain("weak (below 50)")
  })
  test("the same job under two links (a real case): the CV /apply wrote is found, not drafted again", async () => {
    const { jobUrlKey } = await import("../src/lib/joburl.ts")
    const found = "https://in.linkedin.com/jobs/view/genai-ai-engineer-at-prasanz-4448040623"
    const recorded = "https://www.linkedin.com/jobs/view/4448040623"
    expect(jobUrlKey(found)).toBe(jobUrlKey(recorded))
    expect(jobUrlKey("https://www.linkedin.com/jobs/search/?currentJobId=4448040623")).toBe("linkedin:4448040623")
    expect(jobUrlKey("https://boards.greenhouse.io/bolt/jobs/1?gh_src=x")).toBe(jobUrlKey("https://boards.greenhouse.io/bolt/jobs/1/"))
    expect(jobUrlKey("https://boards.greenhouse.io/bolt/jobs/1")).not.toBe(jobUrlKey("https://boards.greenhouse.io/bolt/jobs/2"))
    const p = tmpWorkspace([`2026-11-23,Prasanz,IT,GenAI / AI Engineer,AI,portal,drafted,,57,,cv/prasanz.tex,,${recorded},`], { pz: { title: "GenAI / AI Engineer", company: "Prasanz", url: found, status: "new" } })
    writeFileSync(join(p.root, "cv", "prasanz.tex"), "\\begin{document}\n\\resumeItem{RAG}{Built hybrid retrieval on pgvector.}\n\\end{document}\n")
    const calls: string[] = []
    const r = await prepare(p, readConfig(p.config), { key: "pz", url: found, company: "Prasanz", role: "GenAI / AI Engineer" }, { exec: async (args) => { calls.push(promptOf(args)); return ok('{"unsupported": []}') } })
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.startsWith("/apply"))).toBe(false)
    // And a job already in the tracker is no longer offered as new.
    const { freshPicks } = await import("../src/recommend.ts")
    saveScores(p.scores, { pz: { score: 80, verdict: "", reason: "", strengths: [], gaps: [], location: "PASS", basis: "posting excerpt", date: "x", model: "haiku" } })
    expect(freshPicks(p, readConfig(p.config)).picks).toHaveLength(0)
  })
  test("a CV run killed by a restart shows as interrupted, never as drafting forever", () => {
    const p = ws()
    writeFileSync(join(p.data, "applications.json"), JSON.stringify({
      dead: { key: "dead", url: "https://e.com/d", company: "D", role: "R", stage: "drafting", started: "2026-11-22T20:00:00Z", updated: "2026-11-22T20:00:00Z", pid: 2 ** 22 + 9 },
      old: { key: "old", url: "https://e.com/o", company: "O", role: "R", stage: "drafting", started: "2026-11-22T20:00:00Z", updated: "2026-11-22T20:00:00Z" },
    }))
    const apps = readApps(p)
    expect(apps.dead).toMatchObject({ stage: "failed", note: expect.stringContaining("Interrupted") })
    expect(apps.old.stage).toBe("failed")
  })
  test("a weak fit stops before any CV, and says why", async () => {
    const p = ws()
    const r = await prepare(p, readConfig(p.config), { key: "r1", url: "https://e.com/c", company: "Cove", role: "Sales Lead" }, { exec: drafting(p) })
    expect(r.ok).toBe(false)
    expect(r.report).toContain("sales role")
    expect(readApps(p).r1).toMatchObject({ stage: "stopped", report: expect.stringContaining("sales role") })
    // The page shows the reasons, the posting link and a way to try again.
    const html = (await import("../src/dashboard/page.ts")).renderPage("t")
    expect(html).toContain("Why it stopped")
    expect(html).toContain("View posting")
  })
  test("spending limit: the user's own number, or none at all", async () => {
    const { budgetLeft, budgetText, runClaude } = await import("../src/lib/claude.ts")
    const p = ws()
    const cfg = readConfig(p.config)
    cfg.monthly_budget_usd = null
    writeConfig(p.config, cfg)
    appendFileSync(p.costs, JSON.stringify({ at: new Date().toISOString(), task: "draft", model: "sonnet", usd: 50, ok: true }) + "\n")
    expect(budgetLeft(p.costs, cfg)).toBe(Infinity)
    expect(budgetText(p.costs, cfg)).toBe("No spending limit. $50.00 spent this month.")
    let ran = false
    const r = await runClaude({ root: p.root, ledger: p.costs, cfg, task: "chat", prompt: "x", allowedTools: [], exec: async () => { ran = true; return ok("hi") } })
    expect(ran).toBe(true)
    expect(r.ok).toBe(true)
    cfg.monthly_budget_usd = 20
    expect(budgetText(p.costs, cfg)).toBe("$0.00 of $20 left this month.")
  })
  test("drafted: the review lists the changes and flags what the profile doesn't support; nothing is sent", async () => {
    const p = ws()
    setAnswer(p.answers, { question: "Email", answer: "asha@example.com" })
    const job = { key: "v1", url: "https://boards.greenhouse.io/bolt/1", company: "Bolt", role: "Voice AI Engineer" }
    const exec = drafting(p)
    const [a, b] = await Promise.all([prepare(p, readConfig(p.config), job, { exec }), prepare(p, readConfig(p.config), job, { exec })])
    expect(a).toBe(b) // a double tap runs it once
    expect(readTracker(p.tracker).rows.length).toBe(1)
    const r = a.review!
    expect(r.changes.some((c) => c.after?.includes("Built a voice agent"))).toBe(true)
    expect(r.letter.text).toContain("I led a team of 5")
    expect(r.unsupported).toEqual(["Led a team of 5"])
    expect(r.fields.find((f) => f.label === "Email")).toMatchObject({ value: "asha@example.com" })
    expect(r.how).toBe("kit")
    expect(readApps(p).v1.stage).toBe("ready")
    expect(readShown(p.recommended).v1.reaction).toBe("drafted")
    expect(readTracker(p.tracker).rows[0].status).toBe("drafted")
    // Confirm: the kit, with the page to open. Then "I applied".
    const c = confirm(p, "v1")
    expect(c.how).toBe("kit")
    expect(c.kit.url).toBe("https://boards.greenhouse.io/bolt/1")
    expect(readApps(p).v1.stage).toBe("confirmed")
    expect(markApplied(p, "v1")).toMatchObject({ company: "Bolt" })
    expect(readTracker(p.tracker).rows[0].status).toBe("applied")
    expect(readApps(p).v1.stage).toBe("applied")
  })
  test("with 'fill and confirm' on a Greenhouse job, the review says the form is filled and waits for Send", async () => {
    const p = ws()
    const cfg = readConfig(p.config)
    cfg.approval_level = "L1"
    writeConfig(p.config, cfg)
    await prepare(p, cfg, { key: "v1", url: "https://boards.greenhouse.io/bolt/1", company: "Bolt", role: "Voice AI Engineer" }, { exec: drafting(p, '{"unsupported": []}') })
    const r = readReview(p, "v1")!
    expect(r.how).toBe("fill")
    expect(r.how_note).toContain("Nothing is sent until you tap Send")
    expect(r.checked).toBe(true)
  })
})

describe("the dashboard: chat and apply", () => {
  const p = ws()
  const seenPrompts: string[] = []
  const filled: string[] = []
  const exec: ClaudeExec = async (args) => {
    const prompt = promptOf(args)
    seenPrompts.push(prompt)
    if (prompt.includes("Compare the MESSAGE with the PROFILE")) return ok('{"unsupported": []}')
    if (prompt.startsWith("/apply ")) {
      writeFileSync(join(p.root, "cv", "bolt.tex"), "\\begin{document}\n\\resumeItem{Voice}{Built a voice agent.}\n\\end{document}\n")
      appendFileSync(p.tracker, "2026-11-20,Bolt,AI,Voice AI Engineer,AI,portal,drafted,,80,,cv/bolt.tex,,https://boards.greenhouse.io/bolt/1,\n")
      return ok("Drafted.", 0.5)
    }
    // The agent: looks up, shows the job, asks to apply, keeps a note. Like the real tool server would.
    const out = outOf(args)
    appendFileSync(out, JSON.stringify({ type: "show", keys: ["v1"] }) + "\n" + JSON.stringify({ type: "act", action: "apply v1" }) + "\n" + JSON.stringify({ type: "act", action: "status" }) + "\n")
    return ok("Bolt is the one: voice agents are exactly your work. Tap Yes and I'll write the CV.")
  }
  const h = startDashboard(p, 0, { claudeExec: exec, fillFn: async (o) => { filled.push(o.url); return { status: "cancelled", message: "x" } } })
  afterAll(() => h.stop())
  const base = h.url.replace(/\/$/, "")
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-jobdesk-token": h.token }, body: JSON.stringify(body) }).then((r) => r.json())

  test("one message: a reply, the job it picked, free actions done, the rest waiting for Yes", async () => {
    const r = await post("/api/agent/ask", { text: "anything good today?" })
    expect(r.reply).toContain("Bolt is the one")
    expect(r.jobs.map((j: { key: string }) => j.key)).toEqual(["v1"])
    expect(r.results[0].text).toContain("Drafted 0")
    expect(r.proposals).toHaveLength(1)
    expect(r.proposals[0].question).toContain("Write a CV and letter for Voice AI Engineer at Bolt?")
    // Not done until Yes.
    expect(seenPrompts.some((x) => x.startsWith("/apply"))).toBe(false)
    expect(readShown(p.recommended).v1).toBeTruthy()
    // The agent got its tools, and the conversation is kept.
    expect(seenPrompts[0]).toContain("YOUR TOOLS")
    expect(recentTurns(p).map((t) => t.role)).toEqual(["user", "assistant", "assistant"])
    const hist = await (await fetch(base + "/api/agent/history")).json()
    expect(hist.proposals).toHaveLength(1)
    const yes = await post("/api/agent/confirm", { id: r.proposals[0].id, yes: true })
    expect(yes.text).toContain("Writing the CV and letter")
    for (let i = 0; i < 50 && readApps(p).v1?.stage !== "ready"; i++) await Bun.sleep(20)
    expect(readApps(p).v1.stage).toBe("ready")
    expect((await post("/api/agent/confirm", { id: r.proposals[0].id, yes: true })).error).toContain("expired")
  })
  test("review, confirm (kit and one tap), then applied", async () => {
    const rv = await (await fetch(base + "/api/apply/review?key=v1")).json()
    expect(rv.review.company).toBe("Bolt")
    expect(rv.state.stage).toBe("ready")
    const c = await post("/api/apply/confirm", { id: "v1" })
    expect(c).toMatchObject({ ok: true, how: "kit", kit: { url: "https://boards.greenhouse.io/bolt/1" } })
    expect(filled).toEqual([])
    expect((await post("/api/apply/applied", { id: "v1" })).ok).toBe(true)
    expect(readTracker(p.tracker).rows[0].status).toBe("applied")
    const s = await (await fetch(base + "/api/state")).json()
    expect(s.preparing.find((a: { key: string }) => a.key === "v1").stage).toBe("applied")
  })
})

describe("reading a PDF resume", () => {
  test("a scan or broken file gives no text (Claude reads it instead), never a crash", async () => {
    const p = tmpWorkspace()
    const f = join(p.data, "broken.pdf")
    writeFileSync(f, "%PDF-1.4 not really")
    expect(await pdfText(f)).toBe("")
  })
  test("a real resume PDF on this computer is read (skipped when there is none)", async () => {
    const real = resolve(import.meta.dir, "..", "..", "documents", "cv")
    if (!existsSync(real)) return
    const pdf = (await import("node:fs")).readdirSync(real).find((x) => x.toLowerCase().endsWith(".pdf"))
    if (!pdf) return
    expect((await pdfText(join(real, pdf))).length).toBeGreaterThan(200)
  }, 30_000)
})
