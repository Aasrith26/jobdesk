// The answer bank (APP-3): answers the candidate approved, reused across forms.
// Nothing here is ever invented: an unmatched question returns null and goes to the
// attention queue. Sensitive entries (SAFE-4) are only used when explicitly allowed.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { readJson, writeJson, today } from "../lib/store.ts"

export interface Answer {
  key: string
  label: string
  answer: string
  /** Normalised question texts the user answered this for (custom questions). */
  questions: string[]
  sensitive: boolean
  /** For sensitive entries: the user explicitly allowed using it in applications. */
  allow_in_applications?: boolean
  source: "profile" | "user" | "chat"
  updated: string
}

export type Bank = Record<string, Answer>

/** Built-in question patterns. Order matters: first match wins. */
export const BUILTIN: { key: string; label: string; re: RegExp; sensitive?: boolean }[] = [
  // "Preferred first and last name" / "first name and last name" in one box is the full name.
  { key: "full_name", label: "Full name", re: /\bfirst\s*(name\s*)?(and|&)\s*last\s*name\b/ },
  { key: "first_name", label: "First name", re: /\b(first|given)\s*name\b/ },
  { key: "last_name", label: "Last name", re: /\b(last|family)\s*name\b|\bsurname\b/ },
  // Not "how do you pronounce your name", "preferred name", "nickname" - those aren't the legal full name.
  { key: "full_name", label: "Full name", re: /^(?!.*\b(pronoun|pronunciation|pronounce|preferred|nick\s*name|phonetic|chosen)\b).*\b(full\s*name|your\s*name|^name$|legal\s*name)\b/ },
  { key: "email", label: "Email", re: /\be[- ]?mail\b/ },
  { key: "phone", label: "Phone", re: /\b(phone|mobile|contact\s*number|whatsapp)\b/ },
  { key: "linkedin", label: "LinkedIn URL", re: /\blinked\s*in\b/ },
  { key: "github", label: "GitHub URL", re: /\bgit\s*hub\b/ },
  { key: "website", label: "Website / portfolio", re: /\b(website|portfolio|personal\s*site|blog)\b/ },
  { key: "citizenship", label: "Citizenship (all countries)", re: /\b(citizenship|country of citizenship|passport country|nationality)\b/ },
  { key: "country", label: "Country of residence", re: /\b(country of residence|what country|which country|country are you (based|located|living) in|current country)\b|^country$/ },
  { key: "location", label: "Current location", re: /\b(current\s*)?(location|city)\b|where\s*are\s*you\s*(based|located)|where\s*do\s*you\s*(intend|plan)\s*to\s*work\s*from/ },
  { key: "postal_code", label: "Postal / PIN code", re: /\b(zip|postal|pin)\s*code\b/ },
  { key: "non_compete", label: "Bound by a non-compete or employment agreement", re: /\bnon[- ]?compet|\bpost[- ]?employment restrictions?\b|\bemployment agreements?\b/ },
  { key: "current_company", label: "Current company", re: /\b(current|present)\s*(company|employer|organi[sz]ation)\b|\bname of your current\b.*\b(company|employer)\b|\bcurrent or most recent (company|employer)\b/ },
  // Only questions ABOUT the title ("Current title", "What is your current designation?"), not
  // "How are you using AI in your current role?".
  { key: "current_title", label: "Current job title", re: /^(what('s| is) your |your |please (enter|provide) your )?(current|present)\s*(job\s*)?(title|designation|role|position)\s*$|^(what('s| is) your )?(current|present)\s*(job\s*)?(title|designation)\b/ },
  { key: "university", label: "University / college", re: /\b(which|what)\s+(university|college|school)\b|\b(university|college|school)\s+(did you|you)\s+(attend|attended|graduate|study)|^(university|college|school|institution)(\s+name)?$/ },
  { key: "notice_period", label: "Notice period", re: /\bnotice\s*period\b|\bhow\s*soon\s*can\s*you\s*(join|start)\b|\bearliest\s*start\b|\bavailability\s*to\s*start\b|\bwhen\s*can\s*you\s*(start|join)\b|\bavailable\s*to\s*(start|join)\b/ },
  { key: "current_ctc", label: "Current CTC", re: /\bcurrent\s*(ctc|salary|compensation|pay)\b/ },
  { key: "expected_ctc", label: "Expected CTC", re: /\b(expected|desired)\s*(ctc|salary|compensation|pay)\b|\bsalary\s*expectation/ },
  // Total experience only - "experience as a tech lead", "in sales", "with Kubernetes" is a different question.
  { key: "total_experience", label: "Total years of experience", re: /^(?!.*\bexperience\s+(as|in|with|leading|managing|of\s+(leading|managing|working with))\b)(?!.*\bas\s+an?\s+\w+).*(\b(total\s*)?(years?\s*of\s*(professional\s*|relevant\s*|work\s*)?experience|total\s*experience|experience\s*\(years\))\b|\bhow many years\b.*\b(experience|worked)\b)/ },
  { key: "relocation", label: "Willing to relocate", re: /\breloca/ },
  { key: "work_authorization", label: "Work authorization", re: /\b(authori[sz]ed\s*to\s*work|work\s*authori[sz]ation|right\s*to\s*work|work\s*permit)\b/ },
  { key: "sponsorship", label: "Needs visa sponsorship", re: /\b(visa\s*)?sponsorship\b|\brequire\s*(a\s*)?visa\b/ },
  { key: "heard_about", label: "How did you hear about us", re: /\bhow\s*(did\s*)?you\s*(hear|heard|find|found|learn|learned|come across|get to know|got to know)\b|\bhear(d)?\s*about\s*(us|this)\b|\breferral\s*source\b|\bsource\s*of\s*application\b/ },
  { key: "onsite_ok", label: "Open to working from an office / in person", re: /\b(willing|open|able|comfortable)\b.*\b(work(ing)? (from|in) (the )?office|in[- ]?person|on[- ]?site|in office)\b|\b(work(ing)? (from|in) (the )?office|in[- ]?person|on[- ]?site)\b.*\b(willing|open|able|comfortable|ok|okay)\b/ },
  { key: "remote_ok", label: "Open to remote / hybrid", re: /\b(remote|hybrid|on[- ]?site|in[- ]office)\b.*\b(ok|okay|comfortable|willing|open|able)\b/ },
  // Sensitive / voluntary self-identification (SAFE-4, APP-9): never auto-answered from the bank
  // unless the user explicitly allowed it; voluntary questions default to "prefer not to say".
  { key: "sexual_orientation", label: "Sexual orientation", re: /\bsexual orientation\b/, sensitive: true },
  { key: "transgender", label: "Transgender identity", re: /\btransgender\b/, sensitive: true },
  { key: "first_generation", label: "First-generation professional", re: /\bfirst[- ]generation\b/, sensitive: true },
  { key: "military", label: "Military status", re: /\bmilitary\s*(status|service)\b|\barmed forces\b/, sensitive: true },
  { key: "gender", label: "Gender", re: /\bgender\b|\bsex\b/, sensitive: true },
  { key: "disability", label: "Disability status", re: /\bdisabilit/, sensitive: true },
  { key: "veteran", label: "Veteran status", re: /\bveteran\b/, sensitive: true },
  { key: "ethnicity", label: "Race / ethnicity", re: /\b(race|ethnic|hispanic|latino)\b/, sensitive: true },
  { key: "date_of_birth", label: "Date of birth / age", re: /\b(date\s*of\s*birth|dob|your\s*age)\b/, sensitive: true },
  { key: "marital_status", label: "Marital status", re: /\bmarital\b/, sensitive: true },
  { key: "religion_caste", label: "Religion / caste", re: /\b(religion|caste|community)\b/, sensitive: true },
]

export function normQuestion(q: string): string {
  return q.toLowerCase().replace(/\*/g, "").replace(/\(required\)|\(optional\)/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

export function builtinFor(question: string): (typeof BUILTIN)[number] | undefined {
  const q = normQuestion(question)
  return BUILTIN.find((b) => b.re.test(q))
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter((w) => w.length > 2))
  const B = new Set(b.split(" ").filter((w) => w.length > 2))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

export interface Lookup {
  answer: Answer | null
  key: string | null
  sensitive: boolean
  /** Why it could not be used, when answer is null. */
  reason?: "unknown" | "sensitive_not_allowed"
}

export function lookup(bank: Bank, question: string): Lookup {
  const b = builtinFor(question)
  if (b) {
    const a = bank[b.key]
    if (b.sensitive) {
      if (a && a.allow_in_applications) return { answer: a, key: b.key, sensitive: true }
      return { answer: null, key: b.key, sensitive: true, reason: "sensitive_not_allowed" }
    }
    if (a) return { answer: a, key: b.key, sensitive: false }
    return { answer: null, key: b.key, sensitive: false, reason: "unknown" }
  }
  const nq = normQuestion(question)
  let best: Answer | null = null
  let bestScore = 0
  for (const a of Object.values(bank)) {
    for (const q of a.questions) {
      const s = q === nq ? 1 : jaccard(q, nq)
      if (s > bestScore) {
        bestScore = s
        best = a
      }
    }
  }
  if (best && bestScore >= 0.8) {
    if (best.sensitive && !best.allow_in_applications) return { answer: null, key: best.key, sensitive: true, reason: "sensitive_not_allowed" }
    return { answer: best, key: best.key, sensitive: best.sensitive }
  }
  return { answer: null, key: null, sensitive: false, reason: "unknown" }
}

export function readBank(file: string): Bank {
  return readJson<Bank>(file, {})
}

export function setAnswer(
  file: string,
  input: { key?: string; question?: string; answer: string; sensitive?: boolean; allow_in_applications?: boolean; source?: Answer["source"] },
): Answer {
  const bank = readBank(file)
  const b = input.key ? BUILTIN.find((x) => x.key === input.key) : input.question ? builtinFor(input.question) : undefined
  const key = input.key ?? b?.key ?? "q_" + normQuestion(input.question ?? "").replace(/ /g, "_").slice(0, 60)
  if (!key || key === "q_") throw new Error("An answer needs a key or the question text")
  const prev = bank[key]
  const questions = new Set(prev?.questions ?? [])
  if (input.question) questions.add(normQuestion(input.question))
  const a: Answer = {
    key,
    label: b?.label ?? prev?.label ?? input.question ?? key,
    answer: input.answer.trim(),
    questions: [...questions],
    sensitive: input.sensitive ?? b?.sensitive ?? prev?.sensitive ?? false,
    allow_in_applications: input.allow_in_applications ?? prev?.allow_in_applications,
    source: input.source ?? "user",
    updated: today(),
  }
  bank[key] = a
  writeJson(file, bank)
  return a
}

/** Seed identity answers from 01-candidate-profile.md's Identity bullets (only what is there). */
export function seedFromProfile(file: string, profilePath: string): Answer[] {
  if (!existsSync(profilePath)) return []
  const text = readFileSync(profilePath, "utf8")
  const field = (name: string) => text.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, "i"))?.[1]?.trim()
  const out: Answer[] = []
  const bank = readBank(file)
  const put = (key: string, v: string | undefined) => {
    if (!v || /\[YOUR|pending|\[FIRST/i.test(v) || bank[key]) return
    out.push(setAnswer(file, { key, answer: v, source: "profile" }))
  }
  // Only the full name is copied. Splitting it into first/last would be a guess (name order
  // differs across cultures), so forms that ask for them get one question to the user instead.
  put("full_name", field("Name"))
  put("email", field("Email"))
  put("phone", field("Phone"))
  const li = field("LinkedIn")
  put("linkedin", li && !/^https?:/.test(li) ? "https://" + li : li)
  const gh = field("GitHub")
  put("github", gh && !/^https?:/.test(gh) ? "https://" + gh : gh)
  put("location", field("Location"))
  return out
}

const PROFILE_SECTION = "## Application answers (confirmed by the candidate)"

/**
 * Write a confirmed, non-sensitive fact back to 01-candidate-profile.md (the upstream
 * "write new facts back to the profile" rule), so later drafting sessions treat it as grounded.
 */
export function writeBackToProfile(profilePath: string, a: Answer): boolean {
  if (a.sensitive || !existsSync(profilePath)) return false
  let text = readFileSync(profilePath, "utf8")
  const line = `- **${a.label}:** ${a.answer} (confirmed ${a.updated})`
  if (!text.includes(PROFILE_SECTION)) {
    text = text.replace(/\s*$/, "") + `\n\n${PROFILE_SECTION}\n<!-- Written by jobdesk when the candidate answers an application question. -->\n${line}\n`
  } else {
    const re = new RegExp(`^- \\*\\*${a.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*.*$`, "m")
    const start = text.indexOf(PROFILE_SECTION)
    const head = text.slice(0, start)
    let tail = text.slice(start)
    tail = re.test(tail) ? tail.replace(re, line) : tail.replace(/\s*$/, "") + `\n${line}\n`
    text = head + tail
  }
  writeFileSync(profilePath, text, "utf8")
  return true
}
