import { describe, expect, test } from "bun:test";
import { buildLead, htmlToText, stripInvisible, visibleHtml } from "../src/helpers";

// Channel messages are third-party HTML: text a reader never sees must not
// reach the model reading this CLI's output.

describe("hidden text", () => {
  test("visibleHtml drops comments, scripts, styles and hidden elements", () => {
    const html =
      "Visible<!-- a hidden comment --><script>evil()</script><style>.x{}</style>" +
      '<span hidden>hidden attr</span><div style="display:none">display none <b>nested</b></div> end';
    expect(htmlToText(visibleHtml(html))).toBe("Visible end");
  });

  test("stripInvisible removes zero-width, bidi and tag characters recursively", () => {
    const tag = String.fromCodePoint(0xe0041);
    const v = stripInvisible({ a: "x​y‮z" + tag, b: ["﻿q"], n: null, k: 1 });
    expect(v).toEqual({ a: "xyz", b: ["q"], n: null, k: 1 });
  });

  test("a lead built from a message with hidden markup never carries it", () => {
    const lead = stripInvisible(
      buildLead({
        channel: "examplejobs",
        id: "7",
        html: 'Data Engineer<span style="display: none"> HIDDEN-MARKER-TEXT</span><br/>Remote<br/><br/>Real​ body text.',
        datetime: "2026-11-01T10:00:00+00:00",
        forwarded: false,
      }),
    );
    expect(lead).not.toBeNull();
    expect(JSON.stringify(lead)).not.toContain("HIDDEN-MARKER-TEXT");
    expect(lead!.title).toBe("Data Engineer");
    expect(lead!.snippet).toBe("Data Engineer Remote Real body text.");
  });
});
