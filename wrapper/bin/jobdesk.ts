#!/usr/bin/env bun
// jobdesk - one entry point for the wrapper. Every command prints plain-language results and
// a single next step on failure (ONB-6).

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { paths, ensureDataDir, type Paths } from "../src/lib/paths.ts"
import { readConfig, writeConfig, type Config, type Tier, type ApprovalLevel } from "../src/data/config.ts"
import { startDashboard } from "../src/dashboard/server.ts"
import { scan } from "../src/scan.ts"
import { ingestLink } from "../src/links.ts"
import { buildKit } from "../src/kit.ts"
import { openItems, resolveItem, getItem } from "../src/data/attention.ts"
import { readBank, setAnswer, seedFromProfile, writeBackToProfile } from "../src/data/answers.ts"
import { processInboxFolder, triage, parseEml } from "../src/inbox.ts"
import { refreshReminders, dueFollowUps } from "../src/followups.ts"
import { composeDigest } from "../src/digest.ts"
import { Bot, readToken, saveToken, applyDaily, describeDaily } from "../src/bridge/bot.ts"
import { Telegram } from "../src/bridge/telegram.ts"
import { doctor, formatChecks, bootstrap } from "../src/doctor.ts"
import { readResume, importResumeToProfile } from "../src/intake.ts"
import { searchUrls, parseConnections, matchReferrals } from "../src/linkedin.ts"
import { readTracker, isFinal } from "../src/data/tracker.ts"
import { shortlist, readSeen } from "../src/data/seen.ts"
import { fillApplication, type ReviewCard } from "../src/fill/runner.ts"
import { monthSpend, budgetLeft, budgetText } from "../src/lib/claude.ts"
import { compat } from "../src/compat.ts"
import { readJsonl } from "../src/lib/store.ts"
import { emailLabeler, modelCheckLeads } from "../src/safety/check.ts"
import { draftDm, compareOffers } from "../src/outreach.ts"
import { makeDrafter } from "../src/fill/drafts.ts"
import { startService, takeLock, runningCopy } from "../src/service.ts"
import { autostart } from "../src/autostart.ts"
import { quickRank, unscored, rankEstimate } from "../src/rank.ts"
import { freshPicks } from "../src/recommend.ts"
import { setupStatus } from "../src/setup.ts"
import { bunBin } from "../src/lib/exec.ts"

const HELP = `jobdesk - your job search, on your own computer

  jobdesk start                  start everything: dashboard, Telegram bot and the daily search.
                                 Opens the dashboard; setup happens there. (--no-open, --port N)
  jobdesk autostart on|off       start jobdesk by itself when you log in (macOS, Linux)

  jobdesk doctor                 check what's installed
  jobdesk bootstrap --yes        install what's missing (official installers)
  jobdesk dashboard [--port N]   open the live dashboard (http://127.0.0.1:4317)
  jobdesk scan [--free]          find new jobs and leads. The search is free; the safety
                                 check costs a fraction of a cent per job (--free skips it)
  jobdesk rank [--all]           give a fit score to new jobs that have none (about a cent per
                                 ten jobs; --all scores the whole backlog)
  jobdesk jobs [all]             jobs that fit you, best first
  jobdesk lead <link>            check one link (job page, X post, Reddit post...)
  jobdesk kit <link|company>     everything you need to apply, ready to copy
  jobdesk fill <link> [--dry] [--level L1|L2] [--headless]
                                 fill an application form; nothing is sent without your OK
  jobdesk attention              things that need you
  jobdesk attention done <id>    mark one as done
  jobdesk answers                your saved answers for forms
  jobdesk answers set "<question>" "<answer>" [--private]
  jobdesk answers seed           copy name, email and phone from your profile
  jobdesk inbox [file.eml]       sort recruiter emails (or drop them in wrapper-data/inbox/)
  jobdesk followups              applications that have gone quiet
  jobdesk digest                 print today's digest
  jobdesk dm <key>               draft a short message to whoever posted a lead (you send it)
  jobdesk offers                 your offers side by side
  jobdesk bridge                 start the Telegram bot
  jobdesk bridge --token <T>     save your bot token (from @BotFather)
  jobdesk intake <resume file> [--to-profile]
                                 read a resume (PDF, Word, text); --to-profile adds it to your
                                 profile word for word (free, no AI needed)
  jobdesk linkedin urls          LinkedIn searches to open yourself
  jobdesk linkedin referrals <Connections.csv>
  jobdesk config [key value]     show or change settings
  jobdesk status                 your numbers
  jobdesk cost                   what you've spent this month
  jobdesk compat [--merge]       check that the original framework is untouched
`

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`)
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
function positional(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (["port", "level", "portal", "query", "token", "per-portal"].includes(args[i].slice(2))) i++
      continue
    }
    out.push(args[i])
  }
  return out
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(q)).trim()
  } finally {
    rl.close()
  }
}

function printCard(card: ReviewCard): void {
  console.log(`\nReady to send: ${card.role} at ${card.company} (${card.site})`)
  for (const f of card.fields) console.log(`  ${f.label}: ${f.value}   [${f.source}]`)
  if (card.unknown.length) console.log(`\nQuestions only you can answer:\n${card.unknown.map((u) => "  - " + u).join("\n")}`)
  if (card.stops.length) console.log(`\nSteps only you can do:\n${card.stops.map((u) => "  - " + u).join("\n")}`)
  if (card.flags.length) console.log(`\nCheck:\n${card.flags.map((u) => "  - " + u).join("\n")}`)
  if (card.screenshot) console.log(`\nScreenshot: ${card.screenshot}`)
}

async function configCmd(p: Paths, cfg: Config, args: string[]): Promise<void> {
  const [key, ...vals] = args
  const val = vals.join(" ")
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)
  if (!key) {
    console.log(JSON.stringify(cfg, null, 2))
    return
  }
  switch (key) {
    case "queries": cfg.queries = list(val); break
    case "locations": cfg.locations = list(val); break
    case "channels": cfg.telegram_channels = list(val); break
    case "subreddits": cfg.subreddits = list(val); break
    case "tier":
      if (!["lite", "standard", "max"].includes(val)) throw new Error("Tier must be lite, standard or max.")
      cfg.tier = val as Tier
      break
    case "budget": {
      // "config budget 25" caps paid features at $25 a month; "config budget off" removes the cap.
      if (/^(off|none|no|unlimited)$/i.test(val.trim())) cfg.monthly_budget_usd = null
      else {
        const n = Number(val)
        if (!val.trim() || !Number.isFinite(n) || n < 0) throw new Error("Use an amount in dollars, like: config budget 25. Or: config budget off")
        cfg.monthly_budget_usd = n
      }
      break
    }
    case "cap": cfg.daily_application_cap = Math.max(1, Math.floor(Number(val))); break
    case "level":
      if (!["L0", "L1", "L2"].includes(val)) throw new Error("Level must be L0 (kit only), L1 (fill and review) or L2 (fill and send).")
      cfg.approval_level = val as ApprovalLevel
      break
    case "trust": cfg.trusted_ats = list(val); break
    case "digest":
      if (!/^\d{2}:\d{2}$/.test(val)) throw new Error("Use a time like 09:00.")
      cfg.telegram.digest_time = val
      break
    case "followup-days": cfg.followup_days = Number(val); break
    case "daily": {
      // jobdesk config daily on 08:30 | off | apply ask|auto|off | followups on|off
      if (!val.trim()) {
        console.log(describeDaily(cfg))
        return
      }
      const next = applyDaily(cfg, val)
      if (!next) throw new Error("Use: config daily on 08:30, config daily off, config daily apply ask|auto|off, config daily followups on|off.")
      cfg.daily = next.daily
      console.log(describeDaily(cfg))
      break
    }
    case "browser": cfg.browser = val; break
    case "port": cfg.dashboard_port = Number(val); break
    case "min-fit": {
      const n = Number(val)
      if (!val.trim() || !Number.isFinite(n) || n < 0 || n > 100) throw new Error("Use a number from 0 to 100, like: config min-fit 60")
      cfg.min_fit = Math.round(n)
      break
    }
    case "auto-rank":
      if (!["on", "off"].includes(val)) throw new Error("Use: config auto-rank on|off")
      cfg.auto_rank = val === "on"
      break
    default: throw new Error(`Unknown setting "${key}".`)
  }
  writeConfig(p.config, cfg)
  console.log(`Saved ${key}.`)
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP)
    return 0
  }
  if (cmd === "doctor") {
    console.log(formatChecks(await doctor()))
    return 0
  }
  if (cmd === "bootstrap") {
    const checks = await doctor()
    console.log(formatChecks(checks))
    if (!flag(args, "yes")) {
      console.log('\nNothing installed. Run "jobdesk bootstrap --yes" to install the missing items with their official installers.')
      return 0
    }
    await bootstrap(checks, (s) => console.log(s))
    return 0
  }
  const p = paths()
  ensureDataDir(p)
  const cfg = readConfig(p.config)
  const pos = positional(args)
  switch (cmd) {
    case "start": {
      const port = opt(args, "port") ? Number(opt(args, "port")) : undefined
      const svc = await startService(p, { port })
      const st = setupStatus(p, readConfig(p.config), svc.bot.status())
      console.log(`jobdesk is running. Dashboard: ${svc.dashboard.url}`)
      console.log(st.complete ? "Everything is set up." : "Finish setting up in the dashboard (the Setup tab).")
      console.log("It only listens on this computer. Press Ctrl+C to stop.")
      if (!flag(args, "no-open")) {
        const url = svc.dashboard.url
        const opener = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
        Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] })
      }
      const quit = async () => {
        await svc.stop()
        process.exit(0)
      }
      process.on("SIGINT", quit)
      process.on("SIGTERM", quit)
      await new Promise(() => {})
      return 0
    }
    case "autostart": {
      if (!["on", "off"].includes(pos[0] ?? "")) throw new Error("Use: jobdesk autostart on, or jobdesk autostart off")
      if (pos[0] === "on" && runningCopy(p)) console.log("Note: jobdesk is already running in a terminal. Stop that one (Ctrl+C) so the login copy can take over.")
      console.log(await autostart(p, pos[0] === "on", bunBin()))
      return 0
    }
    case "rank": {
      const n = unscored(p).length
      if (!n) {
        console.log("Every job already has a fit score.")
        return 0
      }
      const limit = flag(args, "all") ? n : Math.min(n, 60)
      console.log(`Scoring ${limit} of ${n} unscored job(s). About $${rankEstimate(limit).toFixed(2)}.`)
      const r = await quickRank(p, cfg, { limit, log: (m) => console.log(m) })
      console.log(r.skipped && !r.scored ? `Didn't run: ${r.skipped}` : `Scored ${r.scored}${r.failed ? `, ${r.failed} failed` : ""}. Cost $${r.usd.toFixed(3)}. ${r.remaining} still unscored.`)
      return r.scored ? 0 : 1
    }
    case "jobs": {
      const r = freshPicks(p, cfg, { includeShown: true, n: pos[0] === "all" ? 0 : 15 })
      if (!r.picks.length) console.log(`Nothing that fits yet (your minimum fit is ${cfg.min_fit}). ${unscored(p).length} job(s) have no score: run jobdesk rank.`)
      for (const j of r.picks) console.log(`${j.score !== undefined ? String(j.score).padStart(3) : "  ?"}  ${j.title} at ${j.company}${j.location ? `, ${j.location}` : ""}${j.reason ? `\n     ${j.reason}` : ""}\n     ${j.url}`)
      return 0
    }
    case "dashboard": {
      const port = Number(opt(args, "port") ?? cfg.dashboard_port)
      const h = startDashboard(p, port)
      console.log(`Dashboard running at ${h.url}\nIt only listens on this computer. Press Ctrl+C to stop.`)
      if (flag(args, "open")) {
        const opener = process.platform === "win32" ? ["cmd", "/c", "start", "", h.url] : process.platform === "darwin" ? ["open", h.url] : ["xdg-open", h.url]
        Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] })
      }
      await new Promise(() => {})
      return 0
    }
    case "scan": {
      const s = await scan(p, cfg, {
        portals: opt(args, "portal")?.split(","),
        queries: opt(args, "query")?.split("|"),
        perPortal: opt(args, "per-portal") ? Number(opt(args, "per-portal")) : undefined,
        log: (m) => console.log(m),
      })
      if (s.added.length && !flag(args, "free")) {
        const mc = await modelCheckLeads(p, cfg, s.added)
        if (mc.checked) console.log(`Model check on ${mc.checked} new posting(s): ${mc.flagged.length} more warning(s). Cost $${mc.usd.toFixed(3)}.`)
        else if (mc.skipped) console.log(`Model check skipped: ${mc.skipped}. The free rule check still ran.`)
        s.flagged.push(...mc.flagged)
        if (cfg.auto_rank) {
          const r = await quickRank(p, cfg, { keys: s.added })
          console.log(r.skipped ? `Scoring skipped: ${r.skipped}` : `Scored ${r.scored} new job(s) against your profile. Cost $${r.usd.toFixed(3)}.`)
        }
      }
      console.log(`\nNew: ${s.added.length}. With warnings: ${s.flagged.length}.`)
      for (const x of s.portals) console.log(`  ${x.name}: ${x.status}${x.status === "ok" ? ` (${x.found} found, ${x.added} new)` : x.error ? ` - ${x.error}` : ""}`)
      return 0
    }
    case "lead": {
      if (!pos[0]) throw new Error("Give me a link: jobdesk lead https://...")
      const r = await ingestLink(p, cfg, pos[0])
      console.log(`${r.title}\n${r.company}\nRead via: ${r.method}\n${r.guard_verdict}\nFit (keywords): ${r.fit}\n${r.stored ? `Saved as ${r.key}` : r.note ?? ""}`)
      if (r.scam.length || r.discrimination.length) console.log(`Warnings:\n${[...r.scam, ...r.discrimination].map((w) => "  - " + w).join("\n")}`)
      return 0
    }
    case "kit": {
      if (!pos[0]) throw new Error("Which job? jobdesk kit <link or company>")
      const k = buildKit(p, pos[0])
      console.log(k.text)
      console.log(`\nPrintable kit: ${k.html_path}`)
      return 0
    }
    case "fill": {
      if (!pos[0]) throw new Error("Which job? jobdesk fill <link>")
      const url = pos[0]
      const t = readTracker(p.tracker)
      const row = t.rows.find((r) => r.source === url)
      const seen = readSeen(p.seen).find((s) => s.url === url)
      const pdf = (x?: string) => (x ? x.replace(/\.tex$/i, ".pdf") : undefined)
      const level = (flag(args, "dry") ? "dry" : (opt(args, "level") as ApprovalLevel | undefined) ?? (cfg.approval_level === "L0" ? "dry" : cfg.approval_level)) as ApprovalLevel | "dry"
      if (cfg.approval_level === "L0" && !flag(args, "dry")) console.log("Your setting is Kit only (L0), so this is a dry run: the form is filled and nothing is sent.\nTo allow sending after your OK: jobdesk config level L1\n")
      const res = await fillApplication(p, cfg, {
        url, company: row?.company ?? seen?.company ?? new URL(url).hostname, role: row?.role ?? seen?.title ?? "",
        files: { cv: pdf(row?.cv_file), cover: pdf(row?.cover_letter_file) }, level, preApproved: level === "L2",
        headless: flag(args, "headless"), log: (m) => console.log(m), draftOpenAnswers: flag(args, "no-drafts") ? undefined : makeDrafter(p, cfg),
        approve: async (card) => {
          printCard(card)
          const a = await ask('\nType SEND and press Enter to submit it. Anything else cancels: ')
          return a === "SEND" ? "submit" : "cancel"
        },
      })
      if (res.card && level === "dry") printCard(res.card)
      console.log(`\n${res.message}`)
      return res.status === "aborted" || res.status === "blocked" ? 1 : 0
    }
    case "attention": {
      if (pos[0] === "done" && pos[1]) {
        console.log(resolveItem(p.attention, pos[1], "done") ? "Done." : "Not found or already done.")
        return 0
      }
      if (pos[0] === "answer" && pos[1] && pos[2]) {
        const it = getItem(p.attention, pos[1])
        if (!it) throw new Error("Not found.")
        const a = setAnswer(p.answers, { question: String(it.data?.question ?? it.title), answer: pos.slice(2).join(" "), source: "user" })
        if (!a.sensitive) writeBackToProfile(p.profile, a)
        resolveItem(p.attention, pos[1], `answered: ${a.key}`)
        console.log(`Saved: ${a.label} = ${a.answer}`)
        return 0
      }
      refreshReminders(p, cfg)
      const items = openItems(p.attention)
      if (!items.length) console.log("Nothing needs you right now.")
      for (const i of items) console.log(`[${i.id}]\n  ${i.title}${i.due ? ` (due ${i.due})` : ""}\n  ${i.why}\n  Next: ${i.action}\n`)
      return 0
    }
    case "answers": {
      if (pos[0] === "seed") {
        const added = seedFromProfile(p.answers, p.profile)
        console.log(added.length ? `Copied from your profile: ${added.map((a) => a.label).join(", ")}` : "Nothing new to copy from your profile.")
        return 0
      }
      if (pos[0] === "set" && pos[1] && pos[2]) {
        const priv = flag(args, "private")
        const a = setAnswer(p.answers, { question: pos[1], answer: pos[2], sensitive: priv || undefined, allow_in_applications: flag(args, "allow") || undefined, source: "user" })
        if (!a.sensitive) writeBackToProfile(p.profile, a)
        console.log(`Saved: ${a.label} = ${a.answer}${a.sensitive ? " (private: used only if you add --allow)" : ""}`)
        return 0
      }
      const bank = readBank(p.answers)
      const list = Object.values(bank)
      if (!list.length) console.log('No answers yet. Run "jobdesk answers seed", then add more with "jobdesk answers set".')
      for (const a of list) console.log(`${a.label}: ${a.sensitive && !a.allow_in_applications ? "(private, not used in forms)" : a.answer}`)
      return 0
    }
    case "inbox": {
      if (pos[0]) {
        const f = resolve(pos[0])
        const r = triage(p, parseEml(readFileSync(f, "utf8"), f.split(/[\\/]/).pop()!))
        console.log(`${r.label}${r.company ? ` (${r.company})` : ""}${r.due ? `, date ${r.due}` : ""}`)
        return 0
      }
      const out = await processInboxFolder(p, emailLabeler(p, cfg))
      console.log(out.length ? out.map((o) => `${o.file}: ${o.label}${o.company ? ` (${o.company})` : ""}`).join("\n") : `No emails waiting. Save emails as .eml or .txt files in ${p.inbox}`)
      return 0
    }
    case "followups": {
      const due = dueFollowUps(p.tracker, cfg)
      refreshReminders(p, cfg)
      console.log(due.length ? due.map((f) => `${f.row.company} - ${f.row.role}: ${f.daysQuiet} days quiet, ${f.sent} follow-up(s) sent`).join("\n") + "\n\nDraft a note with /outcome followup in Claude Code." : "No follow-ups due.")
      return 0
    }
    case "digest":
      console.log(composeDigest(p, cfg).text)
      return 0
    case "dm": {
      if (!pos[0]) throw new Error("Which lead? jobdesk dm <key from the dashboard>")
      const r = await draftDm(p, cfg, pos[0])
      console.log(r.ok ? `Draft (copy it, edit it, send it yourself):\n\n${r.text}\n\nCost: $${r.usd.toFixed(3)}` : r.error)
      return r.ok ? 0 : 1
    }
    case "offers":
      console.log(await compareOffers(p))
      return 0
    case "bridge": {
      const tok = opt(args, "token")
      if (tok) {
        saveToken(p, tok)
        console.log(`Token saved in ${join(p.data, ".env")} (never committed).`)
        return 0
      }
      const token = readToken(p)
      if (!token) throw new Error("No bot token yet. In Telegram, message @BotFather, send /newbot, then run: jobdesk bridge --token <token>")
      // One bot per token: a second copy (here or inside "jobdesk start") makes Telegram reject both.
      const release = takeLock(p, 0)
      process.on("exit", release)
      process.on("SIGINT", () => process.exit(0))
      process.on("SIGTERM", () => process.exit(0))
      const tg = new Telegram(token)
      const me = await tg.getMe()
      const bot = new Bot({ paths: p, tg, log: (s) => console.log(s) })
      if (cfg.telegram.owner_chat_id === undefined) console.log(`Open this link on your phone to pair:\n\n  https://t.me/${me.username}?start=${bot.pairCode}\n\nOr find @${me.username} in Telegram and send: /pair ${bot.pairCode}\n`)
      else console.log(`Bot @${me.username} is running for your chat. Press Ctrl+C to stop.`)
      await bot.loop()
      return 0
    }
    case "intake": {
      if (!pos[0]) throw new Error("Which file? jobdesk intake path/to/resume.pdf")
      const r = await readResume(p.root, resolve(pos[0]))
      console.log(r.needsClaude ? `This ${r.kind} needs Claude to read it (a photo or a scan). Copied to ${r.copiedTo}. Run /jobdesk:onboard in Claude Code.` : `Read ${r.text.length} characters from your ${r.kind}. Copied to ${r.copiedTo}.\n\n${r.text.slice(0, 1500)}`)
      if (flag(args, "to-profile") && r.text) {
        // Free path (no AI needed): the resume goes into the profile word for word.
        importResumeToProfile(p.profile, r.text)
        seedFromProfile(p.answers, p.profile)
        console.log(`\nAdded your resume to ${p.profile} as written. With Claude, /jobdesk:onboard can sort it into sections later.`)
      }
      return 0
    }
    case "linkedin": {
      if (pos[0] === "referrals") {
        if (!pos[1] || !existsSync(pos[1])) throw new Error("Give me the Connections.csv from LinkedIn's data export: jobdesk linkedin referrals Connections.csv")
        const conns = parseConnections(pos[1])
        const companies = [...readTracker(p.tracker).rows.filter((r) => !isFinal(r.status)).map((r) => r.company), ...shortlist(readSeen(p.seen), 30).map((j) => j.company)]
        const m = matchReferrals(conns, companies)
        console.log(m.length ? m.map((x) => `${x.company}:\n${x.people.map((c) => `  - ${c.name}, ${c.position} ${c.url}`).join("\n")}`).join("\n\n") : "None of your connections work at your shortlisted companies yet.")
        return 0
      }
      const skills = cfg.queries.length ? cfg.queries : ["AI Engineer"]
      for (const u of searchUrls(skills, cfg.locations[0])) console.log(`${u.label}:\n  ${u.url}\n`)
      console.log("Open these in your own browser. jobdesk never logs in to LinkedIn.")
      return 0
    }
    case "config":
      await configCmd(p, cfg, args)
      return 0
    case "status": {
      const rows = readTracker(p.tracker).rows
      console.log(`Applications in tracker: ${rows.length}\nJobs found: ${readSeen(p.seen).length}\nNeeds you: ${openItems(p.attention).length}\n${budgetText(p.costs, cfg)}`)
      return 0
    }
    case "cost": {
      const entries = readJsonl<{ at: string; task: string; model: string; usd: number }>(p.costs)
      for (const e of entries.slice(-20)) console.log(`${e.at.slice(0, 16)}  ${e.task.padEnd(8)} ${e.model.padEnd(7)} $${e.usd.toFixed(3)}`)
      console.log(`\n${budgetText(p.costs, cfg)}`)
      return 0
    }
    case "compat": {
      const r = await compat(p, { merge: flag(args, "merge"), log: (s) => console.log(s) })
      return r.ok ? 0 : 1
    }
    default:
      console.log(`Unknown command "${cmd}".\n\n${HELP}`)
      return 1
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\n${(e as Error).message}`)
    process.exit(1)
  },
)
