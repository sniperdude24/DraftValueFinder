// Last-3-game trend detection over the 2025 game log.
//
// Primary window: the player's last 3 games PLAYED (missed weeks skip
// naturally). Every output keeps the raw numbers (season vs last-3) so the
// UI and AI explanations can show evidence instead of adjectives.
//
// Spec rule: a meaningful sleeper trend requires increasing snaps AND
// increasing targets/touches. A fantasy-point spike without usage growth is
// explicitly flagged as unsustainable, not rewarded.

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

export function computeTrend(player) {
  const games = player.games_2025 ?? [];
  const pos = player.position;
  if (['K', 'DST'].includes(pos)) return { available: false, reason: 'Trend analysis not applied to K/DST' };
  if (games.length === 0) {
    const rookie = (player.meta?.years_exp ?? null) === 0;
    return { available: false, reason: rookie ? 'Rookie — no NFL game data' : 'No 2025 games played — data unavailable' };
  }
  if (games.length < 4) {
    return { available: false, reason: `Only ${games.length} games in 2025 — sample too small for a season-vs-recent comparison` };
  }

  const last3 = games.slice(-3);
  const withOpp = g => ({ ...g, opp: opportunity(g, pos) });
  const seasonG = games.map(withOpp), last3G = last3.map(withOpp);

  const season = {
    games: games.length,
    snap_pct: round(avg(seasonG, 'snap_pct'), 3),
    targets: round(avg(seasonG, 'targets')),
    carries: round(avg(seasonG, 'carries')),
    opportunities: round(avg(seasonG, 'opp')),
    target_share: round(avg(seasonG, 'target_share'), 3),
    ppr: round(avg(seasonG, 'fantasy_points_ppr')),
  };
  const recent = {
    weeks: last3.map(g => g.week),
    snap_pct: round(avg(last3G, 'snap_pct'), 3),
    targets: round(avg(last3G, 'targets')),
    carries: round(avg(last3G, 'carries')),
    opportunities: round(avg(last3G, 'opp')),
    target_share: round(avg(last3G, 'target_share'), 3),
    ppr: round(avg(last3G, 'fantasy_points_ppr')),
  };

  const snapDelta = season.snap_pct != null && recent.snap_pct != null
    ? round(recent.snap_pct - season.snap_pct, 3) : null;
  const oppDelta = season.opportunities != null && recent.opportunities != null
    ? round(recent.opportunities - season.opportunities) : null;
  const oppDeltaPct = oppDelta != null && season.opportunities > 0
    ? round(oppDelta / season.opportunities, 3) : null;
  const pprDelta = season.ppr != null && recent.ppr != null ? round(recent.ppr - season.ppr) : null;

  // Direction thresholds (documented, deliberately simple):
  //  snaps: ±4 percentage points; opportunities: ±10% AND ±1.0 absolute.
  const snapDir = snapDelta == null ? 'unknown'
    : snapDelta >= 0.04 ? 'rising' : snapDelta <= -0.04 ? 'falling' : 'flat';
  const oppDir = oppDelta == null || oppDeltaPct == null ? 'unknown'
    : (oppDeltaPct >= 0.10 && oppDelta >= 1) ? 'rising'
    : (oppDeltaPct <= -0.10 && oppDelta <= -1) ? 'falling' : 'flat';

  // Points spiking while usage is NOT rising = noisy result, not opportunity.
  const unsustainableSpike = pprDelta != null && season.ppr > 0
    && pprDelta / season.ppr >= 0.35 && snapDir !== 'rising' && oppDir !== 'rising';

  // Usage rising while points lag = the market may not have noticed yet.
  const quietUsageRise = snapDir === 'rising' && oppDir === 'rising'
    && (pprDelta == null || season.ppr <= 0 || pprDelta / season.ppr < 0.20);

  const usage = snapDir === 'rising' && oppDir === 'rising' ? 'rising'
    : snapDir === 'falling' && oppDir === 'falling' ? 'falling'
    : (snapDir === 'rising' || oppDir === 'rising') ? 'mixed-up'
    : (snapDir === 'falling' || oppDir === 'falling') ? 'mixed-down'
    : 'flat';

  // A last-3 window ending the season can include a rested/injured finale.
  const lastGame = games[games.length - 1];
  const restNote = lastGame.snap_pct != null && season.snap_pct != null
    && lastGame.snap_pct < season.snap_pct * 0.4
    ? `Week ${lastGame.week} snap share (${Math.round(lastGame.snap_pct * 100)}%) was far below the season norm — possible rest or injury game inside the window`
    : null;

  return {
    available: true,
    season, recent,
    deltas: { snap_pct: snapDelta, opportunities: oppDelta, opportunities_pct: oppDeltaPct, ppr: pprDelta },
    directions: { snaps: snapDir, opportunities: oppDir },
    usage,
    flags: {
      unsustainable_spike: Boolean(unsustainableSpike),
      quiet_usage_rise: Boolean(quietUsageRise),
    },
    notes: restNote ? [restNote] : [],
  };
}
