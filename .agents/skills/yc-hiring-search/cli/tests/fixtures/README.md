# Test fixtures

Recorded once from the live yc-oss API on 2026-11-11 (data `last_updated`
2026-11-11T03:51Z), then trimmed:

- `hiring.json` - 10 real records picked from `companies/hiring.json` (1,498
  records, 2.6 MB) to cover: an India HQ (razorpay), India + Fully Remote
  (zuddl), Partly Remote UK (circuithub), two Fall 2026 AI companies, Spring
  2025 Fully Remote, Summer 2024 and Winter 2024 fintech, a Germany company and
  an `Unspecified` batch with no location. `long_description` cut to 600 chars.
- `all.json` - two of the same records plus one active, **not hiring** company
  from `companies/all.json` (6,387 records, 10.9 MB), for the `detail`
  fallback.
- `meta.json` - `meta.json` cut to `last_updated`, `readme` and the hiring
  entry.

Hidden-text cases are synthetic and live inline in `hidden-text.test.ts`.
