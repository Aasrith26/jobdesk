// Approval-gated application filling (APP-5..13).
//   dry run - fill, show the card, never submit
//   L1      - fill, show the card, submit only after approve() says "submit"
//   L2      - submit without a second tap only when: pre-approved for this job, trusted ATS,
//             zero flags. Any flag falls back to L1 (APP-6).
// Values come only from the answer bank and this job's own files; the browser may only stay
// on the application's own host (APP-10); confirmation is captured before the tracker says
// "applied" (APP-11).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Paths } from "../lib/paths.ts"
import { readBank } from "../data/answers.ts"
import { addItem } from "../data/attention.ts"
import { readTracker, updateStatus, appendRow, canonicalStatus } from "../data/tracker.ts"
import { daysBetween, today, nowIso } from "../lib/store.ts"
import type { Config, ApprovalLevel } from "../data/config.ts"
import { effectivePolicy } from "./policy.ts"
import { launchBrowser, pageSession, evaluate, type CDP, type Browser } from "./cdp.ts"
import { SCAN_SCRIPT, setValueScript, setRadioScript, CLICK_SUBMIT_SCRIPT, RESULT_SCRIPT, CONFIRM_RE, DECLINE_RE, pickOption, findExpr, type PageScan } from "./forms.ts"
import { planFill, isOpenQuestion, DECLINE_TOKEN, type Plan, type AppFiles } from "./plan.ts"
import { findBrowser } from "../doctor.ts"
import { capCheck } from "../kit.ts"

export interface CardField {
  label: string
  value: string
  source: string
  required: boolean
}

export interface ReviewCard {
  id: string
  url: string
  company: string
  role: string
  site: string
  terms_checked: boolean
  fields: CardField[]
  unknown: string[]
  stops: string[]
  flags: string[]
  screenshot?: string
  submittable: boolean
}

export type Decision = "submit" | "cancel"

export interface FillOpts {
  url: string
  company: string
  role: string
  files: AppFiles
  level: ApprovalLevel | "dry"
  /** L2 only: the user approved this specific job before the fill started. */
  preApproved?: boolean
  approve?: (card: ReviewCard) => Promise<Decision>
  headless?: boolean
  browserExe?: string
  /** Tests only: treat 127.0.0.1/localhost forms as automate. */
  allowLocal?: boolean
  log?: (s: string) => void
  /** Hosts the form may legitimately move to (e.g. an ATS confirmation subdomain). */
  extraHosts?: string[]
  sameCompanyWindowDays?: number
  /** Drafts answers to open questions from the profile (see fill/drafts.ts). Returns question -> answer. */
  draftOpenAnswers?: (questions: string[], pageText: string) => Promise<Record<string, string>>
}

export interface FillResult {
  status: "kit_only" | "blocked" | "needs_you" | "dry_run_done" | "cancelled" | "submitted" | "unconfirmed" | "aborted"
  message: string
  card?: ReviewCard
  evidenceDir?: string
  plan?: Plan
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
}

/** ATS pages that need a suffix to show the form. */
export function formUrl(url: string): string {
  try {
    const u = new URL(url)
    if (/(^|\.)lever\.co$/.test(u.hostname) && !/\/apply\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/apply")
    if (/(^|\.)ashbyhq\.com$/.test(u.hostname) && !/\/application\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/application")
    return u.toString()
  } catch {
    return url
  }
}

/** APP-12: never twice for the same job; warn for the same company within the window. */
export function duplicateCheck(p: Paths, url: string, company: string, windowDays = 30): { block?: string; warn?: string } {
  const rows = readTracker(p.tracker).rows
  const u = url.replace(/\/+$/, "")
  const sent = (s: string) => !["", "drafted"].includes(canonicalStatus(s))
  const same = rows.find((r) => r.source.replace(/\/+$/, "") === u && sent(r.status))
  if (same) return { block: `You already applied to this job on ${same.date} (status: ${same.status}).` }
  const co = company.toLowerCase().replace(/[^a-z0-9]/g, "")
  const recent = rows.find((r) => r.company.toLowerCase().replace(/[^a-z0-9]/g, "") === co && sent(r.status) && daysBetween(r.date, today()) <= windowDays)
  if (recent) return { warn: `You applied to ${recent.company} on ${recent.date} ("${recent.role}"). Some employers frown on many applications at once.` }
  return {}
}

export async function fillApplication(p: Paths, cfg: Config, o: FillOpts): Promise<FillResult> {
  const log = o.log ?? (() => {})
  const url = formUrl(o.url)
  const pol = effectivePolicy(url, o.allowLocal)
  const runId = `${today()}-${slug(o.company)}-${slug(o.role)}`
  if (pol.policy !== "automate") {
    return { status: "kit_only", message: `${pol.name}: ${pol.note} Use the kit for this one.` }
  }
  const dup = duplicateCheck(p, o.url, o.company, o.sameCompanyWindowDays ?? 30)
  if (dup.block) return { status: "blocked", message: dup.block }
  if (o.level !== "dry") {
    const cap = capCheck(p, cfg)
    if (!cap.ok && !readTracker(p.tracker).rows.some((r) => r.source === o.url)) return { status: "blocked", message: cap.message! }
  }
  // Only this application's own files may ever be uploaded (APP-10).
  const files: AppFiles = {}
  for (const k of ["cv", "cover"] as const) {
    const f = o.files[k]
    if (!f) continue
    const abs = resolve(p.root, f)
    if (!existsSync(abs) || !abs.toLowerCase().endsWith(".pdf")) return { status: "blocked", message: `The ${k === "cv" ? "CV" : "cover letter"} PDF isn't there: ${f}. Compile it first.` }
    files[k] = abs
  }
  const exe = o.browserExe ?? cfg.browser ?? findBrowser()
  if (!exe) return { status: "blocked", message: "No Chrome or Edge found. Install one, or use the kit instead." }

  const evidenceDir = join(p.evidence, runId)
  mkdirSync(evidenceDir, { recursive: true })
  const allowedHosts = new Set([pol.host, ...(o.extraHosts ?? [])])
  let browser: Browser | undefined
  let c: CDP | undefined
  let offsite: string | null = null
  try {
    browser = await launchBrowser(exe, join(p.data, "browser-profile"), { headless: o.headless })
    c = await pageSession(browser)
    await c.send("Page.enable")
    await c.send("Runtime.enable")
    await c.send("DOM.enable")
    // Headless pages have no keyboard focus unless emulated; typed dropdowns need it.
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
    c.on("Page.frameNavigated", (ev) => {
      const frame = ev.frame as { parentId?: string; url: string }
      if (frame.parentId) return
      try {
        const h = new URL(frame.url).hostname
        if (frame.url.startsWith("http") && !allowedHosts.has(h)) offsite = frame.url
      } catch {
        /* about:blank etc. */
      }
    })
    // Popups/new windows are never followed.
    c.on("Page.windowOpen", () => {})
    const loaded = c.waitFor("Page.loadEventFired", 45_000)
    await c.send("Page.navigate", { url })
    await loaded
    await Bun.sleep(800)
    // Redirected away on arrival: the employer hosts the form on its own site, which isn't one
    // jobdesk fills. That's a kit, not an incident.
    if (offsite) {
      const where = (() => {
        try {
          return new URL(offsite).hostname
        } catch {
          return offsite
        }
      })()
      return { status: "kit_only", message: `This job's form is on ${where}, not on ${pol.name}. jobdesk only fills forms on sites it knows, so use the kit for this one.` }
    }

    // Forms rendered by JavaScript (Ashby, some Lever pages) can appear after the load event.
    let scan = await evaluate<PageScan>(c, SCAN_SCRIPT)
    for (let i = 0; i < 10 && scan.fields.filter((f) => f.visible).length === 0; i++) {
      await Bun.sleep(1000)
      scan = await evaluate<PageScan>(c, SCAN_SCRIPT)
    }
    const bank = readBank(p.answers)
    const plan = planFill(scan, bank, files, {
      company: o.company,
      profile: existsSync(p.profile) ? readFileSync(p.profile, "utf8") : "",
      tracker: readTracker(p.tracker).rows.map((r) => ({ company: r.company, status: r.status, source: r.source })),
      url: o.url,
    })
    // Open questions ("Why us?", "Proudest project?"): a draft from the profile and this page,
    // checked for invented claims, shown on the card as a draft to check. Never auto-sent (L2 falls back).
    let drafted = 0
    if (o.draftOpenAnswers) {
      const open = plan.unknown.filter((u) => !u.sensitive && ["textarea", "text"].includes(u.field.type) && isOpenQuestion(u.field.label))
      if (open.length) {
        const answers = await o.draftOpenAnswers(open.map((u) => u.field.label), scan.text).catch(() => ({}) as Record<string, string>)
        for (const u of open) {
          const a = answers[u.field.label]
          if (!a) continue
          plan.actions.push({ field: u.field, kind: "text", value: a, display: a.length > 80 ? a.slice(0, 77) + "..." : a, source: "DRAFT from your profile - check it before sending" })
          plan.unknown.splice(plan.unknown.indexOf(u), 1)
          drafted++
        }
      }
    }
    log(`Found ${scan.fields.length} fields: ${plan.actions.length} to fill, ${plan.unknown.length} unknown, ${plan.stops.length} hard stops`)

    // Fill (APP-4: every action carries its source).
    const filled: CardField[] = []
    const { root: docRoot } = await c.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1, pierce: false })
    // Files first: uploads make React forms re-render, and other fields are re-found by marker.
    const ordered = [...plan.actions.filter((a) => a.kind === "file"), ...plan.actions.filter((a) => a.kind !== "file")]
    for (const a of ordered) {
      if (offsite) break
      let got: string | null = null
      if (a.kind === "file" && !Object.values(files).includes(a.value)) throw new Error("Refusing to upload a file that isn't this application's CV or cover letter.")
      try {
        if (a.kind === "file") {
          const { nodeId } = await c.send<{ nodeId: number }>("DOM.querySelector", { nodeId: docRoot.nodeId, selector: `[data-jd="${a.field.id}"]` })
          if (nodeId) {
            // Chrome fires input/change itself for setFileInputFiles.
            await c.send("DOM.setFileInputFiles", { nodeId, files: [a.value] })
            await Bun.sleep(500)
            got = a.display
          }
        } else if (a.kind === "combobox") {
          got = await fillCombobox(c, a.field.id, a.value, a.field.domId)
        } else if (a.kind === "radio") {
          got = await evaluate<string | null>(c, setRadioScript(a.field.group!, a.value))
        } else {
          got = await evaluate<string | null>(c, setValueScript(a.field.id, a.value, a.field.domId))
          // Autocomplete text boxes (Lever's location) clear a typed value unless a suggestion is picked.
          if (got !== null && !got.trim() && a.value.trim()) got = await fillAutocomplete(c, a.field.id, a.value, a.field.domId)
        }
      } catch (e) {
        log(`Couldn't fill "${a.field.label}": ${(e as Error).message}`)
        got = null
      }
      // An empty result for a non-empty answer means the page didn't keep it (e.g. an autocomplete cleared it).
      if (got !== null && !got.trim() && a.value.trim()) got = null
      filled.push({ label: a.field.label, value: got ?? "(could not set)", source: got === null ? "FAILED" : a.source, required: a.field.required })
    }
    if (offsite) return await abort(p, o, evidenceDir, `The page tried to send the browser to another site (${offsite}). Stopped.`)

    const shot = await c.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
    const screenshot = join(evidenceDir, "filled.png")
    writeFileSync(screenshot, Buffer.from(shot.data, "base64"))

    const flags: string[] = []
    const trusted = cfg.trusted_ats.some((t) => t.toLowerCase() === pol.name.toLowerCase())
    if (!pol.terms_checked && !trusted) flags.push(`${pol.name}'s terms haven't been reviewed by a person yet. Add it to your trusted list once you have.`)
    if (dup.warn) flags.push(dup.warn)
    if (filled.some((f) => f.source === "FAILED")) flags.push("Some fields could not be filled. Check the screenshot.")
    // Drafted answers are always read by a person first: this flag also stops L2 from auto-sending.
    if (drafted) flags.push(`${drafted} answer(s) are drafts written from your profile. Read and edit them before sending.`)
    if (!scan.submitLabel) flags.push("No submit button found on the page.")
    const card: ReviewCard = {
      id: runId, url, company: o.company, role: o.role, site: pol.name, terms_checked: pol.terms_checked,
      fields: filled, unknown: plan.unknown.map((u) => u.question), stops: plan.stops.map((s) => s.message), flags, screenshot,
      submittable: plan.unknown.length === 0 && plan.stops.filter((s) => s.reason !== "captcha" || o.headless).length === 0 && !filled.some((f) => f.source === "FAILED") && !!scan.submitLabel,
    }
    writeFileSync(join(evidenceDir, "card.json"), JSON.stringify({ ...card, at: nowIso(), level: o.level }, null, 2))

    // Questions and hard stops go to the attention queue (ATT-1). Answers are saved to the bank,
    // so re-running the fill picks up exactly where it stopped (ATT-2, ATT-4).
    for (const u of plan.unknown) {
      addItem(p.attention, {
        id: `q:${slug(o.company)}:${slug(u.question)}`, kind: "unknown_question", title: `${o.company} asks: ${u.question.slice(0, 120)}`,
        why: "This question isn't in your answer bank, and jobdesk never invents answers.", action: "Type your answer. It's saved for every future form.",
        data: { question: u.field.label, url: o.url, sensitive: u.sensitive },
      })
    }
    for (const s of plan.stops) {
      addItem(p.attention, {
        id: `stop:${runId}:${s.reason}:${s.field?.id ?? ""}`, kind: "hard_stop", title: `${o.company}: you need to do one step`, why: s.message,
        action: s.reason === "captcha" ? "Open the form and solve the CAPTCHA yourself." : "Open the form and do this step yourself, or use the kit.",
        data: { url: o.url, screenshot },
      })
    }

    if (o.level === "dry") return { status: "dry_run_done", message: `Dry run done: ${filled.length} fields filled, nothing sent.`, card, evidenceDir, plan }
    // Not submittable means a person must act first. A CAPTCHA only counts as passable when the
    // browser window is visible, so the user can solve it before approving.
    if (!card.submittable) {
      return { status: "needs_you", message: `Paused: ${plan.unknown.length} question(s) and ${plan.stops.length} step(s) need you. They're in your attention list.`, card, evidenceDir, plan }
    }

    // Decide (APP-5, APP-6).
    const l2ok = o.level === "L2" && o.preApproved && trusted && card.flags.length === 0 && card.submittable && plan.stops.length === 0
    let decision: Decision = "cancel"
    if (l2ok) decision = "submit"
    else {
      if (!o.approve) {
        addItem(p.attention, { id: `review:${runId}`, kind: "review_submit", title: `Ready to send: ${o.role} at ${o.company}`, why: `${filled.length} fields filled. Check the screenshot before sending.`, action: "Approve it from the bot or the terminal.", data: { url: o.url, screenshot } })
        return { status: "needs_you", message: "Filled and waiting for your approval.", card, evidenceDir, plan }
      }
      decision = await o.approve(card)
    }
    if (decision !== "submit") return { status: "cancelled", message: "Not sent. Nothing was submitted.", card, evidenceDir, plan }
    if (offsite) return await abort(p, o, evidenceDir, `The page tried to send the browser to another site (${offsite}). Stopped.`)

    // Submit and capture evidence (APP-11).
    const before = await evaluate<{ url: string }>(c, RESULT_SCRIPT)
    const clicked = await evaluate<boolean>(c, CLICK_SUBMIT_SCRIPT)
    if (!clicked) return await unconfirmed(p, o, evidenceDir, "Couldn't find the submit button after approval.", card)
    type PageResult = { url: string; host?: string; text?: string; invalid?: string[] }
    let result: PageResult = before
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(500)
      result = await evaluate<PageResult>(c, RESULT_SCRIPT).catch(() => result)
      if (CONFIRM_RE.test(result.text ?? "") || (result.invalid?.length ?? 0) > 0) break
    }
    const after = await c.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }).catch(() => null)
    if (after) writeFileSync(join(evidenceDir, "after-submit.png"), Buffer.from(after.data, "base64"))
    writeFileSync(join(evidenceDir, "after-submit.txt"), `${nowIso()}\n${result.url}\n\n${result.text ?? ""}`)
    if (offsite) return await abort(p, o, evidenceDir, `After submitting, the page went to another site (${offsite}).`)
    if (!CONFIRM_RE.test(result.text ?? "")) {
      return await unconfirmed(p, o, evidenceDir, result.invalid?.length ? `The form showed errors: ${result.invalid.join("; ")}` : "No confirmation message appeared.", card)
    }
    // Confirmed: the tracker says applied, with the real submission date.
    const t = readTracker(p.tracker)
    const row = t.rows.find((r) => r.source.replace(/\/+$/, "") === o.url.replace(/\/+$/, ""))
    if (row) updateStatus(p.tracker, { company: row.company, role: row.role, url: row.source }, "applied", "submitted via jobdesk with confirmation captured")
    else appendRow(p.tracker, { date: today(), company: o.company, role: o.role, channel: "online", status: "applied", notes: "submitted via jobdesk with confirmation captured", source: o.url, cv_file: o.files.cv?.replace(/\.pdf$/i, ".tex") ?? "", cover_letter_file: o.files.cover?.replace(/\.pdf$/i, ".tex") ?? "" })
    return { status: "submitted", message: `Sent. Confirmation saved in ${evidenceDir}.`, card, evidenceDir, plan }
  } finally {
    c?.close()
    if (browser) await browser.close()
  }
}

async function key(c: CDP, k: string, code: number): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code })
}

/**
 * Typed dropdowns (react-select and similar, used by Greenhouse): open with a real click, type
 * key by key so the list filters, pick the matching option with arrow keys + Enter (no
 * coordinates, so options below the fold work), then confirm the control shows it.
 */
async function fillCombobox(c: CDP, id: string, answer: string, domId?: string): Promise<string | null> {
  const r = await evaluate<{ x: number; y: number; before: string } | null>(c, `(() => {
    const e = ${findExpr(id, domId)}; if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const ctl = e.closest('[class*=control]') || e; const r = ctl.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, before: (ctl.innerText || '').trim() };
  })()`)
  if (!r) return null
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 })
  await evaluate(c, `(() => { const e = ${findExpr(id, domId)}; if (e) e.focus(); return true })()`)
  // Yes/no answers match better against the full list than against what typing filters to.
  const decline = answer === DECLINE_TOKEN
  const yesNo = decline || /^(yes|no|y|n)$/i.test(answer.trim())
  const typeText = async (t: string) => {
    for (const ch of t.slice(0, 40)) {
      await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch })
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch })
    }
  }
  if (!yesNo) await typeText(answer)
  await Bun.sleep(900)
  // Only the options of THIS field's open menu: pages often keep other option lists in the DOM.
  const readOptions = () => evaluate<string[]>(c, `(() => {
    const e = ${findExpr(id, domId)}; if (!e) return [];
    const lb = e.getAttribute('aria-controls') || e.getAttribute('aria-owns');
    let root = lb ? document.getElementById(lb) : null;
    if (!root) { const cont = e.closest('[class*=container]') || e.parentElement; root = cont ? cont.querySelector('[class*=menu], [role=listbox]') : null; }
    if (!root) return [];
    return Array.from(root.querySelectorAll('[role=option]')).filter(o => o.getBoundingClientRect().height > 0).map(o => o.innerText.replace(/\\s+/g, ' ').trim());
  })()`)
  let options = await readOptions()
  if (!options.length) {
    // The previous menu may still be closing: refocus and open this one with the down arrow.
    await evaluate(c, `(() => { const e = ${findExpr(id, domId)}; if (e) e.focus(); return true })()`)
    await key(c, "ArrowDown", 40)
    await Bun.sleep(600)
    options = await readOptions()
  }
  let chosen = decline ? (options.find((o) => DECLINE_RE.test(o)) ?? null) : pickOption(options, answer)
  // Place autocompletes ("Hyderabad, India" -> "Hyderabad, Telangana, India"): type only the first
  // part, then accept the one suggestion that contains every part of the answer.
  if (!chosen && answer.includes(",")) {
    const parts = answer.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    for (let i = 0; i < 40; i++) await key(c, "Backspace", 8)
    await typeText(parts[0])
    await Bun.sleep(1200)
    options = await readOptions()
    const hits = options.filter((o) => o.toLowerCase().startsWith(parts[0]) && parts.every((pt) => o.toLowerCase().includes(pt)))
    chosen = hits.length === 1 ? hits[0] : (hits.sort((a, b) => a.length - b.length)[0] ?? null)
  }
  if (!chosen && process.env.JOBDESK_DEBUG) console.error(`[combobox ${domId ?? id}] answer=${answer} no match in: ${options.slice(0, 6).join(" | ")}`)
  if (!chosen) {
    await key(c, "Escape", 27)
    return null
  }
  // Move from whichever option is highlighted now (aria-activedescendant), not from an assumed start.
  const focused = await evaluate<number>(c, `(() => {
    const e = ${findExpr(id, domId)}; const act = e && e.getAttribute('aria-activedescendant');
    const lb = e && (e.getAttribute('aria-controls') || e.getAttribute('aria-owns'));
    let root = lb ? document.getElementById(lb) : null;
    if (!root) { const cont = e && (e.closest('[class*=container]') || e.parentElement); root = cont ? cont.querySelector('[class*=menu], [role=listbox]') : null; }
    if (!root) return 0;
    const opts = Array.from(root.querySelectorAll('[role=option]')).filter(o => o.getBoundingClientRect().height > 0);
    const i = opts.findIndex(o => (act && o.id === act) || /is-focused|focused|highlight/i.test(String(o.className)));
    return i < 0 ? 0 : i;
  })()`)
  const idx = options.indexOf(chosen)
  for (let i = focused; i < idx; i++) await key(c, "ArrowDown", 40)
  for (let i = focused; i > idx; i--) await key(c, "ArrowUp", 38)
  await key(c, "Enter", 13)
  await Bun.sleep(400)
  const shownNow = () => evaluate<string>(c, `(() => { const e = ${findExpr(id, domId)}; const ctl = e && (e.closest('[class*=control]') || e.parentElement); return ctl ? ctl.innerText.replace(/\\s+/g, ' ').trim() : '' })()`)
  const shown = await shownNow()
  const s = shown.toLowerCase()
  const ch = chosen.toLowerCase()
  if (process.env.JOBDESK_DEBUG) console.error(`[combobox ${domId ?? id}] answer=${answer} options=${options.slice(0, 4).join(" | ")} chosen=${chosen} from=${focused} idx=${idx} before=${r.before} shown=${shown}`)
  const ok = s && s !== r.before.toLowerCase() && (ch.includes(s) || s.includes(ch))
  if (!ok && s && s !== r.before.toLowerCase()) {
    // Never leave a wrong value showing: clear what got selected.
    await evaluate(c, `(() => { const e = ${findExpr(id, domId)}; if (e) e.focus(); return true })()`)
    await key(c, "Backspace", 8)
    await Bun.sleep(200)
  }
  return ok ? chosen : null
}

/** "Hyderabad, India" vs "Hyderabad, Telangana, IND": every part must appear; a country may be a 3-letter code. */
export function placeMatches(option: string, answer: string): boolean {
  const o = option.toLowerCase()
  const parts = answer.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!parts.length || !o.startsWith(parts[0])) return false
  const segs = o.split(",").map((s) => s.trim())
  return parts.slice(1).every((pt) => o.includes(pt) || segs.some((s) => s.length === 3 && pt.startsWith(s)) || segs.some((s) => s.length === 2 && pt.slice(0, 2) === s))
}

async function fillAutocomplete(c: CDP, id: string, answer: string, domId?: string): Promise<string | null> {
  const first = answer.split(",")[0].trim()
  await evaluate(c, `(() => { const e = ${findExpr(id, domId)}; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); e.value = ''; return true })()`)
  for (const ch of first) {
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch })
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch })
  }
  await Bun.sleep(1800)
  // Suggestions near the field: standard options, or leaf items inside a dropdown/suggestion box.
  const items = await evaluate<{ i: number; t: string }[]>(c, `(() => {
    const e = ${findExpr(id, domId)}; if (!e) return [];
    const box = e.parentElement && e.parentElement.querySelector('[role=listbox], [class*=dropdown], [class*=autocomplete], [class*=suggest], [class*=results]');
    const scope = box || document;
    const els = Array.from(scope.querySelectorAll('[role=option], [class*=dropdown-location], [class*=suggestion], [class*=result-item], li')).filter(x => x.getBoundingClientRect().height > 0 && !x.querySelector('*[role=option], li'));
    window.__jdItems = els;
    return els.map((x, i) => ({ i, t: x.innerText.replace(/\\s+/g, ' ').trim() })).filter(x => x.t);
  })()`)
  const hits = items.filter((x) => placeMatches(x.t, answer))
  const pick = hits.length ? hits.sort((a, b) => a.t.length - b.t.length)[0] : null
  if (!pick) return null
  await evaluate(c, `(() => { const el = window.__jdItems[${pick.i}]; for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true })()`)
  await Bun.sleep(500)
  const now = await evaluate<string>(c, `(() => { const e = ${findExpr(id, domId)}; return e ? e.value : '' })()`)
  return now && now.toLowerCase().startsWith(first.toLowerCase()) ? now : null
}

async function abort(p: Paths, o: FillOpts, dir: string, why: string): Promise<FillResult> {
  writeFileSync(join(dir, "aborted.txt"), `${nowIso()}\n${why}\n`)
  addItem(p.attention, { id: `abort:${dir}`, kind: "failed_run", title: `Stopped filling ${o.company}`, why, action: "Check the posting is real before going further.", data: { url: o.url } })
  return { status: "aborted", message: why, evidenceDir: dir }
}

async function unconfirmed(p: Paths, o: FillOpts, dir: string, why: string, card: ReviewCard): Promise<FillResult> {
  addItem(p.attention, { id: `unconfirmed:${dir}`, kind: "unconfirmed_submission", title: `Not sure ${o.company} got your application`, why, action: "Check your email or the site. The tracker stays unchanged until it's confirmed.", data: { url: o.url, screenshot: join(dir, "after-submit.png") } })
  return { status: "unconfirmed", message: why, card, evidenceDir: dir }
}
