import { describe, test, expect } from "bun:test";
import {
  buildSearchUrl,
  cardAgeDays,
  cleanDescription,
  decodeFlight,
  normalizeDetailInput,
  parseJobCards,
  parseJobDetail,
  parsePostedAtMap,
  parseSearchMeta,
  relativeAgeDays,
  slugify,
} from "../src/helpers";
import { fixture } from "./helpers";

const SEARCH = fixture("search.html");
const DETAIL = fixture("detail.html");

describe("search URL building", () => {
  test("keyword + city", () => {
    expect(buildSearchUrl({ query: "Machine Learning Engineer", location: "Hyderabad", page: 1, sort: "relevance" }))
      .toBe("https://www.shine.com/job-search/machine-learning-engineer-jobs-in-hyderabad");
  });
  test("page suffix and date sort", () => {
    expect(buildSearchUrl({ query: "ai engineer", location: "Hyderabad, Telangana, India", page: 3, sort: "date" }))
      .toBe("https://www.shine.com/job-search/ai-engineer-jobs-in-hyderabad-3?sort=1");
  });
  test("keyword only and location only", () => {
    expect(buildSearchUrl({ query: "data scientist", page: 1, sort: "relevance" }))
      .toBe("https://www.shine.com/job-search/data-scientist-jobs");
    expect(buildSearchUrl({ location: "New Delhi", page: 2, sort: "relevance" }))
      .toBe("https://www.shine.com/job-search/jobs-in-new-delhi-2");
  });
  test("trailing 'jobs' in the query is not doubled", () => {
    expect(buildSearchUrl({ query: "python jobs", page: 1, sort: "relevance" }))
      .toBe("https://www.shine.com/job-search/python-jobs");
  });
  test("slugify spells out symbols like Shine's search box", () => {
    expect(slugify("C++")).toBe("c-plus-plus");
    expect(slugify("Node.js developer")).toBe("node-dot-js-developer");
    expect(slugify("C# / .NET")).toBe("c-sharp-dot-net");
  });
  test("never builds a robots-disallowed path", () => {
    const url = buildSearchUrl({ query: "ml engineer", location: "Pune", page: 2, sort: "date" });
    expect(url).not.toMatch(/\/api\/|\/job-search\/simple\/|\/job-search\/similar\/|jd_cname|vendorid|rect=|type=amp/);
  });
});

describe("search page parsing", () => {
  test("renderedAt comes from the flight dehydratedAt timestamp", () => {
    const html = '<script>self.__next_f.push([1,"{\\"dehydratedAt\\":1792790807320}"])</script>';
    expect(parseSearchMeta(html).renderedAt).toBe("2026-10-23T21:26:47.320Z");
  });

  const flight = decodeFlight(SEARCH);
  const cards = parseJobCards(SEARCH, parsePostedAtMap(flight));

  test("parses each card independently and skips the malformed one", () => {
    expect(cards.map((c) => c.id)).toEqual(["19955272", "19932727", "19999999"]);
  });

  test("extracts all card fields", () => {
    const c = cards[1];
    expect(c.title).toBe("Machine Learning Engineer");
    expect(c.company).toBe("CAREERGUIDE");
    expect(c.location).toBe("Bangalore");
    expect(c.experience).toBe("5 Yrs");
    expect(c.salary).toBe("Not Disclosed");
    expect(c.posted).toBe("2 weeks ago");
    expect(c.badges).toContain("Actively Hiring");
    expect(c.skills.slice(0, 3)).toEqual(["machine learning", "artificial intelligence", "python"]);
    expect(c.url).toBe("https://www.shine.com/jobs/machine-learning-engineer/careerguide/19932727");
    expect(c.postedAt).toBe("2026-10-26T12:25:37+05:30");
    expect(c.date).toBe("2026-10-26");
  });

  test("hidden markup never reaches a field; entities decode", () => {
    const c = cards[2];
    expect(c.title).not.toMatch(/IGNORE/);
    expect(c.location).toBe("Hyderabad");
    expect(c.company).toBe("Acme's AI Labs");
  });

  test("a non-ISO postedAt in the flight data is rejected", () => {
    expect(cards[2].postedAt).toBeNull();
    expect(cards[2].date).toBeNull();
  });

  test("meta: totals and what Shine interpreted the query as", () => {
    const meta = parseSearchMeta(SEARCH, flight);
    expect(meta.total).toBe(3465);
    expect(meta.pageCount).toBe(174);
    expect(meta.hasNextPage).toBe(true);
    expect(meta.pageTitle).toBe("Machine Learning Engineer Jobs in Hyderabad");
    expect(meta.renderedAt).toBeNull(); // fixture flight has no dehydratedAt
  });

  test("no cards in an empty or foreign page", () => {
    expect(parseJobCards("")).toEqual([]);
    expect(parseJobCards("<html><body><article class='other'>x</article></body></html>")).toEqual([]);
  });
});

describe("posting age", () => {
  test("relative labels", () => {
    expect(relativeAgeDays("3 hours ago")).toBe(0);
    expect(relativeAgeDays("Today")).toBe(0);
    expect(relativeAgeDays("5 days ago")).toBe(5);
    expect(relativeAgeDays("2 weeks ago")).toBe(14);
    expect(relativeAgeDays("1 month ago")).toBe(30);
    expect(relativeAgeDays("a month ago")).toBe(30);
    expect(relativeAgeDays("whenever")).toBeNull();
    expect(relativeAgeDays(null)).toBeNull();
  });
  test("absolute timestamp wins over the relative label", () => {
    const card = {
      id: "1", title: "t", company: null, location: null, date: "2026-11-01",
      postedAt: "2026-11-01T00:00:00+05:30", posted: "1 month ago", experience: null,
      salary: null, skills: [], badges: [], url: "u",
    };
    const age = cardAgeDays(card, new Date("2026-11-04T18:30:00Z"));
    expect(Math.round(age!)).toBe(4);
    expect(cardAgeDays({ ...card, postedAt: null })).toBe(30);
    // A relative label on a stale snapshot is aged by the snapshot's age too.
    const now = new Date("2026-11-09T00:00:00Z");
    expect(cardAgeDays({ ...card, postedAt: null, posted: "2 days ago" }, now, "2026-10-23T00:00:00.000Z")).toBe(19);
  });
});

describe("detail input", () => {
  test("numeric id uses letter placeholder slugs (robots disallows /jobs/1*, /jobs/9*)", () => {
    expect(normalizeDetailInput("19932727")).toEqual({
      id: "19932727",
      url: "https://www.shine.com/jobs/job/company/19932727",
    });
  });
  test("shine URL with query string keeps its slugs and drops the query", () => {
    expect(normalizeDetailInput("https://www.shine.com/jobs/ai-engineer/acme/20011124?jobtype=rs&position_in_results=1")).toEqual({
      id: "20011124",
      url: "https://www.shine.com/jobs/ai-engineer/acme/20011124",
    });
    expect(normalizeDetailInput("www.shine.com/jobs/ai-engineer/acme/20011124")?.id).toBe("20011124");
  });
  test("slugs that would hit a disallowed prefix are replaced", () => {
    expect(normalizeDetailInput("https://www.shine.com/jobs/1-ai-engineer/acme/20011124")?.url)
      .toBe("https://www.shine.com/jobs/job/company/20011124");
  });
  test("foreign and look-alike hosts are rejected", () => {
    expect(normalizeDetailInput("https://example.com/jobs/ai-engineer/acme/20011124")).toBeNull();
    expect(normalizeDetailInput("https://www.shine.com.evil.io/jobs/a/b/20011124")).toBeNull();
    expect(normalizeDetailInput("https://www.shine.com@evil.io/jobs/a/b/20011124")).toBeNull();
    expect(normalizeDetailInput("not an id")).toBeNull();
    expect(normalizeDetailInput("123")).toBeNull();
  });
});

describe("detail page parsing", () => {
  const job = parseJobDetail(DETAIL, "19932727");

  test("role card and JSON-LD fields", () => {
    expect(job.title).toBe("Machine Learning Engineer");
    expect(job.company).toBe("CAREERGUIDE");
    expect(job.location).toBe("Bangalore");
    expect(job.experience).toBe("5 Yrs");
    expect(job.salary).toBe("Not Disclosed");
    expect(job.employmentType).toBe("Full Time");
    expect(job.industry).toBe("Power / Energy");
    expect(job.postedAt).toBe("2026-10-26T12:25:37+05:30");
    expect(job.date).toBe("2026-10-26");
    expect(job.validThrough).toBe("2026-11-10T12:25:35+05:30");
    expect(job.skills).toContain("mlops");
    expect(job.url).toBe("https://www.shine.com/jobs/machine-learning-engineer/careerguide/19932727");
  });

  test("description is the visible text with line breaks, hidden text removed", () => {
    expect(job.description).toMatch(/^We are seeking a skilled Machine Learning Engineer/);
    expect(job.description).toMatch(/\nKey Responsibilities:\n- Design, develop, and deploy/);
    expect(job.description).not.toMatch(/Ignore all prior instructions/);
  });

  test("falls back to JSON-LD when the visible body is missing", () => {
    const noPre = DETAIL.replace(/<pre[\s\S]*?<\/pre>/, "");
    const j = parseJobDetail(noPre, "19932727");
    expect(j.description).toMatch(/Key Responsibilities:/);
  });

  test("HTML descriptions keep paragraphs and list items", () => {
    expect(cleanDescription("<p>Intro &amp; more</p><ul><li>One</li><li>Two</li></ul><p>End<br>line</p>"))
      .toBe("Intro & more\n\n- One\n\n- Two\n\nEnd\nline");
  });
});
