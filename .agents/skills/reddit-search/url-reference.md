# Reddit RSS/Atom feed reference

The feeds this skill depends on and the markup it parses. Update this file if
Reddit changes its feeds.

**Verification status (2026-11-11):** only `robots.txt` was fetched. It answered
`User-agent: *` / `Disallow: /` on both `www.reddit.com` and `old.reddit.com`, and
`tools/robots_check.py` reports `DISALLOWED for Claude-User` for the feed URLs, so
**no feed was requested** and the response layout below is Reddit's documented /
long-standing feed format, not a live capture. Re-verify against a real feed if
robots.txt ever allows these paths.

| Endpoint | Used for |
|----------|----------|
| `GET https://www.reddit.com/r/<sub>/new/.rss?limit=<1-100>` | `search`: newest posts of one subreddit |
| `GET <permalink>.rss` (`https://www.reddit.com/r/<sub>/comments/<id>/<slug>/.rss`) | `detail`: the post, then its comments |
| `GET https://www.reddit.com/comments/<id>/.rss` | `detail` for a bare id / `redd.it` link |
| `GET https://www.reddit.com/robots.txt` | Read by `tools/robots_check.py` before every request |
| `/r/<sub>/new.json`, `oauth.reddit.com` | Not used (JSON API / OAuth are out of scope) |

Every request sends `User-Agent: Mozilla/5.0 (compatible; ai-job-search-reddit-cli/1.0)`
(no username or e-mail), `Accept: application/atom+xml,...`, a 20 s timeout, at
most one request every 2 s (retries included), and exponential backoff with
jitter on 429/5xx (500 ms doubling to 8 s, max 6 retries; numeric `Retry-After`
honoured up to 30 s). 404 -> subreddit `not_found` / post `NOT_FOUND`.

## Feed layout (`parseFeed` / `splitContent` in `cli/src/helpers.ts`)

```xml
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <category term="forhire" label="r/forhire"/>
  <title>newest submissions : forhire</title>
  <entry>
    <author><name>/u/someone</name><uri>https://www.reddit.com/user/someone</uri></author>
    <category term="forhire" label="r/forhire"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Body&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;
      &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/someone&quot;&gt; /u/someone &lt;/a&gt;
      &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;LINK&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32;
      &lt;span&gt;&lt;a href=&quot;PERMALINK&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/forhire/comments/abc123/slug/" />
    <updated>2026-11-10T12:00:00+00:00</updated>
    <published>2026-11-10T12:00:00+00:00</published>
    <title>[Hiring] Senior React Developer - Remote</title>
  </entry>
</feed>
```

- Entries are split on `<entry>...</entry>` and parsed independently.
- `<id>`: `t3_<id>` = post, `t1_<id>` = comment (only in a post's own feed; skipped).
- `<content type="html">` is XML-escaped HTML: decoded once to HTML, then the
  `submitted by ... [link] [comments]` trailer is cut off. `[link]` of a link post
  points at the external URL (used as `apply_url` when it is off Reddit); for a
  self post it is the permalink.
- `<title>` is decoded twice (XML, then HTML entities Reddit leaves in titles); it is
  plain text, never re-parsed as HTML.
- Self-post bodies are Reddit-rendered markdown: `<p>`, `<ul><li>`, `<a href>`,
  `<code>`, `<strong>`; link posts may carry a thumbnail `<table>` with no text.

## Post filtering anchors

- r/forhire (`HIRING_TAG_SUBS`): keep titles matching `/\[\s*hiring\s*\]/i` unless
  `--include-for-hire`. Other subreddits are not tag-filtered.
- Title tags: leading `[...]`/`(...)` groups, each up to 40 chars, optionally
  followed by `:`/`-`/`|`.
- Company: a body line `Company:` / `Company name:` / `Employer:`, or a title
  `<Capitalised Name> is hiring|is looking for ...`; else `u/<author>` and
  `kind: "lead"`.
