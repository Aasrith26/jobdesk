# Test fixtures

Both files are **real responses recorded once on 2026-11-11**, then trimmed and
scrubbed:

- `channel-preview.html` - `GET https://t.me/s/opento_dev` (a public job channel,
  used here only as a markup sample). Trimmed to 7 of the 20 message blocks:
  plain English postings, a Russian-language posting, a multi-role digest, a
  forwarded post and an advert, so parsing is pinned on the shapes actually seen.
  The page `<head>`, the channel info card and the inline SVGs were removed.
- `message-embed.html` - `GET https://t.me/opento_dev/1182?embed=1`, the
  single-post embed `detail` uses. `<style>`/`<script>`/`<link>` were removed.

Scrubbing (`trim_tg.py` in the session scratchpad, not kept in the repo):

- every `@handle` in message text (recruiter / personal Telegram accounts) ->
  `@placeholder_handle`; any e-mail address -> `redacted@example.invalid`
- image URLs on `cdn*.telesco.pe` (signed tokens) -> `https://cdn.example/placeholder.jpg`
- `data-view`, `data-peer`, `data-peer-hash` and `api_hash` values -> `REDACTED`

Message text, dates, ids and the posting links are otherwise left as served, so
the fixtures still exercise Telegram's quirks (double-escaped `&amp;amp;` in hrefs,
`<i class="emoji"><b>⚡️</b></i>` emoji markup, `&#036;` entities, hashtag links
`?q=%23tag`).
