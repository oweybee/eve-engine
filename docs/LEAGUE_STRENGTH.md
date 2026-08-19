# League strength offsets

*19 August 2026. Migrations 076 and 077, `lib/leagueStrength.js`,
`lib/teamKey.js`.*

## 1. What was wrong

`team_elo` is one pool of ratings, and a rating is only meaningful against the
opponents that produced it. ELO is zero-sum within a match, so a set of clubs
that only ever plays itself conserves its own total and stays at the 1500
default forever. Measured over the completed corpus, the share of each league's
games played against a club from a different league:

| league | completed games | cross-league |
|---|---|---|
| Major League Soccer | 4,712 | **0.0%** |
| Liga MX | 2,790 | **0.0%** |
| J1 League | 3,144 | **0.0%** |
| Chinese Super League | 2,410 | **0.0%** |
| Premier League (Russia) | 2,016 | **0.0%** |
| Liga Profesional (Argentina) | 4,356 | 0.0% (2 games) |
| Serie A (Brazil) | 3,501 | 0.3% |
| … | | |
| Premier League (England) | 19,294 | 9.9% |
| Championship (England) | 3,952 | **50.3%** |
| Ligue 2 (France) | 1,868 | **53.7%** |

An MLS club on 1620 and a Premier League club on 1620 are not the same thing,
and `eloProbs` would call that fixture 50/50. **Inside a pool the ratings are
fine**, which is why this never showed up on a domestic board. It bites the
moment two pools are compared — which is exactly what a European tie is.

## 2. Two data faults had to be fixed first, and they were bigger

The offsets are fitted on replayed pre-match ratings, so the ladder had to be
right before the fit could mean anything. It was not.

**6,199 completed fixtures — 6.7% — were the same match twice.** `matches`
upserts on `external_id`, and the same fixture arrives under three id
namespaces: a historical `datahub_*` import (2005 → May 2025, the big five),
API-Football numerics (2022 →), and a handful from Betfair and The Odds API. In
the overlap both rows exist, and `computeElo` applied the ELO update **twice**
to every one of them — on the biggest clubs in the biggest leagues.

**And the clubs themselves were split.** The feeds spell clubs differently, so
"Tottenham Hotspur" and "Tottenham" were two `teams` rows, two ladder entries,
and often two *undetectable* duplicates because the pair carried different team
ids. Separately, `computeElo`'s key stripped any character outside `a-z0-9` —
and an accented letter is outside `a-z` — so "Bayern München" keyed as
`bayernmnchen` and split from "Bayern Munich". Twenty clubs were split that way,
including Atlético Madrid (1,040 appearances).

`elo_corpus` (migration 076) is the fix and it deletes nothing: a view that
resolves club identity through **`team_alias`** — this repo's existing, audited
answer to "which names are one club" — and keeps one row per (home, away,
kickoff date). Corpus 92,491 rows → **86,292 fixtures**, 1,226 clubs. The
accent class is fixed by a RULE in `lib/teamKey.js`, which folds `ö` to `o`
rather than deleting it, so it cannot go stale the way a list would.

**Nothing was pointing at `team_alias`, and once something did it found eight
false merges that were already there.** Deduplicating by canonical key made two
tests possible, and both are now permanent views that must stay empty:

- `team_alias_false_merges` — two clubs that have **played each other** cannot
  be one club. Four, every one a derby, every one from the `prefix` matcher:
  Los Angeles FC into LA Galaxy (12 fixtures), Dundee into Dundee Utd (7),
  FC Tokyo into Tokyo Verdy (6), Paris FC into Paris Saint Germain (2).
- `team_alias_cross_country` — a club does not play domestic league football in
  **two countries**. Four more, 1,166 games: Racing Club (Argentina) into Racing
  Santander (Spain), Rapid București into Rapid Vienna, Santos into Santos
  Laguna, Club América into América Mineiro.

`lib/teamNames.js` already documents three of exactly this shape. This is not an
ELO-only fix: `mx_team_form` partitions by canonical key too, so for as long as
those rows stood, LAFC's form was Galaxy's.

## 3. The fit

    d = (elo_home + θ[league_home] + home_adv) − (elo_away + θ[league_away])

and `d` goes through `lib/eloProbs.js` unchanged — one draw model over one
rating scale, not a second correction bolted onto a vector that was already
wrong.

θ is the maximum-likelihood estimate of the realised 1X2 outcome over **1,521
cross-league fixtures** (both clubs past 30 games, point-in-time pre-match
ratings replayed chronologically over `elo_corpus`), by coordinate ascent with
the Premier League pinned at 0. The offsets are identified only up to an
additive constant, so one league has to hold the origin.

    log-likelihood   −1521.69 at θ = 0  →  −1466.08 fitted
    2·ΔLL = 111.2 on 22 df, p far below 0.001

**Fitted to outcomes, never to a price.** No market number enters at any point —
the same rule the draw model was fitted under in migration 075.

### Only a genuinely inter-league competition may identify an offset

This restriction is load-bearing, not tidiness. The first fit took any fixture
whose two clubs' domestic leagues differed and returned **Liga MX at +14 and
Spain's Segunda at +33** — both stronger than the Premier League, both from
leagues with no European football at all. The fixtures behind them were ordinary
Brazilian and Argentine *league* games in which one club had been assigned the
wrong domestic league, because of the cross-country merges in §2. A domestic
league match is by definition not cross-league; if the league assignment says
otherwise, the assignment is wrong. The fit set is drawn only from the three
UEFA competitions and the League Cup.

That is how the false merges were found: they showed up first as an implausible
offset, not as a bad club rating. **A number that is obviously wrong is worth
more than a number that is quietly wrong.**

## 4. The result, and it validates itself

Nothing in the fit knows what a strong league is. It returns football's actual
pecking order.

| league | θ (ELO) | ±1 SE | n | identified by | UEFA-only refit |
|---|---:|---:|---:|---|---:|
| Premier League (England) | **0** *(reference)* | 18.4 | 356 | mixed | 0.0 |
| Bundesliga (Germany) | −38.1 | 20.8 | 242 | uefa | −37.2 |
| La Liga (Spain) | −48.5 | 20.8 | 245 | uefa | −46.4 |
| Ligue 1 (France) | −64.0 | 23.1 | 196 | uefa | −63.0 |
| Serie A (Italy) | −68.3 | 20.6 | 243 | uefa | −66.9 |
| Jupiler Pro League (Belgium) | −81.7 | 26.2 | 146 | uefa | −79.7 |
| Primeira Liga (Portugal) | −100.1 | 26.1 | 148 | uefa | −98.9 |
| **Championship (England)** | −108.0 | 30.9 | 121 | league_cup | — |
| Superliga (Denmark) | −115.3 | 36.6 | 79 | uefa | −114.5 |
| **League One (England)** | −124.6 | 30.5 | 124 | league_cup | — |
| Eliteserien (Norway) | −129.6 | 31.3 | 111 | uefa | −128.2 |
| Ekstraklasa (Poland) | −134.9 | 36.2 | 80 | uefa | −135.1 |
| Eredivisie (Netherlands) | −144.6 | 26.1 | 155 | uefa | −143.4 |
| Super League (Greece) | −151.2 | 31.9 | 104 | uefa | −150.0 |
| Super League (Switzerland) | −159.5 | 36.3 | 88 | uefa | −157.2 |
| Süper Lig (Turkey) | −167.8 | 29.1 | 124 | uefa | −166.6 |
| Premiership (Scotland) | −175.0 | 32.7 | 98 | uefa | −173.0 |
| Bundesliga (Austria) | −190.4 | 36.1 | 90 | uefa | −189.8 |
| Liga I (Romania) | −200.3 | 46.0 | 48 | uefa | −199.1 |
| Allsvenskan (Sweden) | −222.0 | 39.3 | 73 | uefa | −230.9 |
| **League Two (England)** | −238.1 | 33.4 | 104 | league_cup | — |
| Premier Division (Ireland) | −310.5 | 67.1 | 27 | uefa | −309.4 |
| Veikkausliiga (Finland) | −327.5 | 55.1 | 40 | uefa | −324.9 |

The English pyramid falls out as 0 / −108 / −125 / −238 without being told it is
a pyramid.

**Robustness.** The English lower divisions are identified almost entirely by
the League Cup (Championship 119 of 121, League One 120 of 124, League Two 104
of 104), where Premier League sides rotate heavily. Refitting on UEFA ties alone
— dropping 207 matches — moves every European offset by at most **2.6** ELO
points, except Sweden at 8.9. All are far inside standard errors of 18 to 67, so
the two competitions agree and the League Cup is not distorting the scale.

## 5. Coverage: what is actually refused, and it is almost nothing

The first version keyed the offset by LEAGUE and refused any pair it could not
place. Measured against the next thirty days — 1,472 fixtures — that refused
111. Almost all of it turned out to be neither a missing offset nor a real
refusal.

**The big one was a lookup bug.** A club's league was read as "the division it
last completed a season in". In August that is wrong for every promoted and
relegated club. **Inter v Monza is a Serie A fixture**, but Monza last completed
a season in Serie B, so the pair looked cross-league, the two offsets failed to
cancel, and an ordinary domestic match was shifted by more than a hundred rating
points. 47 fixtures: Serie A/Serie B, La Liga/Segunda, Ligue 1/Ligue 2,
Bundesliga/2. Bundesliga.

**The competition is the league.** If a fixture IS a Serie A match then both
clubs are Serie A clubs that day, whatever they did last May.
`competitionIsDomesticLeague` is a required argument to `adjustPair` and there
is no default: a caller that omits it gets a refusal, because the alternative
failure — silently shifting a domestic forecast — is invisible and therefore
worse. It is the same principle the fit already used in §3.

**The `not_estimable` leagues refused nothing at all.** MLS, Liga MX, J1, the
Chinese Super League, the Russian Premier League and Argentina are closed pools
— that is *why* they have no offset — and a closed pool never produces a
cross-league fixture. **Zero** of the 1,472 were refused on their account. The
refusal is vacuous for exactly the leagues that look worst in §1, and their
domestic boards were never affected, because same-league offsets cancel.

**What remained was 48 fixtures where a club has no league at all** — the
untracked-nation clubs that appear only in European ties (`ELO_CALIBRATION.md`
§7). 314 such clubs are in the corpus.

Those need no *league* offset, because they have no closed pool to correct:
every game they have played in our data is a cross-pool tie, so their rating is
already anchored to the global ladder. What they inherit instead is their
**opponents' inflation** — a Faroese club that has only played Norwegian sides
earned its rating against ratings themselves ~130 points high, so it carries
~130 points of the same error. `team_scale` (migration 078) estimates that as
the meetings-weighted mean θ of the opponents actually played. 161 of the 314
have at least one rated opponent, 106 have four or more.

That is a **first-order correction, not a fit**, and it is labelled
`source = 'opponents'` so no caller can mistake it for one. It carries
`n_rated_opponents` and `adjustPair` gates on it, defaulting to four.

`team_scale` is a **view, not a table**: the league offsets are fitted and are
therefore frozen data, but these are derived — a deterministic function of
`elo_corpus` and `league_strength` — so they cannot go stale, and a new European
tie improves a club's estimate the moment it settles.

### Where that leaves it, over the next thirty days *(measured 19 Aug 2026 — a count, not a constant; re-run the query in §8)*

| | fixtures | |
|---|---:|---|
| domestic league — no offset needed, offsets cancel | 1,424 | 96.7% |
| cross-league, both clubs on fitted league offsets | 40 | |
| cross-league, a club placed by ≥4 rated opponents | 40 | |
| cross-league, a club placed by fewer (gated off by default) | 8 | |
| **cannot be placed at all** | **2** | **0.14%** |

The two that remain are ties in which *both* clubs are untracked-nation sides
that have only ever played each other's kind — there is genuinely nothing to
anchor them to, and the honest output is silence.

## 5b. An unplaceable fixture says so, by name

`adjustPair` returns **null**, never 0. Zero is a claim — it says this club sits
exactly on the Premier League scale — and for an MLS club that is wrong by
around two hundred rating points and nobody would ever see it happen, because a
wrong probability looks exactly like a right one.

But a withheld forecast was, until now, withheld *silently*, and a fixture that
produces no number looks exactly like a fixture nobody asked about. This repo
has ruled on that shape twice already: `value_signals.score_withheld_reason`
strips the claim and records why, and `/api/inplay` reports which of four causes
made it empty, because three features shipped dead when "returns nothing" was
confused with "cannot return anything".

So there are two ways to ask, and they never disagree:

- **`placement()`** in `lib/leagueStrength.js` returns a structured verdict —
  either the adjusted pair, or `{placed: false, code, reason, sides}` with a
  machine code (`club_unplaced`, `club_thinly_placed`, `no_rating`,
  `no_competition_context`) and a reason naming the club. `adjustPair` stays as
  the thin numbers-only wrapper returning null, so no caller can read a rating
  off a refusal by accident.
- **`fixture_placement`** (migration 079) is the same verdict computed in SQL
  for every upcoming fixture, so the reason is queryable now, before any surface
  exists to draw it.

Over the next thirty days, measured 19 Aug 2026: 1,370 placed by the competition rule, 54 on fitted
league offsets, 38 on opponent-derived ones, and **10 unplaced** — five
two-legged ties, each naming its cause:

| tie | why |
|---|---|
| Rangers v FK Jablonec (both legs) | FK Jablonec has no place on the ELO scale — no domestic league in the corpus and no rated opponent |
| Beşiktaş v Kauno Žalgiris | Kauno Žalgiris is placed only by 2 rated opponent(s), under the 4 required |
| Atalanta v Hapoel Tel Aviv | Hapoel Tel Aviv, 2 rated opponents |
| Egnatia Rrogozhinë v Lillestrom | Egnatia Rrogozhinë, 2 rated opponents |
| Dinamo Tirana v Pafos | Dinamo Tirana, 2 rated opponents |

Eight of the ten are the 4-opponent gate, not a total absence — they would place
on a looser threshold, and `min_rated_opponents` is a column so that judgement
can be revisited in one place.

### One definition of each rule

Migration 079 also removes two duplications that were about to appear:

- **`team_key_map`** — the team-id-to-canonical-key mapping was inline in
  `elo_corpus`, which was fine while `elo_corpus` was the only consumer. Upcoming
  fixtures need it too, so it is a view of its own now and the accent-folding
  string exists in exactly one place in SQL.
- **`team_scale.is_usable`** — the four-rated-opponents gate was about to live in
  both the SQL view and `lib/leagueStrength.js`. It is a column; the module reads
  it rather than re-deciding it. A threshold written in two languages is two
  thresholds.

There is deliberately **no compiled fallback table** in `lib/leagueStrength.js`.
`MODEL_SIGMA` is the cautionary tale: a hand-copy that disagreed with the
database twice in production and threw neither time. If the view has not loaded,
every cross-league pair is refused — loudly, with a reason.

## 5c. How these numbers stay right

Three of the artefacts here update themselves and two do not, and it matters
which is which.

**Self-updating (views).** `team_key_map`, `elo_corpus`, `team_scale`,
`fixture_placement` and every health check are views over live tables. A new
result, a new alias, a new fixture list — all reflected on the next read. An
orphan club's opponent-derived offset improves the moment another tie settles.

**A CLUB'S LEAGUE IS FORWARD-LOOKING, which is what makes August safe.**
`team_scale` originally read a club's league as the division it last *completed*
a season in, which in August is last season's for every promoted and relegated
club. Migration 078's competition rule hid that for domestic fixtures, but not
for cup ties, where the competition cannot tell you the division. Measured
19 Aug, three League Cup ties six days out were affected: Coventry, Hull City and
Ipswich were all scaled as **Championship (−108)** when they had been promoted to
the **Premier League (0)**. A 108-point error, in the same direction every time,
on a well-formed forecast that looked fine.

A club's league is now the league of its **soonest upcoming domestic fixture**,
falling back to the most recent completed one only when nothing is scheduled. A
fixture list is published before a season starts, so a promoted club is right
from the moment its calendar lands. `team_scale_stale_league` is the invariant
and is empty.

**Frozen (the fit).** `league_strength` holds fitted parameters and does not move
on its own — correctly, since a parameter that drifts under you is not a
parameter. Two things keep it honest:

- **`fitLeagueStrength.js` is the refit**, and it is the artefact that was
  missing: the original offsets were produced by hand in scratch SQL tables that
  were then dropped, so nothing could reproduce or check them. The script
  replays the ladder with `lib/elo.js` and evaluates the likelihood through
  `lib/eloProbs.js` — the SAME maths every forecast uses, rather than the second
  plpgsql implementation the first fit relied on. `--dry-run` reports without
  writing. It marks every league it cannot identify `not_estimable`, so a stale
  row can never survive a refit as though it had been re-measured, and it warns
  on any league that moves by more than its own standard error.
- **`league_strength_staleness`** shows how much cross-league evidence has landed
  since `fitted_at`, per league. Empty means current. A league appearing there
  with `status = not_estimable` and `n_obs_now > 0` has become fittable and is
  being refused for no reason any more.

**The estimator is checked against ground truth, not against plausibility.**
−108 for the Championship looks reasonable whether the fit is right or subtly
wrong, so `engine.fitleaguestrength.test.js` simulates matches from offsets it
chose itself and asks the fitter to recover them. It does, to within 25 ELO
points on 6,000 observations — well inside the 18–67 standard errors the real fit
reports. The pinned league stays at the origin, a common shift leaves the
likelihood unchanged, and the profile interval brackets the estimate and narrows
with data.

**Refit when** `league_strength_staleness` is non-empty and the new evidence is
material — as a rule of thumb, when a league has gained a season's worth of
European ties (roughly 20+ observations, or `pct_new` above ~20%). The natural
cadence is once per European season. **The published values below were produced
by the original SQL fit; run `node fitLeagueStrength.js --dry-run` once against
production and confirm it reproduces them** before relying on the script for a
real refit.

**Known limits that time does not fix.** The offsets average 2022–2026 and a
league's strength drifts; the fit has no time-varying term. And the 14
`not_estimable` leagues will stay that way until they play someone outside their
own pool, which for MLS, Liga MX, J1, the Chinese Super League, the Russian
Premier League and Argentina means never, within this corpus.

## 6. What this does NOT license

**It does not make the untracked small leagues comparable.** That was the
question this work came from — can we track the ~34 countries whose clubs appear
in European ties (see `ELO_CALIBRATION.md` §7)? Those clubs still have no
domestic league in our data, so they have no offset and never will until their
leagues are ingested. This machinery is what would make such an ingest *safe*;
it is not a substitute for it.

**It does not license a cross-border disagreement sentence.** The 10pp
`min_publishable_gap` for ELO was fitted on 16,480 matches from five English
divisions and has never been tested on a cross-border tie. Migration 075 already
made the threshold a property of the model; a cross-border tie is a different
measurement regime and needs its own row before anything is published from it.

**The offsets are static.** A league's strength drifts across seasons and this
fit averages 2022–2026. Refit when the corpus grows materially.

## 7. Reproducing it

    node fitLeagueStrength.js --dry-run     # fit and report, write nothing
    node fitLeagueStrength.js               # fit and write league_strength

That script IS the recipe — it replays `elo_corpus` with `lib/elo.js`, evaluates
the likelihood through `lib/eloProbs.js`, coordinate-ascends with the Premier
League pinned, and takes standard errors from the profile likelihood at
ΔLL = 0.5. The knobs (`MIN_GAMES` 30, `MIN_OBS` 27, `MAX_SE` 70, `REFERENCE`,
`INTER_LEAGUE`) are exported constants at the top of the file.

## 8. The health checks, and what each one means

All five should be empty. Query them after any ingest change, alias rebuild, or
refit.

| view | non-empty means |
|---|---|
| `team_alias_false_merges` | two clubs that have PLAYED each other share one canonical key |
| `team_alias_cross_country` | one canonical key plays domestic football in two countries |
| `team_scale_stale_league` | a club is scaled by a division it is not next scheduled to play in |
| `league_strength_staleness` | cross-league evidence has landed since the last fit |
| `fixture_placement` where `status='unplaced'` | fixtures that will get no forecast, each with a reason naming the club |

The last is not a defect — it is the visible form of a withheld forecast, and it
should be read rather than emptied.

    select status, basis, count(*) from fixture_placement
    where kickoff_at < now() + interval '30 days' group by 1,2;
