# Test fixtures

Recorded once from the live GitHub REST API on 2026-11-11 (unauthenticated),
then trimmed to the fields the CLI reads and to a few items each:

- `search-issues-label.json` - `GET /search/issues` for
  `python is:issue is:open label:"help wanted" updated:>=...` (first 5 items,
  bodies cut to 500 chars).
- `search-issues-keyword.json` - `GET /search/issues` for the keyword OR query
  (`(hiring OR paid OR bounty OR contract)`, advanced search). The 3 recorded
  items are real **noise** hits (the words only appear in passing in the body)
  that the client-side check must drop; the last item duplicates the first
  label hit (must be de-duplicated). The first two items
  (`example-org/widget#7`, `example-co/infra#42`) are **synthetic**, added to
  cover a bounty label/title hit and a "paid task" body phrase, and the first
  carries a hidden HTML-comment injection and a zero-width space.
- `search-repos.json` - `GET /search/repositories` for
  `"we're hiring" in:readme archived:false pushed:>=...` (first 4 items).
- `issue-full.json` - `GET /repos/patsypppe/meridian/issues/31` with
  `Accept: application/vnd.github.full+json`.
- `repo.json` - `GET /repos/patsypppe/meridian`.
- `readme.html` - `GET /repos/langfuse/langfuse/readme` with
  `Accept: application/vnd.github.html+json`, cut down to the "We're hiring"
  block.
