# Fantasy Value Finder

Season-long fantasy football player analysis for a 10-team league.
**Numbers first. Team context second. AI connects the dots.**

The point is not to rank players — the market already does that. The point is to
find value the market is late on: players whose snap share AND opportunities are
rising while their price hasn't moved.

The app leads with a **Players explorer** built on real game logs — WOPR,
target and air-yards share, EPA per play, yards per target, catch rate, YAC,
first downs, explosive plays — sliceable by season / last 3 games / last game.
A draft board is still included for draft day, but the focus is the season.

A **Teams** page covers the other half: opportunity is a fixed pie, so the
page reconstructs each offense's weekly target total from player shares and
shows how that pie is divided, how the division is moving, what departed
players vacated, and — in the *ripple watch* — which teammates gained usage
alongside an absence. Ripple links are labeled as observed co-movement, never
as proven causation.

The same page carries the **red-zone pie**: touches inside the 20 and inside
the 5, which is where touchdowns actually get decided and where the pecking
order is often not the one between the 20s. Red-zone shares need no
reconstruction — the play-by-play source sees every snap in the league, so
the denominator is exact.

## Run it

```bash
npm start          # → http://localhost:3210
```

Refresh data (fetches all sources, rebuilds the player database):

```bash
npm run refresh
```

Then restart the server. Run tests with `npm test`.

## Data sources (all free)

| Role | Source |
|---|---|
| ADP | Fantasy Football Calculator API (PPR, 10-team, live mock drafts) |
| Expert rankings | FantasyPros expert consensus (PPR cheat sheet page) |
| Weekly stats 2025 | nflverse `stats_player_week_2025.csv` |
| Snap counts 2025 | nflverse `snap_counts_2025.csv` |
| Red-zone usage 2025 | nflverse `play_by_play_2025.csv.gz`, reduced at ingest |
| Player metadata | Sleeper API (teams, depth charts, injury status) |
| Trade-market values | [Stats Guy Fantasy](https://statsguyfantasy.com) (free API; values from >1M real Sleeper-league trades, non-SF redraft format) |

Every snapshot is stored with source + fetch timestamp (`data/raw/*.meta.json`),
and every number in the UI is traceable to its source. Conflicts between
sources are recorded on the player record, not silently resolved.

## What it does

- **League rosters** — all ten teams, named and editable, with any player
  assignable to any team from the League page, the Players explorer or the draft
  board. Rosters can be pasted in bulk; names that do not match are reported
  rather than quietly skipped. Roster-size and bye problems are flagged, never
  blocked. Ownership is the stored fact — "drafted" and "mine" are derived from
  it, so they cannot drift apart.
- **Draft board** — top 250 (200 core + 50 sleeper watch) with ADP, expert rank,
  AI rank, trend arrows, sleeper badges, bye, availability, and personal ranks.
  Click-to-track picks (mine / gone / undo).
- **AI assessment** — a deterministic, transparent re-ranking: market baseline
  (ADP + expert average) adjusted only for evidence in the data (usage trends,
  unsustainable spikes, injury designations). Every adjustment is emitted as a
  readable factor. Confidence % measures evidence strength, not win probability.
- **Custom scoring** — PPR, half-PPR, standard, or a per-stat rule set, edited on
  the Data page. Points are computed from each game's components rather than taken
  from a precomputed total, so a change re-scores every game log and flows through
  trends, the AI rank, team pages and the chat. Changing it re-scores in memory and
  downloads nothing.
- **Red-zone usage** — a Players-explorer preset and a Teams panel covering
  touches inside the 20 and inside the 5, red-zone TDs, and each player's
  share of the team's scoring chances. Counts lead, rates follow: a 50% TD
  rate on two touches is not a finding, so the denominator is always shown.
- **Trend detection** — last 3 games played vs season average. A sleeper signal
  requires snaps AND opportunities both rising; point spikes without usage
  growth are flagged as noise.
- **Sleeper radar** — three states: recommendation / emerging / sleeper signal,
  with the raw evidence shown for each.
- **Market page** — biggest disagreements between ADP, experts, and the AI,
  with the reasons the AI differs.
- **Recommendations** — roster-aware (needs, byes, tier scarcity), with
  Why/Risk bullets. Positional warnings, never forced picks.
- **Personal ranks** — yours, never overridden; disagreements are explained.
- **AI chat** — grounded in the app's actual data. Uses Claude
  (`ANTHROPIC_API_KEY` or an `ant auth login` profile) when available; falls
  back to a built-in deterministic query engine when not.
- **History** — every recommendation logged with its full context
  (`data/history.jsonl`) for later accountability review.

## Architecture

```
src/ingest/     fetch raw snapshots (each source independent, none blocking)
src/normalize/  name/team matching, mode resolution → data/players.json
src/analyze/    fantasyPoints (configurable scoring), playerStats (windowed
                metrics), teamContext (opportunity distribution + red-zone pie
                + ripple), trends, signals, score (AI rank), market
                comparison, recommendations
src/analyze/league.js   team rosters, warnings, bulk name resolution
src/ai/         chat grounded in structured data (Claude + fallback)
src/store/      league rosters (owners + pick order), personal ranks, history
src/yahoo/      dormant Yahoo draft sync (credential-gated)
server/         zero-framework node:http API + static frontend
public/         vanilla-JS UI (no build step); table.js is the shared
                sort/filter machinery, players.js the explorer
```

`data/players.json` is a **generated build artifact and is not committed** —
the server builds it automatically on first run and refreshes it whenever it
is more than 20 hours old.

### Stat conventions (they change the numbers)

- **Rate stats** (yards per target, per carry, catch rate) are computed from
  window **totals**, never as a mean of per-game ratios — one 1-target game
  should not weigh as much as a 10-target game.
- **Share stats** (target share, air-yards share, WOPR) *are* per-game
  averages, which is what "per-game usage" means and how the source reports
  them.
- **Opportunity** is position-aware and shared with the trend engine:
  RB = carries + targets, WR/TE = targets, QB = attempts + carries.
- **Red zone** is inside the 20; **goal line** is inside the 5, a strict
  subset of it. Both are counted from play-by-play with the same rules
  nflverse uses for its weekly totals — applied without a yardline filter
  those rules reproduce the published season targets and carries for every
  player exactly, which is what makes the red-zone subset trustworthy.
  Two-point conversions are excluded, as nflverse excludes them.
- **Red-zone shares divide by the true team total**, not by the tracked
  players — the play-by-play file has every snap, so nothing is inferred.
  The share that went to players outside the top-250 universe is displayed.
- **Fantasy points** are computed by `analyze/fantasyPoints.js` from component
  stats, never read from a precomputed total. Under PPR rules the engine
  reproduces nflverse's own `fantasy_points_ppr` for every one of the 18,539
  regular-season player-weeks in the source file, which is what makes the
  custom rule sets trustworthy — they are the same arithmetic with different
  coefficients. nflverse's figure is kept on each game row untouched, as the
  reference the engine is checked against.
- **Fumbles**: only sack, rushing and receiving fumbles are charged. The raw
  `fumbles_lost_total` also counts special-teams muffs, which fantasy does not
  penalize — using it over-charged return men by 2 points a muff.
- Undefined rates render as `—`, never as `0`. A red-zone blank means the
  play-by-play source has not covered those games; `0` means the player was
  genuinely shut out. The two are never conflated.
- **ADP and expert ranks stay PPR** whatever your scoring is set to: both come
  from PPR-specific endpoints and cannot be converted. Under non-PPR scoring the
  app says so rather than implying the comparison is like-for-like.

### Data pipeline

| Source | Snapshot | Role (draft / season mode) | Cadence | On failure |
|---|---|---|---|---|
| Sleeper `state/nfl` | `sleeper_state.json` | Decides the mode + current week | Every refresh | Last snapshot kept |
| nflverse weekly stats + snaps | `stats_player_week_<yr>.csv`, `snap_counts_<yr>.csv` | Trends/game logs; prior year doubles as the in-season baseline | Weekly in-season; completed seasons cached | Last snapshot kept |
| nflverse play-by-play | `redzone_<yr>.json` | Red-zone / goal-line usage and exact team red-zone totals | Weekly in-season; completed seasons cached | Red-zone columns read `—`, app unaffected |
| FFC ADP | `ffc_adp.json` | Draft market / stale artifact | Daily | Last snapshot kept |
| FantasyPros cheat sheet | `fantasypros_ecr.json` | Expert ranks (draft mode) | Daily | Last snapshot kept |
| FantasyPros rest-of-season | `fantasypros_ros.json` | Expert ranks (season mode) | Weekly in-season | Last snapshot kept |
| Sleeper players | `sleeper_players.json` | Teams, depth charts, injuries | Every refresh | Last snapshot kept |
| Stats Guy trade values | `statsguy_values.json` | Trade-market column (host is `api.statsguyfantasy.com` — the docs page's bare paths return HTML) | ~Daily | Column goes empty, app unaffected |

The server auto-refreshes the whole pipeline when the built database is
older than 20 hours (hourly check; manual button on the Data page; disable
with `DVF_NO_AUTO_REFRESH=1`).

### Deferred / dormant

1. **Yahoo draft sync** — fully built, waiting on Yahoo's API-access
   approval; activation steps are on the app's Data page.
2. **Stats Guy value-history** — per-player market-price timelines, useful
   for grading "the market was late" calls in the accountability log.
3. **Start/sit + waiver claims** — deliberately out of scope.

## Yahoo draft sync (optional)

`src/yahoo/` can mirror a live Yahoo draft onto the board automatically —
polling `draftresults` every 10s, mapping picks to the player database by
name+position, and marking your team's picks via your team key. Unmatched
picks are surfaced, never dropped. It is fully credential-gated: without
Yahoo API access the app works exactly as before (manual pick tracking).

Yahoo now reviews Fantasy Sports API access applications
(sports.yahoo.com/developer/access — personal/single-league use is an
accepted category; the app's Data page shows suggested wording). Once
approved: create a Confidential Client app with Fantasy Sports Read scope
and redirect URI `https://localhost:8443/yahoo/callback`, put
`YAHOO_CLIENT_ID`/`YAHOO_CLIENT_SECRET` in `.env`, restart, and use
Connect on the Data page. The OAuth callback runs on a self-signed
localhost cert (one-time browser warning is expected).
