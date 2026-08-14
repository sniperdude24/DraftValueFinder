import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend, opportunity } from '../src/analyze/trends.js';

// Build a WR game log: [snap_pct, targets, points] per week.
function wr(games) {
  return {
    position: 'WR',
    meta: { years_exp: 3 },
    games: games.map(([snap, tgt, points], i) => ({
      week: i + 1, snap_pct: snap, targets: tgt, receptions: Math.round(tgt * 0.7),
      carries: 0, attempts: 0, fantasy_points: points, target_share: null,
    })),
  };
}

test('rising snaps AND targets over last 3 → usage rising', () => {
  const t = computeTrend(wr([[0.6, 6, 12], [0.6, 6, 11], [0.6, 6, 12], [0.6, 6, 12], [0.7, 8, 14], [0.72, 9, 15], [0.75, 9, 16]]));
  assert.ok(t.available);
  assert.equal(t.directions.snaps, 'rising');
  assert.equal(t.directions.opportunities, 'rising');
  assert.equal(t.usage, 'rising');
});

test('falling snaps AND targets → usage falling', () => {
  const t = computeTrend(wr([[0.8, 9, 18], [0.8, 9, 17], [0.8, 9, 18], [0.8, 8, 16], [0.6, 5, 8], [0.58, 5, 7], [0.55, 4, 6]]));
  assert.equal(t.usage, 'falling');
});

test('point spike WITHOUT usage growth is flagged unsustainable, not rewarded', () => {
  // Flat-to-declining usage, but huge PPR jump in last 3 (TD luck).
  const t = computeTrend(wr([[0.6, 6, 10], [0.6, 6, 10], [0.6, 6, 10], [0.6, 6, 10], [0.58, 5.5, 26], [0.57, 5.5, 24], [0.56, 5.5, 25]]));
  assert.ok(t.flags.unsustainable_spike, 'spike without usage growth must be flagged');
  assert.notEqual(t.usage, 'rising');
});

test('quiet usage rise (usage up, points lag) is flagged as market-lag candidate', () => {
  const t = computeTrend(wr([[0.5, 4, 8], [0.5, 4, 8], [0.5, 4, 8], [0.5, 4, 8], [0.62, 6, 8.5], [0.65, 6.5, 8.5], [0.66, 7, 9]]));
  assert.equal(t.usage, 'rising');
  assert.ok(t.flags.quiet_usage_rise);
});

test('too few games → trend unavailable with reason', () => {
  const t = computeTrend(wr([[0.6, 6, 12], [0.6, 6, 12], [0.7, 8, 14]]));
  assert.equal(t.available, false);
  assert.match(t.reason, /sample too small/i);
});

test('rookie with no games → unavailable, labeled rookie', () => {
  const t = computeTrend({ position: 'WR', meta: { years_exp: 0 }, games: [] });
  assert.equal(t.available, false);
  assert.match(t.reason, /rookie/i);
});

test('K/DST excluded from trend analysis', () => {
  const t = computeTrend({ position: 'DST', games: [] });
  assert.equal(t.available, false);
});

test('opportunity metric is position-aware', () => {
  const g = { targets: 4, carries: 12, attempts: 30 };
  assert.equal(opportunity(g, 'RB'), 16);   // carries + targets
  assert.equal(opportunity(g, 'WR'), 4);    // targets
  assert.equal(opportunity(g, 'QB'), 42);   // attempts + carries
});

test('rest-game caveat noted when final week snap share collapses', () => {
  const t = computeTrend(wr([[0.8, 8, 15], [0.8, 8, 15], [0.8, 8, 15], [0.8, 8, 15], [0.85, 9, 16], [0.85, 9, 17], [0.15, 1, 2]]));
  assert.ok(t.notes.some(n => /rest or injury/i.test(n)), 'week-18 rest game should be surfaced');
});

// ---- the baseline must not borrow a differently-scored number ----

test('a baseline with no scored points reports null, not nflverse\'s PPR average', () => {
  // `baseline.ppr` is nflverse's PPR figure. Falling back to it here would put
  // a PPR number under a column labelled with the user's own scoring — the same
  // category error as calling custom points "PPR", but at the value level,
  // where nothing on screen could reveal it.
  const legacy = { season: 2025, games: 15, snap_pct: 0.45, targets: 4.0, carries: 0, attempts: 0, ppr: 7.5 };
  const player = {
    position: 'WR', stats_season: 2026, meta: { years_exp: 4 },
    games: [{ week: 1, snap_pct: 0.85, targets: 9, receptions: 6, carries: 0, attempts: 0, fantasy_points: 14, target_share: null }],
    baseline: legacy,
  };
  const t = computeTrend(player);
  assert.equal(t.basis.type, 'prior-baseline');
  assert.equal(t.season.points, null, 'no stored components means no number, not a borrowed one');
  assert.equal(t.deltas.points, null, 'and no delta computed against one');

  // With components scored, the same baseline reports the custom figure.
  const scored = computeTrend({ ...player, baseline: { ...legacy, points: 6.2 } });
  assert.equal(scored.season.points, 6.2);
});
