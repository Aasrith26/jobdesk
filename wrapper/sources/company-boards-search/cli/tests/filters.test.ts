import { describe, expect, test } from "bun:test";
import type { Posting } from "../src/ats";
import { filterPostings, sortPostings } from "../src/commands/search";
import { compileLocation, compileQuery, isUnrestrictedRemote, selectCompanies } from "../src/helpers";
import { fixtureCompanies } from "./stub";

function posting(over: Partial<Posting["job"]> & { locations?: string[]; extra?: string[]; html?: string }): Posting {
  const { locations = [], extra = [], html = null, ...job } = over as any;
  return {
    job: {
      id: `ashby:x:${Math.random()}`, title: "Engineer", company: "X", location: locations.join("; ") || null, date: "2026-11-01",
      url: null, ats: "ashby", token: "x", department: null, team: null, remote: null, workplaceType: null,
      employmentType: null, updated: null, compensation: null, tags: [], ...job,
    },
    locations,
    locationExtra: extra,
    descriptionHtml: html,
    applyUrl: null,
  };
}

describe("compileQuery", () => {
  test("terms match case-insensitively at a word start, not mid-word", () => {
    const q = compileQuery("ai");
    expect(q("Applied AI Engineer")).toBe(true);
    expect(q("AI-powered tooling")).toBe(true);
    expect(q("Maintenance Lead")).toBe(false);
  });
  test("words are ANDed; OR and | separate alternatives; quotes keep phrases", () => {
    expect(compileQuery("ml engineer")("Senior ML Platform Engineer")).toBe(true);
    expect(compileQuery("ml engineer")("ML Researcher")).toBe(false);
    const alt = compileQuery("voice OR speech|llm");
    expect(alt("Speech Scientist")).toBe(true);
    expect(alt("LLMs Engineer")).toBe(true);
    expect(alt("Designer")).toBe(false);
    expect(compileQuery('"machine learning"')("Machine Learning Engineer")).toBe(true);
    expect(compileQuery('"machine learning"')("Learning machine")).toBe(false);
  });
  test("lowercase 'or' is an ordinary word", () => {
    expect(compileQuery("voice or speech")("Speech Engineer")).toBe(false);
  });
});

describe("compileLocation", () => {
  test("India expands to Indian cities as whole words and does not match Indiana", () => {
    const loc = compileLocation("India");
    expect(loc("Bengaluru")).toBe(true);
    expect(loc("Hyderabad, TS")).toBe(true);
    expect(loc("Remote - India")).toBe(true);
    expect(loc("Indianapolis, Indiana")).toBe(false);
  });
  test("Bangalore and Bengaluru are interchangeable; comma means OR; other terms are substrings", () => {
    expect(compileLocation("Bangalore")("Bengaluru, KA")).toBe(true);
    expect(compileLocation("Hyderabad,Pune")("Pune, Maharashtra")).toBe(true);
    expect(compileLocation("berl")("Berlin, Germany")).toBe(true);
  });
});

describe("isUnrestrictedRemote", () => {
  test("generic remote wording is open; a named place restricts it", () => {
    expect(isUnrestrictedRemote(["Remote"])).toBe(true);
    expect(isUnrestrictedRemote(["Remote (Global)", "Anywhere"])).toBe(true);
    expect(isUnrestrictedRemote(["Remote - US"])).toBe(false);
    expect(isUnrestrictedRemote(["United States"])).toBe(false);
  });
});

describe("filterPostings", () => {
  const blr = posting({ title: "AI Engineer", locations: ["Bengaluru"] });
  const lever = posting({ title: "ML Engineer", locations: ["Noida"], extra: ["India"] });
  const openRemote = posting({ title: "Voice Engineer", locations: ["Remote"], remote: true });
  const usRemote = posting({ title: "Voice Engineer", locations: ["Remote - US"], remote: true });
  const london = posting({ title: "Voice Engineer", locations: ["London"], remote: false, html: "<p>WebRTC telephony</p>" });

  test("-l matches location plus extra location text (country names from codes)", () => {
    expect(filterPostings([blr, lever, london], { location: "India" })).toEqual([blr, lever]);
  });
  test("--remote alone keeps remote roles only, whatever the region", () => {
    expect(filterPostings([blr, openRemote, usRemote, london], { remote: true })).toEqual([openRemote, usRemote]);
  });
  test("-l with --remote adds remote roles open anywhere, not region-locked ones", () => {
    expect(filterPostings([blr, openRemote, usRemote, london], { location: "India", remote: true })).toEqual([blr, openRemote]);
  });
  test("--in-description extends -q to the description", () => {
    expect(filterPostings([london], { query: "webrtc" })).toEqual([]);
    expect(filterPostings([london], { query: "webrtc", inDescription: true })).toEqual([london]);
  });
  test("--jobage keeps recent dated postings and drops undated ones", () => {
    const now = Date.parse("2026-11-09T00:00:00Z");
    const fresh = posting({ date: "2026-11-05" });
    const old = posting({ date: "2026-08-01" });
    const undated = posting({ date: null });
    expect(filterPostings([fresh, old, undated], { jobage: 7, now })).toEqual([fresh]);
  });
  test("sort: newest first, undated last", () => {
    const a = posting({ date: "2026-01-01" });
    const b = posting({ date: null });
    const c = posting({ date: "2026-10-01" });
    expect(sortPostings([a, b, c])).toEqual([c, a, b]);
  });
});

describe("selectCompanies", () => {
  const all = fixtureCompanies();
  test("--company matches a name substring or exact token; --tag and --ats narrow", () => {
    expect(selectCompanies(all, { company: ["voice"] }).map((c) => c.token)).toEqual(["examplevoice"]);
    expect(selectCompanies(all, { company: ["examplesr"] }).map((c) => c.name)).toEqual(["Example SR"]);
    expect(selectCompanies(all, { tag: ["voice"] }).map((c) => c.ats)).toEqual(["greenhouse", "workable"]);
    expect(selectCompanies(all, { tag: ["india"], ats: ["lever"] }).map((c) => c.token)).toEqual(["examplelever"]);
  });
});
