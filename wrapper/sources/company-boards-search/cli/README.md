# company-boards-cli

CLI that searches a curated, user-editable list of companies' career boards
through the official public job-board APIs of **Greenhouse, Lever, Ashby,
SmartRecruiters and Workable**.

**Data source**: the ATS public posting APIs (see `../url-reference.md`).
**Company list**: `../companies.json` (override with `COMPANY_BOARDS_FILE`).
**Authentication**: none.
**Dependencies**: none at runtime (plain `bun` + `fetch`). `bun install` only pulls
TypeScript dev types for `typecheck`.

## Installation

```bash
cd wrapper/sources/company-boards-search/cli
bun install   # optional — dev types only
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Fan out over the selected boards (6 at a time), filter and page client-side |
| `detail <ats:token:id\|url>` | One posting with its full plain-text description |
| `companies` | List the configured boards; `--check` adds live job counts |

`search` and `companies` accept `--format json|table|plain`; `detail` accepts
`--format json|plain`. Default is `json`. Errors are written to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`; unknown flags are rejected.
A search where only some boards fail still exits `0` and lists them in
`meta.errors` (plus a `PARTIAL_RESULTS` warning on stderr).

## Quick examples

```bash
bun run src/cli.ts search -q "engineer" -l India --format table
bun run src/cli.ts search -q "voice OR speech" --remote --format table
bun run src/cli.ts search -q "ai engineer OR llm" -l "Hyderabad,Bengaluru" --remote --jobage 30 --format table
bun run src/cli.ts detail ashby:sarvam:36f89b00-2010-4d23-aae3-17a2f53d9eaa --format plain
bun run src/cli.ts companies --check --format table
```

## Layout

| File | Role |
|------|------|
| `src/cli.ts` | Flag parsing/validation, help, dispatch |
| `src/helpers.ts` | `jsonFetch` (backoff, timeout), HTML-to-text + `visibleHtml`/`stripInvisible`, companies.json loader, query/location filters |
| `src/ats.ts` | Per-ATS list/detail fetchers and normalizers onto the shared `Job` shape |
| `src/commands/*.ts` | `search` (fan-out, filter, sort, render), `detail`, `companies` |

## Tests

```bash
bun run test        # offline suite (stubbed fetch + fixtures) plus one live smoke test
COMPANY_BOARDS_SKIP_LIVE=1 bun run test   # offline only
bun run typecheck
```

The live smoke test does one fan-out over the `india`-tagged boards and one
`detail` on its first hit. Fixtures in `tests/fixtures/` are hand-written in the
exact shapes the APIs return (see `tests/fixtures/README.md`).

See `../SKILL.md` for the full flag reference.
