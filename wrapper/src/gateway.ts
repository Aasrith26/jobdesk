// The command surface exposed to OpenClaw (MSG-8) and any other chat adapter: a fixed
// allowlist with validated arguments, read-mostly, no shell. Approval flows (fill, draft)
// are deliberately not here - they need buttons and run on Telegram or the dashboard.

import type { Paths } from "./lib/paths.ts"
import { readConfig } from "./data/config.ts"
import { composeDigest, digestJobs } from "./digest.ts"
import { openItems } from "./data/attention.ts"
import { readTracker, updateStatus, bucketOf, findRow } from "./data/tracker.ts"
import { buildKit } from "./kit.ts"
import { ingestLink } from "./links.ts"
import { setAnswer, writeBackToProfile } from "./data/answers.ts"
import { scan } from "./scan.ts"

export const GATEWAY_COMMANDS = ["help", "digest", "jobs", "status", "attention", "kit", "lead", "applied", "answer", "scan"] as const
type Cmd = (typeof GATEWAY_COMMANDS)[number]

export class GatewayError extends Error {}

function validate(cmd: string, arg: string): asserts cmd is Cmd {
  if (!(GATEWAY_COMMANDS as readonly string[]).includes(cmd)) throw new GatewayError(`"${cmd}" isn't allowed. Allowed: ${GATEWAY_COMMANDS.join(", ")}.`)
  if (/[\r\n`$;|&<>]/.test(arg) && cmd !== "answer") throw new GatewayError("That argument has characters that aren't allowed.")
  if (cmd === "lead" && !/^https?:\/\/\S+$/.test(arg)) throw new GatewayError("lead needs one http(s) link.")
  if ((cmd === "kit" || cmd === "applied") && !/^(\d{1,2}|https?:\/\/\S+|[\w .&'-]{2,80})$/.test(arg)) throw new GatewayError(`${cmd} needs a job number, link or company name.`)
  if (cmd === "answer" && (!arg.includes("=") || arg.length > 500)) throw new GatewayError('answer needs "question = answer".')
}

export async function gateway(p: Paths, cmd: string, arg = ""): Promise<string> {
  arg = arg.trim()
  validate(cmd, arg)
  const cfg = readConfig(p.config)
  const pick = (a: string) => {
    if (/^\d+$/.test(a)) return digestJobs(p, 8)[Number(a) - 1]?.url ?? a
    return a
  }
  switch (cmd) {
    case "help":
      return `You can send: ${GATEWAY_COMMANDS.join(", ")}. To fill forms or write a CV, use the Telegram bot or the dashboard.`
    case "digest":
      return composeDigest(p, cfg).text
    case "jobs":
      return digestJobs(p, 8).map((j, i) => `${i + 1}. ${j.title} at ${j.company}${j.flagged ? " (warning)" : ""}\n${j.url}`).join("\n\n") || "No jobs yet."
    case "status": {
      const rows = readTracker(p.tracker).rows
      const c = (b: string) => rows.filter((r) => bucketOf(r.status).bucket === b).length
      return `Drafted ${c("Drafted")}, waiting ${c("Active")}, interviews ${c("Interview")}, offers ${c("Offer")}. Needs you: ${openItems(p.attention).length}.`
    }
    case "attention":
      return openItems(p.attention).slice(0, 10).map((i) => `- ${i.title}: ${i.action}`).join("\n") || "Nothing needs you."
    case "kit":
      return buildKit(p, pick(arg)).text
    case "lead": {
      const r = await ingestLink(p, cfg, arg)
      return [`${r.title} - ${r.company}`, `Fit (keywords): ${r.fit}`, ...[...r.scam, ...r.discrimination].map((w) => `Warning: ${w}`)].join("\n")
    }
    case "applied": {
      const target = pick(arg)
      const t = readTracker(p.tracker)
      const row = t.rows.find((r) => r.source === target) ?? findRow(t, { company: target })
      if (!row) return "Not in your tracker yet."
      updateStatus(p.tracker, { company: row.company, role: row.role, url: row.source }, "applied", "marked applied from chat")
      return `Marked ${row.company} as applied.`
    }
    case "answer": {
      const [q, ...a] = arg.split("=")
      const saved = setAnswer(p.answers, { question: q.trim(), answer: a.join("=").trim(), source: "chat" })
      if (!saved.sensitive) writeBackToProfile(p.profile, saved)
      return `Saved: ${saved.label} = ${saved.answer}`
    }
    case "scan": {
      const s = await scan(p, cfg)
      return `${s.added.length} new jobs. ${s.flagged.length} with warnings.`
    }
  }
}
