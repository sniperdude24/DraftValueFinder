import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPlayer, assessAll, marketRank } from '../src/analyze/score.js';

function mkPlayer(games, { adpRank = 50, expertRank = 50, injury = null, id = 'WR-a' } = {}) {
  return {
    id, name: 'Player ' + id, position: 'WR', team: 'KC', team_2025: 'KC', changed_team: false,
    bye: 8, meta: { years_exp: 3, injury_status: injury },
    adp: { rank: adpRank, overall: adpRank, formatted: 'x', stdev: 3 },
    expert: { rank: expertRank, tier: 3, stdev: 5 },
    games: games.map(([snap, tgt], i) => ({
      week: i + 1, snap_pct: snap, targets: tgt, receptions: Math.round(tgt * 0.7),
      carries: 0, attempts: 0, fantasy_points_ppr: tgt * 1.8, target_share: null,
    })),
  };
}

const rising = [[0.5, 5], [0.5, 5], [0.5, 5], [0.5, 5], [0.62, 7], [0.65, 8], [0.68, 8]];
const falling = [[0.7, 8], [0.7, 8], [0.7, 8], [0.7, 8], [0.55, 5], [0.52, 5], [0.5, 4]];
const flat = [[0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6], [0.6, 6]];

test('marketRank averages ADP and expert rank', () => {
  assert.equal(marketRank(mkPlayer(flat, { adpRank: 40, expertRank: 60 })), 50);
});

test('rising usage moves AI assessment ahead of market; falling behind it', () => {
  const up = assessPlayer(mkPlayer(rising), []);
  const down = assessPlayer(mkPlayer(falling), []);
  const base = assessPlayer(mkPlayer(flat), []);
  assert.ok(up.ai_rank_score < base.ai_rank_score, 'rising usage must improve (lower) the rank score');
  assert.ok(down.ai_rank_score > base.ai_rank_score, 'falling usage must worsen the rank score');
  assert.equal(up.verdict, 'higher');
  assert.equal(down.verdict, 'lower');
});

test('serious injury designation worsens assessment and is cited as a factor', () => {
  const hurt = assessPlayer(mkPlayer(flat, { injury: 'IR' }), []);
  const healthy = assessPlayer(mkPlayer(flat), []);
  assert.ok(hurt.ai_rank_score > healthy.ai_rank_score);
  assert.ok(hurt.factors.some(f => /IR/.test(f.text)));
});

test('every adjustment is explained by a factor with real numbers', () => {
  const a = assessPlayer(mkPlayer(rising), []);
  const usageFactor = a.factors.find(f => f.effect === 'up');
  assert.ok(usageFactor, 'rising usage must produce an up factor');
  assert.match(usageFactor.text, /\d/, 'factor must cite the underlying numbers');
});

test('confidence stays within [20, 95] and drops when data is missing', () => {
  const full = assessPlayer(mkPlayer(flat), []);
  const noStats = assessPlayer(mkPlayer([]), []);
  assert.ok(full.confidence >= 20 && full.confidence <= 95);
  assert.ok(noStats.confidence < full.confidence, 'missing game data must reduce confidence');
});

test('player with no market data gets no invented rank', () => {
  const p = mkPlayer(flat);
  p.adp = null; p.expert = null;
  const a = assessPlayer(p, []);
  assert.equal(a.ai_rank_score, null);
  assert.equal(a.verdict, 'no-data');
  assert.match(a.factors[0].text, /unavailable/i);
});

test('assessAll assigns dense ordinal ranks', () => {
  const players = [mkPlayer(rising, { id: 'WR-a', adpRank: 30, expertRank: 30 }), mkPlayer(falling, { id: 'WR-b', adpRank: 20, expertRank: 20 }), mkPlayer(flat, { id: 'WR-c', adpRank: 25, expertRank: 25 })];
  const out = assessAll(players);
  const ranks = players.map(p => out.get(p.id).ai_rank).sort();
  assert.deepEqual(ranks, [1, 2, 3]);
});
