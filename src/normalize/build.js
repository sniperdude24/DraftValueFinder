// Normalization: merge raw snapshots into the canonical player database.
//
// Output: data/players.json
//   { built_at, sources: {per-source metadata}, players: [...], unmatched: {...} }
//
// Principles (from the project spec):
// - Every number keeps its source; nothing is invented.
// - Conflicts between sources are recorded, not silently resolved.
// - Top 200 by consensus = 'core' (full analysis); 201-250 = 'watch'
//   (monitored for sleeper signals).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot, parseCsv, ROOT } from '../ingest/util.js';
import { nameKey, normPosition, normTeam, samePositionGroup, playerId } from './names.js';

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

export function buildDatabase() {
  const ffcSnap = req('ffc_adp.json');
  const fpSnap = req('fantasypros_ecr.json');
  const weeklySnap = req('stats_player_week_2025.csv');
  const snapsSnap = req('snap_counts_2025.csv');
  const sleeperSnap = req('sleeper_players.json');

  const ffc = JSON.parse(ffcSnap.body);
  const fp = JSON.parse(fpSnap.body);
  const sleeper = JSON.parse(sleeperSnap.body);
  const weekly = parseCsv(weeklySnap.body);
  const snaps = parseCsv(snapsSnap.body);

  // ---- index sources by nameKey ----
  const fpByKey = new Map();
  for (const p of fp.players) {
    const pos = normPosition(p.player_position_id);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    fpByKey.set(`${pos}|${nameKey(p.player_name)}`, p);
  }

  const ffcByKey = new Map();
  for (const p of ffc.players) {
    const pos = normPosition(p.position);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    // FFC names team defenses "49ers Defense" — key DSTs by team code instead.
    const key = pos === 'DST' ? `DST|${p.team}` : `${pos}|${nameKey(p.name)}`;
    ffcByKey.set(key, p);
  }

  const sleeperByKey = new Map();
  for (const [sid, p] of Object.entries(sleeper)) {
    if (!p.full_name) continue;
    const pos = normPosition(p.position);
    const key = `${pos}|${nameKey(p.full_name)}`;
    const prev = sleeperByKey.get(key);
    // Duplicate name+position: prefer the one currently on a team.
    if (!prev || (!prev.p.team && p.team)) sleeperByKey.set(key, { sid, p });
  }

  // Weekly 2025 game logs grouped by name+position-group (REG season only).
  // logsByName is the fallback for cross-source position disagreements
  // (e.g. two-way players listed CB by nflverse but WR by fantasy sources).
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

  // Snap counts by name+week (offense only), with position kept for group check.
  const snapByNameWeek = new Map();
  for (const r of snaps) {
    if (r.game_type !== 'REG') continue;
    const key = `${nameKey(r.player)}|${r.week}`;
    snapByNameWeek.set(key, r);
  }

  // ---- build the universe: union of FantasyPros + FFC players ----
  const entries = new Map(); // id -> partial entry
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
  // Consensus = expert rank when present, else ADP-implied overall slot.
  const ffcSorted = [...ffc.players].sort((a, b) => a.adp - b.adp);
  const adpOverall = new Map(ffcSorted.map((p, i) => [p.player_id, i + 1]));
  const list = [...entries.values()].map(e => {
    const ecr = e.fp?.rank_ecr ?? null;
    const adpRank = e.ffc ? adpOverall.get(e.ffc.player_id) : null;
    return { ...e, consensus: ecr ?? (adpRank != null ? adpRank + 0.5 : Infinity) };
  }).sort((a, b) => a.consensus - b.consensus).slice(0, UNIVERSE_SIZE);

  // ---- assemble full player records ----
  const players = list.map((e, i) => {
    const pos = e.position;
    const key = `${pos}|${nameKey(e.name)}`;
    const sl = pos === 'DST' ? null : sleeperByKey.get(key)?.p ?? null;
    const conflicts = [];

    // Bye week: prefer FantasyPros (updated daily), fall back to FFC.
    const fpBye = num(e.fp?.player_bye_week);
    const ffcBye = num(e.ffc?.bye);
    if (fpBye != null && ffcBye != null && fpBye !== ffcBye) {
      conflicts.push({ field: 'bye', fantasypros: fpBye, ffc: ffcBye, kept: 'fantasypros' });
    }

    // Team: prefer Sleeper (fastest to update), then FantasyPros, then FFC.
    const teams = { sleeper: normTeam(sl?.team), fantasypros: normTeam(e.fp?.player_team_id), ffc: normTeam(e.ffc?.team) };
    const team = teams.sleeper ?? teams.fantasypros ?? teams.ffc ?? null;
    if (teams.sleeper && teams.fantasypros && teams.sleeper !== teams.fantasypros) {
      conflicts.push({ field: 'team', ...teams, kept: 'sleeper' });
    }

    // 2025 game log (regular season, games actually played).
    const logKey = `${pos}|${nameKey(e.name)}`;
    let rawLog = logsByKey.get(logKey) ?? [];
    if (!rawLog.length && !['K', 'DST'].includes(pos)) {
      // Fallback: same name, different listed position, but with real
      // offensive usage in the row (guards against defender name collisions).
      const alt = (logsByName.get(nameKey(e.name)) ?? []).filter(r =>
        (num(r.targets) ?? 0) + (num(r.carries) ?? 0) + (num(r.attempts) ?? 0) > 0);
      if (alt.length) {
        rawLog = alt;
        conflicts.push({
          field: 'stats_position',
          note: `2025 stats list this player at ${alt[0].position}; matched by name + offensive usage`,
        });
      }
    }
    rawLog = [...rawLog].sort((a, b) => num(a.week) - num(b.week));
    const games = rawLog.map(r => {
      const wk = num(r.week);
      const snapRow = snapByNameWeek.get(`${nameKey(r.player_display_name || r.player_name)}|${r.week}`);
      // Accept the snap row when its position matches the player OR matches
      // the stats row's own listed position (two-way / mislabeled players).
      const snapOk = snapRow && (samePositionGroup(snapRow.position, pos) || normPosition(snapRow.position) === normPosition(r.position));
      return {
        week: wk,
        team_2025: normTeam(r.team),
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

    const team2025 = games.length ? games[games.length - 1].team_2025 : null;

    return {
      id: e.id,
      name: e.name,
      position: pos,
      team,
      team_2025: team2025,
      changed_team: Boolean(team2025 && team && team2025 !== team),
      bye: fpBye ?? ffcBye ?? null,
      consensus_rank: i + 1,
      tier_group: i < CORE_SIZE ? 'core' : 'watch',
      adp: e.ffc ? {
        overall: e.ffc.adp,
        formatted: e.ffc.adp_formatted,
        rank: adpOverall.get(e.ffc.player_id) ?? null,
        high: e.ffc.high, low: e.ffc.low, stdev: e.ffc.stdev,
        times_drafted: e.ffc.times_drafted,
      } : null,
      expert: e.fp ? {
        rank: e.fp.rank_ecr,
        pos_rank: e.fp.pos_rank,
        tier: e.fp.tier,
        best: num(e.fp.rank_min), worst: num(e.fp.rank_max),
        avg: num(e.fp.rank_ave), stdev: num(e.fp.rank_std),
      } : null,
      meta: sl ? {
        age: sl.age, years_exp: sl.years_exp,
        injury_status: sl.injury_status ?? null,
        status: sl.status ?? null,
        depth_chart_position: sl.depth_chart_position ?? null,
        depth_chart_order: sl.depth_chart_order ?? null,
      } : null,
      games_2025: games,
      conflicts,
    };
  });

  // Unmatched-log diagnostics: universe players with no 2025 stats who are
  // not rookies (possible name-matching misses worth eyeballing).
  const suspiciousNoStats = players
    .filter(p => !['K', 'DST'].includes(p.position))
    .filter(p => p.games_2025.length === 0 && (p.meta?.years_exp ?? 0) > 0)
    .map(p => ({ id: p.id, name: p.name, years_exp: p.meta?.years_exp ?? null }));

  const db = {
    built_at: new Date().toISOString(),
    season: { draft_year: 2026, stats_season: 2025 },
    sources: {
      adp: ffcSnap.meta,
      expert: fpSnap.meta,
      weekly_stats: weeklySnap.meta,
      snap_counts: snapsSnap.meta,
      player_meta: sleeperSnap.meta,
    },
    counts: {
      players: players.length,
      core: players.filter(p => p.tier_group === 'core').length,
      with_adp: players.filter(p => p.adp).length,
      with_expert: players.filter(p => p.expert).length,
      with_stats: players.filter(p => p.games_2025.length).length,
    },
    unmatched: { ffc_only: unmatchedFfc, veterans_without_2025_stats: suspiciousNoStats },
    players,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'players.json'), JSON.stringify(db, null, 1));
  return db;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const db = buildDatabase();
  console.log(JSON.stringify(db.counts));
  console.log(`ffc-only players added: ${db.unmatched.ffc_only.length}`);
  console.log(`veterans without 2025 stats: ${db.unmatched.veterans_without_2025_stats.length}`);
  for (const p of db.unmatched.veterans_without_2025_stats.slice(0, 15)) console.log('  ?', p.name);
}
