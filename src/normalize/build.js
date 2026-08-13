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
import { matchTradeMarket } from './tradeMarket.js';
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
function buildLogIndexes(weekly, snaps) {
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
  return { logsByKey, logsByName, snapByNameWeek };
}

function gamesFor(name, pos, indexes, conflicts) {
  const { logsByKey, logsByName, snapByNameWeek } = indexes;
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
    return {
      week: num(r.week),
      stats_team: normTeam(r.team),
      opponent: r.opponent_team,
      snap_pct: snapOk ? round3(num(snapRow.offense_pct)) : null,
      offense_snaps: snapOk ? num(snapRow.offense_snaps) : null,
      targets: num(r.targets),
      receptions: num(r.receptions),
      receiving_yards: num(r.receiving_yards),
      receiving_tds: num(r.receiving_tds),
      target_share: round3(num(r.target_share)),
      carries: num(r.carries),
      rushing_yards: num(r.rushing_yards),
      rushing_tds: num(r.rushing_tds),
      completions: num(r.completions),
      attempts: num(r.attempts),
      passing_yards: num(r.passing_yards),
      passing_tds: num(r.passing_tds),
      interceptions: num(r.passing_interceptions),
      fantasy_points_ppr: round1(num(r.fantasy_points_ppr)),
    };
  });
}

function avg(games, pick) {
  const vals = games.map(pick).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function baselineFrom(games, season) {
  if (!games.length) return null;
  return {
    season,
    games: games.length,
    snap_pct: round3(avg(games, g => g.snap_pct)),
    targets: round1(avg(games, g => g.targets)),
    carries: round1(avg(games, g => g.carries)),
    attempts: round1(avg(games, g => g.attempts)),
    ppr: round1(avg(games, g => g.fantasy_points_ppr)),
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
  const indexes = buildLogIndexes(parseCsv(weeklySnap.body), parseCsv(snapsSnap.body));

  // In season mode, last season's logs feed the early-season baseline.
  let baselineIndexes = null;
  if (sr.mode === 'season' && sr.baseline_season) {
    const bw = loadSnapshot(`stats_player_week_${sr.baseline_season}.csv`);
    const bs = loadSnapshot(`snap_counts_${sr.baseline_season}.csv`);
    if (bw && bs) baselineIndexes = buildLogIndexes(parseCsv(bw.body), parseCsv(bs.body));
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
    const sl = pos === 'DST' ? null : sleeperByKey.get(key)?.p ?? null;
    const conflicts = [];

    const fpBye = num(e.fp?.player_bye_week);
    const ffcBye = num(e.ffc?.bye);
    if (fpBye != null && ffcBye != null && fpBye !== ffcBye) {
      conflicts.push({ field: 'bye', fantasypros: fpBye, ffc: ffcBye, kept: 'fantasypros' });
    }

    const teams = { sleeper: normTeam(sl?.team), fantasypros: normTeam(e.fp?.player_team_id), ffc: normTeam(e.ffc?.team) };
    const team = teams.sleeper ?? teams.fantasypros ?? teams.ffc ?? null;
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
      bye: fpBye ?? ffcBye ?? null,
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
      weekly_stats: weeklySnap.meta,
      snap_counts: snapsSnap.meta,
      player_meta: sleeperSnap.meta,
    },
    counts: {
      players: players.length,
      core: players.filter(p => p.tier_group === 'core').length,
      with_adp: players.filter(p => p.adp).length,
      with_expert: players.filter(p => p.expert).length,
      with_stats: players.filter(p => p.games.length).length,
      with_trade_market: players.filter(p => p.trade_market).length,
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
