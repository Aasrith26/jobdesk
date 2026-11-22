// Site policy registry (APP-2): how far the wrapper may go on each site.
//   automate - public application forms built for candidates to fill (approval-gated)
//   assist   - terms forbid automation, a login/account is needed, or terms are unchecked: kit only
//   manual   - user does it
// Unknown sites fall back to assist. `terms_checked` records whether a human has read the
// site's terms for this entry; entries that are false stay assist-only until someone does,
// except the public ATS forms, which are marked automate with that caveat visible on every card.

export type Policy = "automate" | "assist" | "manual"

export interface SiteRule {
  match: RegExp
  name: string
  policy: Policy
  terms_checked: boolean
  note: string
}

export const SITES: SiteRule[] = [
  { match: /(^|\.)greenhouse\.io$/, name: "Greenhouse", policy: "automate", terms_checked: false, note: "Public application form. Fill is approval-gated. CAPTCHAs always go to you." },
  { match: /(^|\.)lever\.co$/, name: "Lever", policy: "automate", terms_checked: false, note: "Public application form. Fill is approval-gated. CAPTCHAs always go to you." },
  { match: /(^|\.)ashbyhq\.com$/, name: "Ashby", policy: "automate", terms_checked: false, note: "Public application form. Fill is approval-gated." },
  { match: /(^|\.)smartrecruiters\.com$/, name: "SmartRecruiters", policy: "automate", terms_checked: false, note: "Public application form. Fill is approval-gated." },
  { match: /(^|\.)workable\.com$/, name: "Workable", policy: "automate", terms_checked: false, note: "Public application form. Fill is approval-gated." },
  { match: /(^|\.)(myworkdayjobs|workday)\.com$/, name: "Workday", policy: "assist", terms_checked: false, note: "Needs an account per employer. jobdesk never creates accounts, so use the kit." },
  { match: /(^|\.)linkedin\.com$/, name: "LinkedIn", policy: "assist", terms_checked: true, note: "LinkedIn's User Agreement forbids bots. Use the kit and apply yourself." },
  { match: /(^|\.)naukri\.com$/, name: "Naukri", policy: "assist", terms_checked: false, note: "Login required, and the terms aren't checked yet. Use the kit." },
  { match: /(^|\.)hirist\.(tech|com)$/, name: "hirist", policy: "assist", terms_checked: false, note: "Login required, and the terms aren't checked yet. Use the kit." },
  { match: /(^|\.)instahyre\.com$/, name: "Instahyre", policy: "assist", terms_checked: false, note: "Login required, and the terms aren't checked yet. Use the kit." },
  { match: /(^|\.)cutshort\.io$/, name: "Cutshort", policy: "assist", terms_checked: false, note: "Login required, and the terms aren't checked yet. Use the kit." },
  { match: /(^|\.)shine\.com$/, name: "Shine", policy: "assist", terms_checked: false, note: "Login required, and the terms aren't checked yet. Use the kit." },
  { match: /(^|\.)(wellfound|angel)\.co$/, name: "Wellfound", policy: "assist", terms_checked: false, note: "Login required. Use the kit." },
  { match: /(^|\.)indeed\.com$/, name: "Indeed", policy: "assist", terms_checked: false, note: "Use the kit." },
  { match: /(^|\.)(x|twitter|reddit|t)\.(com|me)$/, name: "Social post", policy: "manual", terms_checked: true, note: "A post, not a form. Reply or DM yourself with the drafted message." },
]

export function policyFor(url: string): SiteRule & { host: string } {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    /* invalid */
  }
  const hit = SITES.find((s) => s.match.test(host))
  return { ...(hit ?? { match: /$^/, name: host || "Unknown site", policy: "assist" as Policy, terms_checked: false, note: "Unknown site, so the kit only." }), host }
}

/** Local test pages (127.0.0.1/localhost) are treated as automate so the filler can be tested end to end. */
export function effectivePolicy(url: string, allowLocal = false): SiteRule & { host: string } {
  const r = policyFor(url)
  if (allowLocal && /^(127\.0\.0\.1|localhost)$/.test(r.host)) return { ...r, name: "Local test form", policy: "automate", note: "Test page." }
  return r
}
