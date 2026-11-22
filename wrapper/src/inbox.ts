// Recruiter email triage (INB-1..3). Rule-based, zero-model. Each email becomes an
// attention item; a likely rejection is confirmed with one tap rather than changing the
// tracker silently, because a wrong guess there would hide a live application.

import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { addItem } from "./data/attention.ts"
import { readTracker, isFinal } from "./data/tracker.ts"

export type EmailLabel = "interview_invite" | "assessment" | "rejection" | "info_request" | "other"

const R = {
  autoAck: /\b(we (have )?received your application|thank(s| you) for (applying|your application|your interest)[^.]{0,80}(review|received|get back|be in touch|reach out)|application (has been )?(received|submitted successfully)|this is an automated|do not reply to this (e-?mail|message))\b/i,
  marketing: /\b(unsubscribe|newsletter|job alert|jobs? (you may|that match|for you|matching)|recommended jobs|upgrade to premium|webinar|% off|top companies hiring|weekly digest|new jobs? (posted|for)|people (are )?viewing your profile)\b/i,
  rejection: /\b(unfortunately,? (we|you|your|the|this|after|at this)(?! are unable to sponsor)|not to extend an offer|not (be )?extending an offer|not (to )?take (your candidacy|your application|you|it) forward|candidature has not been (considered|shortlisted)|not the right fit|not a (good|great) fit|isn'?t the right fit|regret to inform|sorry to inform|not (been )?shortlisted|filled the [\w\s-]{0,40}(position|role)|position has (now )?been filled|appoint(ed)? an internal candidate|(go|going) in a different direction|not (be )?progressing your application|won'?t be progressing|decided not to proceed|chosen to (proceed|move forward) with (a|another) candidate|proceed with (a|another) candidate|not (to )?progress(ing)? (your|with your) application|will not be (moving|taking) (your application )?forward|not (be )?(moving|progressing|proceeding) forward|decided (not )?to (move|proceed|go) (forward )?with (other|another)|(other|another) candidates?|not (been )?selected|position has been filled|role has been filled|no longer (being )?considered|not a (fit|match) (at this time|for this role)|will not be proceeding|unable to (move|offer)|have filled the (position|role)|decided to pursue other)\b/i,
  assessment: /\b((writing|translation|english|aptitude|situational judg(e)?ment|design|coding|technical|online|skills?|versant|typing|language|cognitive|logical) (test|challenge|assignment|task|exercise)|design challenge|demo task|take-home|assessment|questionnaire|psychometric|exercise|excel test|case study|hirevue|one-way (video|recorded)|recorded video interview|coding (test|challenge|round)|hackerrank|hacker earth|hackerearth|codility|codesignal|testgorilla|mettl|take[- ]home|online test|technical test|aptitude test|assignment)\b/i,
  invite: /\b(interview|(virtual )?onsite|over zoom|on zoom|zoom call|demo (class|session|lesson)|a \d+[- ]minute (conversation|call|chat|session|meeting)|(would|do) any of these (times|slots)|times work for|schedule (a )?(call|chat|time)|calendly|book a (slot|time)|availability for (a )?(call|chat|discussion|conversation)|(phone|video|screening|intro(ductory)?) (call|screen|round)|meet (the|our) team|next round|google meet|zoom link|teams (link|meeting)|would (like|love) to (speak|chat|talk|connect))\b/i,
  info: /\b((could|can|would) you (please )?(briefly )?(share|send|provide|confirm|tell|explain|email|let us know|reply)|please (upload|fill|enter|submit|share|send|confirm|provide|reply|email)|screening questions?|could you reply|reply with|compensation expectations?|right to work|please (upload|fill( in)?|enter|submit|share) (a|the|your|an)|candidate details form|notice period|current (ctc|salary|compensation)|expected (ctc|salary|compensation)|updated (resume|cv)|share (your|an updated) (resume|cv)|please (share|send|provide|confirm)|could you (share|send|provide|confirm|let us know)|(let us|let me) know your|reason for (change|leaving)|availability to (join|start)|earliest (joining|start) date)\b/i,
}

export interface Classified {
  label: EmailLabel
  reasons: string[]
}

export function classifyEmail(subject: string, body: string): Classified {
  const text = `${subject}\n${body}`
  const reasons: string[] = []
  const has = (k: keyof typeof R) => {
    const m = text.match(R[k])
    if (m) reasons.push(`${k}: "${m[0]}"`)
    return !!m
  }
  const rej = has("rejection")
  const ass = has("assessment")
  const inv = has("invite")
  const info = has("info")
  const ack = has("autoAck")
  const mkt = has("marketing")
  if (rej && !/\b((pleased|happy|delighted) to (invite|inform|move|share)|move forward with your application|invite you to the next)\b/i.test(text)) return { label: "rejection", reasons }
  if (info && /\bbefore (we|i) (schedule|proceed|share|move|set up)/i.test(text)) return { label: "info_request", reasons }
  if (ass && /(link|complete|deadline|due|within|attempt|invite|start|take|submit|send|share|return|attached|brief|hours|minutes|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i.test(text)) return { label: "assessment", reasons }
  if (ack && !/\b(would like to|invite you|schedule|book a|choose a slot)\b/i.test(text)) return { label: "other", reasons }
  if (inv && !mkt) return { label: "interview_invite", reasons }
  if (info && !mkt && !ack) return { label: "info_request", reasons }
  if (ass && !mkt) return { label: "assessment", reasons }
  return { label: "other", reasons }
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }

/** First explicit date in the text, as YYYY-MM-DD (ISO, "12 Nov 2026", "Nov 12, 2026", "12/11/2026" as D/M). */
export function extractDate(text: string, fallbackYear = new Date().getFullYear()): string | null {
  const p = (n: number) => String(n).padStart(2, "0")
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*,?\s*(20\d{2})?\b/i)
  if (dmy) return `${dmy[3] ?? fallbackYear}-${p(MONTHS[dmy[2].toLowerCase()])}-${p(+dmy[1])}`
  const mdy = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})?\b/i)
  if (mdy) return `${mdy[3] ?? fallbackYear}-${p(MONTHS[mdy[1].toLowerCase()])}-${p(+mdy[2])}`
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
  if (slash) return `${slash[3]}-${p(+slash[2])}-${p(+slash[1])}`
  return null
}

/** Which open tracker row the email is about: the company name must appear in it. */
export function matchCompany(p: Paths, text: string): string | null {
  const lower = text.toLowerCase()
  const rows = readTracker(p.tracker).rows.filter((r) => !isFinal(r.status) && r.company.trim().length > 1)
  const hits = rows.filter((r) => lower.includes(r.company.toLowerCase()))
  return hits.length === 1 ? hits[0].company : null
}

export interface Email {
  id: string
  from?: string
  subject: string
  body: string
}

export function parseEml(raw: string, id: string): Email {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/)
  const h = (n: string) => head.match(new RegExp(`^${n}:\\s*(.+)$`, "im"))?.[1]?.trim()
  if (!h("Subject") && !h("From")) return { id, subject: raw.split(/\r?\n/)[0] ?? "", body: raw }
  return { id, from: h("From"), subject: h("Subject") ?? "", body: rest.join("\n\n") }
}

const LABELS = new Set<EmailLabel>(["interview_invite", "assessment", "rejection", "info_request", "other"])

/** `modelLabel` (from the optional model check) wins over the rules when present. */
export function triage(p: Paths, e: Email, modelLabel?: string): { label: EmailLabel; company: string | null; due: string | null } {
  const rules = classifyEmail(e.subject, e.body)
  const c = modelLabel && LABELS.has(modelLabel as EmailLabel) ? { ...rules, label: modelLabel as EmailLabel } : rules
  const company = matchCompany(p, `${e.from ?? ""}\n${e.subject}\n${e.body}`)
  const due = extractDate(`${e.subject}\n${e.body}`)
  const who = company ?? e.from ?? "a recruiter"
  if (c.label === "interview_invite") {
    addItem(p.attention, { id: `mail:${e.id}`, kind: "recruiter_reply", title: `Interview invite from ${who}`, why: e.subject, action: "Reply with your available times. Interview prep is sent the evening before.", due: due ?? undefined, data: { label: c.label, company } })
  } else if (c.label === "assessment") {
    addItem(p.attention, { id: `mail:${e.id}`, kind: due ? "deadline" : "recruiter_reply", title: `Assessment from ${who}`, why: e.subject, action: due ? `Finish it before ${due}.` : "Open the email to find the deadline.", due: due ?? undefined, data: { label: c.label, company } })
  } else if (c.label === "info_request") {
    addItem(p.attention, { id: `mail:${e.id}`, kind: "recruiter_reply", title: `${who} asked for details`, why: e.subject, action: "Reply. Answers you've already approved are in your answer bank.", data: { label: c.label, company } })
  } else if (c.label === "rejection") {
    addItem(p.attention, { id: `mail:${e.id}`, kind: "other", title: `Looks like a rejection from ${who}`, why: e.subject, action: company ? `Confirm, and I'll mark ${company} as rejected in the tracker.` : "Tell me which application this was, and I'll update the tracker.", data: { label: c.label, company, confirm_status: "rejected" } })
  }
  return { label: c.label, company, due }
}

/**
 * Process .eml/.txt files dropped into wrapper-data/inbox/; processed files move to inbox/done/.
 * Pass `labeler` to sort with the model check (98% on the unseen holdout vs 73% for rules).
 */
export async function processInboxFolder(p: Paths, labeler?: (emails: Email[]) => Promise<Record<string, string>>): Promise<{ file: string; label: EmailLabel; company: string | null }[]> {
  if (!existsSync(p.inbox)) return []
  const done = join(p.inbox, "done")
  mkdirSync(done, { recursive: true })
  const out: { file: string; label: EmailLabel; company: string | null }[] = []
  const files = readdirSync(p.inbox).filter((f) => /\.(eml|txt)$/i.test(f))
  const emails = files.map((f) => parseEml(readFileSync(join(p.inbox, f), "utf8"), f))
  let labels: Record<string, string> = {}
  if (labeler && emails.length) labels = await labeler(emails).catch(() => ({}))
  for (const e of emails) {
    const f = e.id
    const r = triage(p, e, labels[e.id])
    out.push({ file: f, label: r.label, company: r.company })
    renameSync(join(p.inbox, f), join(done, f))
  }
  return out
}
