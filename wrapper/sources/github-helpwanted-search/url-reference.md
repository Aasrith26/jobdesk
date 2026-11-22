# GitHub help-wanted API reference

The endpoints, parameters and response shapes this skill depends on. Update this
file if the GitHub API changes. All verified live (HTTP 200, unauthenticated) on
2026-11-11.

| Endpoint | Resource | Used for |
|----------|----------|----------|
| `GET https://api.github.com/search/issues` | search (10/min anon, 30/min token) | `search` (issues mode), 2 requests |
| `GET https://api.github.com/search/repositories` | search | `search --mode repos`, 1 request |
| `GET https://api.github.com/repos/{owner}/{repo}` | core (60/h anon, 5000/h token) | stars enrichment (cached 24 h), `detail` |
| `GET https://api.github.com/repos/{owner}/{repo}/issues/{n}` | core | `detail <issue>` |
| `GET https://api.github.com/repos/{owner}/{repo}/readme` | core | `detail <repo>` |

Every request sends `User-Agent: ai-job-search-github-helpwanted-cli/1.0`,
`Accept: application/vnd.github+json` (unless noted), `X-GitHub-Api-Version:
2022-11-28`, and `Authorization: Bearer <GITHUB_TOKEN>` only when that env var
is set. 20 s timeout; exponential backoff with jitter on 429/5xx (500 ms
doubling to 8 s, max 6 retries); 404 -> `null`; 422 -> `BAD_QUERY`.

## Rate-limit headers

Every response carries `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-used`, `x-ratelimit-resource` (`search` / `core`) and
`x-ratelimit-reset` (epoch seconds). Verified: an anonymous search response
had `X-RateLimit-Limit: 10`, `X-RateLimit-Resource: search`. A primary limit
answers 403 (or 429) with `x-ratelimit-remaining: 0`; a secondary limit answers
403/429 with `retry-after: <s>`. The CLI waits when the reset is <= 65 s away,
else exits `RATE_LIMITED`. It also records `remaining: 0` on a *successful*
response so the next invocation waits for the reset first. State file:
`<os.tmpdir()>/ai-job-search-github-helpwanted/ratelimit.json`
(`GH_HELPWANTED_STATE_DIR` overrides the directory; tests use this).

## 1. Issue search

```
GET /search/issues?q=<q>&sort=updated&order=desc&per_page=100&page=1[&advanced_search=true]
```

| Query | Notes |
|-------|-------|
| `<kw> is:issue is:open archived:false label:"help wanted" updated:>=YYYY-MM-DD` | Plain search. Precise; recorded 3,711 hits for `python` / 30 days. |
| `<kw> is:issue is:open archived:false (hiring OR paid OR bounty OR contract) updated:>=YYYY-MM-DD` | Needs `advanced_search=true` for the parenthesised OR. Matches anywhere in the issue (title **or body**): recorded 17,267 hits for `react` / 30 days and 0 of the first 50 had a lead-shaped phrase, so the CLI re-checks every hit (see SKILL.md). `in:title` combined with the OR group did **not** restrict to titles in testing, so it is not used. |

Response: `{ total_count, incomplete_results, items: [...] }`. Item fields used:

```jsonc
{
  "html_url": "https://github.com/owner/repo/issues/31",   // -> url
  "repository_url": "https://api.github.com/repos/owner/repo", // -> repo, company (owner)
  "number": 31,
  "title": "Support Python 3.14",
  "body": "### Context\n...",          // markdown, may contain <!-- template comments -->
  "labels": [{ "name": "help wanted", ... }],
  "user": { "login": "..." },
  "comments": 0,
  "created_at": "2026-11-04T18:14:04Z", // -> date / posted_date
  "updated_at": "2026-11-07T23:18:48Z", // -> updated_date, sort key
  "pull_request": { ... }               // present only on PRs (excluded by is:issue; dropped if seen)
}
```

The search hit has **no star count**; stars come from `GET /repos/{o}/{r}`
(`stargazers_count`), cached 24 h in `repos.json` next to the rate-limit state.

## 2. Repository search (`--mode repos`)

```
GET /search/repositories?q=<kw> "we're hiring" in:readme archived:false pushed:>=YYYY-MM-DD[ stars:>=N]&sort=updated&order=desc&per_page=100
```

Recorded 358 hits with no keyword / 30 days. Item fields used: `full_name`,
`html_url`, `description`, `homepage`, `stargazers_count`, `language`,
`topics`, `pushed_at`, `archived`, `owner.login`, `owner.type`
(`User`/`Organization`). The README match is GitHub's; the CLI does not
re-download the README during search.

## 3. Detail

- Issue: `GET /repos/{o}/{r}/issues/{n}` with
  `Accept: application/vnd.github.full+json`, which adds `body_html` (GitHub's
  sanitized rendering; template HTML comments are already gone) and
  `body_text`. The CLI converts `body_html` (visibleHtml -> anchors expanded
  as `label (href)` -> tags stripped -> entities decoded -> stripInvisible).
  Plus `GET /repos/{o}/{r}` for stars (cached).
- Repo: `GET /repos/{o}/{r}` and `GET /repos/{o}/{r}/readme` with
  `Accept: application/vnd.github.html+json`, which returns **raw HTML** (not
  JSON). GitHub wraps headings with an anchor holding an `aria-hidden` SVG,
  which visibleHtml drops.

Accepted `detail` inputs: `https://github.com/<o>/<r>/issues/<n>`,
`github.com/<o>/<r>/issues/<n>`, `<o>/<r>#<n>`, `https://github.com/<o>/<r>`.
Host checked with real URL parsing (`github.com` / `www.github.com` only, no
userinfo).
