# Telegram public channel preview reference

The pages this skill depends on, and the markup it parses. Update this file if
Telegram changes the preview markup. Both endpoints are public and need no login;
verified live (HTTP 200) on 2026-11-11.

| Endpoint | Used for |
|----------|----------|
| `GET https://t.me/s/<channel>` | `search`: the channel's ~20 most recent messages |
| `GET https://t.me/<channel>/<id>?embed=1` | `detail`: one post (the widget-embed page, ~5 KB) |
| `GET https://t.me/s/<channel>?before=<id>` | Not used: older messages (would multiply requests) |
| `GET https://t.me/robots.txt` | Read by `tools/robots_check.py`; **404** on 2026-11-11 = no published policy |

Every request sends `User-Agent: Mozilla/5.0 (compatible; ai-job-search-telegram-cli/1.0)`,
a 20 s timeout, at most one request every 2 s (retries included), and exponential
backoff with jitter on 429/5xx (500 ms doubling to 8 s, max 6 retries; numeric
`Retry-After` honoured up to 30 s). 404 -> channel `not_found` / post `NOT_FOUND`.

Before each page request the CLI runs `python tools/robots_check.py <url>`
(exit 0 + `ALLOWED ...` = fetch; anything else = skip). Results are cached per
URL for the run.

## Channel usernames

Public usernames are 4-32 characters `[A-Za-z0-9_]`, starting with a letter
(`CHANNEL_RE`). `t.me/s/<name>` for a user, bot, group or a channel with the
preview disabled answers **200** with a profile card and no message blocks; the
CLI reports that channel as `not_public`.

## Message markup (`parseMessages` in `cli/src/helpers.ts`)

```html
<div class="tgme_widget_message_wrap js-widget_message_wrap">          <!-- list page only -->
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="<channel>/<id>" data-view="...">
    <div class="tgme_widget_message_user">...</div>
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_forwarded_from ...">...</div>      <!-- forwarded posts -->
      <div class="tgme_widget_message_author ...">channel title</div>
      <a class="tgme_widget_message_photo_wrap ...">...</a>              <!-- optional media -->
      <div class="tgme_widget_message_text js-message_text" dir="auto">
        <b>Title</b><br/>Line 2<br/><a href="https://...">label</a> ...
      </div>
      <div class="tgme_widget_message_footer ...">
        <a class="tgme_widget_message_date" href="https://t.me/<channel>/<id>">
          <time datetime="2026-11-02T07:01:26+00:00" class="time">07:01</time></a>
      </div>
```

- The page is split at every `<div class="tgme_widget_message ..." data-post="...">`
  (the `_wrap` div exists only on the list page; the embed page has the message
  div directly under `<body>`), and each chunk is parsed independently.
- Text = inner HTML of the first `div.tgme_widget_message_text` (matched by div
  depth). A reply's quoted text uses `tgme_widget_message_metatext` and is not picked up.
- Date = `datetime` of the `<time>` inside `a.tgme_widget_message_date`.
- URL = `https://t.me/` + `data-post`.

## Text quirks

- Line breaks are `<br/>`; bold/italic are `<b>`/`<i>`.
- Emoji are `<i class="emoji" style="background-image:..."><b>⚡️</b></i>`: tags are
  stripped and the character kept; the variation selector U+FE0F is removed by
  `stripInvisible`.
- Hashtags are relative links `<a href="?q=%23tag">#tag</a>`: text kept, link dropped.
- Link `href`s are **double-escaped** (`?a=1&amp;amp;b=2`); the CLI decodes once and
  folds the remaining `&amp;` once more. Autolinked text (`CVAT.ai` ->
  `http://CVAT.ai/`) keeps its visible text; other links render as `label (url)`.
- Numeric entities such as `&#036;` (`$`) and `&#33;` (`!`) are common.
