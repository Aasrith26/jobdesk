// Local dashboard server (DSH-2, DSH-5): binds to 127.0.0.1 only, pushes a change event
// within ~1 s of any watched file changing, and serves files only from the workspace's
// document folders. Writes need the per-start token and a localhost Host header, so another
// website open in the same browser can't post to it (CSRF / DNS rebinding).

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"
import { randomBytes } from "node:crypto"
import type { Paths } from "../lib/paths.ts"
import { computeState } from "./state.ts"
import { renderPage } from "./page.ts"
import { getItem, resolveItem } from "../data/attention.ts"
import { setAnswer, writeBackToProfile } from "../data/answers.ts"
import { updateStatus } from "../data/tracker.ts"
import { readConfig, writeConfig } from "../data/config.ts"
import { setupStatus, saveUploadedResume, draftProfile, saveProfile } from "../setup.ts"
import { importResumeToProfile, readResume } from "../intake.ts"
import { seedFromProfile } from "../data/answers.ts"
import { saveToken } from "../bridge/bot.ts"
import { applyDaily } from "../bridge/bot.ts"
import { doctor } from "../doctor.ts"
import { quickRank } from "../rank.ts"
import { react } from "../data/recommended.ts"
import type { ClaudeExec } from "../lib/claude.ts"
import type { BotSupervisor } from "../service.ts"
import { today, nowIso } from "../lib/store.ts"
import { findJob, prepare, confirm, markApplied, shelve, isPreparing, readApps } from "../apply.ts"
import { readReview } from "../review.ts"
import { fillApplication, type ReviewCard, type Decision, type FillOpts, type FillResult } from "../fill/runner.ts"
import { makeDrafter } from "../fill/drafts.ts"
import { askAgent } from "../agent/run.ts"
import { recentTurns, readNotes, removeNote, addTurn } from "../agent/memory.ts"
import { describeAction, runAction, needsConfirm, isKnown, verbOf } from "../agent/actions.ts"
import { freshPicks } from "../recommend.ts"
import { markShown } from "../data/recommended.ts"
import { HELP } from "../bridge/bot.ts"
import { startTask, readTasks, requestStop } from "../tasks.ts"

const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json" }

export interface DashboardHandle {
  url: string
  port: number
  token: string
  stop: () => void
}

export interface DashboardOpts {
  onChange?: () => void
  /** Present when run by `jobdesk start`: the dashboard can then switch the bot on. */
  service?: { bot: BotSupervisor }
  claudeExec?: ClaudeExec
  /** Tests only: stands in for the browser form filler. */
  fillFn?: (o: FillOpts) => Promise<FillResult>
  log?: (s: string) => void
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(",")).map((x) => x.trim()).filter(Boolean).slice(0, 20)

export function startDashboard(p: Paths, port: number, opts: DashboardOpts = {}): DashboardHandle {
  const token = randomBytes(16).toString("hex")
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      for (const c of clients) {
        try {
          c.enqueue(enc.encode(`data: change\n\n`))
        } catch {
          clients.delete(c)
        }
      }
      opts.onChange?.()
    }, 250)
  }
  const watchers: FSWatcher[] = []
  const watchPath = (target: string, recursive = false) => {
    if (!existsSync(target)) return
    try {
      watchers.push(watch(target, { recursive }, notify))
    } catch {
      /* some platforms lack recursive watch; the poll below still catches changes */
    }
  }
  watchPath(p.root) // tracker lives at the root (non-recursive)
  watchPath(join(p.root, "job_scraper"))
  watchPath(p.applications, true)
  watchPath(p.data, true)
  watchPath(join(p.root, "cv"))
  watchPath(join(p.root, "cover_letters"))
  watchPath(join(p.root, ".claude", "skills", "job-application-assistant"))
  // Belt and braces: a cheap mtime poll catches editors that replace files atomically.
  const mtimes = new Map<string, number>()
  const poll = setInterval(() => {
    for (const f of [p.tracker, p.seen, p.attention, p.leads, p.costs, p.scores, p.recommended, p.config, p.profile]) {
      const m = existsSync(f) ? statSync(f).mtimeMs : 0
      if (mtimes.has(f) && mtimes.get(f) !== m) notify()
      mtimes.set(f, m)
    }
  }, 1000)

  const busy = new Set<string>()
  /** Filled forms waiting for the user's Send (L1), by job key. */
  const pendingSends = new Map<string, { card: ReviewCard; decide: (d: Decision) => void }>()
  /** Actions the agent asked for that wait for a Yes, by id. */
  const proposals = new Map<string, { action: string; question: string }>()
  let proposalN = 0
  const log = opts.log ?? (() => {})
  const allowedRoots = [join(p.root, "cv"), join(p.root, "cover_letters"), join(p.root, "documents"), p.kits, p.reviews, p.evidence].map((r) => resolve(r) + sep)
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const host = (req.headers.get("host") ?? "").split(":")[0]
      if (host !== "127.0.0.1" && host !== "localhost") return new Response("Forbidden", { status: 403 })
      const sec = { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }
      if (req.method === "GET" && url.pathname === "/") return new Response(renderPage(token), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...sec } })
      if (req.method === "GET" && url.pathname === "/api/state") return json(computeState(p))
      if (req.method === "GET" && url.pathname === "/api/setup") return json(setupStatus(p, readConfig(p.config), opts.service?.bot.status()))
      if (req.method === "GET" && url.pathname === "/api/doctor") return json(await doctor())
      if (req.method === "GET" && url.pathname === "/api/apply/review") {
        const key = url.searchParams.get("key") ?? ""
        const review = readReview(p, key)
        return review ? json({ review, state: readApps(p)[key] ?? null, sending: pendingSends.get(key)?.card ?? null }) : json({ error: "No review for that job yet." }, 404)
      }
      if (req.method === "GET" && url.pathname === "/api/agent/history") {
        const picks = new Map(freshPicks(p, { ...readConfig(p.config), min_fit: 0 }, { includeShown: true }).picks.map((j) => [j.key, j]))
        const turns = recentTurns(p, 60).map((t) => ({ ...t, jobs: (t.jobs ?? []).map((k) => picks.get(k)).filter((j) => !!j) }))
        return json({ turns, notes: readNotes(p), proposals: [...proposals.entries()].map(([id, x]) => ({ id, question: x.question })) })
      }
      if (req.method === "GET" && url.pathname === "/events") {
        let ctl: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c
            clients.add(c)
            c.enqueue(enc.encode(`retry: 2000\n\n`))
          },
          cancel() {
            clients.delete(ctl)
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } })
      }
      if (req.method === "GET" && url.pathname === "/file") {
        const rel = url.searchParams.get("path") ?? ""
        const abs = resolve(p.root, rel)
        if (!allowedRoots.some((r) => abs.startsWith(r)) || !existsSync(abs) || !statSync(abs).isFile()) return new Response("Not found", { status: 404 })
        const type = TYPES[extname(abs).toLowerCase()]
        if (!type) return new Response("Not found", { status: 404 })
        return new Response(readFileSync(abs), { headers: { "content-type": type, "cache-control": "no-store", ...sec } })
      }
      if (req.method === "POST") {
        if (req.headers.get("x-jobdesk-token") !== token) return json({ error: "Missing or wrong token. Reload the page." }, 403)
        if (url.pathname === "/api/setup/resume") {
          try {
            const form = await req.formData()
            const f = form.get("file")
            if (!(f instanceof Blob) || !("name" in f)) return json({ error: "Choose a file first." }, 400)
            const r = await saveUploadedResume(p, String((f as File).name), new Uint8Array(await f.arrayBuffer()))
            return json({ ok: true, file: r.file, kind: r.kind, chars: r.text.length, needsClaude: r.needsClaude, preview: r.text.slice(0, 600) })
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
        }
        let body: Record<string, unknown> = {}
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return json({ error: "Bad request" }, 400)
        }
        const id = String(body.id ?? "")
        if (url.pathname === "/api/setup/profile/draft") {
          // A background task: the draft waits in tasks.json even if the page is closed meanwhile.
          const file = String(body.file ?? "")
          const t = startTask(p, "profile", `Drafting your profile from ${file}`, async (h) => {
            h.progress(0, 1)
            const d = await draftProfile(p, readConfig(p.config), file, { exec: opts.claudeExec, date: today() })
            h.progress(1, 1)
            return d.ok ? { message: `Draft ready ($${d.usd.toFixed(2)}). Nothing is saved until you press Save.`, result: { markdown: d.markdown, unsupported: d.unsupported, usd: d.usd } } : { message: d.error ?? "Couldn't draft the profile.", failed: true }
          })
          return json({ ok: true, task: t.task, already: !t.started })
        }
        if (url.pathname === "/api/setup/profile/save") {
          try {
            const r = saveProfile(p, String(body.markdown ?? ""), nowIso())
            return json({ ok: true, backup: r.backup ? r.backup.slice(p.root.length + 1) : null, seeded: r.seeded })
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
        }
        if (url.pathname === "/api/setup/profile/import") {
          // The free path: the resume goes in word for word, nothing rewritten.
          const file = join(p.root, "documents", "cv", String(body.file ?? "").replace(/[\\/]/g, ""))
          if (!existsSync(file)) return json({ error: "That resume isn't there any more." }, 404)
          const r = await readResume(p.root, file)
          if (!r.text) return json({ error: "This file needs Claude to read it (a photo or a scan). Use \"Draft my profile\" instead." }, 400)
          importResumeToProfile(p.profile, r.text)
          seedFromProfile(p.answers, p.profile)
          return json({ ok: true })
        }
        if (url.pathname === "/api/setup/looking-for") {
          const cfg = readConfig(p.config)
          const queries = list(body.queries)
          const locations = list(body.locations)
          if (!queries.length || !locations.length) return json({ error: "Give at least one kind of job and one place (\"Remote\" counts)." }, 400)
          cfg.queries = queries
          cfg.locations = locations
          const mf = Number(body.min_fit)
          if (Number.isFinite(mf) && body.min_fit !== undefined && body.min_fit !== "") cfg.min_fit = Math.max(0, Math.min(100, Math.round(mf)))
          writeConfig(p.config, cfg)
          return json({ ok: true })
        }
        if (url.pathname === "/api/setup/telegram") {
          const t = String(body.token ?? "").trim()
          try {
            if (opts.service) return json({ ok: true, telegram: await opts.service.bot.connect(t) })
            saveToken(p, t)
            return json({ ok: true, telegram: { running: false, paired: false, error: "Token saved. Run jobdesk start to switch the bot on." } })
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
        }
        if (url.pathname === "/api/setup/telegram/unpair") {
          if (!opts.service) return json({ error: "Run jobdesk start to manage the bot from here." }, 400)
          return json({ ok: true, telegram: await opts.service.bot.unpair() })
        }
        if (url.pathname === "/api/setup/schedule") {
          let cfg = readConfig(p.config)
          const time = String(body.time ?? cfg.daily.time)
          if (!/^\d{1,2}:\d{2}$/.test(time)) return json({ error: "Use a time like 08:30." }, 400)
          const changes = [body.search ? `on ${time}` : "off"]
          if (["ask", "auto", "off"].includes(String(body.apply))) changes.push(`apply ${body.apply}`)
          const next = applyDaily(cfg, changes.join("; "))
          if (!next) return json({ error: "Use a time like 08:30." }, 400)
          cfg = next
          const dt = String(body.digest_time ?? "")
          if (dt) {
            if (!/^\d{2}:\d{2}$/.test(dt)) return json({ error: "Use a time like 09:00 for the morning update." }, 400)
            cfg.telegram.digest_time = dt
          }
          writeConfig(p.config, cfg)
          return json({ ok: true })
        }
        if (url.pathname === "/api/jobs/score") {
          // Every unscored job (what the button's price covers), in the background, with progress.
          const t = startTask(p, "score", "Scoring jobs", async (h) => {
            const r = await quickRank(p, readConfig(p.config), { limit: 1000, exec: opts.claudeExec, progress: h.progress, shouldStop: h.shouldStop })
            if (r.skipped && !r.scored) return { message: `Couldn't score: ${r.skipped}`, failed: true }
            return { message: `Scored ${r.scored} job${r.scored === 1 ? "" : "s"} ($${r.usd.toFixed(2)}).${r.failed ? ` ${r.failed} couldn't be scored.` : ""}${r.remaining ? ` ${r.remaining} left.` : ""}` }
          })
          return json({ ok: true, task: t.task, already: !t.started })
        }
        if (url.pathname === "/api/tasks/stop") {
          const t = readTasks(p).find((x) => x.id === id && x.status === "running")
          if (!t) return json({ error: "That isn't running." }, 404)
          requestStop(id)
          return json({ ok: true })
        }
        if (url.pathname === "/api/jobs/skip") {
          if (!id) return json({ error: "Which job?" }, 400)
          react(p.recommended, id, "skipped")
          return json({ ok: true })
        }
        // ---- Apply: prepare -> review -> confirm -> (fill and Send | kit and one tap) -> applied ----
        if (url.pathname === "/api/apply/start") {
          const job = findJob(p, id)
          if (!job) return json({ error: "I can't find that job." }, 404)
          if (!isPreparing(job.key)) {
            void prepare(p, readConfig(p.config), job, { exec: opts.claudeExec }).then((r) => {
              if (!r.ok) log(`apply ${job.company}: ${r.error ?? "stopped"}`)
            })
          }
          return json({ ok: true, key: job.key })
        }
        if (url.pathname === "/api/apply/confirm") {
          let c
          try {
            c = confirm(p, id)
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
          if (c.how === "fill" && !pendingSends.has(id)) {
            const cfg = readConfig(p.config)
            const pdf = (x?: string) => (x ? join(p.root, x) : undefined)
            const fo: FillOpts = {
              url: c.review.url, company: c.review.company, role: c.review.role,
              files: { cv: c.review.cv.pdf_exists ? pdf(c.review.cv.pdf) : undefined, cover: c.review.letter.pdf_exists ? pdf(c.review.letter.pdf) : undefined },
              level: cfg.approval_level, draftOpenAnswers: makeDrafter(p, cfg), log,
              // The filled form waits here until the user clicks Send or Cancel on the page.
              approve: (card) => new Promise<Decision>((decide) => {
                pendingSends.set(id, { card, decide })
                notify()
              }),
            }
            void (opts.fillFn ? opts.fillFn(fo) : fillApplication(p, cfg, fo))
              .then((r) => log(`fill ${c.review.company}: ${r.message}`))
              .catch((e) => log(`fill failed: ${(e as Error).message}`))
              .finally(() => {
                pendingSends.delete(id)
                notify()
              })
          }
          return json({ ok: true, how: c.how, kit: { url: c.kit.url, answers: c.kit.answers, files: c.kit.files.map((f) => ({ label: f.label, path: relative(p.root, f.path), exists: f.exists })), page: relative(p.root, c.kit.html_path), warnings: c.kit.warnings } })
        }
        if (url.pathname === "/api/jobs/scan") {
          return json({ ok: true, ...(await runAction(p, "scan", { exec: opts.claudeExec, log })) })
        }
        if (url.pathname === "/api/apply/send") {
          const w = pendingSends.get(id)
          if (!w) return json({ error: "That form isn't waiting any more." }, 404)
          pendingSends.delete(id)
          w.decide(body.decision === "submit" ? "submit" : "cancel")
          return json({ ok: true })
        }
        if (url.pathname === "/api/apply/applied") {
          try {
            const r = markApplied(p, id)
            return json({ ok: true, ...r })
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
        }
        if (url.pathname === "/api/apply/later") {
          shelve(p, id)
          return json({ ok: true })
        }
        // ---- The agent, from the dashboard: one conversation with Telegram ----
        if (url.pathname === "/api/agent/ask") {
          const text = String(body.text ?? "").trim().slice(0, 2000)
          if (!text) return json({ error: "Type a message." }, 400)
          if (busy.has("agent")) return json({ error: "Still answering your last message." }, 409)
          busy.add("agent")
          try {
            const cfg = readConfig(p.config)
            const r = await askAgent(p, cfg, { question: text, channel: "dashboard", help: HELP, exec: opts.claudeExec })
            if (!r.ok) return json({ error: r.error ?? "I couldn't answer that right now." }, r.skipped ? 402 : 502)
            const picks = new Map(freshPicks(p, { ...cfg, min_fit: 0 }, { includeShown: true }).picks.map((j) => [j.key, j]))
            const jobs = r.show.map((k) => picks.get(k)).filter((j) => !!j)
            markShown(p.recommended, jobs.map((j) => j!.key), "dashboard")
            const results: { text: string; link?: { label: string; href: string } }[] = []
            const asks: { id: string; question: string }[] = []
            for (const a of r.actions.filter(isKnown)) {
              if (verbOf(a) === "jobs") continue
              if (!needsConfirm(a)) {
                const res = await runAction(p, a, { exec: opts.claudeExec, log })
                if (res.text) {
                  results.push(res)
                  addTurn(p, "dashboard", "assistant", res.text.slice(0, 500))
                }
                continue
              }
              const question = describeAction(p, cfg, a)
              if (!question) continue
              const pid = `x${++proposalN}`
              proposals.set(pid, { action: a, question })
              asks.push({ id: pid, question })
            }
            return json({ ok: true, reply: r.reply, jobs, results, proposals: asks, remembered: r.remembered, usd: r.usd })
          } finally {
            busy.delete("agent")
          }
        }
        if (url.pathname === "/api/agent/confirm") {
          const pr = proposals.get(id)
          if (!pr) return json({ error: "That question has expired. Ask again." }, 404)
          proposals.delete(id)
          if (!body.yes) {
            addTurn(p, "dashboard", "assistant", "Okay, left it.")
            return json({ ok: true, text: "Okay, left it." })
          }
          const res = await runAction(p, pr.action, { exec: opts.claudeExec, log })
          addTurn(p, "dashboard", "assistant", res.text.slice(0, 500))
          return json({ ok: true, ...res })
        }
        if (url.pathname === "/api/agent/forget") {
          return json({ ok: true, notes: removeNote(p, Number(body.index)) })
        }
        if (url.pathname === "/api/settings/sending") {
          const level = String(body.level)
          if (level !== "L0" && level !== "L1") return json({ error: "Choose kit only, or fill and confirm." }, 400)
          const cfg = readConfig(p.config)
          cfg.approval_level = level
          writeConfig(p.config, cfg)
          return json({ ok: true })
        }
        if (url.pathname === "/api/attention/resolve") {
          return resolveItem(p.attention, id, String(body.resolution ?? "done")) ? json({ ok: true }) : json({ error: "Already done or not found." }, 404)
        }
        if (url.pathname === "/api/attention/answer") {
          const item = getItem(p.attention, id)
          const answer = String(body.answer ?? "").trim()
          if (!item || !answer) return json({ error: "Need an answer." }, 400)
          const question = String((item.data?.question as string) ?? item.title)
          const a = setAnswer(p.answers, { question, answer, sensitive: !!body.sensitive, allow_in_applications: body.sensitive ? false : undefined, source: "user" })
          writeBackToProfile(p.profile, a)
          resolveItem(p.attention, id, `answered: ${a.key}`)
          return json({ ok: true, key: a.key })
        }
        if (url.pathname === "/api/attention/confirm") {
          const item = getItem(p.attention, id)
          const company = item?.data?.company as string | undefined
          const status = item?.data?.confirm_status as string | undefined
          if (!item || !company || !status) return json({ error: "Nothing to confirm." }, 400)
          try {
            updateStatus(p.tracker, { company }, status, `${status} - confirmed from email in jobdesk`)
          } catch (e) {
            return json({ error: (e as Error).message }, 400)
          }
          resolveItem(p.attention, id, `confirmed ${status}`)
          return json({ ok: true })
        }
      }
      return new Response("Not found", { status: 404 })
    },
  })
  const actualPort = server.port ?? port
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    token,
    stop: () => {
      clearInterval(poll)
      clearTimeout(timer)
      for (const w of watchers) w.close()
      server.stop(true)
    },
  }
}
