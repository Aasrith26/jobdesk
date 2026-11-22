// Turns a scanned form into a fill plan. Pure function, no browser: every value carries its
// source (APP-4); anything without one becomes an unknown question or a hard stop.

import { lookup, builtinFor, type Bank } from "../data/answers.ts"
import { DECLINE_RE, LEGAL_RE, VOLUNTARY_RE, pickOption, type PageField, type PageScan } from "./forms.ts"

export interface Action {
  field: PageField
  kind: "text" | "select" | "radio" | "file" | "combobox"
  value: string
  display: string
  source: string
}

export interface Stop {
  field?: PageField
  reason: "captcha" | "login" | "legal_statement" | "unsupported_field" | "unknown_file" | "no_decline_option"
  message: string
}

export interface Unknown {
  field: PageField
  question: string
  sensitive: boolean
}

export interface Plan {
  actions: Action[]
  unknown: Unknown[]
  stops: Stop[]
  skipped: { field: PageField; why: string }[]
}

export interface AppFiles {
  cv?: string
  cover?: string
}

const SUPPORTED = new Set(["text", "email", "tel", "url", "number", "textarea", "select-one", "select", "radio", "checkbox", "file", "combobox"])

/** Combobox value meaning "open it and pick the decline / prefer-not-to-say option". */
export const DECLINE_TOKEN = "__DECLINE__"

/** Bank entries whose answer is a yes/no decision. */
const YES_NO_KEYS = new Set(["relocation", "sponsorship", "work_authorization", "remote_ok", "onsite_ok", "non_compete"])
/** "What is the address...", "Please describe..." - asks for content, not a decision. */
export function isOpenQuestion(label: string): boolean {
  return /^\s*(what|which|where|when|how|why|who|please|describe|explain|share|tell|list|provide|give|write|enter|mention)\b/i.test(label)
}
const isYesNo = (s: string) => /^(yes|no|y|n|true|false)\b/i.test(s.trim())
/** "Are you...?", "Do you have...?" - expects yes or no. */
export function isYesNoQuestion(label: string): boolean {
  return /^\s*(are|do|does|did|have|has|had|is|was|were|will|would|can|could|should)\s+(you|your|we)\b/i.test(label) && !/\b(which|what|where|how many|how much)\b/i.test(label)
}

/** What jobdesk knows about this application, for answers it can work out instead of asking. */
export interface PlanContext {
  /** The employer's name or ATS slug (e.g. "figma", "razorpaysoftwareprivatelimited"). */
  company?: string
  /** 01-candidate-profile.md text. */
  profile?: string
  /** Tracker rows (other applications). */
  tracker?: { company: string; status: string; source: string }[]
  url?: string
}

const CITY_ALIASES: Record<string, string[]> = {
  bengaluru: ["bangalore"], bangalore: ["bengaluru"], mumbai: ["bombay"], bombay: ["mumbai"], gurugram: ["gurgaon"], gurgaon: ["gurugram"],
  chennai: ["madras"], kolkata: ["calcutta"], "new delhi": ["delhi"], delhi: ["new delhi"], "united states": ["us", "usa"], us: ["united states", "usa"], usa: ["united states", "us"],
  uk: ["united kingdom"], "united kingdom": ["uk"],
}
const DEMONYM: Record<string, string> = { indian: "india", singaporean: "singapore", american: "united states", british: "united kingdom", canadian: "canada", australian: "australia", german: "germany", polish: "poland" }
const NOT_PLACES = new Set(["are", "you", "currently", "based", "out", "of", "in", "either", "or", "the", "located", "location", "living", "reside", "residing", "do", "a", "an", "your", "and", "now", "permanent", "resident", "citizen"])

function mentionsCompany(label: string, company: string): boolean {
  const c = company.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (c.length < 3) return false
  const words = label.match(/\b[A-Z][A-Za-z0-9&.-]{2,}\b/g) ?? []
  return words.some((w) => {
    const x = w.toLowerCase().replace(/[^a-z0-9]/g, "")
    return x.length >= 3 && !NOT_PLACES.has(x) && (c.includes(x) || x.includes(c))
  })
}

const COMMON_WORDS = new Set(["have", "has", "had", "did", "were", "was", "are", "you", "your", "note", "any", "yes", "please", "if", "the", "its", "our", "this", "that", "subsidiary", "subsidiaries", "employee", "employees", "intern", "contractor", "consultant", "capacity", "full", "time", "part", "former", "current", "previously", "ever", "before", "worked", "work", "for", "with", "at", "or", "and", "company", "companies", "group", "inc", "ltd", "llc", "affiliate", "affiliates", "outside", "e.g", "eg", "ie", "i.e"])

/** Organisation names a question mentions ("...employed by Amazon or any Amazon subsidiary (outside of Twitch)"). */
export function orgNames(label: string): string[] {
  const out = new Set<string>()
  for (const m of label.matchAll(/\b([A-Z][A-Za-z0-9&.'-]{1,}(?:\s+[A-Z][A-Za-z0-9&.'-]+)*)\b/g)) {
    const words = m[1].split(/\s+/).filter((w) => !COMMON_WORDS.has(w.toLowerCase().replace(/[.,]/g, "")) && !NOT_PLACES.has(w.toLowerCase()))
    const name = words.join(" ").trim()
    if (name.length >= 3 && !/^(I|We|They|It)$/.test(name)) out.add(name)
  }
  return [...out]
}

const COUNTRY_WORDS = /\b(united states|u\.?s\.?a?\b|america|united kingdom|uk|britain|canada|australia|germany|singapore|india|poland|ireland|netherlands|france|spain|europe|eu|uae|japan|israel|mexico|brazil)\b/gi
const UNKNOWN_COUNTRY = /\b(this country|the country (for which|where|in which|of the)|country you('| a)re applying|country of (the )?(role|job|position)|the location of the (role|job|position)|your current location)\b/i

/**
 * Work authorisation and sponsorship depend on the country. A saved generic answer is only used
 * when the question names no country, or only the candidate's own citizenship country.
 */
const INDIA_PLACES = /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|chennai|delhi|new delhi|gurugram|gurgaon|noida|kolkata|ahmedabad|kochi|jaipur|chandigarh|indore|coimbatore)\b/i
const FOREIGN_PLACES = /\b(united states|usa|u\.s\.|\bus\b-?based|remote\s*[-(]?\s*us\b|san francisco|new york|seattle|austin|boston|los angeles|chicago|denver|bay area|london|united kingdom|\buk\b|canada|toronto|vancouver|berlin|amsterdam|dublin|paris|singapore|sydney|tokyo|tel aviv|,\s*(ca|ny|wa|tx|ma|il|co)\b)/i

/**
 * Is the JOB in the candidate's own country? Read from the job page. Unknown counts as "no", so a
 * generic sponsorship / authorisation answer is only reused when the page clearly shows a home location.
 */
export function jobInOwnCountry(pageText: string, bank: Bank): boolean {
  const own = (bank.citizenship?.answer ?? bank.country?.answer ?? "").toLowerCase()
  if (!own || !pageText) return false
  const home = own.includes("india") ? INDIA_PLACES : new RegExp(`\\b${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  return home.test(pageText) && !(FOREIGN_PLACES.test(pageText) && !home.test(pageText.slice(0, 1500)))
}

export function countrySafe(label: string, bank: Bank, pageText = ""): boolean {
  if (UNKNOWN_COUNTRY.test(label)) return jobInOwnCountry(pageText, bank)
  const named = [...label.matchAll(COUNTRY_WORDS)].map((m) => m[0].toLowerCase().replace(/\./g, ""))
  if (!named.length) return jobInOwnCountry(pageText, bank)
  const own = (bank.citizenship?.answer ?? bank.country?.answer ?? "").toLowerCase()
  if (!own) return false
  return named.every((n) => sameplace(own, n === "us" || n === "usa" || n === "america" ? "united states" : n === "uk" || n === "britain" ? "united kingdom" : n))
}

function places(label: string): string[] {
  return (label.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !NOT_PLACES.has(w) && !w.split(" ").every((x) => NOT_PLACES.has(x)))
}

function sameplace(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.includes(y) || (CITY_ALIASES[y] ?? []).some((alt) => x.includes(alt))
}

/** Profile has real work history (not the blank template). */
function experienceOf(profile: string): string | null {
  const sec = profile.match(/(?:^|\n)##\s*Professional Experience[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? ""
  if (!sec || /\[(JOB_TITLE|COMPANY)\]/.test(sec) || sec.replace(/^.*\n/, "").trim().length < 20) return null
  return sec
}

export interface Derived {
  answer: string
  source: string
}

/**
 * Answers jobdesk can work out from the user's own data instead of asking. Each one names where it
 * came from, so the review card shows it. Returns null when it can't be worked out for sure.
 */
export function deriveAnswer(label: string, bank: Bank, ctx: PlanContext): Derived | null {
  const l = label.toLowerCase()
  const company = ctx.company ?? ""
  // Never derive anything about visas, authorisation, relatives, referrals or agreements.
  if (/sponsor|visa|authori[sz]|immigration|eligib|relative|family|friend|spouse|referr|non[- ]?compet|agreement|export/.test(l)) return null
  // Have YOU worked / been employed / consulted / interned at a named company before (or now)?
  if (/\b(have|has|did|were|are|do)\s+you\b/.test(l) && /\b(worked|work(ing)?|employed|employee|consult(ed|ant)?|contractor|intern(ed)?)\b/.test(l) && /\b(previously|ever|before|current|currently|now|any capacity)\b/.test(l)) {
    const named = orgNames(label)
    const aboutApplied = company ? mentionsCompany(label, company) : false
    if (named.length || aboutApplied) {
      const exp = ctx.profile ? experienceOf(ctx.profile) : null
      if (!exp) return null
      const e = exp.toLowerCase()
      const worked = named.some((n) => e.includes(n.toLowerCase())) || (aboutApplied && (mentionsCompany(exp, company) || e.includes(company.toLowerCase())))
      const who = named.length ? named.join(" / ") : company
      return { answer: worked ? "Yes" : "No", source: worked ? `derived: your profile lists ${who}` : `derived: your profile's work history doesn't include ${who}` }
    }
  }
  // Applied / interviewed at this company before?
  if (company && /\b(previously|before|ever)\b/.test(l) && /\b(applied|interviewed)\b/.test(l) && mentionsCompany(label, company) && ctx.tracker) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
    const rows = ctx.tracker.filter((r) => (norm(r.company).includes(norm(company)) || norm(company).includes(norm(r.company))) && norm(r.company).length > 2 && r.source !== ctx.url && r.status.trim() && r.status.trim() !== "drafted")
    const interviewed = rows.some((r) => /interview|offer|hired/.test(r.status))
    const yes = /interviewed/.test(l) ? interviewed : rows.length > 0
    return { answer: yes ? "Yes" : "No", source: "derived: your application tracker" }
  }
  // Citizen of X? (permanent residency can't be deduced from citizenship, so it isn't)
  if (/\bcitizen\b/.test(l) && !/permanent resident|\bpr\b/.test(l) && isYesNoQuestion(label) && bank.citizenship) {
    const cit = bank.citizenship.answer.toLowerCase()
    const asked = places(label).map((p) => DEMONYM[p] ?? p)
    if (asked.length) {
      const yes = asked.some((p) => sameplace(cit, p))
      return { answer: yes ? "Yes" : "No", source: `derived: your citizenship (${bank.citizenship.answer})` }
    }
  }
  // University: from the profile's Education section, if it names one.
  if (/\b(which|what)\s+(university|college|school)\b|\b(university|college|school)\s+(did you|you)\s+(attend|attended|graduate|study)/.test(l) && ctx.profile) {
    const edu = ctx.profile.match(/(?:^|\n)##\s*Education[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? ""
    const inst = edu.match(/,\s*([^,(\n]*(University|College|Institute|School|IIT|NIT|IIIT)[^,(\n]*)/i)?.[1]?.trim() ?? edu.match(/\|\s*([^|\n]*(University|College|Institute)[^|\n]*)\|/i)?.[1]?.trim()
    if (inst && !/\[|pending/i.test(inst)) return { answer: inst, source: `derived: your education (${inst})` }
  }
  // Are you based / located / living in X?  (Only that exact kind of question, never mixed with relocation.)
  if (/^\s*(are|do)\s+you\s+(currently\s+)?(based|located|location|living|live|reside|residing)\b/.test(l) && !/reloca|willing|open to|or would/.test(l) && bank.location) {
    const loc = bank.location.answer
    const asked = places(label)
    if (asked.length) {
      const yes = asked.some((p) => sameplace(loc, p))
      return { answer: yes ? "Yes" : "No", source: `derived: your location (${loc})` }
    }
  }
  return null
}

export function planFill(scan: PageScan, bank: Bank, files: AppFiles, ctx: PlanContext = {}): Plan {
  const plan: Plan = { actions: [], unknown: [], stops: [], skipped: [] }
  if (scan.captcha) plan.stops.push({ reason: "captcha", message: "This form has a CAPTCHA. jobdesk never solves those, so you'll need to do that part." })
  if (scan.password) plan.stops.push({ reason: "login", message: "This page asks for a password or login. jobdesk never logs in or creates accounts for you." })
  for (const f of scan.fields) {
    if (!f.visible) {
      plan.skipped.push({ field: f, why: "hidden field (never filled)" })
      continue
    }
    const label = f.label || f.name
    if (!SUPPORTED.has(f.type)) {
      if (f.required) plan.stops.push({ field: f, reason: "unsupported_field", message: `"${label}" is a ${f.type} field that jobdesk doesn't fill.` })
      else plan.skipped.push({ field: f, why: `unsupported ${f.type}` })
      continue
    }
    if (f.type === "file") {
      const l = label.toLowerCase()
      if (/\b(resume|résumé|cv|curriculum)\b/.test(l) && files.cv) plan.actions.push({ field: f, kind: "file", value: files.cv, display: files.cv.split(/[\\/]/).pop()!, source: "file: this application's CV" })
      else if (/\bcover\b/.test(l) && files.cover) plan.actions.push({ field: f, kind: "file", value: files.cover, display: files.cover.split(/[\\/]/).pop()!, source: "file: this application's cover letter" })
      else if (f.required) plan.stops.push({ field: f, reason: "unknown_file", message: `"${label}" wants a file jobdesk doesn't have for this job. Only the CV and cover letter are ever uploaded.` })
      else plan.skipped.push({ field: f, why: "optional upload with no matching file" })
      continue
    }
    // Legal statements (certify, consent, arbitration...) are always the person's call, whatever the field type.
    if (LEGAL_RE.test(label) || (f.type === "radio" && f.options.some((o) => LEGAL_RE.test(o)))) {
      if (f.required || f.type !== "checkbox") plan.stops.push({ field: f, reason: "legal_statement", message: `"${label.slice(0, 160)}" is a statement only you can agree to. Do this part yourself.` })
      else plan.skipped.push({ field: f, why: "optional agreement left for you" })
      continue
    }
    if (f.type === "checkbox") {
      plan.skipped.push({ field: f, why: "optional checkbox left as it is" })
      continue
    }
    const voluntary = VOLUNTARY_RE.test(label) || (builtinFor(label)?.sensitive ?? false)
    // Worked out from the user's own data (profile, tracker, saved location/citizenship).
    const derived = voluntary ? null : deriveAnswer(label, bank, ctx)
    if (derived) {
      if (f.options.length) {
        let opt = pickOption(f.options, derived.answer)
        let source = derived.source
        // The form itself says to pick "Other" when your school isn't listed.
        if (!opt && derived.source.startsWith("derived: your education")) {
          opt = f.options.find((o) => /^other\b/i.test(o.trim())) ?? null
          if (opt) source = `${derived.source} - not in the list, so "Other"`
        }
        if (opt) {
          plan.actions.push({ field: f, kind: f.type === "radio" ? "radio" : "select", value: opt, display: opt, source })
          continue
        }
      } else {
        plan.actions.push({ field: f, kind: f.type === "combobox" ? "combobox" : "text", value: derived.answer, display: derived.answer, source: derived.source })
        continue
      }
    }
    let look = lookup(bank, label)
    // "Authorised to work in the US?" is not answered by a generic "Yes" saved for India.
    if (look.answer && (look.key === "work_authorization" || look.key === "sponsorship") && !countrySafe(label, bank, scan.text)) {
      look = { answer: null, key: look.key, sensitive: false, reason: "unknown" }
    }
    // A yes/no answer never goes into an open question, even if the question mentions the topic
    // ("What is the address you'll work from, if you're open to relocation?" is not "Yes").
    if (look.answer && (YES_NO_KEYS.has(look.key ?? "") || isYesNo(look.answer.answer)) && isOpenQuestion(label)) {
      look = { answer: null, key: null, sensitive: false, reason: "unknown" }
    }
    // The reverse: a Yes/No question ("Are you currently located in Canada?", "Do you have 3+ years...?")
    // never gets a city or a number just because it mentions location or experience.
    const yesNoField = f.options.length > 0 && f.options.filter((o) => !/^select|^--|^choose/i.test(o.trim())).every((o) => /^(yes|no)\b/i.test(o.trim()))
    if (look.answer && !isYesNo(look.answer.answer) && (yesNoField || isYesNoQuestion(label)) && !YES_NO_KEYS.has(look.key ?? "")) {
      look = { answer: null, key: null, sensitive: false, reason: "unknown" }
    }
    if (look.answer) {
      if (f.type === "select-one" || f.type === "select" || f.type === "radio") {
        const opt = pickOption(f.options, look.answer.answer)
        if (opt) {
          plan.actions.push({ field: f, kind: f.type === "radio" ? "radio" : "select", value: opt, display: opt, source: `answer bank: ${look.answer.label}` })
          continue
        }
        if (f.required) plan.unknown.push({ field: f, question: `${label} (options: ${f.options.filter((o) => !/^select|^--/i.test(o)).join(" / ")})`, sensitive: look.sensitive })
        continue
      }
      plan.actions.push({ field: f, kind: f.type === "combobox" ? "combobox" : "text", value: look.answer.answer, display: look.answer.answer, source: `answer bank: ${look.answer.label}` })
      continue
    }
    if (voluntary || look.reason === "sensitive_not_allowed") {
      // APP-9 / SAFE-4: voluntary and sensitive questions default to "prefer not to say".
      if (f.options.length) {
        const decline = f.options.find((o) => DECLINE_RE.test(o))
        if (decline) {
          plan.actions.push({ field: f, kind: f.type === "radio" ? "radio" : "select", value: decline, display: decline, source: "default: prefer not to say (voluntary question)" })
          continue
        }
        if (f.required) plan.stops.push({ field: f, reason: "no_decline_option", message: `"${label}" is a personal question with no "prefer not to say" option. Only you can answer it.` })
        else plan.skipped.push({ field: f, why: "voluntary question left blank" })
        continue
      }
      // Typed dropdowns only show their options once opened: the filler opens it and picks the
      // "decline" option, or clears it and hands it over if there isn't one.
      if (f.type === "combobox") {
        plan.actions.push({ field: f, kind: "combobox", value: DECLINE_TOKEN, display: "prefer not to say", source: "default: prefer not to say (voluntary question)" })
        continue
      }
      if (f.required) plan.unknown.push({ field: f, question: label, sensitive: true })
      else plan.skipped.push({ field: f, why: "voluntary question left blank" })
      continue
    }
    if (f.required) plan.unknown.push({ field: f, question: label, sensitive: false })
    else plan.skipped.push({ field: f, why: "optional and not in your answer bank" })
  }
  return plan
}
