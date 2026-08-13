// AI assessment: a transparent, deterministic re-ranking of the market.
//
// This is NOT a projection. It starts from what the market already believes
// (ADP + expert consensus) and shifts a player up or down ONLY for reasons
// derivable from the data we hold: usage trends, unsustainable spikes,
// injury designations, and sample-size caveats. Every adjustment is emitted
// as a human-readable factor so the UI can show exactly why the AI differs.
// All outputs from this module are AI-generated interpretation, and are
// labeled as such by the UI.

import { computeTrend } from './trends.js';
import { computeSignal } from './signals.js';

// Baseline market rank: average of expert rank and ADP rank when both exist.
export function marketRank(player) {
  const e = player.expert?.rank ?? null;
  const a = player.adp?.rank ?? null;
  if (e != null && a != null) return (e + a) / 2;
  return e ?? a ?? null;
}

export function assessPlayer(player, allPlayers) {
  const trend = computeTrend(player);
  const signal = computeSignal(player, allPlayers, trend);
  const base = marketRank(player);
  const factors = [];
  let mult = 1.0;

  if (base == null) {
    return {
      ai_rank_score: null, verdict: 'no-data', confidence: null, factors: [
        { effect: 'none', text: 'No ADP or expert ranking available — data unavailable' },
      ], trend, signal,
    };
  }

  if (trend.available) {
    if (trend.usage === 'rising') {
      mult *= 0.85;
      factors.push({ effect: 'up', text: `Usage rising: snap share ${pct(trend.season.snap_pct)} → ${pct(trend.recent.snap_pct)}, opportunities ${trend.season.opportunities} → ${trend.recent.opportunities} per game (last 3 of 2025)` });
    } else if (trend.usage === 'mixed-up') {
      mult *= 0.93;
      factors.push({ effect: 'up', text: `Partial usage growth: snaps ${trend.directions.snaps}, opportunities ${trend.directions.opportunities} (last 3 of 2025)` });
    } else if (trend.usage === 'falling') {
      mult *= 1.15;
      factors.push({ effect: 'down', text: `Usage falling: snap share ${pct(trend.season.snap_pct)} → ${pct(trend.recent.snap_pct)}, opportunities ${trend.season.opportunities} → ${trend.recent.opportunities} per game (last 3 of 2025)` });
    } else if (trend.usage === 'mixed-down') {
      mult *= 1.07;
      factors.push({ effect: 'down', text: `Partial usage decline: snaps ${trend.directions.snaps}, opportunities ${trend.directions.opportunities} (last 3 of 2025)` });
    }
    if (trend.flags.unsustainable_spike) {
      mult *= 1.10;
      factors.push({ effect: 'down', text: `Recent point spike (${trend.season.ppr} → ${trend.recent.ppr} PPR/g) came WITHOUT usage growth — treated as noise, not opportunity` });
    }
    if (trend.flags.quiet_usage_rise) {
      factors.push({ effect: 'context', text: 'Usage rose faster than production — the kind of gap fantasy markets are slow to price in' });
    }
    for (const n of trend.notes) factors.push({ effect: 'caution', text: n });
  } else {
    factors.push({ effect: 'context', text: trend.reason });
  }

  const inj = player.meta?.injury_status;
  if (inj === 'Out' || inj === 'IR' || inj === 'PUP' || inj === 'Sus') {
    mult *= 1.30;
    factors.push({ effect: 'down', text: `Injury designation: ${inj} (Sleeper)` });
  } else if (inj === 'Doubtful') {
    mult *= 1.15;
    factors.push({ effect: 'down', text: 'Injury designation: Doubtful (Sleeper)' });
  } else if (inj === 'Questionable') {
    mult *= 1.05;
    factors.push({ effect: 'down', text: 'Injury designation: Questionable (Sleeper)' });
  }

  if (player.changed_team) {
    factors.push({ effect: 'caution', text: `2025 usage was earned on ${player.team_2025}; now on ${player.team} — role may differ` });
  }

  // Market disagreement between the two external sources is itself information.
  const e = player.expert?.rank, a = player.adp?.rank;
  if (e != null && a != null && Math.abs(e - a) >= 15) {
    factors.push({ effect: 'context', text: `ADP (#${a}) and expert consensus (#${e}) disagree by ${Math.abs(e - a)} spots — the market itself is unsure` });
  }

  const score = base * mult;
  const verdict = mult <= 0.88 ? 'higher' : mult >= 1.12 ? 'lower' : 'inline';

  // Confidence: starts at 50, earns points for corroborating evidence,
  // loses points for unknowns. Bounded [20, 95]. This is a measure of how
  // much evidence backs the assessment — NOT a probability of success.
  let conf = 50;
  if (e != null && a != null) conf += Math.abs(e - a) <= 10 ? 15 : 5;
  if (trend.available) {
    conf += 10;
    if (trend.season.games >= 10) conf += 5;
    if (trend.usage === 'rising' || trend.usage === 'falling') conf += 10; // consistent story
    if (trend.flags.unsustainable_spike) conf -= 5;
  } else {
    conf -= 15;
  }
  if (player.changed_team) conf -= 10;
  if (inj) conf -= 10;
  if (player.expert?.stdev != null && player.expert.stdev > 20) conf -= 5;
  conf = Math.max(20, Math.min(95, Math.round(conf)));

  return { ai_rank_score: score, verdict, confidence: conf, factors, trend, signal };
}

// Assess the full universe and assign ordinal AI ranks.
export function assessAll(players) {
  const out = new Map();
  for (const p of players) out.set(p.id, assessPlayer(p, players));
  const ranked = players
    .filter(p => out.get(p.id).ai_rank_score != null)
    .sort((x, y) => out.get(x.id).ai_rank_score - out.get(y.id).ai_rank_score);
  ranked.forEach((p, i) => { out.get(p.id).ai_rank = i + 1; });
  for (const p of players) if (out.get(p.id).ai_rank === undefined) out.get(p.id).ai_rank = null;
  return out;
}

function pct(v) { return v == null ? 'n/a' : `${Math.round(v * 100)}%`; }
