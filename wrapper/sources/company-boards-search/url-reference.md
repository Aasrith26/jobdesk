# ATS job-board API reference

The endpoints, parameters and response fields this skill depends on — the file to
update when an ATS changes its public API. All five are official, documented (or,
for Workable, long-standing public widget) endpoints that companies use to publish
openings to third parties. None needs authentication. Verified live 2026-11-09.

Every request sends `User-Agent: Mozilla/5.0 (compatible; company-boards-cli/1.0)`
and `Accept: application/json`, has a per-request timeout (default 30s, `--timeout`),
and backs off exponentially with jitter on 429/5xx (500ms doubling to 8s cap, honours
a numeric `Retry-After`, max 6 retries). A 404 is a value (board/posting not found),
not a crash. Timeouts and connection errors are not retried: in the fan-out they
are one board's failure, reported in `meta.errors`.

The skill's result `id` is `<ats>:<token>:<posting id>`.

## Greenhouse

Docs: https://developers.greenhouse.io/job-board.html

| Call | URL |
|------|-----|
| List | `GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true` |
| Detail | `GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>` |

- Without `content=true` the list omits `content`, `departments` and `offices`;
  with it, large boards are a few MB (Databricks ~3.4MB, ~1s).
- EU-hosted boards (`job-boards.eu.greenhouse.io/<token>`) are served by the same
  `boards-api.greenhouse.io` host.
- Unknown token → 404 `{"status":404,"error":"Job not found"}`.

| Field | → result |
|-------|----------|
| `id` (number) | `id` third segment |
| `title` | `title` (trimmed; titles often carry trailing spaces) |
| `location.name` | `location` (falls back to offices) |
| `offices[].location` / `.name` | location matching only |
| `departments[].name` | `department` (joined) |
| `first_published` → else `updated_at` | `date` |
| `updated_at` | `updated` |
| `absolute_url` | `url` (often the company's own site with `?gh_jid=<id>`) |
| `metadata[]` `{name: "Location Type", value: "Remote"/"Hybrid"/"On-Site"}` | `workplaceType`/`remote` when present (Anthropic) |
| `content` | description — **entity-encoded HTML** (`&lt;p&gt;`): decoded exactly once, then rendered |

## Lever

Docs: https://github.com/lever/postings-api

| Call | URL |
|------|-----|
| List | `GET https://api.lever.co/v0/postings/<site>?mode=json` (bare JSON array) |
| Detail | `GET https://api.lever.co/v0/postings/<site>/<id>` |

- Slow on larger boards (5–30s seen live for ~1MB); hence the 30s default timeout.
- Unknown site → 404 `{"ok":false,"error":"Document not found"}`.
- The skill reads the whole list in one request (no `skip`/`limit` paging).

| Field | → result |
|-------|----------|
| `id` (uuid) | `id` |
| `text` | `title` |
| `categories.location`, `categories.allLocations[]` | `location` |
| `country` (ISO alpha-2, e.g. `IN`) | location matching only (as "India") |
| `categories.department` / `.team` / `.commitment` | `department` / `team` / `employmentType` |
| `workplaceType` (`remote`/`hybrid`/`onsite`/`unspecified`) | `workplaceType`, `remote` |
| `createdAt` (epoch ms) | `date` (Lever exposes no published date) |
| `hostedUrl` / `applyUrl` | `url` / `applyUrl` |
| `salaryRange {min,max,currency,interval}` | `compensation` |
| `description` (or `opening`+`descriptionBody`), `lists[] {text, content: "<li>…"}`, `additional` | description (concatenated in that order) |

## Ashby

Docs: https://developers.ashbyhq.com/docs/public-job-posting-api

| Call | URL |
|------|-----|
| List | `GET https://api.ashbyhq.com/posting-api/job-board/<name>?includeCompensation=true` |
| Detail | none public — `detail` reads the list and picks the id |

- The list already carries `descriptionHtml` for every posting (OpenAI ~1.6MB).
- Unknown board → 404 `Not Found` (text).
- `isListed: false` postings are dropped.

| Field | → result |
|-------|----------|
| `id` (uuid) | `id` |
| `title`, `department`, `team`, `employmentType` | same names |
| `location`, `secondaryLocations[].location` | `location` |
| `address.postalAddress.{addressLocality,addressRegion,addressCountry}` (also on secondaries) | location matching only |
| `workplaceType` (`Remote`/`Hybrid`/`OnSite`/null) | `workplaceType` — preferred over `isRemote`, which is also true on many hybrid roles |
| `isRemote` | `remote` when `workplaceType` is null |
| `publishedAt` | `date` |
| `jobUrl` / `applyUrl` | `url` / `applyUrl` |
| `compensation.compensationTierSummary` (→ `scrapeableCompensationSalarySummary`) | `compensation` |
| `descriptionHtml` | description |

## SmartRecruiters

Docs: https://developers.smartrecruiters.com/docs/posting-api

| Call | URL |
|------|-----|
| List | `GET https://api.smartrecruiters.com/v1/companies/<id>/postings?limit=100&offset=<n>` |
| Detail | `GET https://api.smartrecruiters.com/v1/companies/<id>/postings/<postingId>` |

- The company id is **case-sensitive in URLs we build** (use the casing from
  `jobs.smartrecruiters.com/<Id>`, e.g. `Freshworks`, `Swiggy`).
- Paged: `{offset, limit, totalFound, content[]}`, max 100 per page. The skill pages
  until `totalFound`, capped at 10 pages (1000 postings) per company.
- An unknown company returns 200 with `totalFound: 0`, so a typo shows as 0 jobs in
  `companies --check`, not as an error.
- The list carries no description; `detail` reads `jobAd.sections.{companyDescription,
  jobDescription, qualifications, additionalInformation}.{title,text}`.

| Field | → result |
|-------|----------|
| `id` | `id` |
| `name` | `title` |
| `location.fullLocation` (empty segments dropped: `"Hyderabad, , India"` → `"Hyderabad, India"`) | `location` |
| `location.country` (alpha-2), `.region`, `.city` | location matching only |
| `location.remote` / `.hybrid` | `workplaceType`, `remote` |
| `department.label` → else `function.label` | `department` |
| `typeOfEmployment.label` | `employmentType` |
| `releasedDate` | `date` |
| `postingUrl` (detail) → else `https://jobs.smartrecruiters.com/<id>/<postingId>` | `url` |
| `applyUrl` (detail) | `applyUrl` |

## Workable

| Call | URL |
|------|-----|
| List | `GET https://apply.workable.com/api/v1/widget/accounts/<subdomain>?details=true` |
| Detail | none used — `detail` reads the list and picks the shortcode |

- `details=true` adds the full `description` HTML to each job.
- Unknown account → 404 `Not Found`.

| Field | → result |
|-------|----------|
| `shortcode` | `id` |
| `title`, `department`, `employment_type` | `title`, `department`, `employmentType` |
| `locations[] {city, region, country, countryCode, hidden}` (→ `city`/`state`/`country`) | `location` |
| `telecommuting` | `remote` (`true` → `workplaceType: "remote"`) |
| `published_on` → else `created_at` | `date` |
| built: `https://apply.workable.com/<subdomain>/j/<shortcode>/` | `url` (the API's own `url` omits the account, which `detail` could not resolve) |
| `application_url` | `applyUrl` |
| `description` | description |

## Detail URL forms accepted

| Host | Path |
|------|------|
| `job-boards.greenhouse.io`, `boards.greenhouse.io`, `*.eu.greenhouse.io` | `/<token>/jobs/<id>`; `/embed/job_app?for=<token>&token=<id>` |
| `boards-api.greenhouse.io` | `/v1/boards/<token>/jobs/<id>` |
| `jobs.lever.co`, `jobs.eu.lever.co` | `/<site>/<id>[/apply]` |
| `api.lever.co` | `/v0/postings/<site>/<id>` |
| `jobs.ashbyhq.com` | `/<name>/<id>[/application]` |
| `jobs.smartrecruiters.com` | `/<Company>/<digits>[-slug]` |
| `apply.workable.com` | `/<subdomain>/j/<shortcode>/` |

Hosts are compared after real URL parsing; look-alikes (`jobs.lever.co.evil.io`)
and userinfo (`user@host`) are rejected.

## Description rendering

Description HTML is third-party content. It goes through `visibleHtml` (drops
comments, `<script>/<style>/<template>`, `hidden` and `display:none` /
`visibility:hidden` / `mso-hide:all` elements) before tags are stripped; block
elements become line breaks and `<li>` becomes `- `. Every output passes through
`stripInvisible` (controls, bidi, zero-width, variation selectors, Unicode tag
characters). Both are copied from `linkedin-search/cli/src/helpers.ts`.

## Token discovery log (2026-11-09)

Probed for this list (all five APIs unless noted); only tokens returning jobs were kept.

- Found and shipped: see `companies.json`.
- Found, not shipped: SmartRecruiters `ServiceNow`, `BoschGroup`; Greenhouse
  `cloudflare`, `uberfreight`, `clear`, `slice` (no India/AI-relevant roles at probe time);
  Ashby `speechmatics` (duplicate of the Greenhouse board, which is fresher); Ashby `runway`.
- Not found under any tried token: Gnani (`gnani`, `gnaniai`), Exotel, Haptik,
  Yellow.ai (`yellowai`, `yellow-ai`, `yellowmessenger`), Uniphore, Krutrim/Ola,
  Postman (`postman`, `postmanlabs`, `getpostman`), Zepto, Hasura, Mistral, Hugging Face
  outside Workable, Uber, Retell AI, Synthflow, Groq, Qdrant, PhonePe, Zomato, Sprinklr,
  BrowserStack, Dream11, ShareChat, Chargebee, Innovaccer, Gupshup, Kore.ai, Verloop, Skit.ai,
  Convin, Ultrahuman, Simplismart.
