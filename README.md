# Draft Value Finder — Phase 1

Fantasy football draft assistant for a 10-team PPR league (2026 draft).
**Numbers first. Team context second. AI connects the dots.**

The point is not to rank players — the market already does that. The point is to
find value the market is late on: players whose snap share AND opportunities
were rising over their last 3 games of 2025 while their draft price hasn't moved.

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
| Player metadata | Sleeper API (teams, depth charts, injury status) |
| Trade-market values | [Stats Guy Fantasy](https://statsguyfantasy.com) (free API; values from >1M real Sleeper-league trades, non-SF redraft format) |

Every snapshot is stored with source + fetch timestamp (`data/raw/*.meta.json`),
and every number in the UI is traceable to its source. Conflicts between
sources are recorded on the player record, not silently resolved.

## What it does

- **Draft board** — top 250 (200 core + 50 sleeper watch) with ADP, expert rank,
  AI rank, trend arrows, sleeper badges, bye, availability, and personal ranks.
  Click-to-track picks (mine / gone / undo).
- **AI assessment** — a deterministic, transparent re-ranking: market baseline
  (ADP + expert average) adjusted only for evidence in the data (usage trends,
  unsustainable spikes, injury designations). Every adjustment is emitted as a
  readable factor. Confidence % measures evidence strength, not win probability.
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
src/analyze/    trends, signals, scoring, market comparison, recommendations
src/ai/         chat grounded in structured data (Claude + fallback)
src/store/      draft state, personal ranks, history log
src/yahoo/      dormant Yahoo draft sync (credential-gated)
server/         zero-framework node:http API + static frontend
public/         vanilla-JS UI (no build step)
```

### Data pipeline

| Source | Snapshot | Role (draft / season mode) | Cadence | On failure |
|---|---|---|---|---|
| Sleeper `state/nfl` | `sleeper_state.json` | Decides the mode + current week | Every refresh | Last snapshot kept |
| nflverse weekly stats + snaps | `stats_player_week_<yr>.csv`, `snap_counts_<yr>.csv` | Trends/game logs; prior year doubles as the in-season baseline | Weekly in-season; completed seasons cached | Last snapshot kept |
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
