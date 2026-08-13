import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTradeMarket } from '../src/normalize/tradeMarket.js';
import { assessPlayer } from '../src/analyze/score.js';
import { marketComparison } from '../src/analyze/market.js';
import { assessAll } from '../src/analyze/score.js';

function mkPlayer(id, name, pos, { adpRank = 50, expertRank = 50 } = {}) {
  return {
    id, name, position: pos, team: 'KC', stats_team: 'KC', changed_team: false, bye: 8,
    stats_season: 2025, meta: { years_exp: 3, injury_status: null },
    adp: { rank: adpRank, overall: adpRank, formatted: 'x', stdev: 2 },
    expert: { rank: expertRank, tier: 3, stdev: 4 },
    games: Array.from({ length: 8 }, (_, i) => ({
      week: i + 1, snap_pct: 0.6, targets: 6, receptions: 4, carries: 0, attempts: 0,
      fantasy_points_ppr: 12, target_share: null,
    })),
    baseline: null,
  };
}

test('matchTradeMarket matches across name variants and reports unmatched', () => {
  const players = [
    mkPlayer('WR-jamarr_chase', "Ja'Marr Chase", 'WR'),
    mkPlayer('RB-kenneth_walker', 'Kenneth Walker III', 'RB'),
  ];
  const statsguy = { asOf: '2026-08-13T00:00:00Z', rankings: [
    { rank: 3, id: '1', name: 'Jamarr Chase', team: 'CIN', position: 'WR', positionRank: 1, value: 8505 },
    { rank: 40, id: '2', name: 'Kenneth Walker', team: 'SEA', position: 'RB', positionRank: 12, value: 3000 },
    { rank: 200, id: '3', name: 'Deep Benchguy', team: 'NYJ', position: 'TE', positionRank: 30, value: 100 },
  ] };
  const r = matchTradeMarket(players, statsguy);
  assert.equal(r.matched, 2);
  assert.equal(players[0].trade_market.rank, 3);
  assert.equal(players[0].trade_market.as_of, '2026-08-13T00:00:00Z');
  assert.equal(players[1].trade_market.value, 3000);
  assert.deepEqual(r.unmatched.map(u => u.name), ['Deep Benchguy']);
});

test('players without a trade value get explicit null, and missing source is safe', () => {
  const players = [mkPlayer('WR-a', 'A Guy', 'WR')];
  const r = matchTradeMarket(players, { rankings: [] });
  assert.equal(players[0].trade_market, null);
  assert.equal(r.matched, 0);
});

test('trade-vs-expert split of 15+ spots surfaces as a context factor; smaller splits stay silent', () => {
  const split = mkPlayer('WR-x', 'X', 'WR', { expertRank: 50 });
  split.trade_market = { rank: 90, value: 2000, pos_rank: 30, as_of: null };
  const a = assessPlayer(split, []);
  const f = a.factors.find(x => /trade market/i.test(x.text));
  assert.ok(f, 'the split must be surfaced');
  assert.equal(f.effect, 'context', 'display-only evidence — must not move the AI rank');

  const close = mkPlayer('WR-y', 'Y', 'WR', { expertRank: 50 });
  close.trade_market = { rank: 60, value: 3000, pos_rank: 20, as_of: null };
  const a2 = assessPlayer(close, []);
  assert.ok(!a2.factors.some(x => /trade market/i.test(x.text)), '10-spot split is not meaningful');
});

test('trade split does not change the AI rank score (evidence, not input)', () => {
  const base = mkPlayer('WR-z', 'Z', 'WR');
  const withTrade = mkPlayer('WR-z2', 'Z2', 'WR');
  withTrade.trade_market = { rank: 200, value: 100, pos_rank: 60, as_of: null };
  assert.equal(assessPlayer(base, []).ai_rank_score, assessPlayer(withTrade, []).ai_rank_score);
});

test('market comparison rows carry trade rank and ai_vs_trade delta', () => {
  const players = [mkPlayer('WR-a', 'A', 'WR', { adpRank: 10, expertRank: 10 }), mkPlayer('WR-b', 'B', 'WR', { adpRank: 20, expertRank: 20 })];
  players[0].trade_market = { rank: 30, value: 5000, pos_rank: 10, as_of: null };
  const m = marketComparison(players, assessAll(players));
  const rowA = m.rows.find(r => r.id === 'WR-a');
  assert.equal(rowA.trade_rank, 30);
  assert.equal(rowA.ai_vs_trade, 30 - rowA.ai_rank);
  const rowB = m.rows.find(r => r.id === 'WR-b');
  assert.equal(rowB.trade_rank, null);
  assert.equal(rowB.ai_vs_trade, null);
});
