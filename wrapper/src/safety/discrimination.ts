// Flags postings that screen on protected attributes (SAFE-2). Shown to the user as a
// flag; the posting is never hidden. Equal-opportunity statements are not flagged.

import type { Flag } from "./scam.ts"

const EEO = /\b(equal opportunity|do(es)? not discriminate|regardless of|irrespective of|without regard to|we welcome|encourage(s|d)? .{0,40}to apply|diversity|inclusive|returners?|returnship)\b/i

const RULES: { rule: string; re: RegExp; reason: string }[] = [
  {
    rule: "age_limit",
    re: /\b(age|aged)\s*(limit|bar|criteria|criterion|should be|must be|between|below|under|upto|up to|not more than|less than|max(imum)?)\b[^.]{0,25}\d{2}|\b(below|under|upto|up to|not above|less than|max(imum)?)\s*\d{2}\s*(years|yrs)\s*(of age|old)?\b(?![^.]{0,20}experience)|\b\d{2}\s*[-–to]+\s*\d{2}\s*(years|yrs)\s*(of age|old)\b|\bfreshers? (below|under) \d{2}\b|\bage\s*:\s*\d{2}/i,
    reason: "Sets an age limit.",
  },
  {
    rule: "gender",
    re: /\b(only|preferably|prefer(red)?|must be)\s*(female|male|women|men|girls?|boys?|ladies|gents)\b|\b(female|male|women|men|girls?|boys?|ladies|gents)\s*(candidates?|applicants?)?\s*(only|preferred|required|needed)\b/i,
    reason: "Restricts or prefers a gender.",
  },
  {
    rule: "marital_status",
    re: /\b(unmarried|single|married|bachelors?)\s*(candidates?|applicants?|only|preferred|required)\b|\bmarital status\s*:\s*(single|unmarried|married)/i,
    reason: "Screens on marital status.",
  },
  {
    rule: "religion_caste",
    re: /\b(hindu|muslim|christian|sikh|jain|brahmin|caste|community|religion)\b[^.]{0,20}\b(only|preferred|required|candidates)\b|\b(only|preferably)\s*(hindu|muslim|christian|sikh|jain|brahmin)\b/i,
    reason: "Screens on religion, caste or community.",
  },
  {
    rule: "appearance",
    re: /\b(fair (complexion|skin)|good[- ]looking|attractive|pleasing personality|slim|height (above|minimum|at least|of)\s*\d|minimum height)\b/i,
    reason: "Screens on physical appearance.",
  },
  {
    rule: "region_origin",
    re: /\b(only|preferably)\s*(locals?|natives?|north indians?|south indians?|[a-z]+ ?speaking natives?)\b|\bcandidates? from\s+[A-Z][a-z]+\s+(only|preferred)\b|\b(locals?|natives?)\s+(of|from)\s+[A-Za-z]+\s+(only|preferred)\b/i,
    reason: "Restricts candidates by region or origin.",
  },
]

const EXCLUDES = /\b(will not be (considered|shortlisted|entertained)|need not apply|not (be )?eligible|cannot apply|should not apply|are not (considered|eligible)|not be shortlisted|won'?t be (considered|shortlisted))\b/i
const PROTECTED = /\b(disabilit\w*|disabled|differently abled|handicap\w*|married|unmarried|pregnan\w*|children|kids|mothers?|age|aged|religio\w*|caste|category|community|native|non-native|gender|women|men|female|male|girls?|boys?|from [A-Z][a-z]+)\b/

const EXTRA: { rule: string; re: RegExp; reason: string }[] = [
  { rule: "excludes_group", re: /./, reason: "Excludes people for a personal trait (age, disability, family, origin, religion or similar)." },
  { rule: "age_max", re: /\b(maximum age|age limit|upper age)\b|\bage\b[^.]{0,30}\b(not (be )?more than|maximum|max\.?|below|under|less than|upto|up to)\b[^.]{0,15}\d{2}|\b(under|below)\s+\d{2}\b(?!\s*(lpa|k\b|%|hours|employees|people|years of experience))[^.]{0,10}|\bdigital natives?\b/i, reason: "Sets an age limit." },
  { rule: "age_range", re: /\b(ideal|preferred|required|suitable)\s+age\b|\bage\b[^.]{0,20}\b\d{2}\s*(-|–|to)\s*\d{2}\b/i, reason: "Sets an age range." },
  { rule: "only_community", re: /\b[Oo]nly\s+[A-Z][a-z]+(\s*(,|or|and|\/)\s*[A-Z][a-z]+)*\s+(candidates|applicants|people|boys|girls)\b/, reason: "Restricts candidates to one community, language group or origin." },
  { rule: "category", re: /\b(general|reserved|sc|st|obc|upper)[- ]category\b[^.]{0,50}\b(only|not (be )?considered|need not apply)\b/i, reason: "Screens on caste category." },
  { rule: "origin", re: /\bno (candidates|applicants|one|people) from\b|\b(native [a-z]+ speakers?)\b[^.]{0,50}\bonly\b|\bnon-native applicants\b/i, reason: "Screens on where people come from." },
]

export function detectDiscrimination(text: string): { flagged: boolean; flags: Flag[] } {
  const flags: Flag[] = []
  const sents = text.split(/(?<=[.!?;])\s+|\n+/)
  for (const s of sents) {
    if (EXCLUDES.test(s) && PROTECTED.test(s) && !EEO.test(s)) {
      flags.push({ rule: EXTRA[0].rule, reason: EXTRA[0].reason, strength: "strong", evidence: s.trim().slice(0, 200) })
      break
    }
  }
  for (const r of EXTRA.slice(1)) {
    const s = sents.find((x) => r.re.test(x))
    if (!s) continue
    if (r.rule === "age_max" && /\b(18|21)\s*(\+|years)/.test(s) && /legal|law|act\b|minimum age/i.test(s)) continue
    if (r.rule === "age_max" && /\b(experience|exp)\b/i.test(s) && !/\bage\b/i.test(s) && !/natives?/i.test(s)) continue
    if (EEO.test(s) && !/\bonly\b/i.test(s)) continue
    flags.push({ rule: r.rule, reason: r.reason, strength: "strong", evidence: s.trim().slice(0, 200) })
  }
  for (const r of RULES) {
    const m = text.match(r.re)
    if (!m || m.index === undefined) continue
    // An equal-opportunity sentence around the match ("we welcome women ...") is not a restriction.
    const sentence = text.slice(Math.max(0, text.lastIndexOf(".", m.index) + 1), (text.indexOf(".", m.index + m[0].length) + 1 || text.length))
    if (EEO.test(sentence) && !/\bonly\b/i.test(m[0])) continue
    if (r.rule === "age_limit" && /\b(18|21)\s*(\+|years|yrs)/i.test(m[0]) && /legal|law|minimum age|at least 18|18\+|above 18/i.test(sentence)) continue
    flags.push({ rule: r.rule, reason: r.reason, strength: "strong", evidence: sentence.trim().slice(0, 200) })
  }
  return { flagged: flags.length > 0, flags }
}
