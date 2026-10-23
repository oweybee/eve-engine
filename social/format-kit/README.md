# Format and breakdown video kit

Builds MaxEdge's match breakdowns and format videos (Predict the weekend, Streak watch, Weekend results,
This or that, Odd one out, Who is he, Guess the team, Higher or lower, monthly awards) in the site's design.
The daily countdowns and quizzes use social/video-kit instead.

Owen's rules (22 Oct 2026), built in: one file for TikTok, Instagram, Facebook and YouTube Shorts, never X;
voice only, no animation sound effects; kit-colour badge discs, never crests or initials; end card "Like and
follow for more" with no site; no em or en dashes; on-screen and spoken text passes the TikTok banned-word
check (fmt_kit runs it at build). Instagram/Facebook captions end "Link in bio" then "18+ | GamCare 0808 8020 133".

## Files
- `fmt_kit.py`: the `Video` class (scenes of ("say", text) steps plus an html(m, cut) function; m[i] is when
  step i starts, so elements can appear with data-in, data-pop, data-count, data-spin, data-row, data-t),
  `badge(club, size)`, the end card. Its `site_kit.py` is this folder's copy (CSS, JS, voice helpers).
- `format_example.py`: Predict the weekend and Streak watch, 23 Oct 2026. Copy it for any format video.
- `breakdown_example.py`: Bournemouth v AC Milan, 22 Oct 2026. Copy it for any match breakdown.
- `team_stats.sql` + `make_stats.py`: last 10 games per club as S.json for the breakdowns.
- `render_all.py out 30`: renders every page in `out/manifest.json` to MP4 (Playwright frames into ffmpeg).

## Run
1. Setup: `pip install --break-system-packages -q soundfile playwright numpy` (Chromium is preinstalled; do not run
   playwright install). Font: `npm pack @fontsource-variable/onest && tar xzf fontsource-variable-onest-*.tgz &&
   cp package/files/onest-latin-wght-normal.woff2 onest.woff2`.
2. Data: query the database on the day (matches, league_standings, player_match_stats, player_injuries); never the
   form column. Check every number you will say. Check team news for every player named; never call a player
   as playing unless the lineup is confirmed.
3. Write the day's script by copying an example. Every spoken string ends in . ? or ! and has no abbreviation
   with a full stop. Pass the extra CSS as the 4th argument of Video(...).
4. `VOICE=script python3 <script>.py out` writes `<key>_script.txt` per video. Make ONE Everygen
   generate_voiceover call per video with that text exactly, voiceId "astro". Save the audio as `out/<key>_astro.wav`
   and `{"sentenceEnds": timing.sentenceEnds}` as `out/<key>_astro.json`. Delete the script files.
5. `VOICE=astro python3 <script>.py out`, then `python3 render_all.py out 30`.
6. Look at frame 0, every scene and the last frame (ffmpeg, then Read) before uploading.
