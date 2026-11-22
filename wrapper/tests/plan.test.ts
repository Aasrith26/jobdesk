import { describe, expect, test } from "bun:test"
import { planFill } from "../src/fill/plan.ts"
import { pickOption, type PageField, type PageScan } from "../src/fill/forms.ts"
import { policyFor } from "../src/fill/policy.ts"
import { formUrl } from "../src/fill/runner.ts"
import type { Bank } from "../src/data/answers.ts"

const f = (id: string, label: string, type = "text", extra: Partial<PageField> = {}): PageField => ({ id, tag: "input", type, name: id, label, required: true, visible: true, options: [], value: "", ...extra })
const scan = (fields: PageField[], extra: Partial<PageScan> = {}): PageScan => ({ url: "https://boards.greenhouse.io/x/jobs/1", host: "boards.greenhouse.io", fields, captcha: false, password: false, submitLabel: "Submit application", text: "", ...extra })
const bank: Bank = {
  email: { key: "email", label: "Email", answer: "a@example.com", questions: [], sensitive: false, source: "profile", updated: "2026-11-11" },
  full_name: { key: "full_name", label: "Full name", answer: "Test Person", questions: [], sensitive: false, source: "profile", updated: "2026-11-11" },
  relocation: { key: "relocation", label: "Willing to relocate", answer: "Yes", questions: [], sensitive: false, source: "user", updated: "2026-11-11" },
}

describe("fill plan (APP-3, APP-4, APP-8, APP-9, APP-10)", () => {
  test("every filled value has a source; unknown required questions are never guessed", () => {
    const p = planFill(scan([f("a", "Email *"), f("b", "Full name"), f("c", "Why do you want to join us?", "textarea")]), bank, {})
    expect(p.actions.map((a) => [a.field.id, a.value])).toEqual([["a", "a@example.com"], ["b", "Test Person"]])
    expect(p.actions.every((a) => a.source.startsWith("answer bank"))).toBe(true)
    expect(p.unknown.map((u) => u.field.id)).toEqual(["c"])
  })
  test("only this application's CV and cover letter are uploaded; other required files stop", () => {
    const p = planFill(scan([f("cv", "Resume/CV", "file"), f("cl", "Cover Letter", "file"), f("x", "SSH private key", "file")]), bank, { cv: "C:/a/cv.pdf" })
    expect(p.actions.map((a) => a.value)).toEqual(["C:/a/cv.pdf"])
    expect(p.stops.map((s) => s.reason)).toEqual(["unknown_file", "unknown_file"])
  })
  test("hidden fields are never filled (prompt-injection honeypots)", () => {
    const p = planFill(scan([f("h", "Email", "text", { visible: false })]), bank, {})
    expect(p.actions.length).toBe(0)
  })
  test("legal statements, CAPTCHAs and logins go to the human", () => {
    const p = planFill(scan([f("t", "I certify that the information is true and complete", "checkbox")], { captcha: true, password: true }), bank, {})
    expect(p.stops.map((s) => s.reason).sort()).toEqual(["captcha", "legal_statement", "login"])
  })
  test("voluntary/sensitive questions default to 'prefer not to say'", () => {
    const p = planFill(scan([f("g", "Gender (voluntary self-identification)", "select-one", { options: ["Select...", "Male", "Female", "Decline to self-identify"] })]), bank, {})
    expect(p.actions[0].value).toBe("Decline to self-identify")
    expect(p.actions[0].source).toContain("prefer not to say")
  })
  test("a required sensitive question with no decline option stops", () => {
    const p = planFill(scan([f("g", "Disability status", "select-one", { options: ["Yes", "No"] })]), bank, {})
    expect(p.stops[0].reason).toBe("no_decline_option")
  })
  test("a yes/no answer never fills an open question that merely mentions the topic", () => {
    const p = planFill(scan([f("addr", "What is the address from which you plan on working? (If you're open to relocation, say so)", "text")]), bank, {})
    expect(p.actions.length).toBe(0)
    expect(p.unknown.map((u) => u.field.id)).toEqual(["addr"])
  })
  test("file inputs labelled by their button still get the CV when the field is the resume", () => {
    const p = planFill(scan([f("resume", "Resume/CV resume Attach", "file")]), bank, { cv: "C:/a/cv.pdf" })
    expect(p.actions[0]?.value).toBe("C:/a/cv.pdf")
  })
  test("arbitration and consent questions are hard stops whatever the field type", () => {
    const p = planFill(scan([f("arb", "Agreement to Arbitrate*", "combobox"), f("ai", "Notetakers", "radio", { options: ["Yes, I consent", "No"], group: "g" })]), bank, {})
    expect(p.stops.map((s) => s.reason)).toEqual(["legal_statement", "legal_statement"])
  })
  test("yes/no answers map onto the form's own options", () => {
    expect(pickOption(["Yes, I am willing", "No"], "yes")).toBe("Yes, I am willing")
    expect(pickOption(["Select", "Immediately", "30 days"], "30 days")).toBe("30 days")
    // Real bug found on a live Greenhouse form: "India" must never pick a longer name containing it.
    expect(pickOption(["British Indian Ocean Territory +246", "India +91", "Indonesia +62"], "India")).toBe("India +91")
    expect(pickOption(["British Indian Ocean Territory"], "India")).toBeNull()
    const p = planFill(scan([f("r", "Are you willing to relocate?", "radio", { options: ["Yes", "No"], group: "g" })]), bank, {})
    expect(p.actions[0].value).toBe("Yes")
  })
})

describe("answers worked out from the user's own data", () => {
  const profile = "## Identity\n- **Name:** Test Person\n\n## Professional Experience\n### AI Engineer - Example Labs (Jan 2024 - Present)\n- Built things.\n\n## Education\n"
  const b2: Bank = {
    ...bank,
    location: { key: "location", label: "Current location", answer: "Bengaluru, India", questions: [], sensitive: false, source: "user", updated: "2026-11-11" },
    citizenship: { key: "citizenship", label: "Citizenship", answer: "India", questions: [], sensitive: false, source: "user", updated: "2026-11-11" },
  }
  const yn = (id: string, label: string) => f(id, label, "select-one", { options: ["Select...", "Yes", "No"] })
  test("worked at this company before: from the profile's work history", () => {
    const p = planFill(scan([yn("a", "Have you ever worked for Figma before, as an employee or a contractor?"), yn("b", "Have you previously worked at Example Labs?")]), b2, {}, { company: "figma", profile })
    // Any company the question names is checked against the profile's work history.
    expect(p.actions.map((a) => [a.field.id, a.value])).toEqual([["a", "No"], ["b", "Yes"]])
    expect(p.actions[0].source.toLowerCase()).toContain("doesn't include figma")
    const q = planFill(scan([yn("b", "Have you previously worked at Example Labs?")]), b2, {}, { company: "examplelabs", profile })
    expect(q.actions.map((a) => a.value)).toEqual(["Yes"])
  })
  test("no real work history in the profile means no guess", () => {
    const p = planFill(scan([yn("a", "Have you ever worked for Figma before?")]), b2, {}, { company: "figma", profile: "## Professional Experience\n- **[JOB_TITLE]** - **[COMPANY]**\n" })
    expect(p.actions.length).toBe(0)
    expect(p.unknown.length).toBe(1)
  })
  test("applied / interviewed before: from the tracker", () => {
    const tracker = [{ company: "Anthropic", status: "rejected", source: "https://x/1" }, { company: "Groww", status: "interview", source: "https://x/2" }]
    const p = planFill(scan([yn("a", "Have you ever interviewed at Anthropic before?"), yn("b", "Have you previously applied to Groww?")]), b2, {}, { company: "anthropic", tracker })
    expect(p.actions.find((a) => a.field.id === "a")?.value).toBe("No")
    const q = planFill(scan([yn("b", "Have you ever interviewed at Groww before?")]), b2, {}, { company: "groww", tracker })
    expect(q.actions[0].value).toBe("Yes")
  })
  test("based in / citizen of: from saved location and citizenship, with city aliases", () => {
    const p = planFill(scan([yn("a", "Are you based out of Bangalore ?"), yn("b", "Are you currently located in either Canada, UK or Poland?"), yn("c", "Are you a Singapore citizen?"), yn("d", "Are you a Singapore permanent resident?")]), b2, {}, {})
    const v = Object.fromEntries(p.actions.map((a) => [a.field.id, a.value]))
    expect(v).toEqual({ a: "Yes", b: "No", c: "No" })
    expect(p.unknown.map((u) => u.field.id)).toEqual(["d"])
  })
  test("work authorisation and sponsorship: never a generic answer for another country (real bug)", () => {
    const b3: Bank = { ...b2, work_authorization: { key: "work_authorization", label: "Work authorization", answer: "Yes", questions: [], sensitive: false, source: "user", updated: "" }, sponsorship: { key: "sponsorship", label: "Needs visa sponsorship", answer: "No", questions: [], sensitive: false, source: "user", updated: "" } }
    const p = planFill(scan([
      yn("us", "Are you legally authorized to work in the United States?*"),
      yn("tc", "Are you currently authorized to work in this country?*"),
      yn("sp", "Will you now or in the future require sponsorship to work in the US?"),
      yn("in", "Are you legally authorized to work in India?"),
      yn("gen", "Will you now or in the future require visa sponsorship?"),
    ]), b3, {}, {})
    // Without a job page showing a home-country location, even the country-less question is asked.
    const v = Object.fromEntries(p.actions.map((a) => [a.field.id, a.value]))
    expect(v).toEqual({ in: "Yes" })
    expect(p.unknown.map((u) => u.field.id).sort()).toEqual(["gen", "sp", "tc", "us"])
  })
  test("relatives, visas and qualified experience are never derived or mis-mapped (real bugs)", () => {
    const tl = f("tl", "How many years of experience do you have as a tech lead or team lead?", "text")
    const rel = yn("rel", "Do you have a relative/ family member working currently in Groww?*")
    const imm = yn("imm", "Do you now, or will you in the future, require immigration sponsorship to work at Reddit?")
    const pr = f("pr", "Name Pronunciation | How do you pronounce your name?", "text")
    const b4: Bank = { ...b2, total_experience: { key: "total_experience", label: "Total years", answer: "1", questions: [], sensitive: false, source: "user", updated: "" } }
    const p = planFill(scan([tl, rel, imm, pr]), b4, {}, { company: "groww", profile })
    expect(p.actions.length).toBe(0)
  })
  test("named companies other than the employer are checked against the profile too", () => {
    const p = planFill(scan([yn("amz", "Have you previously been employed by Amazon or any Amazon subsidiary?*")]), b2, {}, { company: "twitch", profile })
    expect(p.actions[0]?.value).toBe("No")
    expect(p.actions[0]?.source).toContain("Amazon")
  })
  test("more real bugs: 'current role' isn't a title question; 'based in or willing to relocate' isn't derived; foreign jobs get no generic sponsorship answer", () => {
    const b5: Bank = { ...b2, current_title: { key: "current_title", label: "Current job title", answer: "AI Engineer", questions: [], sensitive: false, source: "user", updated: "" }, sponsorship: { key: "sponsorship", label: "Needs visa sponsorship", answer: "No", questions: [], sensitive: false, source: "user", updated: "" } }
    const p = planFill(scan([f("ai", "How are you using AI today in your current role?", "textarea"), yn("bay", "Are you currently based in or willing to relocate to the Bay Area?"), yn("sp", "Do you now, or will you in the future, require immigration sponsorship?"), f("t", "Current title", "text")]), b5, {}, {})
    // "based in OR willing to relocate" is honestly answered by the relocation answer, not by location.
    expect(p.actions.map((a) => [a.field.id, a.value, a.source])).toEqual([["bay", "Yes", "answer bank: Willing to relocate"], ["t", "AI Engineer", "answer bank: Current job title"]])
    const us = planFill(scan([yn("sp", "Will you require sponsorship?")], { text: "Software Engineer - San Francisco, CA (Hybrid)" }), b5, {}, {})
    expect(us.actions.length).toBe(0)
    const ind = planFill(scan([yn("sp", "Will you require sponsorship?")], { text: "Software Engineer - Bengaluru, India" }), b5, {}, {})
    expect(ind.actions[0]?.value).toBe("No")
  })
  test("university: from the profile; 'Other' when the form says to pick it", () => {
    const prof = "## Education\n- B.E. Computer Science, Test Institute of Technology, Hyderabad (2019 - 2023)\n"
    const p = planFill(scan([f("u", "Which university are you currently attending or did you last attend? Please select Other if not listed", "select-one", { options: ["Select", "IIT Bombay", "Other (School not listed)"] })]), b2, {}, { profile: prof })
    expect(p.actions[0]?.value).toBe("Other (School not listed)")
    expect(p.actions[0]?.source).toContain("Test Institute of Technology")
  })
  test("voluntary questions in typed dropdowns get the decline option", () => {
    const p = planFill(scan([f("g", "How would you describe your gender identity (please select one)?", "combobox"), f("s", "I identify my sexual orientation as", "combobox")]), b2, {}, {})
    expect(p.actions.map((a) => a.value)).toEqual(["__DECLINE__", "__DECLINE__"])
  })
})

describe("place matching for location autocompletes", () => {
  test("every part must match; country codes count; other countries don't", async () => {
    const { placeMatches } = await import("../src/fill/runner.ts")
    expect(placeMatches("Hyderabad, Telangana, IND", "Hyderabad, India")).toBe(true)
    expect(placeMatches("Hyderabad, Sindh, PAK", "Hyderabad, India")).toBe(false)
    expect(placeMatches("Hyderabad, Telangana, India", "Hyderabad, India")).toBe(true)
    expect(placeMatches("New Hyderabad, IND", "Hyderabad, India")).toBe(false)
  })
})

describe("site policy (APP-2)", () => {
  test("LinkedIn and job boards are assist-only; public ATS forms can be automated; unknown falls back to assist", () => {
    expect(policyFor("https://www.linkedin.com/jobs/view/1").policy).toBe("assist")
    expect(policyFor("https://www.hirist.tech/j/x").policy).toBe("assist")
    expect(policyFor("https://boards.greenhouse.io/acme/jobs/1").policy).toBe("automate")
    expect(policyFor("https://jobs.lever.co/acme/1").policy).toBe("automate")
    expect(policyFor("https://acme.myworkdayjobs.com/x").policy).toBe("assist")
    expect(policyFor("https://random.example.com/apply").policy).toBe("assist")
    expect(policyFor("https://evil-greenhouse.io/x").policy).toBe("assist")
  })
  test("ATS pages that need a suffix to show the form", () => {
    expect(formUrl("https://jobs.lever.co/acme/123")).toBe("https://jobs.lever.co/acme/123/apply")
    expect(formUrl("https://jobs.ashbyhq.com/acme/abc")).toBe("https://jobs.ashbyhq.com/acme/abc/application")
  })
})
