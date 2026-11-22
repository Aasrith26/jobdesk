import { describe, expect, test } from "bun:test";
import {
  buildJobPost,
  decodeHtmlEntities,
  htmlToText,
  indiaFriendly,
  isHiringThreadTitle,
  isNonJobPost,
  parseHeader,
  splitComment,
} from "../src/helpers";
import { normalizeId } from "../src/commands/detail";

describe("parseHeader", () => {
  test("classic pipe header", () => {
    const p = parseHeader("Seal (YC S20) | Forward Deployed Engineer | London | ONSITE | Full-time | £50k–£120k + equity");
    expect(p.company).toBe("Seal (YC S20)");
    expect(p.title).toBe("Forward Deployed Engineer");
    expect(p.location).toBe("London");
    expect(p.remote).toBe(false);
    expect(p.work_mode).toEqual(["onsite"]);
    expect(p.salary).toBe("£50k–£120k + equity");
    expect(p.employment_type).toBe("full-time");
  });

  test("remote with region keeps the region in location", () => {
    const p = parseHeader("Thankly | Founding Engineer | REMOTE (US) | Full-time | Equity-first");
    expect(p.company).toBe("Thankly");
    expect(p.title).toBe("Founding Engineer");
    expect(p.location).toBe("REMOTE (US)");
    expect(p.remote).toBe(true);
  });

  test("bare REMOTE becomes location 'Remote'", () => {
    const p = parseHeader("Kaida | Remote | https://kaida.example/");
    expect(p.company).toBe("Kaida");
    expect(p.title).toBeNull();
    expect(p.location).toBe("Remote");
  });

  test("location-first header recovers the company from a short field", () => {
    const p = parseHeader("Cologne, Germany | UMH | Product Engineer | Full-time | 70k - 100k EUR | ONSITE (part remote)");
    expect(p.company).toBe("UMH");
    expect(p.title).toBe("Product Engineer");
    expect(p.location).toContain("Cologne, Germany");
  });

  test("company with an inline URL is cleaned", () => {
    const p = parseHeader("Curiosity ( https://curiosity.example ) | DevOps Architect | Toulouse, France | ONSITE");
    expect(p.company).toBe("Curiosity");
  });

  test("a URL field next to text is not taken as the title", () => {
    const p = parseHeader("Estuary | US-Based / Remote | Full-time – https://estuary.dev/");
    expect(p.title).toBeNull();
    expect(p.location).toBe("US-Based / Remote");
  });

  test("role-first dash header without a company", () => {
    const p = parseHeader("*Software Engineer — Remote — US Only* - US Work Authorization Required");
    expect(p.company).toBeNull();
    expect(p.title).toBe("Software Engineer");
  });

  test("prose first line keeps fields null", () => {
    const p = parseHeader(
      "We are hiring for several roles at a small studio that builds learning videos for kids and the tooling to make them faster",
    );
    expect(p.company).toBeNull();
    expect(p.title).toBeNull();
    expect(p.location).toBeNull();
  });

  test("title recovered from the next line", () => {
    const p = parseHeader("Taxnova | London | Hybrid", "Founding product engineer");
    expect(p.title).toBe("Founding product engineer");
  });

  test("'no remote' is not remote", () => {
    expect(parseHeader("Foo | Engineer | Berlin | ONSITE, no remote").remote).toBe(false);
  });
});

describe("indiaFriendly", () => {
  test("explicit India / Indian city / APAC", () => {
    expect(indiaFriendly("X | Engineer | REMOTE (US/Canada/UK/India)").india_reason).toBe("explicit");
    expect(indiaFriendly("X | Engineer | Hyderabad | ONSITE").india_friendly).toBe(true);
    expect(indiaFriendly("X | SF Bay, Toronto, APAC, Remote").india_reason).toBe("explicit");
  });

  test("West Asia and negated India are not explicit", () => {
    expect(indiaFriendly("X | Engineer | REMOTE (Europe, Africa, W Asia)").india_friendly).toBe(false);
    expect(indiaFriendly("X | Engineer | Remote (anywhere except India)").india_reason).not.toBe("explicit");
  });

  test("worldwide / anywhere / Remote (Global)", () => {
    expect(indiaFriendly("X | Lead | REMOTE (Worldwide)").india_reason).toBe("global");
    expect(indiaFriendly("X | REMOTE, ALMOST ANYWHERE").india_reason).toBe("global");
    expect(indiaFriendly("X | Engineers | 100% Remote (Global)").india_reason).toBe("global");
    expect(indiaFriendly("X | DevOps | REMOTE (worldwide, any timezone)").india_reason).toBe("global");
  });

  test("global with an hours requirement carries a note", () => {
    expect(indiaFriendly("X | PM | REMOTE (anywhere, EST hours)").india_reason).toBe(
      "global; timezone/hours requirement in header",
    );
  });

  test("'Worldwide:' followed by a region list that leaves India out is not global", () => {
    expect(indiaFriendly("X | REMOTE (Worldwide: US / Canada / Europe / UK / LATAM)").india_friendly).toBe(false);
  });

  test("'Global' in a job title does not count", () => {
    expect(indiaFriendly("X | Head of Global GTM | NYC | ONSITE").india_friendly).toBe(false);
  });

  test("region-restricted remote is not India-friendly", () => {
    for (const h of [
      "X | Engineer | REMOTE (US)",
      "X | Engineer | Remote (EU time zone)",
      "X | Engineer | Remote, US only",
      "X | Engineer | Chicago, IL / Remote",
      "X | CTO | Detroit preferred; remote considered",
    ]) {
      expect(indiaFriendly(h).india_friendly).toBe(false);
    }
  });

  test("bare remote is the weakest tier, unless the body restricts it", () => {
    expect(indiaFriendly("X | Engineer | Remote | Full-time", "Async team.").india_reason).toBe("remote-unrestricted");
    expect(indiaFriendly("X | Engineer | Remote", "Must be located in the United States.").india_friendly).toBe(false);
    expect(indiaFriendly("X | Engineer | Remote", "We hire US-based engineers.").india_friendly).toBe(false);
    expect(indiaFriendly("X | Engineer | Remote", "Overlap with EU time zones required.").india_friendly).toBe(false);
  });

  test("onsite outside India is not India-friendly", () => {
    expect(indiaFriendly("X | Engineer | London | ONSITE").india_friendly).toBe(false);
  });
});

describe("comment text", () => {
  test("entities decode in one pass", () => {
    expect(decodeHtmlEntities("a &amp;lt; b &#x2F; c &#x27;d&#x27; &quot;e&quot;")).toBe("a &lt; b / c 'd' \"e\"");
  });

  test("htmlToText keeps paragraphs and expands truncated links", () => {
    const t = htmlToText('Hello<p>See <a href="https:&#x2F;&#x2F;x.example&#x2F;a&#x2F;very&#x2F;long">https:&#x2F;&#x2F;x.example&#x2F;a...</a> now');
    expect(t).toBe("Hello\n\nSee https://x.example/a/very/long now");
  });

  test("splitComment: first line is the header", () => {
    const s = splitComment("A | B | C<p>Body text");
    expect(s.header).toBe("A | B | C");
    expect(s.body).toBe("Body text");
  });

  test("splitComment: one-field-per-line header is joined", () => {
    const s = splitComment("DevOps Engineer\nHybrid\nHong Kong\nFull-time<p>Body");
    expect(s.header).toBe("DevOps Engineer | Hybrid | Hong Kong | Full-time");
    expect(s.body).toBe("Body");
  });

  test("non-job posts are recognized", () => {
    expect(isNonJobPost("India")).toBe(true);
    expect(isNonJobPost("Location: Pune\nRemote: Yes\nWilling to relocate: No\nTechnologies: Python, Go, Rust")).toBe(true);
    expect(isNonJobPost("I'm Jane, a full-stack engineer with five years of experience building web apps.")).toBe(true);
    expect(isNonJobPost("Acme | Engineer | Remote | Full-time. We build databases for everyone.")).toBe(false);
  });

  test("buildJobPost assembles the contract fields with nulls kept", () => {
    const p = buildJobPost("123", 'Acme | Remote<p>Body <a href="https:&#x2F;&#x2F;acme.example">x</a>', {});
    expect(p.url).toBe("https://news.ycombinator.com/item?id=123");
    expect(p.apply_url).toBe("https://acme.example");
    expect(p.header).toBe("Acme | Remote");
    for (const k of ["title", "date", "salary", "author", "thread_id", "thread_title"]) {
      expect(k in p).toBe(true);
      expect((p as unknown as Record<string, unknown>)[k]).toBeNull();
    }
  });

  test("hiring thread titles", () => {
    expect(isHiringThreadTitle("Ask HN: Who is hiring? (November 2026)")).toBe(true);
    expect(isHiringThreadTitle("Ask HN: Who wants to be hired? (November 2026)")).toBe(false);
    expect(isHiringThreadTitle("Ask HN: Freelancer? Seeking freelancer? (November 2026)")).toBe(false);
  });
});

describe("detail normalizeId", () => {
  test("accepts ids and HN item URLs", () => {
    expect(normalizeId("50425675")).toBe("50425675");
    expect(normalizeId("https://news.ycombinator.com/item?id=50425675")).toBe("50425675");
    expect(normalizeId("news.ycombinator.com/item?id=42")).toBe("42");
  });

  test("rejects other hosts and look-alikes", () => {
    expect(normalizeId("https://jobs.example.com/item?id=5")).toBeNull();
    expect(normalizeId("https://news.ycombinator.com.evil.io/item?id=5")).toBeNull();
    expect(normalizeId("https://news.ycombinator.com@evil.io/item?id=5")).toBeNull();
    expect(normalizeId("https://news.ycombinator.com/user?id=5")).toBeNull();
    expect(normalizeId("abc")).toBeNull();
  });
});
