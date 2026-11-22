# Test fixtures

Recorded once from the live feeds on 2026-11-11 with the CLI's User-Agent,
then trimmed by hand-picking a few items per feed (announcements, a round-up,
VC-fund raises, a duplicate raise reported by two outlets, and non-funding
money news), dropping `<content:encoded>` / media tags and cutting
descriptions to 400 characters:

| File | Source |
|------|--------|
| `inc42.xml` | `https://inc42.com/buzz/feed/` (5 items) |
| `entrackr.xml` | `https://entrackr.com/rss` (7 items) |
| `ys.xml` | `https://yourstory.com/tag/funding/feed` (7 items) |
| `tcv.xml` | `https://techcrunch.com/category/venture/feed/` (4 items) |
| `tcs.xml` | `https://techcrunch.com/category/startups/feed/` (3 items) |
| `article-entrackr.html` | One Entrackr article fetched through `tools/fetch_page.py`, cut to its `<meta>` tags, the JSON-LD `datePublished` and the `<article>` block. |

Headlines are kept verbatim because the classifier and company extractor are
tested against them; article bodies are not stored beyond that one trimmed
article. Hidden-text cases are synthetic and live inline in
`hidden-text.test.ts`.
