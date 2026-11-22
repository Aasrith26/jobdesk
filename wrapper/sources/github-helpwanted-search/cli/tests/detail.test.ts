import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { runDetail } from "../src/commands/detail";
import { capture, freshStateDir } from "./helpers";

// Offline: the recorded issue (full+json), repo and README (html) responses.

const fx = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const issue = await fx("issue-full.json");
const repo = await fx("repo.json");
const readme = await fx("readme.html");

const originalFetch = globalThis.fetch;
let accepts: string[] = [];

beforeEach(() => {
  freshStateDir();
  accepts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    accepts.push((init?.headers as Record<string, string>).Accept);
    if (url.endsWith("/repos/patsypppe/meridian/issues/31")) return new Response(issue);
    if (url.endsWith("/repos/patsypppe/meridian")) return new Response(repo);
    if (url.endsWith("/repos/langfuse/langfuse")) {
      return new Response(JSON.stringify({ full_name: "langfuse/langfuse", html_url: "https://github.com/langfuse/langfuse", stargazers_count: 37280, owner: { login: "langfuse", type: "Organization" } }));
    }
    if (url.endsWith("/repos/langfuse/langfuse/readme")) return new Response(readme);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runDetail (offline)", () => {
  test("issue: cleaned body text, labels, stars", async () => {
    const { code, out } = await capture(() => runDetail({ url: "https://github.com/patsypppe/meridian/issues/31", format: "json" }));
    expect(code).toBe(0);
    const d = JSON.parse(out);
    expect(d).toMatchObject({
      id: "patsypppe/meridian#31",
      kind: "lead",
      title: "Support Python 3.14",
      company: "patsypppe",
      url: "https://github.com/patsypppe/meridian/issues/31",
      repo_stars: 2,
      state: "open",
    });
    expect(d.labels).toContain("help wanted");
    expect(d.description).toContain('requires-python = ">=3.12,<3.14"');
    expect(d.description).not.toMatch(/<code|&gt;|&lt;/);
    expect(accepts[0]).toBe("application/vnd.github.full+json");
  });

  test("repo: README hiring excerpt with the careers link expanded", async () => {
    const { code, out } = await capture(() => runDetail({ url: "https://github.com/langfuse/langfuse", format: "json" }));
    expect(code).toBe(0);
    const d = JSON.parse(out);
    expect(d.company).toBe("langfuse");
    expect(d.repo_stars).toBe(37280);
    expect(d.hiring_excerpt.join("\n")).toContain("We're hiring");
    expect(d.links[0]).toStartWith("https://langfuse.com/careers");
    expect(d.description).not.toContain("<svg");
    expect(accepts).toContain("application/vnd.github.html+json");
  });

  test("plain format", async () => {
    const { out } = await capture(() => runDetail({ url: "patsypppe/meridian#31", format: "plain" }));
    expect(out).toStartWith("Support Python 3.14\npatsypppe/meridian · ★2");
    expect(out).toContain("URL: https://github.com/patsypppe/meridian/issues/31");
  });

  test("missing issue -> NOT_FOUND JSON on stderr", async () => {
    const { code, out, err } = await capture(() => runDetail({ url: "a/b#1", format: "json" }));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(JSON.parse(err).code).toBe("NOT_FOUND");
  });
});
