# MaxEdge site-style video kit

Social videos drawn as maxedge.live's own screens (Onest, the site's colour tokens, the green header bar and wordmark, flat cards, pill chips, green hits and red misses), voiced with Everygen "Astro". Approved by Owen on 22 Oct 2026. Used by the MaxEdge video desk scheduled task; the full run book is the Project doc `claude/video-site-kit.md`.

- `team_rows.sql` + `make_team_data.py`: today's qualifying fixtures (3+ goals, both teams scored, 2 or fewer) -> `data.json`
- `team_video.py`: team countdowns (hit-rate card, last 10 results, score pills, goals bar chart)
- `player_video.py`: player countdowns (hit-rate card, bar chart, match log, fixture card, home/away hero)
- `quiz_video.py`: the 8-question quiz plus the unrevealed bonus
- `site_kit.py`: shared CSS, JS timeline, wordmark, copy checks and voice handling
- `render_all.py`: renders `manifest.json` to MP4 (Playwright frames + ffmpeg)

Each script has a `script` mode that writes `<key>_script.txt`. Send that text to Everygen in ONE generate_voiceover call per video (1 credit each on 22 Oct), save `<key>_astro.wav` and `<key>_astro.json` (`{"sentenceEnds": [...]}`), then run `build ... astro`. Font: `npm pack @fontsource-variable/onest`, copy `onest-latin-wght-normal.woff2` here as `onest.woff2`.
