import { describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";

// Opt-in live smoke test against the real t.me preview (2 page requests plus
// the robots checks). CI makes no live portal requests, so it only runs when
// TELEGRAM_LIVE_CHANNEL names a public channel to read, e.g.
//   TELEGRAM_LIVE_CHANNEL=opento_dev bun test tests/live.test.ts

const channel = process.env.TELEGRAM_LIVE_CHANNEL;
const live = channel ? describe : describe.skip;

interface SearchOut {
  meta: { count: number; channels: { channel: string; status: string }[] };
  results: { id: string; title: string; company: string; url: string; posted_date: string | null }[];
}

live("live smoke", () => {
  let firstUrl = "";

  test("search returns >=1 message from the channel preview", async () => {
    const data = parseJSON<SearchOut>(await runCLI(["search", "-c", channel!, "--limit", "3"]));
    expect(data.meta.channels[0].status).toBe("ok");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    for (const r of data.results) {
      expect(r.url).toMatch(/^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/);
      expect(r.title.length).toBeGreaterThan(0);
    }
    firstUrl = data.results[0].url;
  });

  test("detail returns the message text", async () => {
    expect(firstUrl).not.toBe("");
    const job = parseJSON<{ url: string; description: string }>(await runCLI(["detail", firstUrl]));
    expect(job.url).toBe(firstUrl);
    expect(job.description.length).toBeGreaterThan(10);
    expect(job.description).not.toMatch(/<br|&amp;/);
  });
});
