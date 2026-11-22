# yc-oss API reference

The endpoints and record shape this skill depends on. Update this file if the
yc-oss project changes. All verified live (HTTP 200, `application/json`) on
2026-11-11; data `last_updated` 2026-11-11T03:51Z.

| Endpoint | Size | Used for |
|----------|------|----------|
| `GET https://yc-oss.github.io/api/companies/hiring.json` | ~2.6 MB, 1,498 records, all `isHiring: true` | `search`, `detail` (first lookup) |
| `GET https://yc-oss.github.io/api/meta.json` | ~67 KB | `meta.data_last_updated` |
| `GET https://yc-oss.github.io/api/companies/all.json` | ~10.9 MB, 6,387 records (1,498 with `isHiring: true`) | `detail` fallback for a slug not in the hiring list |
| `GET https://yc-oss.github.io/api/` | 404 (no index page) | not used |
| `GET https://yc-oss.github.io/api/batches/<season-year>.json` | per batch | not used (the hiring list already covers every batch) |
| `GET https://yc-oss.github.io/api/companies/top.json` | ~174 KB | not used |

Endpoint list per the project README (`github.com/yc-oss/api`), which also
lists `black-founded`, `hispanic-latino-founded`, `women-founded`,
`nonprofit`, `app-video-public`, `demo-day-video-public` lists and
`changes/latest.json`.

Every request sends `User-Agent: ai-job-search-yc-hiring-cli/1.0` and
`Accept: application/json`, a 60 s timeout, and exponential backoff with
jitter on 429/5xx (500 ms doubling to 8 s, max 6 retries). 404 -> `NOT_FOUND`.

## Cache

`<os.tmpdir()>/ai-job-search-yc-hiring/` (`YC_HIRING_CACHE_DIR` overrides; the
tests use it). File name = API path with `/` -> `_`
(`companies_hiring.json`, `meta.json`, `companies_all.json`). Fresh for 24 h
by mtime; written atomically (tmp + rename). `--refresh` bypasses it; on a
failed download an expired file is served with `meta.cache: "stale"`.

## Record shape (`companies/*.json` is a JSON array of these)

```jsonc
{
  "id": 5,
  "name": "CircuitHub",
  "slug": "circuithub",                        // -> id; detail key
  "former_names": [],
  "small_logo_thumb_url": "https://...png",    // not used
  "website": "https://circuithub.com",         // -> website (http(s) only)
  "all_locations": "London, England, United Kingdom",   // -> location; "; "-separated, may include "Remote"
  "long_description": "CircuitHub offers ...", // -> snippet / detail description (plain text)
  "one_liner": "On-Demand Electronics Manufacturing",
  "team_size": 58,
  "industry": "Industrials",
  "subindustry": "Industrials -> Manufacturing and Robotics",
  "launched_at": 1322045523,                   // epoch s: company launch, NOT a posting date
  "tags": ["Hard Tech", "Hardware", ...],
  "tags_highlighted": [],
  "top_company": false,
  "isHiring": true,
  "nonprofit": false,
  "batch": "Winter 2012",                      // "Winter|Spring|Summer|Fall YYYY" or "Unspecified"
  "status": "Active",                          // hiring list: "Active" or "Public"
  "industries": ["Industrials", "Manufacturing and Robotics"],
  "regions": ["United Kingdom", "Europe", "Remote", "Partly Remote"],
  "stage": "Early",                            // "Early" | "Growth"
  "partners": "Unspecified",
  "app_video_public": false,
  "demo_day_video_public": false,
  "app_answers": null,
  "question_answers": false,
  "url": "https://www.ycombinator.com/companies/circuithub",   // -> url
  "api": "https://yc-oss.github.io/api/batches/winter-2012/circuithub.json"
}
```

Observed values (hiring list, 2026-11-11): batches from `Summer 2009` to
`Winter 2027` plus `Unspecified`; YC's short codes are W/S/F and **X for
Spring** (Spring 2025 = X25). Remote markers in `regions`: `Remote` (744),
`Partly Remote` (557), `Fully Remote` (187); `Remote` co-occurs with the other
two. India: 54 companies with region `India` (also `South Asia`).

## YC pages (linked, never fetched by the CLI)

`https://www.ycombinator.com/companies/<slug>` and `.../<slug>/jobs` (HTTP 200
for `circuithub/jobs` on 2026-11-11). ycombinator.com robots.txt allows `/`
for `*` except `/verify/*`, `/library?*`, `/companies?*` (the query-string
directory search).
