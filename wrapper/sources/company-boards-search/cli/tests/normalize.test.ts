import { afterEach, describe, expect, test } from "bun:test";
import { fetchBoard, fetchPosting, normalizeGreenhouse, toDetail, type Job } from "../src/ats";
import { fixtureCompanies, restoreFetch, stubFetch } from "./stub";

const CONTRACT_FIELDS = [
  "id", "title", "company", "location", "date", "url", "ats", "token", "department", "team",
  "remote", "workplaceType", "employmentType", "updated", "compensation", "tags",
];

afterEach(restoreFetch);

const companies = fixtureCompanies();
const byAts = (ats: string) => companies.find((c) => c.ats === ats)!;

function expectContract(job: Job) {
  for (const f of CONTRACT_FIELDS) expect(Object.prototype.hasOwnProperty.call(job, f)).toBe(true);
  expect(job.id.split(":")).toHaveLength(3);
}

describe("normalizers (fixture boards)", () => {
  test("greenhouse: entity-encoded content, trimmed fields, offices in the location haystack", async () => {
    stubFetch();
    const { postings } = await fetchBoard(byAts("greenhouse"));
    expect(postings).toHaveLength(2);
    const [a, b] = postings;
    expectContract(a.job);
    expect(a.job).toMatchObject({
      id: "greenhouse:examplevoice:5001",
      title: "AI Agent Engineer",
      company: "Example Voice",
      location: "Bengaluru",
      date: "2026-09-23",
      updated: "2026-11-08",
      department: "AI Solutions",
      remote: null,
      workplaceType: null,
      url: "https://www.example-voice.ai/position?gh_jid=5001",
    });
    expect(a.locations).toContain("Bengaluru, Karnataka, India");
    // Decoded exactly once: "&amp;amp;" in the payload is a literal "&" in the posting.
    expect(toDetail(a).description).toBe("About voice agents & telephony\n- Build STT/LLM/TTS pipelines\n- Own WebRTC");
    // null first_published falls back to updated_at; "Location Type: Remote" metadata wins.
    expect(b.job).toMatchObject({ date: "2026-10-01", remote: true, workplaceType: "remote" });
  });

  test("lever: categories, epoch date, lists + additional in the description, salary range", async () => {
    stubFetch();
    const { postings } = await fetchBoard(byAts("lever"));
    const [a, b] = postings;
    expectContract(a.job);
    expect(a.job).toMatchObject({
      id: "lever:examplelever:aaaaaaaa-1111-2222-3333-444444444444",
      location: "Noida; Bengaluru",
      department: "Engineering",
      team: "AI",
      employmentType: "Full Time",
      workplaceType: "hybrid",
      remote: false,
      compensation: "INR 3000000–4500000/year-salary",
    });
    expect(a.job.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.locationExtra).toContain("India");
    expect(toDetail(a).description).toBe("Build speech models.\n\nRequirements\n- Python\n- vLLM\n\nEqual opportunity employer.");
    expect(b.job).toMatchObject({ remote: true, workplaceType: "remote", department: null, team: null, compensation: null });
    expect(toDetail(b).description).toBeNull();
  });

  test("ashby: secondary locations, compensation, unlisted postings dropped", async () => {
    stubFetch();
    const { postings } = await fetchBoard(byAts("ashby"));
    expect(postings.map((p) => p.job.title)).toEqual(["Inference Engineer", "Voice AI Engineer"]);
    const [a, b] = postings;
    expectContract(a.job);
    expect(a.job).toMatchObject({
      location: "Hyderabad; Remote",
      team: "LLM Serving",
      workplaceType: "hybrid",
      remote: false,
      compensation: "₹40L – ₹60L",
      date: "2026-11-01",
    });
    expect(a.locationExtra).toEqual(expect.arrayContaining(["Hyderabad", "Telangana", "India"]));
    expect(b.job).toMatchObject({ remote: true, workplaceType: "remote", department: null });
  });

  test("smartrecruiters: cleaned fullLocation, synthesized posting URL, no list description", async () => {
    stubFetch();
    const { postings, truncated } = await fetchBoard(byAts("smartrecruiters"));
    expect(truncated).toBe(false);
    const [a] = postings;
    expectContract(a.job);
    expect(a.job).toMatchObject({
      id: "smartrecruiters:ExampleSR:744000152914589",
      location: "Hyderabad, India",
      department: "Engineering",
      workplaceType: "hybrid",
      remote: false,
      url: "https://jobs.smartrecruiters.com/ExampleSR/744000152914589",
    });
    expect(a.descriptionHtml).toBeNull();
  });

  test("workable: account-scoped URL, telecommuting -> remote", async () => {
    stubFetch();
    const { postings } = await fetchBoard(byAts("workable"));
    const [a] = postings;
    expectContract(a.job);
    expect(a.job).toMatchObject({
      id: "workable:exampleworkable:9E2A4C02C7",
      location: "Paris, Île-de-France, France",
      url: "https://apply.workable.com/exampleworkable/j/9E2A4C02C7/",
      remote: true,
    });
  });

  test("a board 404 throws a message naming the token", async () => {
    stubFetch();
    await expect(fetchBoard({ name: "Nope", ats: "lever", token: "nope", tags: [] })).rejects.toThrow(/token "nope"/);
  });

  test("smartrecruiters paginates until totalFound", async () => {
    const page = (offset: number, n: number) =>
      JSON.stringify({
        totalFound: 150,
        content: Array.from({ length: n }, (_, i) => ({ id: String(offset + i), name: `Job ${offset + i}`, location: {} })),
      });
    const base = "https://api.smartrecruiters.com/v1/companies/ExampleSR/postings?limit=100";
    const log = stubFetch({
      [`${base}&offset=0`]: () => new Response(page(0, 100)),
      [`${base}&offset=100`]: () => new Response(page(100, 50)),
    });
    const { postings } = await fetchBoard(byAts("smartrecruiters"));
    expect(postings).toHaveLength(150);
    expect(log.urls).toHaveLength(2);
  });

  test("fetchPosting: ashby/workable read the board; a missing id is null", async () => {
    stubFetch();
    const hit = await fetchPosting(byAts("workable"), "9e2a4c02c7");
    expect(hit?.job.title).toContain("Voice Agents");
    expect(await fetchPosting(byAts("ashby"), "missing")).toBeNull();
  });

  test("a posting without id or title is skipped, not a crash", () => {
    expect(normalizeGreenhouse(byAts("greenhouse"), { id: 1 })).toBeNull();
    expect(normalizeGreenhouse(byAts("greenhouse"), { title: "x" })).toBeNull();
  });
});
