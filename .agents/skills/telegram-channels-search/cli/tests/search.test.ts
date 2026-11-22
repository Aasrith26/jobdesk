import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runSearch, type SearchOpts } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { resetRateLimit, setRobotsChecker } from "../src/helpers";

// Offline: fetch is stubbed to serve the recorded fixtures, the robots gate is
// stubbed, and timers fire immediately, so these tests pin parsing + filtering
// + paging + the robots gate without the network.

const preview = await Bun.file(join(import.meta.dir, "fixtures/channel-preview.html")).text();
const embed = await Bun.file(join(import.meta.dir, "fixtures/message-embed.html")).text();

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalWrite = process.stdout.write;
const originalErr = process.stderr.write;
let urls: string[] = [];
let robotsAsked: string[] = [];

function stub(robots: (url: string) => boolean = () => true) {
  urls = [];
  robotsAsked = [];
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
  setRobotsChecker((url) => {
    robotsAsked.push(url);
    const ok = robots(url);
    return { allowed: ok, message: ok ? "ALLOWED - stub" : "DISALLOWED for * - stub" };
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url === "https://t.me/s/opento_dev") return new Response(preview);
    if (url === "https://t.me/opento_dev/1182?embed=1") return new Response(embed);
    if (url === "https://t.me/s/someperson") return new Response('<html><div class="tgme_page_title">Someone</div></html>');
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErr;
  }
}

function run(partial: Partial<SearchOpts>) {
  return capture(() =>
    runSearch({ channels: ["opento_dev"], remote: false, indiaFriendly: false, page: 1, limit: 25, format: "json", ...partial }),
  );
}

beforeEach(() => resetRateLimit());
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  process.stdout.write = originalWrite;
  process.stderr.write = originalErr;
  setRobotsChecker(null);
});

describe("runSearch (offline)", () => {
  test("returns every text message, newest first, with the contract shape", async () => {
    stub();
    const { code, out } = await run({});
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.meta.count).toBe(7);
    expect(data.meta.total).toBe(7);
    expect(data.meta.channels).toEqual([{ channel: "opento_dev", url: "https://t.me/s/opento_dev", status: "ok", messages: 7 }]);
    expect(data.results[0].id).toBe("opento_dev/1353");
    expect(data.results.map((r: { date: string }) => r.date)).toEqual([...data.results.map((r: { date: string }) => r.date)].sort().reverse());
    for (const r of data.results) {
      expect(r.kind).toBe("lead");
      expect(typeof r.title).toBe("string");
      expect(typeof r.company).toBe("string");
      expect(r.url).toMatch(/^https:\/\/t\.me\//);
      expect(r.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // robots was consulted before the one request
    expect(robotsAsked).toEqual(["https://t.me/s/opento_dev"]);
    expect(urls).toEqual(["https://t.me/s/opento_dev"]);
  });

  test("-q filters client-side on title + text, all words must match", async () => {
    stub();
    const data = JSON.parse((await run({ query: "python" })).out);
    expect(data.results.map((r: { id: string }) => r.id)).toEqual(["opento_dev/1353", "opento_dev/1346", "opento_dev/1338"]);
    const two = JSON.parse((await run({ query: "backend worldwide" })).out);
    expect(two.results.map((r: { id: string }) => r.id)).toEqual(["opento_dev/1338"]);
    const none = JSON.parse((await run({ query: "cobol mainframe" })).out);
    expect(none.meta.total).toBe(0);
  });

  test("--remote and --india-friendly filter on the parsed fields", async () => {
    stub();
    const remote = JSON.parse((await run({ remote: true })).out);
    expect(remote.results.map((r: { id: string }) => r.id).sort()).toEqual(["opento_dev/1338", "opento_dev/1353"]);
    const india = JSON.parse((await run({ indiaFriendly: true })).out);
    expect(india.results.every((r: { india_friendly: boolean }) => r.india_friendly)).toBe(true);
  });

  test("--jobage drops older messages", async () => {
    stub();
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-11-11T12:00:00Z");
    try {
      const data = JSON.parse((await run({ jobage: 3 })).out);
      expect(data.results.map((r: { id: string }) => r.id)).toEqual(["opento_dev/1353"]);
    } finally {
      Date.now = realNow;
    }
  });

  test("paging slices the filtered list", async () => {
    stub();
    const p2 = JSON.parse((await run({ limit: 3, page: 2 })).out);
    expect(p2.meta.count).toBe(3);
    expect(p2.meta.total).toBe(7);
    expect(p2.results[0].id).toBe("opento_dev/1344");
  });

  test("table and plain formats render", async () => {
    stub();
    const t = await run({ format: "table", limit: 2 });
    expect(t.out).toContain("COMPANY");
    expect(t.out).toContain("Founding AI Product Engineer");
    const p = await run({ format: "plain", limit: 1 });
    expect(p.out).toContain("https://t.me/opento_dev/1353");
  });

  test("a robots-disallowed channel is skipped without a request; all disallowed is an error", async () => {
    stub(() => false);
    const r = await run({});
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(JSON.parse(r.err).code).toBe("ROBOTS_DISALLOWED");
    expect(urls).toEqual([]);
  });

  test("mixed channels: unreadable ones are reported in meta, readable ones still return", async () => {
    stub((u) => !u.includes("blockedchan"));
    const { code, out } = await run({ channels: ["opento_dev", "blockedchan", "someperson", "missingchan"] });
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.meta.channels.map((c: { status: string }) => c.status)).toEqual(["ok", "robots_disallowed", "not_public", "not_found"]);
    expect(data.meta.total).toBe(7);
    expect(urls).not.toContain("https://t.me/s/blockedchan");
  });

  test("no readable channel at all is SEARCH_FAILED", async () => {
    stub();
    const r = await run({ channels: ["missingchan"] });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).code).toBe("SEARCH_FAILED");
  });
});

describe("runDetail (offline)", () => {
  test("fetches the ?embed=1 page and returns the cleaned text", async () => {
    stub();
    const r = await capture(() => runDetail({ id: "https://t.me/opento_dev/1182", format: "json" }));
    expect(r.code).toBe(0);
    const job = JSON.parse(r.out);
    expect(urls).toEqual(["https://t.me/opento_dev/1182?embed=1"]);
    expect(job.id).toBe("opento_dev/1182");
    expect(job.url).toBe("https://t.me/opento_dev/1182");
    expect(job.date).toBe("2026-07-01");
    expect(job.description).toContain("Senior Devops Engineer / TaxDome");
    expect(job.links.length).toBeGreaterThan(3);
    expect("snippet" in job).toBe(false);
  });

  test("plain format", async () => {
    stub();
    const r = await capture(() => runDetail({ id: "opento_dev/1182", format: "plain" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("URL: https://t.me/opento_dev/1182");
  });

  test("missing post is NOT_FOUND; robots refusal is ROBOTS_DISALLOWED", async () => {
    stub();
    const nf = await capture(() => runDetail({ id: "opento_dev/99", format: "json" }));
    expect(nf.code).toBe(1);
    expect(JSON.parse(nf.err).code).toBe("NOT_FOUND");
    stub(() => false);
    const rb = await capture(() => runDetail({ id: "opento_dev/1182", format: "json" }));
    expect(rb.code).toBe(1);
    expect(JSON.parse(rb.err).code).toBe("ROBOTS_DISALLOWED");
    expect(urls).toEqual([]);
  });
});
