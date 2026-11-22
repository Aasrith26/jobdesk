# Shine.com URL Reference

Public, unauthenticated, server-rendered (Next.js app router) pages used by this skill.
Investigated 2026-11-09 with the UA `Mozilla/5.0 (compatible; shine-cli/1.0)`; both page
types return 200 HTML without login or bot challenge.

> Personal use only. Keep volume low; Shine's terms govern the content.

## robots.txt (User-agent: *)

Disallowed, and never requested by the CLI: `/api/*`, `/jobs/jobs/`, `/jobs/1*`, `/jobs/9*`,
`/job-search/simple/`, `/job-search/similar/`, `/job-search/*?jd_cname=*`, `/*?type=amp`,
`/*?rect=*`, `/*?*vendorid=*`, `/myshine/`, `/lookup/`, `/featuredcompanystats/`.
`User-agent: Scrapy` and `Trabajo` are disallowed entirely. The paths below are allowed.

## Search (JSRP)

```
GET https://www.shine.com/job-search/<kw>-jobs[-in-<city>][-<page>][?sort=1]
GET https://www.shine.com/job-search/jobs-in-<city>[-<page>][?sort=1]
```

| Part | Meaning | Example |
|------|---------|---------|
| `<kw>` | Keyword slug: lowercase, `+`->`plus`, `.`->`dot`, `#`->`sharp`, `&`->`n`, other non-alphanumerics -> `-` | `machine-learning-engineer`, `c-plus-plus` |
| `-in-<city>` | City slug | `-in-hyderabad`, `-in-new-delhi` |
| `-<page>` | Page suffix (page 1 has none), 20 results/page | `-2` |
| `?sort=1` | "Most recent" sort (absent = relevance) | |

Other facet query params the site's JS knows (not used by the CLI): `fexp` (experience),
`farea`, `emp_type`, `findustry`, `job_type`, `shift_type`, `fsalary`, `fcid`, `location`,
`top_companies`. **There is no posting-age parameter**, so `--jobage` is client-side.

An unknown keyword slug may return **404**; a partially unknown one is silently rewritten
(`llm-engineer-jobs-in-new-delhi` -> generic engineer jobs).

### Response structure

- One card per posting: `<article class="result-card_card__<hash> ..." itemProp="itemListElement">`.
  Class names are CSS modules (`<component>_<name>__<hash>`), so the CLI anchors on the
  `result-card_<name>__` prefix only. Inside a card:
  - `<meta itemProp="url" content="https://www.shine.com/jobs/<title>/<company>/<id>">`
  - `a.result-card_hit__` (title text; href has `?jobtype=rs&position_in_results=N`)
  - `span.result-card_company__`, `span.result-card_posted__` ("2 weeks ago")
  - `span.result-card_chip__` badges ("Actively Hiring", "Be An Early Applicant")
  - `span.result-card_meta-item__` x3, each with an icon `<use href="#result-card-icon-briefcase|rupee|pin">`
    and `span.result-card_meta-text__` (experience / salary / comma-separated locations)
  - `span.result-card_skills-item__` (with a decorative `span.result-card_skill-dot__` "·")
- React flight payload: `<script>self.__next_f.push([1,"<json string>"])</script>` chunks.
  Concatenated, they contain the dehydrated query: `"dehydratedAt":<ms>`, `"hasNextPage"`,
  `"pageCount"`, `"pageNumber"`, `"totalCount"`, and `"jobs":[{"badges":[...],"companyName",
  "detailUrl","experienceLabel","id","locations":[...],"postedAt":"YYYY-MM-DDTHH:MM:SS"
  (IST, no offset),"salaryLabel","skills","title",...}]`. The CLI takes only `postedAt` (strict
  ISO) and the counters from here; every displayed field comes from the visible card.
- `dehydratedAt` is the render time. Some slugs are served from a snapshot weeks old (cache
  headers say `s-maxage=300`, but the upstream render can be stale); the relative "posted"
  labels are relative to that render.
- Two JSON-LD blocks: BreadcrumbList and (sometimes) ItemList; no JobPosting on search pages.

## Detail

```
GET https://www.shine.com/jobs/<title-slug>/<company-slug>/<id>
```

Strip the search-result query string. The slugs are not validated: `/jobs/job/company/<id>`
serves the same posting, with `<link rel="canonical">` pointing at the real slugs. (Don't use
`/jobs/<id>`: `/jobs/1*` and `/jobs/9*` are disallowed.) A removed id returns 404.

### Response structure

- `<script type="application/ld+json">` with `"@type":"JobPosting"`: `title`, `hiringOrganization.name`,
  `identifier.value` (id), `url`, `datePosted` (`+05:30`), `validThrough`, `description` (plain text with
  `\n`, occasionally HTML), `employmentType` (`FULL_TIME`), `experienceRequirements.monthsOfExperience`,
  `industry`, `occupationalCategory[]`, `jobLocation[].address.addressLocality`, `skills[]`.
- Visible role card `section.role-overview-card_roleCard__`: `h1.role-overview-card_title__`,
  `span.role-overview-card_companyName__`, `<time dateTime>` in `role-overview-card_bylinePosted__`,
  and `div.role-overview-card_metaItem__` pairs of `metaLabel` / `metaValue` (Location, Experience,
  Salary, Type).
- Visible description: `<pre class="collapsible-jd-body_body__...">` (preferred by the CLI; JSON-LD
  description is the fallback).
- Skills also as `a.skills-list_skill__` links.
