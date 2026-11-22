import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  buildLead,
  companyOf,
  htmlToText,
  normalizeChannel,
  parseMessages,
  postingFields,
  stripInvisible,
  titleOf,
} from "../src/helpers";
import { normalizeId } from "../src/commands/detail";

// Fixtures are a real t.me/s/opento_dev page and one ?embed=1 page recorded on
// 2026-11-11, trimmed to 7 messages, with recruiter @handles, image CDN tokens
// and peer hashes replaced by placeholders (see fixtures/README.md).

const page = await Bun.file(join(import.meta.dir, "fixtures/channel-preview.html")).text();
const embed = await Bun.file(join(import.meta.dir, "fixtures/message-embed.html")).text();

describe("parseMessages (recorded channel preview)", () => {
  const msgs = parseMessages(page);

  test("finds every message block with channel, id and date", () => {
    expect(msgs.map((m) => m.id)).toEqual(["1338", "1341", "1342", "1344", "1346", "1347", "1353"]);
    for (const m of msgs) {
      expect(m.channel).toBe("opento_dev");
      expect(m.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(m.html.length).toBeGreaterThan(0);
    }
    expect(msgs[0].datetime).toBe("2026-11-02T07:01:26+00:00");
  });

  test("flags forwarded messages", () => {
    expect(msgs.find((m) => m.id === "1344")!.forwarded).toBe(true);
    expect(msgs.find((m) => m.id === "1338")!.forwarded).toBe(false);
  });

  test("builds leads with the contract fields", () => {
    const leads = msgs.map((m) => stripInvisible(buildLead(m)!));
    const first = leads[0];
    expect(first).toMatchObject({
      id: "opento_dev/1338",
      kind: "lead",
      title: "Senior Backend Engineer / CVAT.ai",
      company: "@opento_dev",
      location: "Worldwide, Cyprus (Remote)",
      date: "2026-11-02",
      posted_date: "2026-11-02",
      url: "https://t.me/opento_dev/1338",
      remote: true,
      india_friendly: true,
      india_reason: "global",
      thread_id: "opento_dev",
    });
    for (const l of leads) {
      for (const k of ["id", "title", "company", "location", "date", "posted_date", "url", "apply_url", "remote", "header", "snippet", "kind"]) {
        expect(k in l).toBe(true);
      }
      expect(l.url).toMatch(/^https:\/\/t\.me\/opento_dev\/\d+$/);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.title.length).toBeLessThanOrEqual(120);
    }
  });

  test("hashtag-only first lines are skipped for the title", () => {
    const l = buildLead(msgs.find((m) => m.id === "1346")!)!;
    expect(l.title).toBe("Python Developer / Whitensnake");
    expect(l.location).toBe("European Union · B2B contract · Full-time");
    expect(l.employment_type).toContain("full-time");
  });

  test("link targets with Telegram's double-escaped & are decoded to a usable URL", () => {
    const l = buildLead(msgs.find((m) => m.id === "1341")!)!;
    expect(l.apply_url).toMatch(/^https:\/\/wantapply\.com\/android-team-lead-at-appercut\?utm_source=telegram&utm_medium=social/);
    expect(l.apply_url).not.toContain("&amp;");
    expect(l.salary).toBe("5000$");
  });

  test("no recruiter handle or CDN token survives in the fixture output", () => {
    const all = JSON.stringify(msgs.map((m) => buildLead(m)));
    expect(all).not.toMatch(/telesco\.pe/);
  });
});

describe("parseMessages (recorded ?embed=1 page)", () => {
  test("the single embedded post parses like a preview message", () => {
    const msgs = parseMessages(embed);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: "opento_dev", id: "1182", datetime: "2026-07-01T07:10:16+00:00" });
    const text = htmlToText(msgs[0].html);
    expect(text).toContain("Senior Devops Engineer / TaxDome (https://wantapply.com/senior-devops-engineer-at-taxdome)");
    expect(text).not.toMatch(/<[a-z]|&amp;|&#/);
    expect(buildLead(msgs[0])!.title).toBe("DevOps, Support");
  });

  test("a page with no message blocks yields nothing", () => {
    expect(parseMessages("<html><body><div class=\"tgme_page\">user profile</div></body></html>")).toEqual([]);
  });
});

describe("text helpers", () => {
  test("titleOf trims to 120 chars and strips decorative emoji and link targets", () => {
    expect(titleOf("#python #remote\n\u{1F4E3} Big hiring push (https://x.example/jobs) ⚡\nbody")).toBe("Big hiring push");
    const long = "A".repeat(200);
    const t = titleOf(long);
    expect(t.length).toBe(120);
    expect(t.endsWith("…")).toBe(true);
  });

  test("companyOf reads an explicit Company: line only", () => {
    expect(companyOf("ML Engineer\nCompany: Acme Robotics\nRemote")).toBe("Acme Robotics");
    expect(companyOf("ML Engineer\n• Компания: Пример\n")).toBe("Пример");
    expect(companyOf("ML Engineer / Acme\nRemote")).toBeNull();
  });

  test("a Company: line overrides the channel name", () => {
    const l = buildLead({ channel: "examplejobs", id: "9", html: "ML Engineer<br/>Company: Acme Robotics<br/>Location: Bengaluru, India", datetime: "2026-11-10T00:00:00+00:00", forwarded: false })!;
    expect(l.company).toBe("Acme Robotics");
    expect(l.location).toBe("Bengaluru, India");
    expect(l.india_reason).toBe("explicit");
  });

  test("postingFields: bare remote marker becomes location Remote; negated India does not count", () => {
    expect(postingFields("Go Developer\nRemote", "").location).toBe("Remote");
    expect(postingFields("Go Developer\nRemote (not India)", "").india_friendly).toBe(false);
  });

  test("a message without text yields no lead", () => {
    expect(buildLead({ channel: "examplejobs", id: "1", html: "", datetime: null, forwarded: false })).toBeNull();
  });
});

describe("normalizeChannel / normalizeId", () => {
  test("channel forms", () => {
    expect(normalizeChannel("@opento_dev")).toBe("opento_dev");
    expect(normalizeChannel("https://t.me/s/opento_dev")).toBe("opento_dev");
    expect(normalizeChannel("t.me/opento_dev/")).toBe("opento_dev");
    expect(normalizeChannel("abc")).toBeNull();
    expect(normalizeChannel("has space")).toBeNull();
    expect(normalizeChannel("https://evil.example/opento_dev")).toBeNull();
  });

  test("detail id forms", () => {
    expect(normalizeId("opento_dev/1338")).toEqual(["opento_dev", "1338"]);
    expect(normalizeId("https://t.me/opento_dev/1338")).toEqual(["opento_dev", "1338"]);
    expect(normalizeId("https://t.me/s/opento_dev/1338")).toEqual(["opento_dev", "1338"]);
    expect(normalizeId("t.me/opento_dev/1338?single")).toEqual(["opento_dev", "1338"]);
    expect(normalizeId("https://telegram.me/opento_dev/1338")).toEqual(["opento_dev", "1338"]);
    expect(normalizeId("https://t.me/c/1234567/5")).toBeNull();
    expect(normalizeId("https://user@t.me/opento_dev/1")).toBeNull();
    expect(normalizeId("https://t.me.evil.example/opento_dev/1")).toBeNull();
    expect(normalizeId("https://t.me/opento_dev")).toBeNull();
  });
});
