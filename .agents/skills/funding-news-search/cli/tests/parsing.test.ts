import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  classifyFunding,
  extractAmount,
  extractCompany,
  extractRound,
  feedDate,
  isFeed,
  normUrl,
  parseFeed,
  robotsAllows,
  robotsRules,
} from "../src/helpers";
import { applyFilters, type Lead } from "../src/commands/search";
import { buildDetail, publishedDate, validUrl } from "../src/commands/detail";

describe("classifyFunding (real headlines from the recorded feeds)", () => {
  const yes = [
    "Spacetech startup Cosmoserve Space raises $6 Mn in seed round",
    "[Update] Kissht Raises ₹832 Cr Via Preferential Issue, 24 New Investors Join Cap Table",
    "Matiks raises $10M in pre-Series A round led by General Catalyst",
    "Amansa Investments, SBI Mutual Fund, others invest Rs 413 Cr in Tonbo Imaging ahead of IPO",
    "Enrission India Capital participates in Ottonomy’s Rs 40.6 Cr funding round",
    "Ex-Palantir execs launch Dream with $17M from a16z to build AI world models for construction",
    "Exclusive: Armatrix kicks off Rs 67 Cr seed round at 4.8X valuation premium",
    "Harbinger raises $240M after expanding into defense",
  ];
  for (const t of yes) test(`announcement: ${t.slice(0, 50)}`, () => expect(classifyFunding(t).reason).toBe("announcement"));

  test("'bags' without a funding word needs the funding feed or an investor cue", () => {
    const t = "The Pant Project bags Rs 109 Cr to accelerate retail expansion";
    expect(classifyFunding(t).funding).toBe(false);
    expect(classifyFunding(t, { fundingFeed: true }).funding).toBe(true);
    expect(classifyFunding(t, { categories: ["Funding"] }).funding).toBe(true);
  });

  test("round-ups, VC funds and non-funding money news are excluded", () => {
    expect(classifyFunding("From GIVA To EloElo Group — Indian Startups Raised $255 Mn This Week").reason).toBe("roundup");
    expect(classifyFunding("Daksham Growth Ventures raises Rs 125 Cr in first close of maiden consumer fund").reason).toBe("vc_fund");
    expect(classifyFunding("NABARD-backed NABVENTURES raises Rs 450 Cr for second fund").reason).toBe("vc_fund");
    expect(classifyFunding("Proximal Ventures raises debut fund to back startups bringing AI to drug development").reason).toBe("vc_fund");
    expect(classifyFunding("InMobi Secures Naming Rights For Bengaluru’s Ibbaluru Metro Station For ₹65 Cr").funding).toBe(false);
    expect(classifyFunding("Blue Tokai crosses Rs 500 Cr revenue in FY26; losses up 54%").funding).toBe(false);
    expect(classifyFunding("Decoding: Spill Games’ Rs 100 Cr Series A round, valuation and cap table").funding).toBe(false);
  });

  test("a fund named as the investor is not a VC-fund raise", () => {
    expect(classifyFunding("Acme raises Rs 50 Cr from SBI Mutual Fund").reason).toBe("announcement");
  });
});

describe("extractCompany", () => {
  const cases: [string, string | null][] = [
    ["Spacetech startup Cosmoserve Space raises $6 Mn in seed round", "Cosmoserve Space"],
    ["Specialty chemicals startup altM raises $10.3 Mn led by Rainmatter, Mela Ventures", "altM"],
    ["[Update] Kissht Raises ₹832 Cr Via Preferential Issue", "Kissht"],
    ["Froncort.AI Raises $2.3 Mn From Google.org To Expand AI-Based Disease Surveillance", "Froncort.AI"],
    ["Bengaluru-Based Fintech Startup Kiwi Raises $10 Mn", "Kiwi"],
    ["Jewellery brand GIVA raises $100M from Multiples PE", "GIVA"],
    ["The Pant Project bags Rs 109 Cr to accelerate retail expansion", "The Pant Project"],
    ["Amansa Investments, SBI Mutual Fund, others invest Rs 413 Cr in Tonbo Imaging ahead of IPO", "Tonbo Imaging"],
    ["IIFL Finance to raise Rs 6,414 Cr led by Blackstone", "IIFL Finance"],
    ["Bakingo parent raises nearly Rs 100 Cr from Faering Capital", "Bakingo"],
    ["The/Nudge secures $15M from Google.org to develop AI tools", "The/Nudge"],
    ["Enrission India Capital participates in Ottonomy’s Rs 40.6 Cr funding round", "Ottonomy"],
    ["Ex-Palantir execs launch Dream with $17M from a16z", "Dream"],
    ["Exclusive: Armatrix kicks off Rs 67 Cr seed round", "Armatrix"],
    ["Startup raises $5M", null],
    ["Sequoia hits rewind", null],
  ];
  for (const [title, want] of cases) test(`${title.slice(0, 45)} -> ${want}`, () => expect(extractCompany(title)).toBe(want));
});

describe("amount / round / dates", () => {
  test("amounts", () => {
    expect(extractAmount("X raises Rs 12.5 Cr from Y")).toBe("Rs 12.5 Cr");
    expect(extractAmount("X Raises ₹832 Cr Via")).toBe("₹832 Cr");
    expect(extractAmount("X raises $10.3 Mn led by")).toBe("$10.3 Mn");
    expect(extractAmount("X raises funding")).toBeNull();
  });

  test("rounds", () => {
    expect(extractRound("raises $10M in pre-Series A round")).toBe("Pre-Series A");
    expect(extractRound("$80 Mn in Series C led by")).toBe("Series C");
    expect(extractRound("$2.7 Mn in pre-seed round")).toBe("Pre-seed");
    expect(extractRound("Daksham Growth Ventures raises Rs 125 Cr")).toBeNull();
    expect(extractRound("raises Rs 50 Cr in a debt round")).toBe("Debt");
  });

  test("feedDate keeps the publisher's calendar date", () => {
    expect(feedDate("Wed, 11 Nov 2026 01:56:52 +0530")).toBe("2026-11-11");
    expect(feedDate("Tue, 10 Nov 2026 20:47:05 +0000")).toBe("2026-11-10");
    expect(feedDate("2026-11-05T20:36:42+05:30")).toBe("2026-11-05");
    expect(feedDate("sometime")).toBeNull();
  });

  test("normUrl drops query, hash and trailing slash", () => {
    expect(normUrl("https://TechCrunch.com/2026/11/x/?utm_source=rss#a")).toBe("https://techcrunch.com/2026/11/x");
  });
});

describe("feed parsing", () => {
  test("RSS 2.0 (WordPress style, TechCrunch fixture)", async () => {
    const xml = await Bun.file(join(import.meta.dir, "fixtures/tcs.xml")).text();
    expect(isFeed(xml)).toBe(true);
    const items = parseFeed(xml);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "Harbinger raises $240M after expanding into defense",
      date: "2026-11-05",
    });
    expect(items[0].link).toStartWith("https://techcrunch.com/2026/11/05/");
    expect(items[0].categories.length).toBeGreaterThan(0);
  });

  test("entities in titles are decoded once (&#038; inside the title)", () => {
    const items = parseFeed("<rss><channel><item><title>A &#038; B raises $1M</title><link>https://x.example/a</link></item></channel></rss>");
    expect(items[0].title).toBe("A & B raises $1M");
  });

  test("Atom entries", () => {
    const xml =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Foo raises $3M seed</title>' +
      '<link rel="alternate" href="https://atom.example/foo"/><published>2026-11-01T10:00:00Z</published>' +
      '<summary>Short &lt;b&gt;summary&lt;/b&gt;</summary><category term="Funding"/></entry></feed>';
    expect(isFeed(xml)).toBe(true);
    expect(parseFeed(xml)).toEqual([
      { title: "Foo raises $3M seed", link: "https://atom.example/foo", date: "2026-11-01", description: "Short summary", categories: ["Funding"] },
    ]);
  });

  test("HTML (a challenge or error page) is not a feed", () => {
    expect(isFeed("<!DOCTYPE html><html><body>Just a moment...</body></html>")).toBe(false);
    expect(isFeed("<html lang=en><head>")).toBe(false);
  });

  test("non-http links are dropped", () => {
    expect(parseFeed("<rss><item><title>X raises $1M</title><link>javascript:alert(1)</link></item></rss>")[0].link).toBeNull();
  });
});

describe("robots.txt", () => {
  const txt = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /*?*",
    "Disallow: /wp-admin/",
    "",
    "User-agent: ClaudeBot",
    "Disallow: /",
  ].join("\n");

  test("the * group applies to our UA; longest match wins", () => {
    const rules = robotsRules(txt);
    expect(robotsAllows(rules, "/buzz/feed/")).toBe(true);
    expect(robotsAllows(rules, "/buzz/feed/?s=x")).toBe(false);
    expect(robotsAllows(rules, "/wp-admin/x")).toBe(false);
  });

  test("a group naming our token overrides *", () => {
    const rules = robotsRules(txt + "\nUser-agent: ai-job-search-funding-news-cli\nDisallow: /buzz/\n");
    expect(robotsAllows(rules, "/buzz/feed/")).toBe(false);
    expect(robotsAllows(rules, "/rss")).toBe(true);
  });

  test("equal-length Allow/Disallow: Disallow wins (cautious)", () => {
    expect(robotsAllows(robotsRules("User-agent: *\nAllow: /a\nDisallow: /a"), "/a")).toBe(false);
  });

  test("$ anchors and empty Disallow", () => {
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow: /*.xml$"), "/feed.xml")).toBe(false);
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow: /*.xml$"), "/feed.xml/x")).toBe(true);
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });
});

describe("client-side filters", () => {
  const lead = (title: string, date: string | null, extra: Partial<Lead> = {}): Lead =>
    ({ title, date, snippet: null, categories: [], source: "Entrackr", company: null, ...extra }) as Lead;
  const leads = [lead("Fintech startup Foo raises $5M", "2026-11-10"), lead("Bar raises Rs 10 Cr", "2026-10-01", { snippet: "AI fintech" }), lead("Baz raises $1M", null)];
  const NOW = Date.parse("2026-11-11T12:00:00Z");

  test("every query word must match somewhere", () => {
    expect(applyFilters(leads, { query: "fintech" }, NOW).map((l) => l.title)).toEqual(["Fintech startup Foo raises $5M", "Bar raises Rs 10 Cr"]);
    expect(applyFilters(leads, { query: "AI fintech" }, NOW).map((l) => l.title)).toEqual(["Bar raises Rs 10 Cr"]);
  });

  test("--days drops older and undated items", () => {
    expect(applyFilters(leads, { days: 7 }, NOW).map((l) => l.title)).toEqual(["Fintech startup Foo raises $5M"]);
  });
});

describe("detail", () => {
  test("validUrl", () => {
    expect(validUrl("https://entrackr.com/news/x")?.hostname).toBe("entrackr.com");
    expect(validUrl("file:///etc/passwd")).toBeNull();
    expect(validUrl("https://u:p@x.example/")).toBeNull();
  });

  test("buildDetail on the recorded Entrackr article", async () => {
    const html = await Bun.file(join(import.meta.dir, "fixtures/article-entrackr.html")).text();
    expect(publishedDate(html)).toBe("2026-11-05");
    const d = buildDetail("https://entrackr.com/snippets/x", { html, via: "fetch_page.py", status: 200 }, 20000);
    expect(d).toMatchObject({
      title: "Spacetech startup Cosmoserve Space raises $6 Mn in seed round",
      company: "Cosmoserve Space",
      amount: "$6 Mn",
      round: "Seed",
      looks_like_funding: true,
      posted_date: "2026-11-05",
      site: "Entrackr",
      truncated: false,
    });
    expect(d.description).toContain("Founded last year by Chiranjeevi Phanindra");
    expect(d.description).not.toMatch(/<\w|Follow Us|facebook/);
  });
});
