# MaxEdge site-style video kit

Social videos drawn as maxedge.live's own screens (Onest, the site's colour tokens, the green header bar and wordmark, flat cards, pill chips, green hits and red misses), voiced with Everygen "Astro". Approved by Owen on 22 Oct 2026. Used by the MaxEdge video desk scheduled task; the full run book is the Project doc `claude/video-site-kit.md`.

- `team_rows.sql` + `make_team_data.py`: today's qualifying fixtures (3+ goals, both teams scored, 2 or fewer) -> `data.json`
- `team_video.py`: team countdowns (hit-rate card, last 10 results, score pills, goals bar chart)
- `player_video.py`: player countdowns (hit-rate card, bar chart, match log, fixture card, home/away hero)
- `quiz_video.py`: the 8-question quiz plus the unrevealed bonus
- `site_kit.py`: shared CSS, JS timeline, wordmark, copy checks and voice handling
- `render_all.py`: renders `manifest.json` to MP4 (Playwright frames + ffmpeg)

Each script has a `script` mode that writes `<key>_script.txt`. Send that text to Everygen in ONE generate_voiceover call per video (1 credit each on 22 Oct), save `<key>_astro.wav` and `<key>_astro.json` (`{"sentenceEnds": [...]}`), then run `build ... astro`. Font: `npm pack @fontsource-variable/onest`, copy `onest-latin-wght-normal.woff2` here as `onest.woff2`.


## Rules added 22 Oct 2026 (Owen)
- **Club badges are patterned discs in the club's kit colours** (solid, stripes, hoops, halves, centre stripe or sleeves, with a lower band in the second colour), never initials and never the real crest. `site_kit.badge(name, size, col)`. Big clubs are curated in `KITS` (with `ALIAS` for short names); anything else uses its most common `lineups.team_colors` (passed through `team_rows.sql` as `h_col`/`a_col`), then a neutral disc.
- **One video for TikTok, Instagram and Facebook; no videos for X** (Owen, later on 22 Oct, replacing the two-cut rule). Every video ends on the end card: Like, Follow for more. Because the same file goes to TikTok, the end card neither shows nor speaks the site; maxedge.live goes in the Instagram and Facebook captions. `END_LINES` is one line, and `write_cuts` writes one file (`<file>.mp4`), returned as a one-entry list so callers are unchanged.
- **No animation sound effects in match breakdowns or format videos**: voice only (Owen, 22 Oct).
