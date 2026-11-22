# Test fixtures

Hand-written, trimmed responses in the exact shapes the five public job-board
APIs returned when this skill was built (2026-11). Company names, tokens and ids
are fictional (`example*`); field names, nesting, and quirks are real:

- `greenhouse.json` - `GET boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true`.
  `content` is entity-encoded HTML (`&lt;p&gt;`), `location.name` carries a trailing
  space, `first_published` can be null, `metadata` can be null or a list.
- `lever.json` - `GET api.lever.co/v0/postings/<site>?mode=json` (a bare array;
  `createdAt` in epoch ms; `lists[].content` is `<li>` items without the `<ul>`).
- `ashby.json` - `GET api.ashbyhq.com/posting-api/job-board/<name>?includeCompensation=true`
  (`isListed: false` entries must be dropped).
- `smartrecruiters.json` - `GET api.smartrecruiters.com/v1/companies/<id>/postings`
  (no description in the list; `fullLocation` has empty segments like `"Hyderabad, , India"`).
- `workable.json` - `GET apply.workable.com/api/v1/widget/accounts/<sub>?details=true`.
- `companies.json` - a companies list pointing at the fixture boards.
