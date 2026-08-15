import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, gradeLog, MIN_GAMES, DEFAULT_HORIZON } from '../src/analyze/accountability.js';

// A WR game log: [snap_pct, targets, points] per week, weeks 1..n.
const wr = (id, rows) => ({
  id, name: id, position: 'WR', stats_season: 2025,
  games: rows.map(([snap, tgt, pts], i) => ({
    week: i + 1, snap_pct: snap, targets: tgt, receptions: Math.round(tgt * 0.7),
    carries: 0, attempts: 0, target_share: null, fantasy_points: pts,
  })),
});

// Flat, unremarkable usage — never trips a signal.
const flat = n => Array.from({ length: n }, () => [0.7, 6, 10]);

// ---- the property the whole thing rests on ----

test('the future cannot reach the signal — four flat games classify as flat', () => {
  // THE guard. This player is unremarkable for four games and then explodes in
  // both usage and points. With minGames 4 and horizon 2 there is exactly ONE
  // cut, and it may see only the four flat games — so it must classify as
  // 'none'. If the slice leaks, the trend sees the explosion it is supposed to
  // be predicting and the cut lands in 'signal': a backtest that looks
  // brilliant because it was shown the answer.
  const player = wr('leak', [
    [0.70, 6, 10], [0.70, 6, 10], [0.70, 6, 10], [0.70, 6, 10],   // known at the cut
    [0.99, 20, 40], [0.99, 20, 40],                                // the future
  ]);
  const r = backtest([player], { horizon: 2, minGames: 4 });

  assert.equal(r.cuts, 1);
  assert.equal(r.groups.none.n, 1, 'four flat games are not a signal');
  assert.equal(r.groups.signal.n, 0, 'a signal here means the future leaked in');
  // And the forward window is the explosion, measured but never seen.
  assert.equal(r.groups.none.forward_pg, 40);
  assert.equal(r.groups.none.trailing_pg, 10);
});

test('the forward window is strictly after the cut, and never overlaps it', () => {
  // Trailing is weeks 1..N, forward is the N+1.. window. If the cut were
  // off by one the two would share a game and the delta would be damped
  // toward zero — a quiet, plausible-looking wrong answer.
  const player = wr('p', [...flat(4), [0.7, 6, 100], [0.7, 6, 100]]);
  const r = backtest([player], { horizon: 2, minGames: 4 });
  assert.equal(r.cuts, 1, 'exactly one cut fits: 4 known + 2 forward');
  const g = r.groups.none;
  assert.equal(g.trailing_pg, 10, 'trailing is the four flat games only');
  assert.equal(g.forward_pg, 100, 'forward is the two big games only');
  assert.equal(g.delta, 90);
});

// ---- cut generation ----

test('a player with too few games produces no cuts at all', () => {
  assert.equal(backtest([wr('short', flat(MIN_GAMES + DEFAULT_HORIZON - 1))]).cuts, 0);
  assert.equal(backtest([wr('ok', flat(MIN_GAMES + DEFAULT_HORIZON))]).cuts, 1);
});

test('a partial forward window is skipped, not measured short', () => {
  // Cuts near the end of the season would otherwise average over 1 game and
  // sit alongside cuts averaging over 4, which is not a like-for-like row.
  const r = backtest([wr('p', flat(10))], { horizon: 4, minGames: 4 });
  assert.equal(r.cuts, 3, 'cuts after 4, 5 and 6 games; a 7th would run out of forward games');
});

test('an empty universe returns a shaped, empty result rather than throwing', () => {
  const r = backtest([]);
  assert.equal(r.cuts, 0);
  assert.equal(r.groups.signal.n, 0);
  assert.equal(r.groups.signal.delta, null, 'no observations means no number, not zero');
  assert.equal(r.lift, null);
  assert.ok(r.caveats.length >= 3, 'the caveats ship with the result, not with the page');
});

// ---- the two claims, measured against the right baselines ----

test('a rising player lands in the signal group', () => {
  const rising = wr('riser', [
    [0.40, 3, 5], [0.42, 3, 6], [0.41, 3, 5], [0.44, 4, 6],
    [0.75, 9, 16], [0.78, 10, 18], [0.80, 10, 17],
    [0.80, 10, 17], [0.78, 9, 16], [0.80, 10, 18],
  ]);
  const r = backtest([rising], { horizon: 3, minGames: 4 });
  assert.ok(r.groups.signal.n > 0, 'both snaps and opportunities rose sharply');
});

test('the spike claim is measured against the burst, not the season average', () => {
  // The engine says a points burst WITHOUT usage growth will not hold. Testing
  // that against the season mean tests the wrong thing — the burst is inside
  // the season mean. It has to be measured against the burst itself.
  const spiky = wr('spiky', [
    [0.7, 6, 4], [0.7, 6, 5], [0.7, 6, 4], [0.7, 6, 5],
    [0.7, 6, 24], [0.7, 6, 26], [0.7, 6, 25],   // points explode, usage flat
    [0.7, 6, 5], [0.7, 6, 4], [0.7, 6, 5],      // and fall back
  ]);
  const r = backtest([spiky], { horizon: 3, minGames: 7 });
  assert.ok(r.spike.n > 0, 'the spike flag fired');
  assert.ok(r.spike.delta_vs_recent < 0, 'a correct rejection is a NEGATIVE give-back vs the burst');
  assert.ok(r.spike.recent_pg > r.spike.forward_pg, 'the burst did not hold');
});

test('groups report a player count, because cuts from one player are not independent', () => {
  const r = backtest([wr('a', flat(12)), wr('b', flat(12))]);
  assert.equal(r.groups.none.players, 2);
  assert.ok(r.groups.none.n > r.groups.none.players, 'several cuts per player');
});

// ---- grading the log ----

const player = wr('WR-x', [...flat(4), [0.7, 6, 20], [0.7, 6, 20]]);

test('a logged call with no week cannot be placed and is reported, not guessed', () => {
  const g = gradeLog([{ player_id: 'WR-x', player: 'x', at: '2026-08-14T00:00:00Z' }], [player]);
  assert.equal(g.available, false);
  assert.equal(g.pending.no_week, 1);
  assert.match(g.reason, /predates the week being recorded/);
});

test('a call from before games were played grades against what followed', () => {
  const g = gradeLog(
    [{ player_id: 'WR-x', player: 'x', week: 4, season: 2025, sleeper_state: 'signal', ai_rank: 12, at: '2025-10-01T00:00:00Z' }],
    [player], { horizon: 2 });
  assert.equal(g.available, true);
  assert.equal(g.graded[0].trailing_pg, 10, 'form at the time = weeks 1-4');
  assert.equal(g.graded[0].forward_pg, 20, 'what happened after = weeks 5-6');
  assert.equal(g.graded[0].delta, 10);
});

test('a call about a different season is not graded against this one', () => {
  const g = gradeLog([{ player_id: 'WR-x', player: 'x', week: 4, season: 2024 }], [player]);
  assert.equal(g.available, false);
  assert.equal(g.pending.no_games_yet, 1);
});

test('a call about a player no longer in the universe is counted, not dropped', () => {
  const g = gradeLog([{ player_id: 'WR-gone', player: 'gone', week: 4, season: 2025 }], [player]);
  assert.equal(g.pending.player_not_found, 1);
});

test('grading an empty log is empty, not an error', () => {
  const g = gradeLog([], []);
  assert.equal(g.available, false);
  assert.equal(g.summary, null);
  assert.equal(g.pending.total, 0);
});
