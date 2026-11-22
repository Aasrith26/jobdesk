import { afterEach, describe, expect, test } from "bun:test";
import { parseDetailRef, runDetail } from "../src/commands/detail";
import { capture, fixtureCompanies, restoreFetch, stubFetch } from "./stub";

afterEach(restoreFetch);

describe("parseDetailRef", () => {
  test("accepts the <ats>:<token>:<id> form search emits", () => {
    expect(parseDetailRef("ashby:sarvam:36f89b00-2010-4d23-aae3-17a2f53d9eaa")).toEqual({
      ats: "ashby", token: "sarvam", id: "36f89b00-2010-4d23-aae3-17a2f53d9eaa",
    });
    expect(parseDetailRef("SmartRecruiters:Freshworks:744000158477994")?.ats).toBe("smartrecruiters");
  });

  test("accepts posting URLs on every supported ATS host", () => {
    const cases: Array<[string, string, string, string]> = [
      ["https://job-boards.greenhouse.io/observeai/jobs/5432596008", "greenhouse", "observeai", "5432596008"],
      ["https://boards.greenhouse.io/observeai/jobs/5432596008?gh_src=x", "greenhouse", "observeai", "5432596008"],
      ["https://job-boards.eu.greenhouse.io/speechmatics/jobs/5013246101", "greenhouse", "speechmatics", "5013246101"],
      ["https://boards.greenhouse.io/embed/job_app?for=stripe&token=123", "greenhouse", "stripe", "123"],
      ["https://boards-api.greenhouse.io/v1/boards/stripe/jobs/123", "greenhouse", "stripe", "123"],
      ["https://jobs.lever.co/cred/aa98a938-af3a-45f5-851d-966b2b5bad33/apply", "lever", "cred", "aa98a938-af3a-45f5-851d-966b2b5bad33"],
      ["jobs.lever.co/cred/abc-123", "lever", "cred", "abc-123"],
      ["https://jobs.ashbyhq.com/sarvam/36f89b00-2010-4d23-aae3-17a2f53d9eaa/application", "ashby", "sarvam", "36f89b00-2010-4d23-aae3-17a2f53d9eaa"],
      ["https://jobs.smartrecruiters.com/Freshworks/744000158477994-senior-engineering-manager", "smartrecruiters", "Freshworks", "744000158477994"],
      ["https://apply.workable.com/huggingface/j/9E2A4C02C7/", "workable", "huggingface", "9E2A4C02C7"],
    ];
    for (const [input, ats, token, id] of cases) expect(parseDetailRef(input)).toEqual({ ats: ats as any, token, id });
  });

  test("rejects other hosts, look-alikes, userinfo tricks, and unknown ATSes", () => {
    for (const bad of [
      "https://example.com/jobs/1",
      "https://jobs.lever.co.evil.io/cred/abc",
      "https://jobs.lever.co@evil.io/cred/abc",
      "https://user@jobs.lever.co/cred/abc",
      "https://www.observe.ai/position?gh_jid=5432596008",
      "https://apply.workable.com/j/9E2A4C02C7",
      "bamboo:acme:1",
      "ashby:../etc:1",
      "",
    ]) {
      expect(parseDetailRef(bad)).toBeNull();
    }
  });
});

describe("runDetail (offline)", () => {
  test("greenhouse detail reads the single-posting endpoint and renders plain text", async () => {
    const log = stubFetch({
      "https://boards-api.greenhouse.io/v1/boards/examplevoice/jobs/5001": () =>
        new Response(JSON.stringify({ id: 5001, title: "AI Agent Engineer", location: { name: "Bengaluru" }, content: "&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;" })),
    });
    const { code, stdout } = await capture(() =>
      runDetail({ ref: "greenhouse:examplevoice:5001", companies: fixtureCompanies(), format: "plain" }),
    );
    expect(code).toBe(0);
    expect(log.urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/examplevoice/jobs/5001"]);
    expect(stdout).toContain("AI Agent Engineer\nExample Voice · Bengaluru");
    expect(stdout).toContain("Hello & welcome");
    expect(stdout).toContain("ID: greenhouse:examplevoice:5001");
  });

  test("json detail carries the contract fields plus description and applyUrl", async () => {
    stubFetch();
    const { code, stdout } = await capture(() =>
      runDetail({ ref: "https://jobs.ashbyhq.com/exampleashby/11111111-aaaa-bbbb-cccc-000000000001", companies: fixtureCompanies(), format: "json" }),
    );
    expect(code).toBe(0);
    const job = JSON.parse(stdout);
    expect(job).toMatchObject({ company: "Example Ashby", title: "Inference Engineer", description: "Run vLLM at scale." });
    expect(job.applyUrl).toContain("/application");
  });

  test("a board not in companies.json still works, named by its token", async () => {
    stubFetch({
      "https://api.lever.co/v0/postings/othersite/abc?mode=json": () => new Response(JSON.stringify({ id: "abc", text: "Engineer" })),
    });
    const { code, stdout } = await capture(() => runDetail({ ref: "lever:othersite:abc", companies: [], format: "json" }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ company: "othersite", location: null, description: null });
  });

  test("a missing posting is NOT_FOUND on stderr, exit 1", async () => {
    stubFetch();
    const { code, stdout, stderr } = await capture(() =>
      runDetail({ ref: "lever:examplelever:nope", companies: fixtureCompanies(), format: "json" }),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr.trim()).code).toBe("NOT_FOUND");
  });
});
