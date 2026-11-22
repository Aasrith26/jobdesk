# Remote boards: endpoint reference

The endpoints, parameters, response shapes and access rules this skill depends on.
Update this file when a board changes its API. Everything below was verified live
on 2026-11-09 with `User-Agent: Mozilla/5.0 (compatible; remote-boards-cli/1.0)`
(all HTTP 200), and every path was checked with the repo's cautious robots checker
(`python tools/robots_check.py <url>`).

## Access decisions

| Board | robots.txt | Terms / API notice | Decision |
|---|---|---|---|
| Remotive (`remotive.com/api/remote-jobs`) | `Disallow: /api/*` (and `/*search=`) for `User-agent: *` | Public API docs ask for a link back and few calls per day | **Excluded** — robots.txt says no for every agent; the documented API does not override that here. |
| Remote OK (`remoteok.com/api`) | `User-agent: *` `Allow: /`; `Content-Signal: search=yes, ai-train=no, use=reference`; AI-training crawlers (ClaudeBot, GPTBot, …) disallowed | API legal notice (first array element): link back to the Remote OK URL, mention Remote OK, no logo | Included — user-initiated search, never training. |
| Himalayas (`himalayas.app/jobs/api…`) | `Allow: /`; disallows `/apply`, `/jobs?page=`, `/jobs*&page=`, `/jobs/*?page=` | himalayas.app/api: link to the job on Himalayas, use `applicationLink` unchanged, no re-distribution to other boards/aggregators, remove expired jobs | Included — **search page 1 only** (`page=` on `/jobs/api/search` matches the disallow rules). |
| Jobicy (`jobicy.com/api/jobs`) | Disallows `?q=`, `?s=`, `?p=` etc., not `/api/` or `/jobs/<id>`; `Content-Signal: ai-input=yes, search=yes` | jobi.cy/apidocs: credit Jobicy with a direct link; apply buttons use the feed URL; fair use | Included. |
| We Work Remotely (`weworkremotely.com/remote-jobs.rss`) | `Allow: /` (only account/admin paths disallowed) | /remote-job-rss-feed: "Anyone can use the feed, all we ask is that you attribute the links back to We Work Remotely." | Included. |
| Working Nomads (`www.workingnomads.com/api/exposed_jobs/`) | `Disallow:` (empty — everything allowed) | API linked in the site footer; terms forbid competing products/resale | Included. |

## Remote OK

`GET https://remoteok.com/api` (newest ~100 postings) or `GET https://remoteok.com/api?tag=<tag>`
(postings with that tag; the CLI lower-cases and hyphenates the query: `machine learning` → `machine-learning`).

Response: a JSON array. **Element 0 is the legal notice** (`{ last_updated, legal }`);
the rest are jobs:

```jsonc
{ "id": "1137690", "slug": "...-1137690", "epoch": 1793890869, "date": "2026-11-05T15:01:09+00:00",
  "company": "Toptal", "position": "<title>", "tags": ["python", ...],
  "description": "<p>HTML</p>", "location": "Anywhere in the World",  // "" when unspecified
  "salary_min": 0, "salary_max": 0,   // 0 = not given (USD/year when given)
  "url": "https://remoteOK.com/remote-jobs/<slug>", "apply_url": "https://remoteOK.com/remote-jobs/<slug>" }
```

Quirks: some `location`/text fields are UTF-8 decoded as Latin-1 ("EspaÃ±a"); the
CLI repairs them (`fixMojibake`). Host is spelled `remoteOK.com`; normalized to
lower case. No single-job endpoint — `detail` scans the unfiltered feed, then
falls back to the posting page's JSON-LD.

## Himalayas

- Browse: `GET https://himalayas.app/jobs/api?limit=20[&cursor=<nextCursor>]` (max 20; `offset` deprecated). Used when there is no query and no `--india-friendly`.
- Search: `GET https://himalayas.app/jobs/api/search?q=<text>[&country=IN]` — 20 per page.
  Other documented params (unused): `worldwide`, `exclude_worldwide`, `seniority`,
  `employment_type`, `company`, `timezone`, `sort`. `page` is documented but
  disallowed by robots.txt, so the CLI never sends it. `country` "includes
  worldwide roles open to applicants in that country".
- One job: `GET https://himalayas.app/jobs/api/companies/<company>/jobs/<slug>` →
  200 `{ job }` (open), 410 (closed, body has `expiryDate`), 404 (unknown).

Response `{ comments, updatedAt, offset, limit, totalCount, nextCursor?, jobs: [...] }`; job:

```jsonc
{ "title", "excerpt", "companyName", "companySlug", "companyLogo", "employmentType": "Full Time",
  "minSalary": 83109, "maxSalary": 120508, "salaryPeriod": "annual", "currency": "USD",
  "seniority": ["Senior"], "locationRestrictions": ["United States"],    // [] = worldwide
  "timezoneRestrictions": [-10,-9,-8,-7,-6,-5,14],                      // every offset when unrestricted
  "categories": ["Senior-Buyer", ...], "parentCategories": ["Logistics"],
  "description": "<h3>HTML</h3>", "pubDate": 1794228534, "expiryDate": 1799412533,   // unix seconds; pubDate = last update
  "applicationLink": "https://himalayas.app/companies/<c>/jobs/<s>?utm_source=api",
  "guid": "https://himalayas.app/companies/<c>/jobs/<s>" }
```

Documented eligibility rule (used for `--india-friendly`): open to a country when
`locationRestrictions` is empty or includes it, and `timezoneRestrictions` includes
one of its standard offsets (India: 5.5). Result id: `himalayas:<company>/<slug>`.

## Jobicy

`GET https://jobicy.com/api/jobs?count=<1-100>[&tag=<keyword>][&geo=<slug>][&industry=<slug>][&cursor=<nextCursor>]`
(the older `/api/v2/remote-jobs` still answers). Only listings from the **last 7
days**, newest first; `tag` is documented as a title keyword. The CLI sends
`count=50&tag=<q>` (or `count=100` without a usable tag) and no `geo` (there is no
India slug; `apac` would drop "Anywhere" roles).

Response `{ apiVersion, documentationUrl, friendlyNotice, jobCount, lastUpdate, nextCursor, hasMore, appliedFilters, jobs, success, statusCode }`; job:

```jsonc
{ "id": 160069, "url": "https://jobicy.com/jobs/160069-<slug>", "jobSlug": "...", "jobTitle", "companyName",
  "jobIndustry": ["Data Science &amp; Analytics"], "jobType": ["Full-Time"], "jobGeo": "Hong Kong,  Singapore",
  "jobLevel": "Any", "jobExcerpt", "jobDescription": "<p>HTML</p>", "pubDate": "2026-11-09T12:44:26+00:00",
  "salaryMin"?, "salaryMax"?, "salaryCurrency"?, "salaryPeriod"? }
```

Detail: `https://jobicy.com/jobs/<id>` 301-redirects to the slug page, which carries
a schema.org `JobPosting` (title, description as flat text with "•" bullets,
`datePosted`, `validThrough`, `hiringOrganization.name`,
`applicantLocationRequirements[].name`). Batch status (unused):
`/api/jobs/status?ids=1,2`.

## We Work Remotely

`GET https://weworkremotely.com/remote-jobs.rss` — newest 100 postings across all
categories (category feeds such as `/categories/remote-programming-jobs.rss` have
25 and lack `<country>`). RSS 2.0; per `<item>`:

| Element | Use |
|---|---|
| `<title>` | `Company: Job title` — split on the first `": "` |
| `<region>` | Coarse: `Anywhere in the World` (default), `USA Only`, `North America Only`, `Europe Only`, `Latin America Only` |
| `<country>` | Often empty; when set, flag-emoji country list ("🇧🇷 Brazil, 🇨🇱 Chile, and 🇺🇾 Uruguay") — **the real restriction**, preferred over `<region>` |
| `<state>`, `<skills>`, `<category>`, `<type>` | skills/category/type become `tags` |
| `<description>` | Entity-escaped HTML (decoded once, then hidden markup dropped) |
| `<pubDate>`, `<expires_at>`, `<guid>`, `<link>` | `link` = `https://weworkremotely.com/remote-jobs/<slug>`; id `weworkremotely:<slug>` |

Parsing: split on `<item>` and parse each chunk alone (one broken item cannot break
the rest). Detail: the posting page's `JobPosting` JSON-LD — its `description`
contains **raw newlines** inside the JSON string (parsed leniently) and
entity-escaped HTML; `applicantLocationRequirements` lists ~250 countries for
worldwide roles (read as "Anywhere in the World") and the exact list otherwise;
`baseSalary` is present when posted.

## Working Nomads

`GET https://www.workingnomads.com/api/exposed_jobs/` — a JSON array of the newest
~35 postings, no parameters:

```jsonc
{ "url": "https://www.workingnomads.com/job/go/2007977/", "title", "description": "<h3>HTML</h3>",
  "company_name", "category_name": "Development", "tags": "security,operations,cloud",
  "location": "Time zone: CET (+/- 3 hours)" | "Europe, LATAM, APAC, the U.S., Canada" | "Global" | ...,
  "pub_date": "2026-11-09T08:52:38-05:00" }
```

`url` redirects to the employer, so the CLI never fetches it; `detail` re-reads this
feed. Id: `workingnomads:<number from /job/go/<n>/>`.

## Fetching

- `User-Agent: Mozilla/5.0 (compatible; remote-boards-cli/1.0)`, `Accept` per format.
- Exponential backoff with jitter on 429/5xx (500 ms doubling to 8 s, max 6 retries);
  404 → empty (treated as not found); other 4xx → that board's error.
- Per-request `AbortSignal.timeout` (default 15 s, `--timeout`), plus an overall
  per-board deadline of twice that; boards run in parallel (`Promise.allSettled`).
- Nothing is cached to disk.
