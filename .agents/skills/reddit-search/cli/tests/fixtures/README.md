# Test fixtures

All three files are **synthetic**, not recorded:

- `forhire-new.rss` - an Atom feed shaped like `GET https://www.reddit.com/r/forhire/new/.rss?limit=25`
  (6 entries: `[Hiring]` posts with and without an identifiable company, a
  `[For Hire]` post, an untagged rules post, a link post whose `[link]` points
  off Reddit)
- `developersindia-new.rss` - the same shape for `r/developersIndia` (a hiring
  post without a bracket tag, a discussion post)
- `post.rss` - a post's own feed, `GET <permalink>.rss`: the post (`t3_`) followed
  by two comments (`t1_`)

**Why not recorded:** on 2026-11-11 `https://www.reddit.com/robots.txt` (and
`old.reddit.com`'s) was `User-agent: * / Disallow: /`, and
`python tools/robots_check.py https://www.reddit.com/r/forhire/new/.rss`
answered `DISALLOWED for Claude-User`. The skill respects robots, so no feed was
fetched to record. The fixtures follow Reddit's documented feed layout: `<entry>`
with `<author><name>/u/...</name>`, `<category term="<sub>">`, `<content
type="html">` holding XML-escaped HTML (`<!-- SC_OFF --><div class="md">...</div><!-- SC_ON -->`
followed by the `&#32; submitted by &#32; <a ...> /u/x </a> ... [link] ... [comments]`
trailer), `<id>t3_...</id>`, `<link href="<permalink>"/>`, `<updated>`,
`<published>` and `<title>`. If Reddit's real markup differs, re-check
`parseFeed`/`splitContent` against a real feed before relying on this skill.

All usernames are placeholders (`example_user_N`); company names and URLs are
fictional (`*.example.com`/`.org`). Regenerate with the generator script kept
outside the repo (`make_reddit_fixtures.py`) or edit by hand.
