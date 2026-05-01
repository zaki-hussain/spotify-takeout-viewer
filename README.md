# spotify-takeout-viewer

A minimal, fully-local web dashboard for the Spotify *Extended Streaming
History* export. No backend, no analytics, no build step — just open
`index.html` in a modern browser.

## Quick start

```bash
# any static server works
python3 -m http.server 8000
# then open http://localhost:8000
```

Then drop in your `Streaming_History_Audio_*.json` files and explore.

## What it shows

- **KPIs** — total listening time, plays, unique tracks/artists/albums,
  active days, longest streak, shuffle share.
- **Listening over time** — monthly + weekly hours, with hover tooltips.
- **Habits & timing** — hour × day-of-week heatmap, hour-of-day bar,
  day-of-week bar.
- **Calendar** — GitHub-style heatmap, one per year.
- **Top artists / tracks / albums** — all-time, with bar overlays.
- **Year-by-year** — top 10 artists and tracks for each calendar year.
- **Discovery** — first-time tracks and artists per month.
- **Top-artist share over time** — stacked area, both absolute and
  normalized (percentage).
- **Behaviour** — `reason_start` / `reason_end` distributions and the
  most-skipped songs.
- **Platforms & places** — by device and by `conn_country`.
- **Streaks & milestones** — your 1st / 100th / 1000th / 10kth play.

After enrichment (see below) extra sections appear:

- **Genres** — totals across all artists you played.
- **Audio features** — weighted-average energy, valence, danceability,
  etc., and time-series for each.
- **Mood map** — every unique track plotted on a valence × energy
  scatter, sized by play count.
- **Taste vintage** — listening time by track release year.
- **Popularity** — hours listened by Spotify's 0–100 popularity score.

## Enrichment

The streaming-history export does *not* include genres, popularity,
release dates, or audio features. There are two privacy-first ways to
get them:

1. **Spotify PKCE OAuth (recommended).** Click *enrich*, follow the
   three steps (create a Spotify dev app, paste the Redirect URI,
   paste your Client ID), then click *connect spotify*. The browser
   does the entire OAuth dance — there is no backend and no client
   secret. The token is stored only in your browser's IndexedDB and
   is used to call `/v1/tracks`, `/v1/audio-features`, and
   `/v1/artists` for every unique track in your history.

2. **Exportify CSV import.** If you'd rather not authorise an app,
   export your playlists with [Exportify](https://watsonbox.github.io/exportify/),
   drop the CSVs in via the *use playlist CSV instead* button, and
   any track present in those playlists will be enriched. Coverage
   depends on what you've put in playlists.

Either way, all data stays in IndexedDB on this device.

## Privacy

- 100% client-side. No data ever leaves your machine, except for the
  catalog API requests during enrichment (which only contain track IDs,
  not your stream history).
- Use *reset* to wipe everything (streams, tracks, tokens) instantly.

## File layout

```
index.html
styles.css
src/
  main.js       UI orchestration + section rendering
  parser.js     parses JSON exports, normalizes streams
  store.js      IndexedDB wrapper (streams, tracks, artists, files, meta)
  insights.js   pure aggregation/analysis functions
  charts.js     small SVG charts (line, bar, heatmap, calendar, scatter, stacked area)
  enrich.js     Spotify PKCE OAuth + batch enrichment + CSV fallback
```

No frameworks, no bundlers, no third-party JS dependencies.
