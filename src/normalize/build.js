// Normalization: merge raw snapshots into the canonical player database.
//
// Output: data/players.json
//   { built_at, mode, season, stats_season, week, sources, players, unmatched }
//
// Two modes (resolved by src/normalize/season.js from the Sleeper state):
//  - draft:  stats are last season's; expert ranks are the draft cheat sheet.
//  - season: stats are the current season's (updated weekly); expert ranks
//            are rest-of-season consensus; each player carries a baseline of
//            last season's per-game averages for early-season trend work;
//            ADP is kept but flagged stale.
//
// Principles (from the project spec):
// - Every number keeps its source; nothing is invented.
// - Conflicts between sources are recorded, not silently resolved.
// - Top 200 by consensus = 'core'; 201-250 = 'watch'; in season mode any
//   rostered player is force-included so nobody's roster goes dark.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot, parseCsv, ROOT, RAW_DIR } from '../ingest/util.js';
import { nameKey, normPosition, normTeam, samePositionGroup, playerId } from './names.js';
import { resolveSeason } from './season.js';
import { indexSchedule, resultFor, byeWeeks } from './schedules.js';
import { pbpSnapshotName } from '../ingest/sources/nflversePbp.js';
import { matchTradeMarket } from './tradeMarket.js';
import { attachProjections } from './projections.js';
import { SCORING_FIELDS } from '../analyze/fantasyPoints.js';
import { loadState } from '../store/state.js';

const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);
const UNIVERSE_SIZE = 250;
const CORE_SIZE = 200;

function req(name) {
  const snap = loadSnapshot(name);
  if (!snap) throw new Error(`Missing snapshot data/raw/${name} — run \`npm run ingest\` first`);
  return snap;
}

function num(v) {
  if (v === '' || v == null || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
const round3 = v => (v == null ? null : Math.round(v * 1000) / 1000);

// ---- weekly-stats CSV → per-player game logs (used for the active stats
// season AND, in season mode, the prior-season baseline) ----
function buildLogIndexes(weekly, snaps, redzone, schedule = null) {
  const logsByKey = new Map();
  const logsByName = new Map();
  for (const r of weekly) {
    if (r.season_type !== 'REG') continue;
    const pos = normPosition(r.position);
    const nk = nameKey(r.player_display_name || r.player_name);
    if (!logsByName.has(nk)) logsByName.set(nk, []);
    logsByName.get(nk).push(r);
    if (!['QB', 'RB', 'WR', 'TE', 'K'].includes(pos)) continue;
    const key = `${pos === 'K' ? 'K' : pos}|${nk}`;
    if (!logsByKey.has(key)) logsByKey.set(key, []);
    logsByKey.get(key).push(r);
  }
  const snapByNameWeek = new Map();
  for (const r of snaps) {
    if (r.game_type !== 'REG') continue;
    snapByNameWeek.set(`${nameKey(r.player)}|${r.week}`, r);
  }
  // Red-zone usage joins on the nflverse GSIS player id, which both the
  // weekly stats file and the play-by-play file carry — an exact join, so
  // no name matching and no ambiguity.
  const rzByIdWeek = new Map();
  const rzWeeks = new Set(redzone?.weeks ?? []);
  for (const [playerId, weeks] of Object.entries(redzone?.players ?? {})) {
    for (const [week, v] of Object.entries(weeks)) rzByIdWeek.set(`${playerId}|${week}`, v);
  }
  return { logsByKey, logsByName, snapByNameWeek, rzByIdWeek, rzWeeks, hasRedZone: !!redzone, schedule };
}

function gamesFor(name, pos, indexes, conflicts) {
  const { logsByKey, logsByName, snapByNameWeek, rzByIdWeek, rzWeeks, hasRedZone, schedule } = indexes;
  let rawLog = logsByKey.get(`${pos}|${nameKey(name)}`) ?? [];
  if (!rawLog.length && !['K', 'DST'].includes(pos)) {
    // Fallback: same name, different listed position, but with real
    // offensive usage in the row (guards against defender name collisions).
    const alt = (logsByName.get(nameKey(name)) ?? []).filter(r =>
      (num(r.targets) ?? 0) + (num(r.carries) ?? 0) + (num(r.attempts) ?? 0) > 0);
    if (alt.length) {
      rawLog = alt;
      conflicts?.push({
        field: 'stats_position',
        note: `stats list this player at ${alt[0].position}; matched by name + offensive usage`,
      });
    }
  }
  return [...rawLog].sort((a, b) => num(a.week) - num(b.week)).map(r => {
    const snapRow = snapByNameWeek.get(`${nameKey(r.player_display_name || r.player_name)}|${r.week}`);
    // Accept the snap row when its position matches the player OR matches
    // the stats row's own listed position (two-way / mislabeled players).
    const snapOk = snapRow && (samePositionGroup(snapRow.position, pos) || normPosition(snapRow.position) === normPosition(r.position));
    // A week the red-zone source covers but where the player does not appear
    // is a genuine zero. A week it does not cover (no snapshot, or the
    // play-by-play lagging the weekly file) stays null so the UI shows "—"
    // rather than implying the player was shut out of the red zone.
    const rzCovered = hasRedZone && rzWeeks.has(num(r.week));
    const rz = rzCovered ? (rzByIdWeek.get(`${r.player_id}|${r.week}`) ?? {}) : null;
    const rzNum = field => (rz ? (rz[field] ?? 0) : null);
    // Two sources name this game's opponent: the weekly stats file and the
    // schedule. They agree on all 3,051 rows today, but one fact with two
    // homes is how they start disagreeing — so the row stores it ONCE,
    // schedule-first, and `game_result` carries only what the schedule alone
    // knows. The weekly file remains the fallback for a game the schedule has
    // no completed entry for, so nothing goes blank.
    const result = schedule ? resultFor(schedule, r.game_id, r.team) : null;
    return {
      week: num(r.week),
      stats_team: normTeam(r.team),
      // The weekly file's own primary key, and the exact join into the
      // schedules snapshot — no name, date or abbreviation matching.
      game_id: r.game_id || null,
      // Normalized either way. Left raw, the weekly file's Rams read "LA"
      // while the rest of the app says "LAR" — the same mismatch that once
      // rendered an empty LAR page.
      opponent: result?.opponent ?? normTeam(r.opponent_team),
      // Final score and W-L, or null when the schedule has no completed game
      // for this id. A game not yet played is not a 0-0 game.
      game_result: result
        ? { at: result.at, outcome: result.outcome, team_score: result.team_score, opp_score: result.opp_score }
        : null,
      snap_pct: snapOk ? round3(num(snapRow.offense_pct)) : null,
      offense_snaps: snapOk ? num(snapRow.offense_snaps) : null,
      targets: num(r.targets),
      receptions: num(r.receptions),
      receiving_yards: num(r.receiving_yards),
      receiving_tds: num(r.receiving_tds),
      carries: num(r.carries),
      rushing_yards: num(r.rushing_yards),
      rushing_tds: num(r.rushing_tds),
      completions: num(r.completions),
      attempts: num(r.attempts),
      passing_yards: num(r.passing_yards),
      passing_tds: num(r.passing_tds),
      interceptions: num(r.passing_interceptions),
      // nflverse's own PPR number, kept untouched. It is not what the app
      // scores with — it is the reference the scoring engine is checked
      // against, so overwriting it would destroy the only independent
      // answer we have.
      fantasy_points_ppr: round1(num(r.fantasy_points_ppr)),

      // ---- remaining scoring components (see analyze/fantasyPoints.js) ----
      // The three two-point varieties are always worth the same and no
      // scoring system separates them, so they are summed here.
      two_point_conversions: (num(r.passing_2pt_conversions) ?? 0)
        + (num(r.rushing_2pt_conversions) ?? 0)
        + (num(r.receiving_2pt_conversions) ?? 0),
      special_teams_tds: num(r.special_teams_tds),

      // ---- opportunity / advanced (nflverse-computed, per game) ----
      // Shares and WOPR are already per-game rates in the source; WOPR is
      // 1.5*target_share + 0.7*air_yards_share, the standard composite
      // opportunity metric for pass catchers.
      target_share: round3(num(r.target_share)),
      air_yards_share: round3(num(r.air_yards_share)),
      wopr: round3(num(r.wopr)),
      racr: round3(num(r.racr)),
      receiving_air_yards: num(r.receiving_air_yards),
      receiving_yac: num(r.receiving_yards_after_catch),
      receiving_first_downs: num(r.receiving_first_downs),
      receiving_epa: round3(num(r.receiving_epa)),
      receiving_20: num(r.receiving_20),
      receiving_40: num(r.receiving_40),
      rushing_first_downs: num(r.rushing_first_downs),
      rushing_epa: round3(num(r.rushing_epa)),
      rushing_20: num(r.rushing_20),
      rushing_40: num(r.rushing_40),
      passing_40: num(r.passing_40),
      passing_air_yards: num(r.passing_air_yards),
      passing_first_downs: num(r.passing_first_downs),
      passing_epa: round3(num(r.passing_epa)),
      passing_cpoe: round3(num(r.passing_cpoe)),
      pacr: round3(num(r.pacr)),
      // OFFENSIVE fumbles only. `fumbles_lost_total` also counts special-teams
      // muffs, which fantasy scoring does not charge to the player — using it
      // over-penalized return men by exactly 2 points a muff, which is what
      // made 36 player-weeks disagree with nflverse's own PPR figure.
      fumbles_lost: (num(r.sack_fumbles_lost) ?? 0)
        + (num(r.rushing_fumbles_lost) ?? 0)
        + (num(r.receiving_fumbles_lost) ?? 0),
      fumbles_lost_all: num(r.fumbles_lost_total),

      // ---- red-zone usage (nflverse play-by-play, joined on GSIS id) ----
      rz_targets: rzNum('rz_targets'),
      rz_carries: rzNum('rz_carries'),
      rz_tds: rzNum('rz_tds'),
      gl_targets: rzNum('gl_targets'),
      gl_carries: rzNum('gl_carries'),

      // ---- touchdowns of 40+ yards (same play-by-play source and join) ----
      // The weekly file has the 40+ yard PLAYS above; only the play-by-play
      // knows which of them were touchdowns. Same rzNum discipline: a week the
      // source has not covered stays null rather than claiming a zero.
      passing_40_tds: rzNum('passing_40_tds'),
      rushing_40_tds: rzNum('rushing_40_tds'),
      receiving_40_tds: rzNum('receiving_40_tds'),
    };
  });
}

function avg(games, pick) {
  const vals = games.map(pick).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function baselineFrom(games, season) {
  if (!games.length) return null;
  // The baseline season's game rows are not kept on the player record, so
  // its points would be frozen at PPR forever unless the scoring components
  // come along too. Scoring is linear, so storing per-game AVERAGES of each
  // component is enough: the score of the averages equals the average of the
  // scores, and the baseline re-scores exactly under any rule set.
  const components = {};
  for (const field of SCORING_FIELDS) {
    components[field] = round3(avg(games, g => g[field]));
  }
  return {
    season,
    games: games.length,
    snap_pct: round3(avg(games, g => g.snap_pct)),
    targets: round1(avg(games, g => g.targets)),
    carries: round1(avg(games, g => g.carries)),
    attempts: round1(avg(games, g => g.attempts)),
    ppr: round1(avg(games, g => g.fantasy_points_ppr)),
    components,
  };
}

export function buildDatabase() {
  const sleeperState = JSON.parse(req('sleeper_state.json').body);
  const seasonYear = Number(sleeperState?.season ?? new Date().getFullYear());
  const currentStatsOnDisk = existsSync(join(RAW_DIR, `stats_player_week_${seasonYear}.csv`));
  const sr = resolveSeason(sleeperState, currentStatsOnDisk);

  const ffcSnap = req('ffc_adp.json');
  const fpDraftSnap = req('fantasypros_ecr.json');
  const fpRosSnap = loadSnapshot('fantasypros_ros.json');
  const fpSnap = sr.mode === 'season' && fpRosSnap ? fpRosSnap : fpDraftSnap;
  const weeklySnap = req(`stats_player_week_${sr.stats_season}.csv`);
  const snapsSnap = req(`snap_counts_${sr.stats_season}.csv`);
  const sleeperSnap = req('sleeper_players.json');

  const ffc = JSON.parse(ffcSnap.body);
  const fp = JSON.parse(fpSnap.body);
  const sleeper = JSON.parse(sleeperSnap.body);
  // Red zone is optional: if the play-by-play snapshot is missing the rest
  // of the build proceeds and the red-zone fields simply read as unavailable.
  const rzSnap = loadSnapshot(pbpSnapshotName(sr.stats_season));
  const redzone = rzSnap ? JSON.parse(rzSnap.body) : null;
  // Play-by-play spells the Rams "LA" where the rest of the app says "LAR"
  // (and historically JAC/WSH); without this the Rams' red-zone panel would
  // come back silently empty rather than visibly broken. Merge rather than
  // overwrite in case both spellings appear in one season.
  const teamRedzone = redzone ? Object.entries(redzone.teams).reduce((acc, [team, weeks]) => {
    const key = normTeam(team);
    acc[key] = acc[key] ?? {};
    for (const [week, v] of Object.entries(weeks)) {
      const prev = acc[key][week];
      acc[key][week] = prev
        ? Object.fromEntries(Object.keys(v).map(f => [f, (prev[f] ?? 0) + v[f]]))
        : v;
    }
    return acc;
  }, {}) : null;
  // Schedules are optional in the same way red zone is: without the snapshot
  // every game row simply carries no result and the UI shows the week and
  // opponent alone. One file covers every season, so both the active stats
  // season and the baseline season read from it.
  const schedSnap = loadSnapshot('games.csv');
  const schedRows = schedSnap ? parseCsv(schedSnap.body) : null;
  const schedule = schedRows ? indexSchedule(schedRows) : null;
  // Byes are a fact about the season BEING PLAYED, so they come from sr.season
  // rather than stats_season — in draft mode those differ by a year, and the
  // 2025 bye is not the one that matters for a 2026 roster.
  const schedByes = schedRows ? byeWeeks(schedRows, sr.season) : new Map();
  const indexes = buildLogIndexes(parseCsv(weeklySnap.body), parseCsv(snapsSnap.body), redzone, schedule);

  // In season mode, last season's logs feed the early-season baseline.
  let baselineIndexes = null;
  if (sr.mode === 'season' && sr.baseline_season) {
    const bw = loadSnapshot(`stats_player_week_${sr.baseline_season}.csv`);
    const bs = loadSnapshot(`snap_counts_${sr.baseline_season}.csv`);
    const brz = loadSnapshot(pbpSnapshotName(sr.baseline_season));
    if (bw && bs) baselineIndexes = buildLogIndexes(parseCsv(bw.body), parseCsv(bs.body), brz ? JSON.parse(brz.body) : null, schedule);
  }

  // ---- index market sources by nameKey ----
  const ffcByKey = new Map();
  for (const p of ffc.players) {
    const pos = normPosition(p.position);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    const key = pos === 'DST' ? `DST|${p.team}` : `${pos}|${nameKey(p.name)}`;
    ffcByKey.set(key, p);
  }

  const sleeperByKey = new Map();
  for (const [sid, p] of Object.entries(sleeper)) {
    if (!p.full_name) continue;
    const key = `${normPosition(p.position)}|${nameKey(p.full_name)}`;
    const prev = sleeperByKey.get(key);
    if (!prev || (!prev.p.team && p.team)) sleeperByKey.set(key, { sid, p });
  }

  // ---- build the universe: union of FantasyPros + FFC players ----
  const entries = new Map();
  for (const p of fp.players) {
    const pos = normPosition(p.player_position_id);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    const id = playerId(p.player_name, pos);
    entries.set(id, { id, name: p.player_name, position: pos, fp: p, ffc: null });
  }
  const unmatchedFfc = [];
  for (const p of ffc.players) {
    const pos = normPosition(p.position);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    let match = null;
    if (pos === 'DST') {
      match = [...entries.values()].find(e => e.position === 'DST' && e.fp?.player_team_id === p.team);
    } else {
      match = entries.get(playerId(p.name, pos));
    }
    if (match) match.ffc = p;
    else {
      unmatchedFfc.push({ name: p.name, position: pos, adp: p.adp });
      const id = playerId(p.name, pos);
      entries.set(id, { id, name: p.name, position: pos, fp: null, ffc: p });
    }
  }

  // ---- consensus ordering & universe cut ----
  // Draft mode: expert rank blended with ADP-implied slot.
  // Season mode: rest-of-season expert rank only (ADP is a stale artifact).
  const ffcSorted = [...ffc.players].sort((a, b) => a.adp - b.adp);
  const adpOverall = new Map(ffcSorted.map((p, i) => [p.player_id, i + 1]));
  const ranked = [...entries.values()].map(e => {
    const ecr = e.fp?.rank_ecr ?? null;
    const adpRank = e.ffc ? adpOverall.get(e.ffc.player_id) : null;
    const consensus = sr.mode === 'season'
      ? (ecr ?? Infinity)
      : (ecr ?? (adpRank != null ? adpRank + 0.5 : Infinity));
    return { ...e, consensus };
  }).sort((a, b) => a.consensus - b.consensus);

  let list = ranked.slice(0, UNIVERSE_SIZE);
  // Season mode: force-include anyone currently on a roster in the app,
  // so tracked players never drop out of the database between weeks.
  if (sr.mode === 'season') {
    const state = loadState();
    const tracked = new Set([...(state.drafted ?? []), ...(state.mine ?? [])]);
    const included = new Set(list.map(e => e.id));
    for (const e of ranked.slice(UNIVERSE_SIZE)) {
      if (tracked.has(e.id) && !included.has(e.id)) list.push(e);
    }
  }

  // ---- assemble full player records ----
  const players = list.map((e, i) => {
    const pos = e.position;
    const key = `${pos}|${nameKey(e.name)}`;
    const slEntry = pos === 'DST' ? null : sleeperByKey.get(key) ?? null;
    const sl = slEntry?.p ?? null;
    const conflicts = [];

    const fpBye = num(e.fp?.player_bye_week);
    const ffcBye = num(e.ffc?.bye);

    const teams = { sleeper: normTeam(sl?.team), fantasypros: normTeam(e.fp?.player_team_id), ffc: normTeam(e.ffc?.team) };
    const team = teams.sleeper ?? teams.fantasypros ?? teams.ffc ?? null;

    // The schedule settles the bye: it is the week the team has no fixture.
    // FantasyPros and FFC are kept as the fallback for a season the schedule
    // has not been published for, and any disagreement is recorded rather
    // than silently overwritten — the market sources are what the rest of the
    // fantasy world is reading, so a mismatch is worth seeing.
    const schedBye = team != null ? (schedByes.get(team) ?? null) : null;
    if (fpBye != null && ffcBye != null && fpBye !== ffcBye) {
      conflicts.push({ field: 'bye', schedule: schedBye, fantasypros: fpBye, ffc: ffcBye, kept: schedBye != null ? 'schedule' : 'fantasypros' });
    } else if (schedBye != null && fpBye != null && schedBye !== fpBye) {
      conflicts.push({ field: 'bye', schedule: schedBye, fantasypros: fpBye, ffc: ffcBye, kept: 'schedule' });
    }
    if (teams.sleeper && teams.fantasypros && teams.sleeper !== teams.fantasypros) {
      conflicts.push({ field: 'team', ...teams, kept: 'sleeper' });
    }

    const games = gamesFor(e.name, pos, indexes, conflicts);
    const statsTeam = games.length ? games[games.length - 1].stats_team : null;
    const baseline = baselineIndexes
      ? baselineFrom(gamesFor(e.name, pos, baselineIndexes, null), sr.baseline_season)
      : null;

    return {
      id: e.id,
      name: e.name,
      position: pos,
      team,
      stats_team: statsTeam,
      changed_team: Boolean(statsTeam && team && statsTeam !== team),
      bye: schedBye ?? fpBye ?? ffcBye ?? null,
      consensus_rank: i + 1,
      tier_group: i < CORE_SIZE ? 'core' : 'watch',
      stats_season: sr.stats_season,
      adp: e.ffc ? {
        overall: e.ffc.adp,
        formatted: e.ffc.adp_formatted,
        rank: adpOverall.get(e.ffc.player_id) ?? null,
        high: e.ffc.high, low: e.ffc.low, stdev: e.ffc.stdev,
        times_drafted: e.ffc.times_drafted,
        stale: sr.mode === 'season',
      } : null,
      expert: e.fp ? {
        rank: e.fp.rank_ecr,
        pos_rank: e.fp.pos_rank,
        tier: e.fp.tier,
        best: num(e.fp.rank_min), worst: num(e.fp.rank_max),
        avg: num(e.fp.rank_ave), stdev: num(e.fp.rank_std),
        scope: sr.mode === 'season' ? 'rest-of-season' : 'draft',
      } : null,
      meta: sl ? {
        sleeper_id: slEntry.sid,
        age: sl.age, years_exp: sl.years_exp,
        injury_status: sl.injury_status ?? null,
        status: sl.status ?? null,
        depth_chart_position: sl.depth_chart_position ?? null,
        depth_chart_order: sl.depth_chart_order ?? null,
      } : null,
      games,
      baseline,
      conflicts,
    };
  });

  // Trade-market values (optional source — a missing snapshot never blocks).
  const statsguySnap = loadSnapshot('statsguy_values.json');
  const tradeMatch = statsguySnap
    ? matchTradeMarket(players, JSON.parse(statsguySnap.body))
    : (players.forEach(p => { p.trade_market = null; }), { matched: 0, unmatched: [] });

  // External weekly projections (optional source, exact sleeper_id join).
  const projSnap = loadSnapshot('sleeper_projections.json');
  const projResult = projSnap
    ? attachProjections(players, JSON.parse(projSnap.body))
    : (players.forEach(p => { p.projection = null; }), { attached: 0 });

  const suspiciousNoStats = players
    .filter(p => !['K', 'DST'].includes(p.position))
    .filter(p => p.games.length === 0 && (p.meta?.years_exp ?? 0) > 0)
    .map(p => ({ id: p.id, name: p.name, years_exp: p.meta?.years_exp ?? null }));

  const db = {
    built_at: new Date().toISOString(),
    mode: sr.mode,
    season: sr.season,
    stats_season: sr.stats_season,
    baseline_season: sr.baseline_season,
    week: sr.week,
    sources: {
      adp: ffcSnap.meta,
      expert: fpSnap.meta,
      trade_market: statsguySnap?.meta ?? null,
      projections: projSnap?.meta ?? null,
      weekly_stats: weeklySnap.meta,
      snap_counts: snapsSnap.meta,
      play_by_play: rzSnap?.meta ?? null,
      schedules: schedSnap?.meta ?? null,
      player_meta: sleeperSnap.meta,
    },
    // Every red-zone play in the league, not just our top-250 universe — so
    // red-zone shares divide by a complete, exact denominator, unlike the
    // target pie which has to be reconstructed from player shares.
    team_redzone: teamRedzone,
    counts: {
      players: players.length,
      core: players.filter(p => p.tier_group === 'core').length,
      with_adp: players.filter(p => p.adp).length,
      with_expert: players.filter(p => p.expert).length,
      with_stats: players.filter(p => p.games.length).length,
      with_trade_market: players.filter(p => p.trade_market).length,
      with_projection: projResult.attached,
      with_red_zone: players.filter(p => p.games.some(g => (g.rz_targets ?? 0) + (g.rz_carries ?? 0) > 0)).length,
    },
    unmatched: { ffc_only: unmatchedFfc, veterans_without_stats: suspiciousNoStats, trade_market: tradeMatch.unmatched },
    players,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'players.json'), JSON.stringify(db, null, 1));
  return db;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const db = buildDatabase();
  console.log(JSON.stringify({ mode: db.mode, stats_season: db.stats_season, week: db.week, ...db.counts }));
  console.log(`ffc-only players added: ${db.unmatched.ffc_only.length}`);
  console.log(`veterans without ${db.stats_season} stats: ${db.unmatched.veterans_without_stats.length}`);
  for (const p of db.unmatched.veterans_without_stats.slice(0, 15)) console.log('  ?', p.name);
}
