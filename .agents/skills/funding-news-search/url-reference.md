# Funding news feed reference

The feeds, their formats and the parsing anchors this skill depends on. Update
this file when a publisher moves a feed. Candidates were probed live on
2026-11-11; only the ones marked **used** passed (HTTP 200, a real RSS
document, fresh items).

## Feeds probed

| URL | Result | Status |
|-----|--------|--------|
| `https://inc42.com/buzz/feed/` | 200 `application/rss+xml`, RSS 2.0 (WordPress), 24 items, newest same day | **used** (Inc42) |
| `https://inc42.com/feed/` | 200, same items as `/buzz/feed/` | not used (duplicate) |
| `https://inc42.com/tag/funding/feed/` | 200 but stale: newest item 2023-07-01 | rejected |
| `https://inc42.com/tag/funding-galore/feed/` | 200, weekly "Funding Galore" round-ups only | rejected (no single-startup items) |
| `https://inc42.com/buzz/funding/feed/` | 404 | rejected |
| `https://inc42.com/category/buzz/funding-galore/feed/` | 200, a *comments* feed with 0 items | rejected |
| `https://entrackr.com/rss` | 200 `application/xml`, RSS 2.0, 50 items, newest same day (advertised by `<link rel="alternate">` on the home page) | **used** (Entrackr) |
| `https://entrackr.com/feed/`, `/category/funding/feed/`, `/feed`, `/rss.xml`, `/feed.xml` | 404 (site is no longer WordPress) | rejected |
| `https://yourstory.com/tag/funding/feed` | 200 `application/rss+xml`, 20 funding-tagged items | **used** (YourStory) |
| `https://yourstory.com/category/funding/feed` | 200, funding items mixed with funding reports | not used |
| `https://yourstory.com/feed` | 200, general news | not used |
| `https://yourstory.com/rss` | 200 but HTML | rejected |
| `https://techcrunch.com/category/venture/feed/` | 200 `application/rss+xml`, 20 items | **used** (TechCrunch Venture) |
| `https://techcrunch.com/category/startups/feed/` | 200 `application/rss+xml`, 20 items | **used** (TechCrunch Startups) |

Inc42 served a Cloudflare JS challenge (HTML) to one request after ~10 rapid
probes, then the RSS again a few minutes later.

## robots.txt (2026-11-11)

| Host | `*` group | Named AI crawlers |
|------|-----------|-------------------|
| inc42.com | `Allow: /`, `Disallow: /*?*`, `/*page/*`, `/wp-admin/` (feed paths allowed) | GPTBot, ClaudeBot, CCBot, ... `Disallow: /`; Claude-User, ChatGPT-User allowed |
| entrackr.com | `Disallow: /static/*` | SemrushBot, AhrefsBot blocked |
| yourstory.com | `Allow: /` with `Content-Signal: search=yes,ai-train=no,use=reference` (Cloudflare-managed) | ClaudeBot, GPTBot, CCBot, anthropic-ai, Claude-Web, ... `Disallow: /` |
| techcrunch.com | `Disallow: /wp-admin/`, `/wp-json/`, `/search/`, `/?s=` | anthropic-ai, ClaudeBot, ChatGPT-User, ... `Disallow: /` |

The CLI's own matcher (`robotsRules` / `robotsAllows` in `cli/src/helpers.ts`)
picks the group naming `ai-job-search-funding-news-cli`, else `*`; longest
match wins, Disallow wins ties, `*` and `$` wildcards supported. 200 ->
evaluate; 404/410 -> allowed; anything else -> unconfirmed (feed skipped).
Cache: `<os.tmpdir()>/ai-job-search-funding-news/robots.json`, 24 h per origin
(`FUNDING_NEWS_STATE_DIR` overrides the dir; tests use it).

## Request details

`User-Agent: ai-job-search-funding-news-cli/1.0`,
`Accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5`,
20 s timeout, exponential backoff with jitter on 429/5xx (500 ms doubling to
8 s, max 6 retries). Feeds are read in parallel (robots checks for one origin
are serialized so the two TechCrunch feeds share one robots.txt request).

## Item formats

WordPress RSS 2.0 (Inc42, TechCrunch):

```xml
<item>
  <title>Harbinger raises $240M after expanding into defense</title>   <!-- entities: &#8217; &#038; -->
  <link>https://techcrunch.com/2026/11/05/...</link>
  <dc:creator><![CDATA[...]]></dc:creator>
  <pubDate>Tue, 10 Nov 2026 20:47:05 +0000</pubDate>
  <category><![CDATA[Venture]]></category> ...
  <guid isPermaLink="false">https://techcrunch.com/?p=3187132</guid>
  <description><![CDATA[One-paragraph summary]]></description>
  <content:encoded>...</content:encoded>   <!-- not read -->
</item>
```

Entrackr (single-line XML): `<title><![CDATA[... ]]></title>`, `<link>`,
`<description><![CDATA[<img ...><p>full article HTML...]]></description>`,
`<pubDate>Wed, 11 Nov 2026 11:56:52 +0530</pubDate>`, many `<category>`
(`News`, `Snippets`, `Fintrackr`, `Weekly Funding Report`, ...). The channel
also carries ~100 `<category>` elements before the first item.

YourStory: `<title><![CDATA[...]]></title>`, `<link>`, `<guid>` (permalink),
`<pubDate>... GMT</pubDate>`, `<description><![CDATA[plain text]]>`,
`<content:encoded>` with a `display:none` tracking pixel (dropped). No
`<category>`; the feed is funding-only, so it is flagged `fundingFeed: true`.

Atom (`<entry>`, `<link rel="alternate" href>`, `<published>`/`<updated>`,
`<summary>`, `<category term>`) is supported for `--feeds`.

Parsing: items by regex; CDATA unwrapped; titles entity-decoded twice (CDATA
holding `&#038;`), tags and hidden markup removed; link from `<link>` (else a
permalink `<guid>`), kept only if http(s); `pubDate` -> `YYYY-MM-DD` read from
the string (no timezone shift); description -> visibleHtml -> text.
A body that starts with `<!doctype html` / `<html` is `not-a-feed`.

## Article pages (`detail`)

Fetched via `python tools/fetch_page.py <url> --out <tmp>/page.html` (the
script prints `HTTP <code> size=<n> saved=<path>`; exit 1 = robots refusal,
2 = transport error). Anchors used: `<meta property="og:title">` (else
`<title>`), `og:site_name`, `og:description`, `article:published_time` or
JSON-LD `"datePublished": "YYYY-MM-DD..."` (Entrackr uses the latter), the
largest `<article>` block (both Entrackr and Inc42 have one), minus `nav`,
`aside`, `form`, `button`, `footer`, `time` and elements whose class/id says
share / social / bookmark / newsletter / related / author-detail / tags.
