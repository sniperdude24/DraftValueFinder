// Windowed player statistics — the analysis foundation for the season
// platform. Pure: takes a player record, returns aggregates over three
// windows (whole season, last 3 games played, last game).
//
// Two deliberate rules, because they change the numbers materially:
//
//  1. RATE stats are computed from window TOTALS (sum yards / sum targets),
//     never as a mean of per-game ratios. A 1-target-1-yard game would
//     otherwise drag down a 10-target-150-yard game just as hard.
//
//  2. SHARE stats (target share, air-yards share, WOPR) ARE means of the
//     per-game values, because that is what "per-game usage" means and it
//     is how the source publishes them. They are not recomputed from totals.
//
// Every denominator is guarded: zero volume yields null, never NaN/Infinity,
// so the UI can honestly print "—" instead of inventing a number.

import { opportunity } from './trends.js';

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const r3 = v => (v == null ? null : Math.round(v * 1000) / 1000);

function sum(games, field) {
  let total = 0, seen = false;
  for (const g of games) {
    if (g[field] != null) { total += g[field]; seen = true; }
  }
  return seen ? total : null;
}

function mean(games, field) {
  const vals = games.map(g => g[field]).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Rate from totals, guarded. Returns null when the denominator is absent
// or zero — an undefined rate, not a zero rate.
function rate(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

const perGame = (total, games) => (total == null || !games ? null : total / games);

// `position` drives what counts as an opportunity — the same rule the trend
// engine uses (src/analyze/trends.js), so the platform never reports two
// different definitions of the same word.
export function windowStats(games, position = null) {
  if (!games.length) return null;
  const n = games.length;

  const targets = sum(games, 'targets');
  const receptions = sum(games, 'receptions');
  const recYards = sum(games, 'receiving_yards');
  const recAirYards = sum(games, 'receiving_air_yards');
  const recYac = sum(games, 'receiving_yac');
  const carries = sum(games, 'carries');
  const rushYards = sum(games, 'rushing_yards');
  const attempts = sum(games, 'attempts');
  const passYards = sum(games, 'passing_yards');
  const tds = (sum(games, 'receiving_tds') ?? 0) + (sum(games, 'rushing_tds') ?? 0) + (sum(games, 'passing_tds') ?? 0);
  const firstDowns = (sum(games, 'receiving_first_downs') ?? 0) + (sum(games, 'rushing_first_downs') ?? 0);
  const explosive = (sum(games, 'receiving_20') ?? 0) + (sum(games, 'rushing_20') ?? 0);
  const opportunities = position
    ? games.reduce((t, g) => t + (opportunity(g, position) ?? 0), 0)
    : (targets ?? 0) + (carries ?? 0);
  const ppr = sum(games, 'fantasy_points_ppr');
  const epaTotal = (sum(games, 'receiving_epa') ?? 0) + (sum(games, 'rushing_epa') ?? 0) + (sum(games, 'passing_epa') ?? 0);
  // QB opportunities already include pass attempts; don't double-count.
  const plays = position === 'QB' ? opportunities : opportunities + (attempts ?? 0);

  return {
    games: n,
    weeks: games.map(g => g.week),

    // Opportunity (per game) — shares are means of per-game values.
    snap_pct: r3(mean(games, 'snap_pct')),
    targets_pg: r1(perGame(targets, n)),
    carries_pg: r1(perGame(carries, n)),
    opportunities_pg: r1(perGame(opportunities, n)),
    target_share: r3(mean(games, 'target_share')),
    air_yards_share: r3(mean(games, 'air_yards_share')),
    wopr: r2(mean(games, 'wopr')),
    air_yards_pg: r1(perGame(recAirYards, n)),

    // Production (per game, plus counting stats over the window).
    ppr_pg: r1(perGame(ppr, n)),
    rec_pg: r1(perGame(receptions, n)),
    rec_yards_pg: r1(perGame(recYards, n)),
    rush_yards_pg: r1(perGame(rushYards, n)),
    pass_yards_pg: r1(perGame(passYards, n)),
    tds_total: tds,
    first_downs_pg: r1(perGame(firstDowns, n)),
    explosive_total: explosive,

    // Efficiency — all computed from window totals.
    yards_per_target: r2(rate(recYards, targets)),
    catch_rate: r3(rate(receptions, targets)),
    yards_per_carry: r2(rate(rushYards, carries)),
    yards_per_reception: r2(rate(recYards, receptions)),
    yac_per_reception: r2(rate(recYac, receptions)),
    yards_per_attempt: r2(rate(passYards, attempts)),
    ppr_per_opportunity: r2(rate(ppr, opportunities)),
    epa_per_play: r3(rate(epaTotal, plays)),
    racr: r2(mean(games, 'racr')),
    cpoe: r2(mean(games, 'passing_cpoe')),
  };
}

// Three windows over a player's game log. Missing windows return null
// rather than fabricated data (e.g. last3 before three games are played
// still returns what exists — the caller sees `games` and can judge).
export function computeWindows(player) {
  const games = player?.games ?? [];
  if (!games.length) return { season: null, last3: null, last1: null };
  const pos = player.position ?? null;
  return {
    season: windowStats(games, pos),
    last3: windowStats(games.slice(-3), pos),
    last1: windowStats(games.slice(-1), pos),
  };
}
