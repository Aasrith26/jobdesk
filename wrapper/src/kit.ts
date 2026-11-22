// Application kit (APP-1, L0): files, every known answer ready to copy, the apply link and
// the site policy - for every approved application, whatever the site allows.

import { existsSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { readTracker, findRow, type TrackerRow } from "./data/tracker.ts"
import { readSeen, type SeenJob } from "./data/seen.ts"
import { readBank, type Answer } from "./data/answers.ts"
import { readLeads } from "./data/leads.ts"
import { policyFor } from "./fill/policy.ts"
import type { Config } from "./data/config.ts"
import { today } from "./lib/store.ts"

export interface Kit {
  key: string
  company: string
  role: string
  url: string
  policy: ReturnType<typeof policyFor>
  files: { label: string; path: string; exists: boolean }[]
  answers: { label: string; answer: string }[]
  warnings: string[]
  html_path: string
  text: string
}

/** Tailored applications started today (OUT-4): tracker rows dated today that are drafted or later. */
export function applicationsToday(trackerFile: string, day = today()): number {
  return readTracker(trackerFile).rows.filter((r) => r.date === day).length
}

export function capCheck(p: Paths, cfg: Config): { ok: boolean; used: number; cap: number; message?: string } {
  const used = applicationsToday(p.tracker)
  const cap = cfg.daily_application_cap
  if (used < cap) return { ok: true, used, cap }
  return {
    ok: false,
    used,
    cap,
    message: `You've started ${used} applications today, which is your daily limit of ${cap}. Fewer, better applications get more replies. To change the limit, run: jobdesk config cap <number>`,
  }
}

const pdfOf = (tex: string) => tex.replace(/\.tex$/i, ".pdf")

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function buildKit(p: Paths, ref: string): Kit {
  const t = readTracker(p.tracker)
  const seen = readSeen(p.seen)
  let row: TrackerRow | undefined = t.rows.find((r) => r.source === ref) ?? findRow(t, { company: ref })
  let job: SeenJob | undefined = seen.find((j) => j.key === ref || j.url === ref)
  if (!row && job) row = findRow(t, { company: job.company, role: job.title }) ?? t.rows.find((r) => r.source === job!.url)
  if (!job && row) job = seen.find((j) => j.url === row!.source)
  if (!row && !job) throw new Error(`Nothing found for "${ref}". Use a job link, a company name from the tracker, or a key from the dashboard.`)
  const company = row?.company || job?.company || ""
  const role = row?.role || job?.title || ""
  const url = row?.source || job?.url || ""
  const key = job?.key ?? `${company}_${role}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const files: Kit["files"] = []
  for (const [label, tex] of [["CV", row?.cv_file], ["Cover letter", row?.cover_letter_file]] as const) {
    if (!tex) continue
    const pdf = join(p.root, pdfOf(tex))
    files.push({ label: `${label} (PDF)`, path: pdf, exists: existsSync(pdf) })
  }
  const bank = readBank(p.answers)
  const answers = Object.values(bank)
    .filter((a: Answer) => !a.sensitive || a.allow_in_applications)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((a) => ({ label: a.label, answer: a.answer }))
  const warnings: string[] = []
  const lead = readLeads(p.leads)[key]
  if (lead?.flags.scam.length) warnings.push(...lead.flags.scam)
  if (lead?.flags.discrimination.length) warnings.push(...lead.flags.discrimination)
  if (!files.length) warnings.push("No CV for this job yet. Draft one first (the Draft button, or /apply).")
  for (const f of files) if (!f.exists) warnings.push(`${f.label} hasn't been compiled yet: ${relative(p.root, f.path)}`)
  const policy = policyFor(url)
  const text = [
    `Kit: ${role} at ${company}`,
    `Apply here: ${url}`,
    `How: ${policy.note}`,
    "",
    "Files:",
    ...files.map((f) => `- ${f.label}: ${relative(p.root, f.path)}${f.exists ? "" : " (missing)"}`),
    "",
    "Answers you approved:",
    ...answers.map((a) => `- ${a.label}: ${a.answer}`),
    ...(warnings.length ? ["", "Check first:", ...warnings.map((w) => `- ${w}`)] : []),
    "",
    "If the form asks something new, send me the question and your answer. I'll remember it.",
  ].join("\n")
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kit - ${esc(company)}</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#ddd;--accent:#0b57d0;--warn:#8a4b00;--warnbg:#fff4e0}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333;--accent:#8ab4f8;--warn:#ffcc80;--warnbg:#2b2210}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:16px}
h1{font-size:1.4rem}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
button{font:inherit;padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:6px;cursor:pointer;min-height:44px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.warn{background:var(--warnbg);color:var(--warn);padding:8px 12px;border-radius:6px}a{color:var(--accent)}code{word-break:break-all}</style></head><body>
<h1>${esc(role)} at ${esc(company)}</h1>
<p><a href="${esc(url)}" rel="noopener noreferrer">Open the application page</a></p><p>${esc(policy.name)}: ${esc(policy.note)}</p>
${warnings.length ? `<div class="warn" role="alert"><strong>Check first:</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
<h2>Files</h2><ul>${files.map((f) => `<li>${esc(f.label)}: <code>${esc(f.path)}</code>${f.exists ? "" : " (missing)"}</li>`).join("")}</ul>
<h2>Your answers</h2><table><thead><tr><th scope="col">Question</th><th scope="col">Answer</th><th scope="col"><span class="sr">Copy</span></th></tr></thead><tbody>
${answers.map((a, i) => `<tr><td>${esc(a.label)}</td><td id="a${i}">${esc(a.answer)}</td><td><button type="button" aria-label="Copy ${esc(a.label)}" onclick="navigator.clipboard.writeText(document.getElementById('a${i}').textContent)">Copy</button></td></tr>`).join("")}
</tbody></table><p>If the form asks something new, send the question and your answer to the bot. It will remember it for next time.</p></body></html>`
  const html_path = join(p.kits, `${key.replace(/[^a-z0-9_-]+/gi, "-")}.html`)
  writeFileSync(html_path, html, "utf8")
  return { key, company, role, url, policy, files, answers, warnings, html_path, text }
}
