import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { Bot } from "../src/bridge/bot.ts"
import { Telegram, type TgUpdate } from "../src/bridge/telegram.ts"
import { readConfig, writeConfig } from "../src/data/config.ts"

const RESUME = "Asha Rao\nData Analyst, Pune\nSkills: SQL, Python, Tableau\nAnalyst, Acme Retail (2022 - 2025)"

function harness(claude: (prompt: string) => string) {
  const p = tmpWorkspace(["2026-11-01,Acme,AI,AI Engineer,AI,portal,drafted,,70,,cv/Asha_Acme.tex,,https://e.com/a,"])
  const c = readConfig(p.config); c.telegram.owner_chat_id = 7; writeConfig(p.config, c)
  const sent: { method: string; body: Record<string, unknown> }[] = []
  const fake = async (url: string, init?: RequestInit) => {
    if (url.includes("/file/bot")) return new Response(RESUME)
    const method = url.split("/").pop()!
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(String(init?.body ?? "{}"))
    sent.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: method === "getFile" ? { file_path: "documents/file_1.txt" } : true }))
  }
  const prompts: string[] = []
  const bot = new Bot({
    paths: p, tg: new Telegram("1:x", fake as never), pairCode: "1",
    claudeExec: async (args) => {
      const prompt = args[args.indexOf("-p") + 1]
      prompts.push(prompt)
      return { code: 0, stdout: JSON.stringify({ result: claude(prompt), total_cost_usd: 0.01 }), stderr: "" }
    },
  })
  let n = 0
  const msg = (extra: Partial<TgUpdate["message"]>): TgUpdate => ({ update_id: ++n, message: { message_id: n, chat: { id: 7, type: "private" }, ...extra } as never })
  const cb = (data: string): TgUpdate => ({ update_id: ++n, callback_query: { id: `c${n}`, from: { id: 7 }, message: { message_id: 1, chat: { id: 7, type: "private" } }, data } })
  const texts = () => sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text))
  const lastKb = () => [...sent].reverse().find((s) => s.body.reply_markup)?.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  return { p, bot, sent, msg, cb, texts, lastKb, prompts }
}

describe("phone bridge: files and chat", () => {
  test("a resume sent as a file is saved to documents/cv, read, and summarised", async () => {
    const h = harness(() => "")
    await h.bot.handle(h.msg({ document: { file_id: "f1", file_name: "Asha_Resume.txt", file_size: 200 } }))
    const saved = readdirSync(join(h.p.root, "documents", "cv"))
    expect(saved).toContain("Asha_Resume.txt")
    expect(h.texts().at(-1)).toContain("Asha Rao")
    expect(h.lastKb().inline_keyboard[0].map((b) => b.text)).toEqual(["Update my profile", "Just keep the file"])
  })
  test("unsupported or huge files are refused politely", async () => {
    const h = harness(() => "")
    await h.bot.handle(h.msg({ document: { file_id: "f", file_name: "virus.exe", file_size: 10 } }))
    expect(h.texts().at(-1)).toContain("PDF, Word")
    await h.bot.handle(h.msg({ document: { file_id: "f", file_name: "big.pdf", file_size: 40 * 1024 * 1024 } }))
    expect(h.texts().at(-1)).toContain("over 15 MB")
  })
  test("'Update my profile' keeps a backup and only writes a checked, grounded profile", async () => {
    const newProfile = "# Candidate Profile\n\n## Identity\n- **Name:** Asha Rao\n- **Location:** Pune\n"
    const h = harness((prompt) => (prompt.startsWith("Compare the MESSAGE") ? '{"unsupported": []}' : `<<<FILE\n${newProfile}FILE>>>`))
    const before = readFileSync(h.p.profile, "utf8")
    await h.bot.handle(h.msg({ document: { file_id: "f1", file_name: "Asha.txt", file_size: 200 } }))
    await h.bot.handle(h.cb(h.lastKb().inline_keyboard[0][0].callback_data))
    expect(readFileSync(h.p.profile, "utf8")).toContain("Asha Rao")
    const backups = readdirSync(join(h.p.root, ".claude", "skills", "job-application-assistant")).filter((f) => f.includes(".bak-"))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(h.p.root, ".claude", "skills", "job-application-assistant", backups[0]), "utf8")).toBe(before)
  })
  test("an update that adds unsupported facts is refused and the profile is unchanged", async () => {
    const h = harness((prompt) => (prompt.startsWith("Compare the MESSAGE") ? '{"unsupported": ["PhD from MIT"]}' : "<<<FILE\n## Identity\n- **Name:** Asha Rao, PhD (MIT)\nFILE>>>"))
    const before = readFileSync(h.p.profile, "utf8")
    await h.bot.handle(h.msg({ document: { file_id: "f1", file_name: "Asha.txt", file_size: 200 } }))
    await h.bot.handle(h.cb(h.lastKb().inline_keyboard[0][0].callback_data))
    expect(readFileSync(h.p.profile, "utf8")).toBe(before)
    expect(h.texts().at(-1)).toContain("PhD from MIT")
  })
  test("/resume sends the tailored CV and the original", async () => {
    const h = harness(() => "")
    writeFileSync(join(h.p.root, "cv", "Asha_Acme.pdf"), TINY_PDF)
    mkdirSync(join(h.p.root, "documents", "cv"), { recursive: true })
    writeFileSync(join(h.p.root, "documents", "cv", "Asha_Original.pdf"), TINY_PDF)
    await h.bot.handle(h.msg({ text: "/resume" }))
    expect(h.sent.filter((s) => s.method === "sendDocument").length).toBe(2)
    await h.bot.handle(h.msg({ text: "/resume Nobody" }))
    expect(h.texts().at(-1)).toContain("don't have a resume made for")
  })
  test("chat can run safe actions (jobs, resume) but never writing ones (draft) - real request from the live bot", async () => {
    const h = harness(() => JSON.stringify({ reply: "Here are remote jobs and your resume.", actions: ["jobs remote", "resume", "draft 1", "applied 1"] }))
    writeFileSync(join(h.p.root, "cv", "Asha_Acme.pdf"), TINY_PDF)
    await h.bot.handle(h.msg({ text: "Find remote jobs for me which suit my role, also get me my recent resume" }))
    const t = h.texts()
    expect(t).toContain("Here are remote jobs and your resume.")
    expect(t.some((x) => x.includes("matches \"remote\""))).toBe(true)
    expect(h.sent.filter((s) => s.method === "sendDocument").length).toBe(1)
    expect(t.some((x) => x.includes("Writing your CV"))).toBe(false)
    expect(h.prompts[0]).toContain("/jobs - new jobs that fit you")
    expect(h.prompts[0]).toContain("Never suggest Claude Code commands")
  })
  test("Claude Code command names typed into the bot are mapped (/scrape -> /scan)", async () => {
    const h = harness(() => "")
    let scanned = false
    ;(h.bot as unknown as { d: { scanFn: unknown } }).d.scanFn = async () => {
      scanned = true
      return { portals: [], added: [], flagged: [] }
    }
    await h.bot.handle(h.msg({ text: "/scrape remote" }))
    expect(scanned).toBe(true)
    // "/rank" now scores whatever has no score; with nothing to score it just shows the jobs.
    await h.bot.handle(h.msg({ text: "/rank" }))
    expect(h.texts().at(-1)).toContain("Nothing new that fits you")
    expect(h.prompts.length).toBe(0)
  })
  test("Skip really hides a job; asking again never repeats a list - 'same jobs again' from the live bot", async () => {
    const h = harness(() => "")
    const seenFile = join(h.p.root, "job_scraper", "seen_jobs.json")
    writeFileSync(seenFile, JSON.stringify({ seen: {
      old1: { title: "Old Job", company: "A", url: "https://e.com/o1", status: "ranked", rank_score: 80, first_seen: "2026-10-01" },
      new1: { title: "Fresh Job", company: "B", url: "https://e.com/n1", status: "new", fit: "high", first_seen: "2026-11-13" },
      news: { title: "X raises $5M", company: "X", url: "https://e.com/news", status: "new", fit: "high", first_seen: "2026-11-13", portal: "funding-news-search" },
    } }))
    ;(h.bot as unknown as { d: { now: () => Date } }).d.now = () => new Date("2026-11-13T12:00:00")
    // Without scoring (no AI budget), a strong keyword match stands in for a score.
    const c = readConfig(h.p.config); c.auto_rank = false; writeConfig(h.p.config, c)
    await h.bot.handle(h.msg({ text: "/jobs" }))
    // Scored first, then the strong keyword match; never the news item.
    expect(h.texts().at(-1)).toContain("1. Old Job")
    expect(h.texts().at(-1)).toContain("2. Fresh Job")
    expect(h.texts().at(-1)).toContain("strong keyword match, not scored yet")
    expect(h.texts().at(-1)).not.toContain("raises $5M")
    // Asking again doesn't repeat what was just shown.
    await h.bot.handle(h.msg({ text: "/jobs" }))
    expect(h.texts().at(-1)).toContain("Nothing new that fits you")
    expect(h.texts().at(-1)).not.toContain("Old Job")
    // "all" brings them back; Skip there hides one for good.
    await h.bot.handle(h.msg({ text: "/jobs all" }))
    expect(h.texts().at(-1)).toContain("Old Job")
    const skipBtn = h.lastKb().inline_keyboard[0].find((b) => b.text === "Skip")!
    await h.bot.handle(h.cb(skipBtn.callback_data))
    expect(h.texts().at(-1)).toContain("won't show that one again")
    await h.bot.handle(h.msg({ text: "/jobs all" }))
    expect(h.texts().at(-1)).not.toContain("Old Job")
    expect(h.texts().at(-1)).toContain("Fresh Job")
  })
  test("a scan scores what it found and shows only the new ones that fit, not the old list", async () => {
    // The small model scores each new find; "Fresh Job" fits, "Weak Job" doesn't.
    const h = harness((prompt) => prompt.includes("You score job postings")
      ? JSON.stringify({ results: [
        { key: "new1", technical: 85, experience: 80, behavioral: 70, career: 85, location: "PASS", reason: "Strong match on voice agents." },
        { key: "new2", technical: 30, experience: 20, behavioral: 60, career: 30, location: "PASS", reason: "Mostly Java backend work." },
      ] })
      : "")
    writeFileSync(join(h.p.root, "job_scraper", "seen_jobs.json"), JSON.stringify({ seen: {
      old1: { title: "Old Job", company: "A", url: "https://e.com/o1", status: "ranked", rank_score: 80, first_seen: "2026-10-01" },
      new1: { title: "Fresh Job", company: "B", url: "https://e.com/n1", status: "new", fit: "high", first_seen: "2026-11-13" },
      new2: { title: "Weak Job", company: "C", url: "https://e.com/n2", status: "new", fit: "high", first_seen: "2026-11-13" },
    } }))
    ;(h.bot as unknown as { d: { scanFn: unknown; now: () => Date } }).d.scanFn = async () => ({ portals: [], added: ["new1", "new2"], flagged: [] })
    ;(h.bot as unknown as { d: { now: () => Date } }).d.now = () => new Date("2026-11-13T12:00:00")
    await h.bot.handle(h.msg({ text: "/scan" }))
    const last = h.texts().at(-1)!
    expect(last).toContain("Fresh Job")
    expect(last).toContain("Strong match on voice agents.")
    expect(last).not.toContain("Weak Job")
    expect(last).not.toContain("Old Job")
  })
  test("the chat sees what the bot itself just said ('consider it' after a warning)", async () => {
    const h = harness(() => JSON.stringify({ reply: "ok", actions: [] }))
    await h.bot.handle(h.msg({ text: "/status" }))
    await h.bot.handle(h.msg({ text: "consider it" }))
    expect(h.prompts.at(-1)).toContain("Drafted:")
  })
  test("chat remembers the last few turns", async () => {
    const h = harness(() => "Sure.")
    await h.bot.handle(h.msg({ text: "Which job pays best?" }))
    await h.bot.handle(h.msg({ text: "And the second one?" }))
    expect(h.prompts.at(-1)).toContain("Which job pays best?")
    expect(h.prompts.at(-1)).toContain("And the second one?")
    expect(existsSync(h.p.profile)).toBe(true)
  })
})
