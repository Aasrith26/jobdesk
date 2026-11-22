import { describe, expect, test } from "bun:test";
import { buildPost, htmlToText, stripInvisible, visibleHtml } from "../src/helpers";

// Post bodies are third-party HTML: text a reader never sees must not reach
// the model reading this CLI's output.

describe("hidden text", () => {
  test("visibleHtml drops comments, scripts, styles and hidden elements", () => {
    const html =
      "Visible<!-- SC_OFF --><script>evil()</script><style>.x{}</style>" +
      '<span hidden>hidden attr</span><div style="display:none">display none <b>nested</b></div> end';
    expect(htmlToText(visibleHtml(html))).toBe("Visible end");
  });

  test("stripInvisible removes zero-width, bidi and tag characters recursively", () => {
    const tag = String.fromCodePoint(0xe0041);
    const v = stripInvisible({ a: "x​y‮z" + tag, b: ["﻿q"], n: null, k: 1 });
    expect(v).toEqual({ a: "xyz", b: ["q"], n: null, k: 1 });
  });

  test("a post built from an entry with hidden markup never carries it", () => {
    const post = stripInvisible(
      buildPost({
        fullname: "t3_abc123",
        title: "[Hiring] Data​ Engineer",
        author: "example_user",
        link: "https://www.reddit.com/r/forhire/comments/abc123/hiring_data_engineer/",
        published: "2026-11-01T10:00:00+00:00",
        contentHtml:
          '<!-- SC_OFF --><div class="md"><p>Real body.</p><p style="display:none">HIDDEN-MARKER-TEXT</p></div><!-- SC_ON --> &#32; submitted by &#32; <a href="https://www.reddit.com/user/example_user"> /u/example_user </a>',
        subreddit: "forhire",
      }),
    );
    expect(post).not.toBeNull();
    expect(JSON.stringify(post)).not.toContain("HIDDEN-MARKER-TEXT");
    expect(post!.title).toBe("Data Engineer");
    expect(post!.snippet).toBe("Real body.");
  });
});
