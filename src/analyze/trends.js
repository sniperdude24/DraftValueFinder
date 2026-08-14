// Usage trend detection over the active stats season's game log.
//
// Two comparison bases, both reported explicitly (never silently mixed):
//  - 'season':          ≥4 games played → last 3 games vs season average
//                       (the original draft-mode logic, also used from
//                       week 4+ in season mode).
//  - 'prior-baseline':  <4 games played AND a prior-season baseline exists
//                       (early season mode) → current games vs last
//                       season's per-game averages. This is how a week-1
//                       role change gets flagged before the market prices
//                       it in.
//
// Spec rule either way: a meaningful sleeper trend requires increasing
// snaps AND increasing targets/touches. A fantasy-point spike without usage
// growth is explicitly flagged as unsustainable, not rewarded.

const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function avg(games, field) {
  const vals = games.map(g => g[field]).filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// The "opportunity" metric differs by position:
//  RB: carries + targets;  WR/TE: targets;  QB: pass attempts + carries.
export function opportunity(game, position) {
  const t = game.targets ?? 0, c = game.carries ?? 0, a = game.attempts ?? 0;
  if (position === 'RB') return c + t;
  if (position === 'QB') return a + c;
  return game.targets == null ? null : t;
}

function classify(snapDelta, oppDelta, oppDeltaPct) {
  // Direction thresholds (documented, deliberately simple):
  //  snaps: ±4 percentage points; opportunities: ±10% AND ±1.0 absolute.
  const snaps = snapDelta == null ? 'unknown'
    : snapDelta >= 0.04 ? 'rising' : snapDelta <= -0.04 ? 'falling' : 'flat';
  const opps = oppDelta == null || oppDeltaPct == null ? 'unknown'
    : (oppDeltaPct >= 0.10 && oppDelta >= 1) ? 'rising'
    : (oppDeltaPct <= -0.10 && oppDelta <= -1) ? 'falling' : 'flat';
  return { snaps, opps };
}

function assemble({ base, recent, weeks, basis, notes, games }) {
  const snapDelta = base.snap_pct != null && recent.snap_pct != null
    ? round(recent.snap_pct - base.snap_pct, 3) : null;
  const oppDelta = base.opportunities != null && recent.opportunities != null
    ? round(recent.opportunities - base.opportunities) : null;
  const oppDeltaPct = oppDelta != null && base.opportunities > 0
    ? round(oppDelta / base.opportunities, 3) : null;
  const pprDelta = base.ppr != null && recent.ppr != null ? round(recent.ppr - base.ppr) : null;

  const { snaps: snapDir, opps: oppDir } = classify(snapDelta, oppDelta, oppDeltaPct);

  const unsustainableSpike = pprDelta != null && base.ppr > 0
    && pprDelta / base.ppr >= 0.35 && snapDir !== 'rising' && oppDir !== 'rising';
  const quietUsageRise = snapDir === 'rising' && oppDir === 'rising'
    && (pprDelta == null || base.ppr <= 0 || pprDelta / base.ppr < 0.20);

  const usage = snapDir === 'rising' && oppDir === 'rising' ? 'rising'
    : snapDir === 'falling' && oppDir === 'falling' ? 'falling'
    : (snapDir === 'rising' || oppDir === 'rising') ? 'mixed-up'
    : (snapDir === 'falling' || oppDir === 'falling') ? 'mixed-down'
    : 'flat';

  return {
    available: true,
    basis,
    season: { ...base, games: games ?? base.games },
    recent: { ...recent, weeks },
    deltas: { snap_pct: snapDelta, opportunities: oppDelta, opportunities_pct: oppDeltaPct, ppr: pprDelta },
    directions: { snaps: snapDir, opportunities: oppDir },
    usage,
    flags: { unsustainable_spike: Boolean(unsustainableSpike), quiet_usage_rise: Boolean(quietUsageRise) },
    notes,
  };
}

export function computeTrend(player) {
  const games = player.games ?? [];
  const pos = player.position;
  const statsSeason = player.stats_season ?? '?';
  if (['K', 'DST'].includes(pos)) return { available: false, reason: 'Trend analysis not applied to K/DST' };

  const withOpp = g => ({ ...g, opp: opportunity(g, pos) });

  // ---- full-sample path: last 3 games vs season average ----
  if (games.length >= 4) {
    const last3 = games.slice(-3);
    const seasonG = games.map(withOpp), last3G = last3.map(withOpp);
    const base = {
      games: games.length,
      snap_pct: round(avg(seasonG, 'snap_pct'), 3),
      targets: round(avg(seasonG, 'targets')),
      carries: round(avg(seasonG, 'carries')),
      opportunities: round(avg(seasonG, 'opp')),
      target_share: round(avg(seasonG, 'target_share'), 3),
      ppr: round(avg(seasonG, 'fantasy_points')),
    };
    const recent = {
      snap_pct: round(avg(last3G, 'snap_pct'), 3),
      targets: round(avg(last3G, 'targets')),
      carries: round(avg(last3G, 'carries')),
      opportunities: round(avg(last3G, 'opp')),
      target_share: round(avg(last3G, 'target_share'), 3),
      ppr: round(avg(last3G, 'fantasy_points')),
    };
    const notes = [];
    const lastGame = games[games.length - 1];
    if (lastGame.snap_pct != null && base.snap_pct != null && lastGame.snap_pct < base.snap_pct * 0.4) {
      notes.push(`Week ${lastGame.week} snap share (${Math.round(lastGame.snap_pct * 100)}%) was far below the season norm — possible rest or injury game inside the window`);
    }
    return assemble({
      base, recent,
      weeks: last3.map(g => g.week),
      basis: { type: 'season', window_label: `last 3 of ${statsSeason}` },
      notes,
    });
  }

  // ---- early-season path: current games vs prior-season baseline ----
  const baseline = player.baseline;
  if (games.length >= 1 && baseline && baseline.games >= 6) {
    const curG = games.map(withOpp);
    const baseOpp = pos === 'RB' ? (baseline.carries ?? 0) + (baseline.targets ?? 0)
      : pos === 'QB' ? (baseline.attempts ?? 0) + (baseline.carries ?? 0)
      : baseline.targets;
    const base = {
      games: baseline.games,
      snap_pct: baseline.snap_pct,
      targets: baseline.targets,
      carries: baseline.carries,
      opportunities: round(baseOpp),
      target_share: null,
      // Re-scored under the active rules when the database loads. `ppr` is
      // the frozen PPR figure, kept only as a fallback for records built
      // before scoring components were stored on the baseline.
      ppr: baseline.points ?? baseline.ppr,
    };
    const recent = {
      snap_pct: round(avg(curG, 'snap_pct'), 3),
      targets: round(avg(curG, 'targets')),
      carries: round(avg(curG, 'carries')),
      opportunities: round(avg(curG, 'opp')),
      target_share: round(avg(curG, 'target_share'), 3),
      ppr: round(avg(curG, 'fantasy_points')),
    };
    return assemble({
      base, recent,
      weeks: games.map(g => g.week),
      basis: { type: 'prior-baseline', window_label: `${statsSeason} wk ${games.map(g => g.week).join(',')} vs ${baseline.season} per-game baseline` },
      notes: [`Small ${statsSeason} sample (${games.length} game${games.length > 1 ? 's' : ''}) — compared against the player's ${baseline.season} per-game baseline (${baseline.games} games), not a same-season average`],
    });
  }

  // ---- not enough evidence ----
  if (games.length === 0) {
    const rookie = (player.meta?.years_exp ?? null) === 0;
    return { available: false, reason: rookie ? 'Rookie — no NFL game data' : `No ${statsSeason} games played — data unavailable` };
  }
  return {
    available: false,
    reason: `Only ${games.length} game${games.length > 1 ? 's' : ''} in ${statsSeason} and no usable prior-season baseline — sample too small for a trend comparison`,
  };
}
