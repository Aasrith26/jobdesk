// Rule-based scam detector (SAFE-1). Zero-model: runs in the free tier.
// A flag is a warning with a reason shown to the user, never a silent drop.

export interface Flag {
  rule: string
  reason: string
  strength: "strong" | "weak"
  evidence: string
}

const BRANDS = [
  "amazon", "google", "microsoft", "tcs", "tata consultancy", "infosys", "wipro", "accenture", "deloitte", "ibm",
  "flipkart", "hcl", "tech mahindra", "cognizant", "capgemini", "reliance", "jio", "airtel", "meta", "facebook",
  "apple", "oracle", "paytm", "swiggy", "zomato", "byju", "hdfc", "icici", "sbi", "kpmg", "ey", "pwc", "netflix", "uber",
]
const FREEMAIL = /@(gmail|yahoo|ymail|outlook|hotmail|rediffmail|proton(mail)?|aol|zoho|icloud|live)\.(com|in|co\.in|me)\b/i
const OFFICIAL: Record<string, string[]> = {
  amazon: ["amazon.com", "amazon.jobs", "amazon.in", "amazon.science", "aws.amazon.com"],
  google: ["google.com", "careers.google.com", "google.co.in"],
  microsoft: ["microsoft.com", "careers.microsoft.com"],
  tcs: ["tcs.com"], infosys: ["infosys.com"], wipro: ["wipro.com"], accenture: ["accenture.com"], deloitte: ["deloitte.com"],
  flipkart: ["flipkart.com", "flipkartcareers.com"], ibm: ["ibm.com"], cognizant: ["cognizant.com"], capgemini: ["capgemini.com"],
}

function ev(text: string, m: RegExpMatchArray | null): string {
  if (!m || m.index === undefined) return ""
  return text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ").trim()
}

const RULES: { rule: string; re: RegExp; reason: string; strength: "strong" | "weak" }[] = [
  {
    rule: "upfront_fee",
    re: /\b(registration|training|security|processing|joining|onboarding|document(ation)?|verification|application|kit|uniform|id card|laptop)\s*(fee|fees|charges?|deposit|amount)\b(?![^.]{0,40}\b(no|not|never|free|waived|reimburs))/i,
    reason: "Asks the candidate to pay a fee or deposit. Real employers don't charge candidates.",
    strength: "strong",
  },
  {
    rule: "refundable_deposit",
    re: /\brefundable\b[^.]{0,40}\b(deposit|amount|fee|payment)\b|\b(deposit|pay)\b[^.]{0,30}\brefund(ed|able)\b/i,
    reason: "Mentions a 'refundable' payment, a common scam pattern.",
    strength: "strong",
  },
  {
    rule: "pay_to_get_job",
    re: /\b(pay|transfer|send|deposit)\b[^.]{0,40}(₹|rs\.?|inr|\$|usd|rupees)\s*\d[\d,]*[^.]{0,60}\b(job|offer|joining|registration|confirm|slot|seat|interview)\b/i,
    reason: "Asks for money in connection with getting the job.",
    strength: "strong",
  },
  {
    rule: "task_scam",
    re: /\b(like|subscribe to|rate|review)\b[^.]{0,30}\b(youtube|videos?|posts?|hotels?|products?|apps?|restaurants?|movies?)\b[^.]{0,80}\b(earn|paid|income|commission|per task|₹|rs)\b|\b(prepaid|merchant|vip)\s*tasks?\b|\bper\s*task\b/i,
    reason: "Looks like a 'task' scam (paid to like, rate or review things).",
    strength: "strong",
  },
  {
    rule: "unrealistic_earnings",
    re: /\b(earn|income|salary|make)\b[^.]{0,30}(₹|rs\.?|inr|\$)\s*\d[\d,]*\s*(\+\s*)?(per|\/|a|every)\s*(day|daily|week|weekly|hour)\b[^.]{0,60}\b(home|part[- ]?time|mobile|no experience|simple|easy|typing|data entry)\b|\b(home|part[- ]?time|mobile|no experience|typing|data entry)\b[^.]{0,60}\b(earn|income)\b[^.]{0,20}(₹|rs\.?|inr|\$)\s*\d[\d,]*\s*(\+\s*)?(per|\/|a|every)?\s*(day|daily|week|weekly)\b/i,
    reason: "Promises high daily or weekly earnings for easy work-from-home tasks.",
    strength: "strong",
  },
  {
    rule: "sensitive_data_upfront",
    re: /\b(share|send|provide|submit|whatsapp|reply with|upload)\b[^.]{0,40}\b(otp|cvv|atm pin|upi pin|bank (account|details)|net ?banking|banking login|online banking|aadh?aar|pan card|card details|ssn|social security)\b/i,
    reason: "Asks for bank details, an OTP or ID documents before any interview.",
    strength: "strong",
  },
  {
    rule: "crypto_giftcard",
    re: /\b(usdt|bitcoin|btc|crypto(currency)?|gift ?cards?|binance|trust ?wallet)\b/i,
    reason: "Mentions crypto or gift-card payments.",
    strength: "weak",
  },
  {
    rule: "guarantee",
    re: /\b(100\s*%|guaranteed?)\s*(job|placement|selection|offer)\b|\bjob\s*guarantee\b/i,
    reason: "Promises a guaranteed job.",
    strength: "weak",
  },
  {
    rule: "no_interview_direct",
    re: /\b(no interview|without (an )?interview|direct (joining|selection|offer)|spot (offer|selection)|selected without)\b/i,
    reason: "Offers a job with no interview.",
    strength: "weak",
  },
  {
    rule: "chat_only_contact",
    re: /\b(whatsapp|telegram)\b[^.]{0,25}\b(only|immediately|now|asap)\b|\b(only|just)\b[^.]{0,15}\b(whatsapp|telegram)\b|\bdm\b[^.]{0,20}\btelegram\b/i,
    reason: "Wants contact only over WhatsApp or Telegram.",
    strength: "weak",
  },
  {
    rule: "urgency",
    re: /\b(limited (seats|slots|vacancies)|last (date|chance) today|hurry|only \d+ (seats|slots) left|act fast|urgent(ly)? (hiring|requirement)!{2,})\b/i,
    reason: "Uses pressure tactics like limited seats or 'hurry'.",
    strength: "weak",
  },
]

const MONEY = /(₹|rs\.?\s?|inr\s?|\$|usd\s?)\s?\d/i
const COST = /\b(fee|fees|charge|charges|costs?|token amount|demand draft|recharge|investment|joining package|starter kit|plan at|for just|at just|only ₹|payable|pay|paying|premium|one-time|candidate-funded|self-funded|payment (of|receipt)|complete the payment|send (the|your) payment|buy|purchase|deposit|registration amount)\b/i
const NEG_WORDS = /\b(no|zero|nil|never|not|without any|free of|waived|reimburs\w*)\b[^.]{0,30}\b(fee|fees|charge|charges|cost|payment|deposit|money)\b|\b(fee|fees|charges?)\b[^.]{0,15}\b(waived|reimburs\w*|not required|nil)\b/i
const NEG_EMPLOYER_PAYS = /\b(we|company|employer|they)\s+(will\s+)?(cover|covers|pay|pays|bear|bears|reimburse|sponsor)\b/i
const BUT_YOU_PAY = /\b(but|except|however)\b|\b(required to|must|have to|need to|has to)\s+(pay|book|deposit)\b/i
/** "Pay: ₹400 per hour" is a rate, not a request for money. */
const PAY_NOUN = /\bpay(\s*:|\s+(is|of|rate|range|band|scale|level))|\bpay\s*(₹|rs\.?|inr|usd|\$)\s?[\d.,]+[^.]{0,25}\b(per|\/|a|every)\s*(hour|hr|word|month|day|week|annum|year|article|task|ticket)\b|\bpaid (monthly|weekly|every|on time|via|by bank)/gi
const NEGATED = { test: (s: string) => NEG_WORDS.test(s) || (NEG_EMPLOYER_PAYS.test(s) && !BUT_YOU_PAY.test(s)) }
const SALARY = /\b(salary|stipend|ctc|lpa|in hand|per annum|remuneration)\b/i
const PAY_VERB = /\b(pay|paying|deposit|recharge|demand draft|token amount|investment|purchase|buy|candidate-funded|self-funded|(file|registration|processing|service) charges? (of|₹|rs))\b/i
const GOVT = /\b(recruitment notification|notification no|official (recruitment )?(portal|website)|public service commission|psc|ssc|upsc|recruitment board|written exam|admit card)\b/i
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/)

/** Money the candidate is asked to pay, sentence by sentence; salaries and "no fee" lines don't count. */
function candidatePays(text: string): Flag | null {
  const govt = GOVT.test(text)
  for (const raw of sentences(text)) {
    const s = raw.replace(PAY_NOUN, " ")
    if (!MONEY.test(s) || !COST.test(s) || NEGATED.test(s)) continue
    if (govt && /\b(application|exam(ination)?) fee\b/i.test(s)) continue
    if (SALARY.test(s) && !PAY_VERB.test(s)) continue
    return { rule: "candidate_pays", reason: "Asks you to pay money to get or start the job. Real employers don't charge candidates.", strength: "strong", evidence: s.trim().slice(0, 200) }
  }
  return null
}

const EXTRA: { rule: string; test: (t: string) => RegExpMatchArray | null; reason: string; strength: "strong" | "weak" }[] = [
  {
    rule: "task_commission",
    // "commission" as pay to the reader ("earn 8% commission", "commission per task"), not a regulator or a commissioned report.
    test: (t) =>
      /\b(earn|get|receive|keep|paid|credited|you('ll)? (get|earn))\b[^.]{0,40}\bcommission\b|\bcommission\b[^.]{0,30}\b(per|on every|for each|credited|instantly|on each)\b/i.test(t)
        ? t.match(/\b(tasks?|orders?|boost(ing)?|ratings?|reviews?|transactions?|forward)\b/i)
        : null,
    reason: "Pays commission for tasks, orders or reviews: a common task scam.",
    strength: "strong",
  },
  { rule: "per_review_pay", test: (t) => (MONEY.test(t) ? t.match(/\b(har|per|each|every)\s+(review|rating|like|task|video|order)\b/i) : null), reason: "Pays per review, like or task: a common task scam.", strength: "strong" },
  { rule: "money_mule", test: (t) => (/\b(receive|forward|transfer)\b/i.test(t) ? t.match(/\b(personal|own) bank account\b/i) : null), reason: "Wants money to pass through your bank account: that's money laundering, not a job.", strength: "strong" },
  { rule: "check_scam", test: (t) => t.match(/\b(send|mail|issue) you a (check|cheque)\b|\b(check|cheque) to (buy|purchase)\b|\b(cheque|check)\b[^.]{0,80}\b(transfer|forward|vendor)\b|\b(transfer|forward) the (rest|remaining|balance)\b/i), reason: "Sends you a cheque and asks you to pass money on: a known fake-cheque scam.", strength: "strong" },
  { rule: "paid_guarantee", test: (t) => sentences(t).map((s) => (MONEY.test(s) && /\bguarantee/i.test(s) && !SALARY.test(s) ? s.match(/guarantee\w*/i) : null)).find(Boolean) ?? null, reason: "Charges money for a 'guaranteed' shortlist, interview or job.", strength: "strong" },
  { rule: "daily_easy_money", test: (t) => (/\b(minutes a day|minutes daily|on your phone|no experience|housewives|from home|work from home|wfh|part[- ]time|simple work|easy work)\b/i.test(t) ? t.match(/\b(earn|income|salary|paid)\b[^.]{0,30}(₹|rs\.?|inr|\$)\s?\d[\d,]*[^.]{0,30}\b(per|a|\/|every)\s*day\b|\b(credited|paid) daily\b/i) : null), reason: "Promises daily pay for very little work.", strength: "strong" },
  { rule: "recruiter_freemail", test: (t) => t.match(/\b[a-z0-9._%+-]*(hr|recruit|hiring|career|jobs?|talent|placement)[a-z0-9._%+-]*@(gmail|yahoo|ymail|outlook|hotmail|rediffmail|proton(mail)?|aol|icloud|live)\.(com|in|co\.in|me)\b/i), reason: "A 'recruiter' using a personal email address.", strength: "weak" },
  { rule: "chat_only_interview", test: (t) => sentences(t).map((s) => (/\binterview\b/i.test(s) && /\b(telegram|whatsapp|hangouts|signal|text[- ]based|chat)\b/i.test(s) && !/\bvideo call\b|\bin[- ]person\b/i.test(s) ? s.match(/\binterview\b/i) : null)).find(Boolean) ?? null, reason: "The 'interview' happens only by chat.", strength: "weak" },
  { rule: "gift_cards", test: (t) => t.match(/\b(buy|purchase|send)\b[^.]{0,40}\bgift ?cards?\b/i), reason: "Asks you to buy gift cards.", strength: "strong" },
  { rule: "lottery_selection", test: (t) => t.match(/\b(lucky (candidate|winner)|randomly selected|selected by \d+ (top )?companies|unlock recruiter)\b/i), reason: "Says you were 'selected' without applying.", strength: "strong" },
  { rule: "overseas_trafficking", test: (t) => (/\b(data entry|customer support|typing|call cent(er|re))\b/i.test(t) ? t.match(/\b(bangkok|thailand|myanmar|cambodia|laos)\b/i) : null), reason: "Matches the Southeast Asia 'data entry job' trafficking pattern governments warn about.", strength: "strong" },
  { rule: "backdoor", test: (t) => t.match(/\bback ?door (entry|hiring|joining|placement)\b/i), reason: "Offers 'backdoor' entry into a company.", strength: "strong" },
  { rule: "chat_interview", test: (t) => t.match(/\bchat interview\b|\binterview (will be )?(held )?(over|on|via) (google )?(hangouts|telegram|whatsapp)( chat)?\b/i), reason: "The 'interview' happens only over chat apps.", strength: "weak" },
]

/** Brand mentioned as the employer but the contact or link is on a personal or look-alike domain. */
function brandMismatch(text: string): Flag[] {
  const flags: Flag[] = []
  const lower = text.toLowerCase()
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(lower))
  const email = text.match(FREEMAIL)
  if (brand && email) {
    const near = new RegExp(`\\b(hr|recruit\\w*|hiring|careers?|jobs?|talent|official|team|${brand.split(" ")[0]})`, "i").test(text.slice(Math.max(0, (email.index ?? 0) - 60), (email.index ?? 0) + 60))
    flags.push({
      rule: "brand_personal_email",
      reason: `Claims to hire for ${brand.toUpperCase()} but uses a personal email address. Large companies recruit from their own domain.`,
      strength: near ? "strong" : "weak",
      evidence: email[0],
    })
  }
  const domains = [...text.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi)].map((m) => m[1].toLowerCase())
  for (const d of domains) {
    if (d.startsWith("xn--") || d.includes(".xn--")) {
      flags.push({ rule: "punycode_domain", reason: "Contains a disguised (punycode) web address.", strength: "strong", evidence: d })
      continue
    }
    for (const b of Object.keys(OFFICIAL)) {
      if (!d.includes(b)) continue
      const ok = OFFICIAL[b].some((o) => d === o || d.endsWith("." + o))
      if (!ok && !/(linkedin|naukri|indeed|glassdoor|wellfound|instahyre|hirist|cutshort|greenhouse|lever|ashbyhq|workday|myworkdayjobs|smartrecruiters)\./.test(d)) {
        flags.push({ rule: "lookalike_domain", reason: `The address ${d} looks like ${b} but isn't its official domain.`, strength: "strong", evidence: d })
      }
    }
  }
  return flags
}

export interface ScamResult {
  flagged: boolean
  flags: Flag[]
}

export function detectScam(text: string): ScamResult {
  const flags: Flag[] = []
  for (const r of RULES) {
    const m = text.match(r.re)
    if (!m) continue
    // A fee/deposit phrase inside a "no fee" or salary sentence is not a request for money.
    if ((r.rule === "upfront_fee" || r.rule === "refundable_deposit") && NEGATED.test(ev(text, m))) continue
    // "process security deposit refunds" is a job duty: a fee phrase needs money or a pay verb with it.
    if (r.rule === "upfront_fee" || r.rule === "refundable_deposit") {
      const s = sentences(text).find((x) => x.includes(m[0])) ?? ""
      if (!MONEY.test(s) && !/\b(pay|payable|bring|submit|transfer|deposit (it|the|this))\b/i.test(s)) continue
      if (NEGATED.test(s)) continue
      if (GOVT.test(text) && /\b(application|exam(ination)?) fee/i.test(s)) continue
    }
    flags.push({ rule: r.rule, reason: r.reason, strength: r.strength, evidence: ev(text, m) })
  }
  const pays = candidatePays(text)
  if (pays && !flags.some((f) => f.rule === "upfront_fee")) flags.push(pays)
  for (const r of EXTRA) {
    const m = r.test(text)
    if (m) flags.push({ rule: r.rule, reason: r.reason, strength: r.strength, evidence: ev(text, m) })
  }
  flags.push(...brandMismatch(text))
  const strong = flags.filter((f) => f.strength === "strong").length
  const weak = flags.length - strong
  return { flagged: strong >= 1 || weak >= 2, flags }
}
