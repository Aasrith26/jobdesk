import { describe, expect, test } from "bun:test"
import { classifyRegion, descriptionRestriction, timezoneWindowIncludesIndia, titleRestriction } from "../src/helpers"
import { assessIndia } from "../src/commands/search"

describe("classifyRegion (conservative India heuristic)", () => {
  const friendly = [
    "",
    "Anywhere in the World",
    "World Wide",
    "Worldwide",
    "Global",
    "Anywhere",
    "Remote",
    "APAC",
    "Asia",
    "India",
    "Remote, India",
    "Europe, LATAM, APAC, the U.S., Canada",
    "IST +/- 2 hours",
    "UTC+3 (+/- 3 hours)",
  ]
  const restricted = [
    "USA Only",
    "North America Only",
    "Latin America Only",
    "Europe Only",
    "United States",
    "Canada",
    "EMEA",
    "Hong Kong, Singapore",
    "Japan - Remote",
    "Anywhere in the US",
    "Remote - US",
    "Global (EU timezones)",
    "USA, Canada, Ireland or UK only",
    "US, UK, Canada, Australia + 35 other countries",
    "Time zone: CET (+/- 3 hours)",
    "New York, New York, United States",
  ]
  for (const r of friendly) test(`friendly: ${JSON.stringify(r)}`, () => expect(classifyRegion(r)).toBe("friendly"))
  for (const r of restricted) test(`restricted: ${JSON.stringify(r)}`, () => expect(classifyRegion(r)).toBe("restricted"))
})

describe("timezone windows", () => {
  test("CET +/- 3h does not reach IST; CET +/- 5h does", () => {
    expect(timezoneWindowIncludesIndia("CET (+/- 3 hours)")).toBe(false)
    expect(timezoneWindowIncludesIndia("CET (+/- 5 hours)")).toBe(true)
    expect(timezoneWindowIncludesIndia("Worldwide")).toBeNull()
  })
})

describe("title and description restrictions", () => {
  test("titles pinned to another market", () => {
    expect(titleRestriction("Senior AI Engineer - EU")).toBe("EU")
    expect(titleRestriction("Customer Success Engineer (Singapore)")).toBe("Singapore")
    expect(titleRestriction("Account Executive, US East")).toBe("US")
    expect(titleRestriction("Join us as an ML Engineer")).toBeNull()
    expect(titleRestriction("ML Engineer - Europe or India")).toBeNull()
  })

  test("residency / authorization / office-days phrases", () => {
    expect(descriptionRestriction("Candidates must be located in the United States.")).toMatch(/located in the United States/)
    expect(descriptionRestriction("You must be authorized to work in the US.")).toMatch(/authorized to work in the US/)
    expect(descriptionRestriction("We work onsite three days a week in NYC.")).toMatch(/onsite three days a week/)
    expect(descriptionRestriction("We hire globally and are an equal opportunity employer.")).toBeNull()
  })

  test("assessIndia: board verdict first, then title, then description", () => {
    expect(assessIndia({ region: "USA Only", title: "x", description: null })).toEqual({ indiaFriendly: false, restrictionHint: null })
    expect(assessIndia({ region: "Worldwide", title: "Engineer - EU", description: null })).toEqual({
      indiaFriendly: false,
      restrictionHint: "title: EU",
    })
    expect(
      assessIndia({ region: null, title: "Engineer", description: "Applicants must reside in Canada." }).restrictionHint,
    ).toMatch(/^description: /)
    expect(assessIndia({ region: "Worldwide", title: "Engineer", description: "Fully remote." }).indiaFriendly).toBe(true)
    // An explicit India restriction is not second-guessed by the text checks.
    expect(assessIndia({ region: "India", title: "Engineer (US clients)", description: null }).indiaFriendly).toBe(true)
    // A structured verdict (Himalayas) wins over the region text.
    expect(assessIndia({ eligibility: "restricted", region: "Worldwide (timezones UTC-8..UTC-5)", title: "x", description: null }).indiaFriendly).toBe(false)
  })
})
