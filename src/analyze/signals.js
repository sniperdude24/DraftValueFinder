// Sleeper detection: three conceptual states per the spec.
//   'recommendation'  — solid pick at cost, no special usage story required
//                       (handled by recommend.js; not assigned here)
//   'emerging'        — something interesting, evidence incomplete
//   'signal'          — snaps AND opportunities rising; market likely late
//
// This module assigns the sleeper-specific states (emerging / signal / none)
// plus the supporting context that justifies them. Context never substitutes
// for usage evidence — it only supports it (spec: usage first, context second).

import { computeTrend } from './trends.js';

// Supporting context factors we can derive from the data we actually have.
export function contextFactors(player, allPlayers) {
  const factors = [];
  if (!player.team) return factors;

  // Teammate at the same position currently injured/out.
  const posGroup = p => (p === 'RB' ? 'RB' : p);
  for (const other of allPlayers) {
    if (other.id === player.id || other.team !== player.team) continue;
    if (posGroup(other.position) !== posGroup(player.position)) continue;
    const inj = other.meta?.injury_status;
    if (inj && ['Out', 'IR', 'PUP', 'Sus', 'Doubtful', 'Questionable'].includes(inj)) {
      factors.push({
        kind: 'teammate_injury',
        text: `Teammate ${other.name} (${other.position}, ${other.team}) is listed ${inj}`,
        source: 'Sleeper injury status',
      });
    }
  }

  const dco = player.meta?.depth_chart_order;
  if (dco === 1) {
    factors.push({ kind: 'depth_chart', text: `Listed first on the ${player.team} depth chart at ${player.meta.depth_chart_position ?? player.position}`, source: 'Sleeper depth chart' });
  } else if (dco === 2) {
    factors.push({ kind: 'depth_chart', text: `Listed second on the ${player.team} depth chart`, source: 'Sleeper depth chart' });
  }

  if (player.changed_team) {
    factors.push({
      kind: 'team_change',
      text: `Changed teams since 2025 (${player.team_2025} → ${player.team}) — 2025 usage may not carry over`,
      source: 'roster data',
    });
  }
  return factors;
}

export function computeSignal(player, allPlayers, trend = null) {
  trend = trend ?? computeTrend(player);
  const context = contextFactors(player, allPlayers);
  const supporting = context.filter(c => c.kind !== 'team_change');

  if (!trend.available) {
    return { state: 'none', reason: trend.reason, context, evidence: null };
  }

  const { directions, flags } = trend;
  const bothRising = directions.snaps === 'rising' && directions.opportunities === 'rising';
  const oneRising = directions.snaps === 'rising' || directions.opportunities === 'rising';

  const evidence = {
    snaps: { season: trend.season.snap_pct, last3: trend.recent.snap_pct, direction: directions.snaps },
    opportunities: { season: trend.season.opportunities, last3: trend.recent.opportunities, direction: directions.opportunities },
    ppr: { season: trend.season.ppr, last3: trend.recent.ppr },
    window_weeks: trend.recent.weeks,
  };

  if (bothRising) {
    // Spec: signal requires snaps AND opportunities rising. Strength of the
    // rise plus supporting context decides signal vs emerging.
    const strong = (trend.deltas.snap_pct ?? 0) >= 0.07 || (trend.deltas.opportunities_pct ?? 0) >= 0.20;
    if (strong || supporting.length > 0) {
      return { state: 'signal', reason: 'Snap share and opportunities both rising over the last 3 games', context, evidence };
    }
    return { state: 'emerging', reason: 'Snap share and opportunities both rising, but modestly and without supporting context yet', context, evidence };
  }

  if (oneRising && !flags.unsustainable_spike) {
    return { state: 'emerging', reason: directions.snaps === 'rising' ? 'Snap share rising; opportunities not confirming yet' : 'Opportunities rising; snap share not confirming yet', context, evidence };
  }

  if (flags.unsustainable_spike) {
    return { state: 'none', reason: 'Recent fantasy-point spike is NOT backed by usage growth — treating as noise', context, evidence, warning: 'unsustainable_spike' };
  }

  return { state: 'none', reason: 'No usage-based sleeper evidence in the last-3-game window', context, evidence };
}
