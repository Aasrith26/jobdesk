import { describe, expect, test } from "bun:test";
import { classifyIssue, htmlToText, markdownToText, repoFromApiUrl, sinceDate } from "../src/helpers";
import { buildIssueQueries, buildRepoQuery, issueToLead, repoToLead, type SearchOpts } from "../src/commands/search";
import { parseTarget } from "../src/commands/detail";

const base: SearchOpts = { mode: "issues", days: 30, noStars: false, page: 1, limit: 25, format: "json" };
const NOW = Date.parse("2026-11-11T12:00:00Z");

describe("query building", () => {
  test("issues mode builds a label query and a keyword OR query", () => {
    const [a, b] = buildIssueQueries({ ...base, query: "python" }, NOW);
    expect(a).toBe('python is:issue is:open archived:false label:"help wanted" updated:>=2026-10-12');
    expect(b).toBe("python is:issue is:open archived:false (hiring OR paid OR bounty OR contract) updated:>=2026-10-12");
  });

  test("--language and --days are honoured", () => {
    const [a] = buildIssueQueries({ ...base, query: "llm", language: "TypeScript", days: 7 }, NOW);
    expect(a).toContain('llm language:"TypeScript" is:issue');
    expect(a).toContain("updated:>=2026-11-04");
  });

  test("repos mode searches READMEs, pushed recently, with optional stars", () => {
    expect(buildRepoQuery({ ...base, mode: "repos", query: "rust", minStars: 50 }, NOW)).toBe(
      `rust "we're hiring" in:readme archived:false pushed:>=2026-10-12 stars:>=50`,
    );
  });

  test("sinceDate is UTC days back", () => {
    expect(sinceDate(1, NOW)).toBe("2026-11-10");
  });
});

describe("classifyIssue", () => {
  test("help wanted label", () => {
    expect(classifyIssue("Support 3.14", ["enhancement", "help wanted"], "").reasons).toEqual(["label:help wanted"]);
  });

  test("bounty label and title", () => {
    const m = classifyIssue("[Bounty $200] Add streaming", ["💎 Bounty"], "");
    expect(m.matched).toBe(true);
    expect(m.reasons).toContain("label:💎 Bounty");
    expect(m.reasons).toContain("title:bounty");
  });

  test("body needs a lead-shaped phrase, not a bare word", () => {
    expect(classifyIssue("Refactor", [], "Keep the API contract stable; paid plans are unaffected.").matched).toBe(false);
    expect(classifyIssue("Refactor", [], "This is a paid task, $300 on merge.").reasons).toEqual(["body:this is a paid"]);
    expect(classifyIssue("Refactor", [], "/bounty $150").matched).toBe(true);
    expect(classifyIssue("Refactor", [], "We're hiring a Rust engineer to own this.").matched).toBe(true);
  });

  test("a phrase inside an HTML comment does not count", () => {
    expect(classifyIssue("Refactor", [], "<!-- this is a paid task -->Nothing here").matched).toBe(false);
  });
});

describe("lead shaping", () => {
  test("issueToLead carries the contract fields", () => {
    const l = issueToLead(
      {
        html_url: "https://github.com/acme/tool/issues/5",
        repository_url: "https://api.github.com/repos/acme/tool",
        number: 5,
        title: " Fix it ",
        labels: [{ name: "help wanted" }],
        user: { login: "u" },
        created_at: "2026-11-01T01:00:00Z",
        updated_at: "2026-11-02T01:00:00Z",
        body: "## Context\nDo **the** thing",
      },
      ["label:help wanted"],
    )!;
    expect(l).toMatchObject({
      id: "acme/tool#5",
      title: "Fix it",
      company: "acme",
      url: "https://github.com/acme/tool/issues/5",
      posted_date: "2026-11-01",
      date: "2026-11-01",
      updated_date: "2026-11-02",
      kind: "lead",
      lead_type: "github_issue",
      repo_stars: null,
      labels: ["help wanted"],
    });
    expect(l.snippet).toBe("Context Do the thing");
    expect(l.location).toBeNull();
  });

  test("pull requests are not leads", () => {
    expect(
      issueToLead(
        { html_url: "https://github.com/a/b/pull/1", repository_url: "https://api.github.com/repos/a/b", number: 1, title: "x", pull_request: {} },
        [],
      ),
    ).toBeNull();
  });

  test("repoToLead: owner is the company, no invented date", () => {
    const l = repoToLead({
      full_name: "acme/app",
      html_url: "https://github.com/acme/app",
      stargazers_count: 9,
      owner: { login: "acme", type: "Organization" },
      homepage: "https://acme.example",
    })!;
    expect(l.title).toBe("acme is hiring (README of acme/app)");
    expect(l.company).toBe("acme");
    expect(l.posted_date).toBeNull();
    expect(l.repo_stars).toBe(9);
    expect(l.apply_url).toBe("https://acme.example");
  });

  test("repoFromApiUrl", () => {
    expect(repoFromApiUrl("https://api.github.com/repos/o/r")).toBe("o/r");
    expect(repoFromApiUrl("https://evil.example/repos/o/r")).toBeNull();
  });
});

describe("text", () => {
  test("markdownToText drops comments, code fences and images", () => {
    expect(markdownToText("<!-- hidden -->Hi ![img](x.png)\n```\ncode\n```\n[link](https://x.example)")).toBe(
      "Hi\n\nlink (https://x.example)",
    );
  });

  test("htmlToText expands links with their label", () => {
    expect(htmlToText('<p>See <a href="https://acme.example/jobs">open roles</a></p>')).toBe("See open roles (https://acme.example/jobs)");
  });
});

describe("detail parseTarget", () => {
  test("issue URLs and short form", () => {
    expect(parseTarget("https://github.com/a-b/c.d/issues/12")).toEqual({ kind: "issue", owner: "a-b", repo: "c.d", number: 12 });
    expect(parseTarget("github.com/a/b/issues/3")).toEqual({ kind: "issue", owner: "a", repo: "b", number: 3 });
    expect(parseTarget("a/b#9")).toEqual({ kind: "issue", owner: "a", repo: "b", number: 9 });
  });

  test("repo URLs", () => {
    expect(parseTarget("https://github.com/langfuse/langfuse")).toEqual({ kind: "repo", owner: "langfuse", repo: "langfuse" });
  });

  test("rejects other hosts, look-alikes, PRs and junk", () => {
    expect(parseTarget("https://github.com.evil.io/a/b/issues/1")).toBeNull();
    expect(parseTarget("https://github.com@evil.io/a/b/issues/1")).toBeNull();
    expect(parseTarget("https://api.github.com/repos/a/b/issues/1")).toBeNull();
    expect(parseTarget("https://github.com/a/b/pull/1")).toBeNull();
    expect(parseTarget("hello")).toBeNull();
  });
});
