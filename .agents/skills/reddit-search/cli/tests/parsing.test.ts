import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  buildPost,
  companyFromTitle,
  feedUrl,
  isHiringTitle,
  normalizeSubreddit,
  parseFeed,
  postFeedUrl,
  postText,
  splitContent,
  stripInvisible,
  titleTags,
} from "../src/helpers";

// Fixtures are SYNTHETIC Atom feeds in the shape Reddit's /new/.rss and
// <permalink>.rss feeds use (see fixtures/README.md for why none was recorded).

const forhire = await Bun.file(join(import.meta.dir, "fixtures/forhire-new.rss")).text();
const postFeed = await Bun.file(join(import.meta.dir, "fixtures/post.rss")).text();

describe("parseFeed", () => {
  const entries = parseFeed(forhire);

  test("reads every entry with id, title, author, link, date, subreddit", () => {
    expect(entries.map((e) => e.fullname)).toEqual(["t3_1ofh001", "t3_1ofh002", "t3_1ofh003", "t3_1ofh004", "t3_1ofh005", "t3_1ofh006"]);
    expect(entries[0]).toMatchObject({
      title: "[Hiring] Senior React Developer - Remote - $60/hr",
      author: "example_user_1",
      link: "https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react_developer_remote_60hr/",
      published: "2026-11-10T12:00:00+00:00",
      subreddit: "forhire",
    });
    expect(entries[0].contentHtml).toContain('<div class="md">');
  });

  test("the feed's 'submitted by ... [link] [comments]' trailer is split off", () => {
    const { body, externalLink } = splitContent(entries[0].contentHtml);
    expect(body).not.toContain("submitted by");
    expect(externalLink).toBeNull();
    // link post: [link] points off Reddit
    expect(splitContent(entries[5].contentHtml).externalLink).toBe("https://careers.example.org/go-backend");
  });

  test("a malformed entry does not break the others", () => {
    const broken = forhire.replace("<id>t3_1ofh002</id>", "");
    expect(parseFeed(broken).map((e) => e.fullname)).not.toContain("t3_1ofh002");
    expect(parseFeed(broken)).toHaveLength(5);
  });
});

describe("buildPost", () => {
  const posts = parseFeed(forhire).map((e) => stripInvisible(buildPost(e)!));

  test("contract fields; company from a Company: line makes it a job", () => {
    expect(posts[0]).toMatchObject({
      id: "1ofh001",
      kind: "job",
      title: "Senior React Developer - Remote - $60/hr",
      company: "Brightloop Labs",
      location: "Remote",
      date: "2026-11-10",
      posted_date: "2026-11-10",
      url: "https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react_developer_remote_60hr/",
      apply_url: "https://jobs.example.com/brightloop/react?ref=reddit&src=rss",
      remote: true,
      salary: "$60/hr",
      employment_type: "contract",
      author: "example_user_1",
      thread_id: "forhire",
      thread_title: "r/forhire",
      tags: ["Hiring"],
    });
    for (const p of posts) {
      for (const k of ["id", "kind", "title", "company", "location", "date", "posted_date", "url", "apply_url", "remote", "header", "snippet", "author"]) {
        expect(k in p).toBe(true);
      }
      expect(p.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/forhire\/comments\/[a-z0-9]+\/[^/]+\/$/);
    }
  });

  test("no identifiable company -> u/<poster>, kind lead", () => {
    expect(posts[2]).toMatchObject({ company: "u/example_user_3", kind: "lead", location: "Bengaluru, India", india_friendly: true, india_reason: "explicit" });
  });

  test("company from '<Company> is hiring' in the title", () => {
    expect(posts[3]).toMatchObject({ company: "Acme Analytics", kind: "job", location: "Remote, Worldwide", india_reason: "global" });
  });

  test("comments (t1_) are not posts", () => {
    const entries = parseFeed(postFeed);
    expect(entries.map((e) => e.fullname)).toEqual(["t3_1ofh001", "t1_c0mm001", "t1_c0mm002"]);
    expect(buildPost(entries[1])).toBeNull();
  });

  test("postText is the cleaned body with list items and decoded link", () => {
    const text = postText(parseFeed(postFeed)[0]);
    expect(text).toContain("Company: Brightloop Labs");
    expect(text).toContain("5+ years React\nNext.js & Tailwind");
    expect(text).toContain("https://jobs.example.com/brightloop/react?ref=reddit&src=rss");
    expect(text).not.toMatch(/<[a-z]|&amp;|&#32;|submitted by/);
  });
});

describe("title helpers", () => {
  test("titleTags strips leading bracket tags", () => {
    expect(titleTags("[Hiring] [Remote] Senior Dev")).toEqual({ tags: ["Hiring", "Remote"], rest: "Senior Dev" });
    expect(titleTags("[HIRING]: Go dev")).toEqual({ tags: ["HIRING"], rest: "Go dev" });
    expect(titleTags("No tags here")).toEqual({ tags: [], rest: "No tags here" });
  });

  test("isHiringTitle", () => {
    expect(isHiringTitle("[Hiring] x")).toBe(true);
    expect(isHiringTitle("[ HIRING ] x")).toBe(true);
    expect(isHiringTitle("[For Hire] x")).toBe(false);
    expect(isHiringTitle("Hiring: x")).toBe(false);
  });

  test("companyFromTitle", () => {
    expect(companyFromTitle("Acme Analytics is hiring a ML Engineer")).toBe("Acme Analytics");
    expect(companyFromTitle("We are hiring a ML Engineer")).toBeNull();
    expect(companyFromTitle("Senior React Developer - Remote")).toBeNull();
  });
});

describe("URLs", () => {
  test("normalizeSubreddit", () => {
    expect(normalizeSubreddit("r/forhire")).toBe("forhire");
    expect(normalizeSubreddit("/r/PythonJobs")).toBe("PythonJobs");
    expect(normalizeSubreddit("https://www.reddit.com/r/remotejs/")).toBe("remotejs");
    expect(normalizeSubreddit("not a sub")).toBeNull();
    expect(normalizeSubreddit("x")).toBeNull();
  });

  test("feedUrl", () => {
    expect(feedUrl("forhire", 25)).toBe("https://www.reddit.com/r/forhire/new/.rss?limit=25");
  });

  test("postFeedUrl appends .rss to the permalink and rejects other hosts", () => {
    expect(postFeedUrl("https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react/")).toBe(
      "https://www.reddit.com/r/forhire/comments/1ofh001/hiring_senior_react/.rss",
    );
    expect(postFeedUrl("https://old.reddit.com/r/forhire/comments/1ofh001/")).toBe("https://www.reddit.com/r/forhire/comments/1ofh001/.rss");
    expect(postFeedUrl("reddit.com/r/forhire/comments/1ofh001/x?utm_source=share")).toBe("https://www.reddit.com/r/forhire/comments/1ofh001/x/.rss");
    expect(postFeedUrl("https://redd.it/1ofh001")).toBe("https://www.reddit.com/comments/1ofh001/.rss");
    expect(postFeedUrl("t3_1ofh001")).toBe("https://www.reddit.com/comments/1ofh001/.rss");
    expect(postFeedUrl("1ofh001")).toBe("https://www.reddit.com/comments/1ofh001/.rss");
    expect(postFeedUrl("https://user@www.reddit.com/r/forhire/comments/1ofh001/")).toBeNull();
    expect(postFeedUrl("https://reddit.com.evil.example/r/forhire/comments/1ofh001/")).toBeNull();
    expect(postFeedUrl("https://www.reddit.com/user/someone/")).toBeNull();
  });
});
