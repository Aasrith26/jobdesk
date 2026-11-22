---
name: company-boards-search
version: 1.0.0
description: >
  Use this skill to search the career pages of a curated list of target companies
  (AI labs, LLM-infra, voice-AI, RAG/search and Indian tech companies) directly
  through their official public ATS job-board APIs — Greenhouse, Lever, Ashby,
  SmartRecruiters and Workable — or to read one posting from those boards. Covers
  India (Bengaluru, Hyderabad, Pune, Gurugram, ...) and remote roles, and the list
  of companies is user-editable (companies.json). Trigger phrases: search company
  career pages, check target companies' jobs, which of my target companies are
  hiring, AI engineer / LLM / voice AI jobs at <company>, jobs at Sarvam / OpenAI /
  ElevenLabs / Databricks, startup jobs in Bengaluru or Hyderabad, remote AI jobs,
  look up this Greenhouse / Lever / Ashby job posting, naukri ke alawa company
  career page par jobs dhundo.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run wrapper/sources/company-boards-search/cli/src/cli.ts *)
---

# Company Boards Search Skill

Search live openings on **the companies' own career boards** — the source of truth
that aggregators copy from — by reading the official, public, unauthenticated
job-board APIs of five applicant-tracking systems:

| ATS | Public API |
|-----|-----------|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true` |
| Lever | `api.lever.co/v0/postings/<site>?mode=json` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/<name>?includeCompensation=true` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/<id>/postings` |
| Workable | `apply.workable.com/api/v1/widget/accounts/<sub>?details=true` |

No authentication, no API key, **zero runtime dependencies** (just `bun`). These
APIs exist for companies to publish their openings to third parties, so automated
reads are their intended use; keep volume reasonable anyway (one search = one
request per selected board).

## The company list (`companies.json`)

`wrapper/sources/company-boards-search/companies.json` is the list searched. It ships
with 66 verified boards (33 Ashby, 22 Greenhouse, 7 Lever, 2 SmartRecruiters,
1 Workable) tagged by theme. Edit it freely — each entry is:

```json
{ "name": "Sarvam AI", "ats": "ashby", "token": "sarvam", "tags": ["india", "llm", "voice", "indic"] }
```

- `token` is the board slug from the company's careers URL: `jobs.ashbyhq.com/<token>`,
  `job-boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`,
  `jobs.smartrecruiters.com/<token>` (case-sensitive), `apply.workable.com/<token>`.
- Shipped tags: `india` (Indian company or India-based roles), `voice`, `llm`,
  `llm-infra`, `rag`, `agents`, `indic`, `data`, `devtools`, `fintech`, `consumer`,
  `global`. Add your own; `--tag` matches whatever is there.
- After adding a company, verify the token: `companies --check --company <name>`
  (a wrong token shows `ERR` with "board not found (404)").
- `COMPANY_BOARDS_FILE=/path/to/list.json` points the CLI at another list.

## Commands

### Search

```bash
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search [flags]
```

- `--query <text>` / `-q <text>` — matched against the **title**, case-insensitively.
  Each word must appear at the **start of a word** (`ai` matches "Applied AI", not
  "Maintenance"; `llm` matches "LLMs"). Words are ANDed; separate alternatives with
  an uppercase ` OR ` or `|`; `"quoted phrase"` keeps words together:
  `-q "ai engineer OR ml engineer OR llm OR voice"`.
- `--in-description` — also match `--query` against the description (slower,
  broader; SmartRecruiters lists carry no description, so their postings match on
  title only).
- `--location <text>` / `-l <text>` — location filter; comma-separated values are
  ORed (`-l "Hyderabad,Bengaluru"`). Matched against every location the posting
  names (primary, secondary, office addresses, country from a country code). A few
  terms expand: `India` matches Indian cities/states as whole words (Bengaluru,
  Hyderabad, Pune, Gurugram, Noida, Chennai, Mumbai, ...) and not "Indiana";
  `Bangalore`≡`Bengaluru`, `Gurgaon`≡`Gurugram`, `Delhi` includes NCR. Any other
  term is a plain substring.
- `--remote` — include remote roles (no value). **Alone:** remote roles only, any
  region. **With `-l`:** the location's roles **plus** remote roles whose location is
  unrestricted ("Remote", "Anywhere", "Worldwide"); region-locked remote roles like
  "Remote - US" are left out unless they match `-l` themselves ("Remote - India").
- `--company <names>` — only these companies (comma-separated; name substring or
  exact token). Filters **before** fetching, so it also cuts requests.
- `--tag <tags>` — only companies with any of these tags (e.g. `india,voice`). Pre-fetch.
- `--ats <names>` — only these ATSes (`greenhouse,lever,ashby,smartrecruiters,workable`). Pre-fetch.
- `--jobage <days>` — published within N days (first-published date; Greenhouse
  falls back to last-updated when unpublished). Undated postings are excluded.
- `--page <n>` — 1-indexed page. Default 1.
- `--limit <n>` / `-n <n>` — results per page. Default 50.
- `--with-description` — include each result's plain-text description (`json` only;
  verbose — keep `--limit` small).
- `--timeout <seconds>` — per-request timeout. Default 30 (Lever answers big boards
  slowly).
- `--format json|table|plain` — default `json`.

Results are sorted newest first. `--remote` takes no value: `--remote remote` is
rejected (the extra word is an unexpected argument), as is any unknown flag.

### Detail

```bash
bun run wrapper/sources/company-boards-search/cli/src/cli.ts detail <ats:token:id|url> [--format json|plain]
```

Takes the `id` from a search result (`ashby:sarvam:36f89b00-...`) or a posting URL on
`job-boards.greenhouse.io` / `boards.greenhouse.io` (incl. `.eu.`), `jobs.lever.co`,
`jobs.ashbyhq.com`, `jobs.smartrecruiters.com` or `apply.workable.com/<account>/j/<code>`.
Returns the result fields plus `description` (HTML rendered to text, hidden markup
dropped) and `applyUrl`. Works for boards not in `companies.json` too.

A Greenhouse posting embedded on the company's own site (`...?gh_jid=123`, which is
the `url` many Greenhouse results carry) does not name its board, so pass the
result's `id` instead.

### Companies

```bash
bun run wrapper/sources/company-boards-search/cli/src/cli.ts companies [--tag t] [--ats a] [--company c] [--check] [--format json|table|plain]
```

Lists the configured boards with their public board URL. `--check` reads each
selected board and adds its current job count (or the error) — the way to verify
a newly added token.

## Usage examples

```bash
# Engineering roles in India across all target companies
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search -q "engineer" -l India --format table

# AI / LLM / voice roles in Hyderabad or Bengaluru, plus open-anywhere remote roles, last 30 days
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search -q "ai engineer OR ml engineer OR llm OR voice OR speech OR inference" -l "Hyderabad,Bengaluru" --remote --jobage 30 --format table

# Remote voice-AI roles at the voice companies
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search -q "voice OR speech OR audio" --tag voice --remote --format table

# LLM-serving roles that mention vLLM anywhere in the posting
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search -q "vllm OR inference OR serving" --in-description --tag llm-infra,india --format table

# Everything open at two companies
bun run wrapper/sources/company-boards-search/cli/src/cli.ts search --company "sarvam,smallest" --format table

# Full posting
bun run wrapper/sources/company-boards-search/cli/src/cli.ts detail ashby:sarvam:36f89b00-2010-4d23-aae3-17a2f53d9eaa --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, `/scrape` |
| `table` | Scanning many results (id in the last column) |
| `plain` | Reading a single job (`detail`) or a short list |

Search JSON:

```jsonc
{
  "meta": { "count": 50, "page": 1, "limit": 50, "total": 290, "companies": 66,
            "errors": [ { "company": "...", "ats": "...", "token": "...", "error": "..." } ],
            "warnings": [] },
  "results": [ {
    "id": "greenhouse:observeai:5432596008",   // pass to `detail`
    "title": "AI Agent Engineer", "company": "Observe.AI", "location": "Bengaluru",
    "date": "2026-09-23", "url": "https://...", "ats": "greenhouse", "token": "observeai",
    "department": "AI Solutions & Deployment", "team": null,
    "remote": null, "workplaceType": null,   // remote: true/false when the ATS says, null = unknown
    "employmentType": null, "updated": "2026-11-08", "compensation": null, "tags": ["india", "voice"]
  } ]
}
```

Missing values are `null`, never omitted. Errors go to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1` (codes: `UNKNOWN_FLAG`,
`BAD_ARG`, `BAD_CMD`, `NO_ID`, `BAD_ID`, `NOT_FOUND`, `NO_COMPANIES`, `CONFIG_ERROR`,
`ALL_BOARDS_FAILED`, `DETAIL_FAILED`, `SEARCH_FAILED`).

**Partial failure is not an error.** If some boards fail (timeout, 404 from a
stale token, 5xx after retries), the search still exits `0`, lists them in
`meta.errors`, and prints `{ "warning": "...", "code": "PARTIAL_RESULTS", "errors": [...] }`
on stderr. Only when **every** selected board fails does it exit `1` with
`ALL_BOARDS_FAILED`.

## Notes

- Each search reads every selected board in full (6 at a time) and filters
  locally — 66 boards take ~10s. Narrow with `--tag`/`--company`/`--ats` to read fewer.
- `remote`/`workplaceType` come from structured fields where the ATS has them
  (Ashby `workplaceType`, Lever `workplaceType`, SmartRecruiters `location.remote/hybrid`,
  Workable `telecommuting`, Greenhouse "Location Type" metadata); otherwise a
  "remote" in the location text sets `remote: true`, and anything else stays `null`.
  Many Greenhouse boards publish no workplace data at all.
- `url` is the posting page the company publishes (for Greenhouse often the
  company's own careers site with `?gh_jid=`); `applyUrl` (detail) is the
  application form when the ATS exposes one.
- Lever has no "published" date; `date` is its `createdAt`. Ashby and Workable have
  no single-posting endpoint, so `detail` re-reads that one board.
- SmartRecruiters lists are paged (100 per request, capped at 1000 postings per
  company; a truncated board is reported in `meta.warnings`).
- Verified on the live APIs but not shipped: SmartRecruiters `ServiceNow`,
  `BoschGroup`. Not found on these five public APIs (they use other ATSes or
  in-house boards): Gnani, Exotel, Haptik, Yellow.ai, Uniphore, Krutrim/Ola,
  Postman, Zepto, Hasura, Mistral, Uber.
