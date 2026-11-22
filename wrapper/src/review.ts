// The Apply review: before anything is sent, the user sees what the tailored CV changed compared
// with their own resume, the letter, every answer that will go into the form, and anything a
// second check couldn't find in their profile. Nothing here sends or writes outside wrapper-data.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import type { Config } from "./data/config.ts"
import { readTracker, type TrackerRow } from "./data/tracker.ts"
import { readSeen } from "./data/seen.ts"
import { readBank } from "./data/answers.ts"
import { readLeads } from "./data/leads.ts"
import { policyFor } from "./fill/policy.ts"
import { readJson, writeJson, nowIso } from "./lib/store.ts"
import { unsupportedClaims } from "./safety/grounding.ts"
import { readResume } from "./intake.ts"
import type { ClaudeExec } from "./lib/claude.ts"
import { sameJobUrl, companyRoleKey } from "./lib/joburl.ts"

// ---------- reading LaTeX and resumes as plain lines ----------

const LINE_START = /^\s*\\(resumeItem|resumeLine|resumeSubheading|item|cvitem|cventry|cvlistitem|cvlistdoubleitem|section|subsection|lettercontent|small)\b/

/** LaTeX to readable text: commands dropped, their arguments kept, escapes undone. */
export function texToText(s: string): string {
  let t = s
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(vspace|hspace|setlength|addtolength)\*?\{[^}]*\}(\{[^}]*\})?/g, "")
    .replace(/\\(begin|end)\{[^}]*\}(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*/g, " ")
    .replace(/(^|[^\\])&/g, "$1 ")
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")
    .replace(/\\(textbf|textit|emph|underline|small|large|Large|LARGE|scshape|textsc|mbox|text)\b\s*/g, "")
    .replace(/\\resumeItem\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*\{/g, "$1: {")
  for (let i = 0; i < 4; i++) t = t.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, " ")
  return t
    .replace(/\\%/g, "%").replace(/\\&/g, "&").replace(/\\\$/g, "$").replace(/\\_/g, "_").replace(/\\#/g, "#")
    .replace(/\\,/g, " ").replace(/~/g, " ").replace(/\\\\/g, " ").replace(/---?/g, "-")
    .replace(/[{}]/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\s+/g, " ")
    // "\textbf{21\%}." leaves "21% ." once the braces go: no space before punctuation.
    .replace(/\s+([.,;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim()
}

/** The CV's content as one readable line per bullet, heading or paragraph. */
export function texLines(tex: string): string[] {
  const body = tex.includes("\\begin{document}") ? tex.slice(tex.indexOf("\\begin{document}") + 16) : tex
  const chunks: string[] = []
  let cur = ""
  for (const raw of body.replace(/\\end\{document\}[\s\S]*$/, "").split("\n")) {
    if (LINE_START.test(raw) && cur.trim()) {
      chunks.push(cur)
      cur = ""
    }
    cur += raw + "\n"
  }
  if (cur.trim()) chunks.push(cur)
  return chunks.map(texToText).filter((l) => l.split(" ").length >= 3)
}

/** A resume's text (from its PDF or Word file) as one line per bullet or paragraph. */
export function resumeLines(text: string): string[] {
  const out: string[] = []
  let cur = ""
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    // A heading ("Experience", "Technical Skills") is a divider, not content.
    if (/^[A-Z][A-Za-z&]*(?: [A-Za-z&]+){0,2}$/.test(line) && line.length <= 30) {
      if (cur) out.push(cur)
      cur = ""
      continue
    }
    const starts = /^[•◦▪●\-*–]\s/.test(line)
    if (starts && cur) {
      out.push(cur)
      cur = ""
    }
    cur = cur ? `${cur} ${line}` : line
  }
  if (cur) out.push(cur)
  return out.map((l) => l.replace(/^[•◦▪●\-*–]\s*/, "").replace(/\s+/g, " ").trim()).filter((l) => l.split(" ").length >= 3)
}

const STOP = new Set("a an and the of to in on for with at by from as is are was were be into that this it its or over across using via".split(" "))
const words = (s: string) => s.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9][a-z0-9.+#%/-]*/g)?.filter((w) => !STOP.has(w)) ?? []

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

/** How alike two lines are, 0 to 1: shared words over all words (Dice). */
export function similarity(a: string, b: string): number {
  const A = new Set(words(a))
  const B = new Set(words(b))
  if (!A.size || !B.size) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return (2 * both) / (A.size + B.size)
}

export interface Change {
  kind: "new" | "reworded" | "dropped"
  before?: string
  after?: string
}

/** Line by line: what the tailored version added, reworded, or left out, compared with the original. */
export function compareLines(base: string[], tailored: string[]): { changes: Change[]; same: number } {
  const changes: Change[] = []
  const used = new Set<number>()
  let same = 0
  for (const t of tailored) {
    let best = -1
    let score = 0
    base.forEach((b, i) => {
      const s = similarity(b, t)
      if (s > score) {
        score = s
        best = i
      }
    })
    if (score >= 0.88 || (best >= 0 && flat(base[best]) === flat(t))) {
      same++
      used.add(best)
    } else if (score >= 0.45) {
      changes.push({ kind: "reworded", before: base[best], after: t })
      used.add(best)
    } else changes.push({ kind: "new", after: t })
  }
  // A rewritten line (a new summary, say) shares fewer words: pair it with the unused original it's closest to.
  for (const c of changes) {
    if (c.kind !== "new") continue
    let best = -1
    let score = 0.25
    base.forEach((b, i) => {
      const s = used.has(i) ? 0 : similarity(b, c.after!)
      if (s > score) {
        score = s
        best = i
      }
    })
    if (best >= 0) {
      c.kind = "reworded"
      c.before = base[best]
      used.add(best)
    }
  }
  base.forEach((b, i) => {
    if (!used.has(i) && !tailored.some((t) => similarity(b, t) >= 0.45)) changes.push({ kind: "dropped", before: b })
  })
  return { changes, same }
}

// ---------- the review itself ----------

export interface ReviewField {
  label: string
  value: string
  source: string
}

export interface ApplicationReview {
  key: string
  url: string
  company: string
  role: string
  site: string
  /** "fill": jobdesk fills the form in your browser and shows it before sending. "kit": you apply, with everything ready. */
  how: "fill" | "kit"
  how_note: string
  cv: { tex: string; pdf: string; pdf_exists: boolean }
  letter: { tex: string; pdf: string; pdf_exists: boolean; text: string }
  /** The resume the CV is compared with (documents/cv/...), or the profile when there is none. */
  base: string
  changes: Change[]
  unchanged: number
  fields: ReviewField[]
  /** Statements in the CV changes or the letter that the profile doesn't support. */
  unsupported: string[]
  /** True when the fact check ran over the changed lines and the letter. */
  checked: boolean
  check_error?: string
  warnings: string[]
  created: string
  usd: number
}

export function reviewFile(p: Paths, key: string): string {
  return join(p.reviews, "applications", `${key.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`)
}

export function readReview(p: Paths, key: string): ApplicationReview | null {
  return readJson<ApplicationReview | null>(reviewFile(p, key), null)
}

/** The newest resume the user gave (documents/cv/), as lines. */
export async function baseResume(p: Paths): Promise<{ file: string; lines: string[] }> {
  const dir = join(p.root, "documents", "cv")
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => [".pdf", ".docx", ".txt", ".md"].includes(extname(f).toLowerCase())).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    : []
  for (const f of files) {
    const r = await readResume(p.root, join(dir, f))
    if (r.text) return { file: `documents/cv/${f}`, lines: resumeLines(r.text) }
  }
  const profile = existsSync(p.profile) ? readFileSync(p.profile, "utf8").replace(/<!--[\s\S]*?-->/g, "") : ""
  return { file: "your profile", lines: resumeLines(profile.replace(/^#+\s.*$/gm, "").replace(/\*\*/g, "")) }
}

const pdfOf = (tex: string) => tex.replace(/\.tex$/i, ".pdf")

/** The tracker row for a job: same job link (by identity, not exact text), else same company and role. */
export function trackerRowFor(p: Paths, url: string, company?: string, role?: string): TrackerRow | undefined {
  const rows = readTracker(p.tracker).rows
  const byUrl = rows.find((r) => sameJobUrl(r.source, url))
  if (byUrl || !company || !role) return byUrl
  const k = companyRoleKey(company, role)
  return rows.find((r) => companyRoleKey(r.company, r.role) === k)
}

/** Build (and save) the review for a drafted application. Uses the small model once for the check. */
export async function buildReview(p: Paths, cfg: Config, job: { key: string; url: string; company: string; role: string }, o: { exec?: ClaudeExec } = {}): Promise<ApplicationReview> {
  const row = trackerRowFor(p, job.url)
  if (!row?.cv_file) throw new Error(`There's no tailored CV for ${job.company || job.url} yet.`)
  const read = (rel: string) => (rel && existsSync(join(p.root, rel)) ? readFileSync(join(p.root, rel), "utf8") : "")
  const cvTex = read(row.cv_file)
  const letterTex = read(row.cover_letter_file)
  const base = await baseResume(p)
  const { changes, same } = compareLines(base.lines, texLines(cvTex))
  const letterText = texLines(letterTex).join("\n\n")
  const pol = policyFor(job.url)
  const how: ApplicationReview["how"] = pol.policy === "automate" && cfg.approval_level !== "L0" ? "fill" : "kit"
  const bank = readBank(p.answers)
  const fields: ReviewField[] = [
    ...Object.values(bank).filter((a) => !a.sensitive || a.allow_in_applications).map((a) => ({ label: a.label, value: a.answer, source: a.source === "profile" ? "your profile" : "your saved answers" })),
    { label: "CV", value: pdfOf(row.cv_file), source: "written for this job" },
    ...(row.cover_letter_file ? [{ label: "Cover letter", value: pdfOf(row.cover_letter_file), source: "written for this job" }] : []),
  ]
  // Second look: every line that is new or reworded, and the whole letter, against the profile.
  const claims = [...changes.filter((c) => c.after).map((c) => `- ${c.after}`), letterText].join("\n").trim()
  let unsupported: string[] = []
  let check_error: string | undefined
  let usd = 0
  if (claims && existsSync(p.profile)) {
    const g = await unsupportedClaims({ root: p.root, ledger: p.costs, cfg, source: readFileSync(p.profile, "utf8").slice(0, 30000), text: claims.slice(0, 20000), exec: o.exec })
    unsupported = g.unsupported
    check_error = g.error
    usd = g.usd
  }
  const warnings: string[] = []
  const lead = readLeads(p.leads)[job.key]
  if (lead) warnings.push(...lead.flags.scam, ...lead.flags.discrimination)
  const cvPdf = pdfOf(row.cv_file)
  const letterPdf = row.cover_letter_file ? pdfOf(row.cover_letter_file) : ""
  if (!cvTex) warnings.push(`The CV file ${row.cv_file} is missing, so there is nothing to compare. Draft it again before applying.`)
  else if (!existsSync(join(p.root, cvPdf))) warnings.push(`There's no PDF of the CV yet, and job sites need one. If LaTeX isn't installed, run this in the jobdesk folder: ${process.platform === "win32" ? 'powershell -c "irm https://drop-ps1.fullyjustified.net | iex"' : "sh wrapper/install.sh --latex"}. Then apply again to build the PDFs.`)
  const review: ApplicationReview = {
    key: job.key, url: job.url, company: row.company || job.company, role: row.role || job.role, site: pol.name, how,
    how_note: how === "fill"
      ? `jobdesk fills the ${pol.name} form in your browser and shows you every field. Nothing is sent until you tap Send.`
      : pol.policy === "automate"
        ? `You apply on ${pol.name} yourself: one tap opens the page, with your files and answers ready to copy. (To let jobdesk fill ${pol.name} forms for you, choose "Fill forms, I confirm each" in Settings.)`
        : `${pol.name} needs your own login, so you apply there yourself: one tap opens the page, with your files and answers ready to copy.`,
    cv: { tex: row.cv_file, pdf: cvPdf, pdf_exists: existsSync(join(p.root, cvPdf)) },
    letter: { tex: row.cover_letter_file, pdf: letterPdf, pdf_exists: !!letterPdf && existsSync(join(p.root, letterPdf)), text: letterText },
    base: base.file, changes: cvTex ? changes : [], unchanged: same, fields, unsupported, checked: !!claims && !check_error, check_error, warnings, created: nowIso(), usd,
  }
  mkdirSync(join(p.reviews, "applications"), { recursive: true })
  writeJson(reviewFile(p, job.key), review)
  return review
}

/** Short version for a chat message. */
export function reviewSummary(r: ApplicationReview): string {
  const n = (k: Change["kind"]) => r.changes.filter((c) => c.kind === k).length
  const lines = [`Ready to review: ${r.role} at ${r.company}`, "", `What I changed in your CV (compared with ${r.base}):`]
  const shown = r.changes.filter((c) => c.kind !== "dropped").slice(0, 6)
  for (const c of shown) lines.push(c.kind === "new" ? `+ Added: ${c.after}` : `~ Reworded: ${c.after}`)
  if (r.changes.length - shown.length - n("dropped") > 0) lines.push(`...and ${r.changes.length - shown.length - n("dropped")} more.`)
  if (n("dropped")) lines.push(`- Left out ${n("dropped")} line${n("dropped") === 1 ? " that matters" : "s that matter"} less for this job.`)
  if (!r.changes.length) lines.push("Nothing: it's your resume as it is.")
  lines.push(`${r.unchanged} line${r.unchanged === 1 ? "" : "s"} kept as they were.`)
  lines.push("", r.unsupported.length ? `Check these. I couldn't find them in your profile:\n${r.unsupported.map((u) => `! ${u}`).join("\n")}` : r.check_error ? `The fact check didn't run (${r.check_error}). Read it carefully.` : r.checked ? "I checked every changed line and the letter against your profile: nothing is made up." : "There was nothing new to check.")
  lines.push("", `What goes in the form: ${r.fields.filter((f) => f.source !== "written for this job").map((f) => f.label).join(", ") || "your CV and letter only"}.`)
  if (r.warnings.length) lines.push("", ...r.warnings.map((w) => `Note: ${w}`))
  lines.push("", r.how_note)
  return lines.join("\n")
}
