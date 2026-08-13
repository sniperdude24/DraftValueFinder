import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignal, contextFactors } from '../src/analyze/signals.js';

function player(games, { id = 'WR-test', team = 'KC', pos = 'WR', meta = { years_exp: 3 } } = {}) {
  return {
    id, name: 'Test Player', position: pos, team, meta,
    games_2025: games.map(([snap, tgt], i) => ({
      week: i + 1, snap_pct: snap, targets: tgt, receptions: Math.round(tgt * 0.7),
      carries: 0, attempts: 0, fantasy_points_ppr: tgt * 1.8, target_share: null,
    })),
  };
}

const strongRise = [[0.5, 5], [0.5, 5], [0.5, 5], [0.5, 5], [0.62, 7], [0.65, 8], [0.68, 8]];
// Snap delta ≈ +5pts and opportunity delta ≈ +18% vs season — past the
// "rising" thresholds (4pts / 10%) but below "strong" (7pts / 20%).
const modestRise = [[0.5, 5], [0.5, 5], [0.5, 5], [0.5, 5], [0.59, 6.8], [0.59, 6.8], [0.59, 6.8]];
const snapOnlyRise = [[0.5, 5], [0.5, 5], [0.5, 5], [0.5, 5], [0.62, 5], [0.64, 5], [0.66, 5]];
const flat = [[0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6]];

test('strong rise in snaps AND opportunities → SLEEPER SIGNAL', () => {
  const s = computeSignal(player(strongRise), []);
  assert.equal(s.state, 'signal');
  assert.ok(s.evidence.snaps.last3 > s.evidence.snaps.season);
});

test('modest dual rise with no supporting context → EMERGING only', () => {
  const s = computeSignal(player(modestRise), []);
  assert.equal(s.state, 'emerging');
});

test('modest dual rise WITH teammate injury context → upgraded to SIGNAL', () => {
  const p = player(modestRise);
  const injuredTeammate = { id: 'WR-hurt', name: 'Hurt Guy', position: 'WR', team: 'KC', meta: { injury_status: 'IR' } };
  const s = computeSignal(p, [p, injuredTeammate]);
  assert.equal(s.state, 'signal');
  assert.ok(s.context.some(c => c.kind === 'teammate_injury'));
});

test('snaps rising alone (opportunities not confirming) → EMERGING, never SIGNAL', () => {
  const s = computeSignal(player(snapOnlyRise), []);
  assert.equal(s.state, 'emerging');
  assert.match(s.reason, /not confirming/i);
});

test('flat usage → no signal', () => {
  const s = computeSignal(player(flat), []);
  assert.equal(s.state, 'none');
});

test('no game data → no signal, reason exposed', () => {
  const s = computeSignal(player([]), []);
  assert.equal(s.state, 'none');
});

test('context includes team change caveat', () => {
  const p = { ...player(flat), changed_team: true, team_2025: 'NYJ' };
  const ctx = contextFactors(p, []);
  assert.ok(ctx.some(c => c.kind === 'team_change'));
});
