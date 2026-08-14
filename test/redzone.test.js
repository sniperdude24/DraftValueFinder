import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccumulator, accumulatePlay, finalize, resolveColumns, pickFields,
} from '../src/ingest/sources/nflversePbp.js';
import { windowStats } from '../src/analyze/playerStats.js';
import { buildTeamContext } from '../src/analyze/teamContext.js';

// A play-by-play row as the CSV yields it: every field is a string.
function play(over = {}) {
  return {
    season_type: 'REG', week: '1', posteam: 'ATL', yardline_100: '10',
    two_point_attempt: '0', pass_attempt: '0', rush_attempt: '0',
    rush_touchdown: '0', pass_touchdown: '0',
    rusher_player_id: '', receiver_player_id: '', ...over,
  };
}
const carry = over => play({ rush_attempt: '1', rusher_player_id: 'RB1', ...over });
const target = over => play({ pass_attempt: '1', receiver_player_id: 'WR1', ...over });

const fold = plays => plays.reduce((acc, p) => accumulatePlay(acc, p), createAccumulator());
const totals = (acc, id) => [...acc.players.get(id).values()]
  .reduce((a, w) => ({
    rz_targets: a.rz_targets + w.rz_targets, rz_carries: a.rz_carries + w.rz_carries,
    rz_tds: a.rz_tds + w.rz_tds, gl_targets: a.gl_targets + w.gl_targets,
    gl_carries: a.gl_carries + w.gl_carries,
  }), { rz_targets: 0, rz_carries: 0, rz_tds: 0, gl_targets: 0, gl_carries: 0 });

// ---- counting rules ----

test('only plays inside the 20 count as red zone', () => {
  const acc = fold([
    carry({ yardline_100: '21' }),
    carry({ yardline_100: '20' }),
    carry({ yardline_100: '1' }),
    carry({ yardline_100: '75' }),
  ]);
  // The 20 itself is in; the 21 is not.
  assert.equal(totals(acc, 'RB1').rz_carries, 2);
  assert.equal(acc.plays, 4, 'all four are scrimmage touches');
  assert.equal(acc.rzPlays, 2);
});

test('goal line is the inside-5 subset of the red zone, never a separate bucket', () => {
  const acc = fold([
    carry({ yardline_100: '18' }),
    carry({ yardline_100: '5' }),
    carry({ yardline_100: '2' }),
  ]);
  const t = totals(acc, 'RB1');
  assert.equal(t.rz_carries, 3);
  assert.equal(t.gl_carries, 2);
  assert.ok(t.gl_carries <= t.rz_carries, 'goal-line touches are a subset of red-zone touches');
});

test('two-point conversions are excluded entirely', () => {
  // A two-point try snaps from the 2 and would otherwise look like a
  // goal-line carry. nflverse excludes it from carries, so we must too, or
  // our totals stop agreeing with the weekly file.
  const acc = fold([carry({ yardline_100: '2', two_point_attempt: '1' })]);
  assert.equal(acc.players.size, 0);
  assert.equal(acc.rzPlays, 0);
});

test('a pass with no receiver (sack or throwaway) is not a target', () => {
  const acc = fold([
    play({ pass_attempt: '1', receiver_player_id: '' }),
    target(),
  ]);
  assert.equal(totals(acc, 'WR1').rz_targets, 1);
});

test('postseason plays are ignored', () => {
  const acc = fold([carry({ season_type: 'POST' }), carry()]);
  assert.equal(totals(acc, 'RB1').rz_carries, 1);
});

test('touchdowns are credited to the scorer, not to everyone on the play', () => {
  const acc = fold([
    target({ pass_touchdown: '1', yardline_100: '3' }),
    carry({ rush_touchdown: '1' }),
    carry(),
  ]);
  assert.equal(totals(acc, 'WR1').rz_tds, 1);
  assert.equal(totals(acc, 'RB1').rz_tds, 1);
  assert.equal(totals(acc, 'RB1').rz_carries, 2);
});

test('team totals accumulate every red-zone touch, including untracked players', () => {
  const acc = fold([
    carry(), target(),
    carry({ rusher_player_id: 'FB_NOBODY', yardline_100: '1' }),
  ]);
  const week = acc.teams.get('ATL').get(1);
  assert.equal(week.rz_carries, 2);
  assert.equal(week.rz_targets, 1);
  assert.equal(week.gl_carries, 1);
  // The team denominator therefore exceeds the sum of the players we track.
  assert.ok(week.rz_carries > totals(acc, 'RB1').rz_carries);
});

test('weeks are recorded so downstream can tell "no data" from "no touches"', () => {
  const acc = fold([carry({ week: '4' }), carry({ week: '6' })]);
  assert.deepEqual(finalize(acc, 2025).weeks, [4, 6]);
});

// ---- CSV plumbing ----

test('column indices are resolved from the header, not hardcoded', () => {
  const idx = resolveColumns('week,posteam,season_type,yardline_100,two_point_attempt,'
    + 'pass_attempt,rush_attempt,rush_touchdown,pass_touchdown,rusher_player_id,receiver_player_id');
  assert.equal(idx.week, 0);
  assert.equal(idx.receiver_player_id, 10);
});

test('a missing column fails loudly rather than silently counting zeros', () => {
  assert.throws(() => resolveColumns('week,posteam'), /missing column/);
});

test('fields are extracted past quoted commas in the play description', () => {
  const idx = { a: 0, desc: 1, b: 2 };
  const got = pickFields('10,"Pass short right, complete to A.Jones",REG', idx);
  assert.equal(got[0], '10');
  assert.equal(got[2], 'REG', 'the quoted comma must not shift later columns');
});

// ---- window aggregation ----

const game = over => ({
  week: 1, targets: 5, carries: 10, receptions: 3, receiving_yards: 30,
  rushing_yards: 40, fantasy_points: 10,
  rz_targets: 1, rz_carries: 3, rz_tds: 1, gl_targets: 0, gl_carries: 2, ...over,
});

test('red-zone counts sum over the window and TD rate divides by opportunities', () => {
  const w = windowStats([game(), game({ week: 2 })], 'RB');
  assert.equal(w.rz_targets, 2);
  assert.equal(w.rz_carries, 6);
  assert.equal(w.rz_opportunities, 8);
  assert.equal(w.gl_opportunities, 4);
  assert.equal(w.rz_tds, 2);
  assert.equal(w.rz_td_rate, 0.25);
  assert.equal(w.rz_opportunities_pg, 4);
});

test('a player with no red-zone data reads as null, not as zero', () => {
  // The distinction matters: 0 means "shut out of the red zone", null means
  // "the play-by-play source has not covered these games".
  const w = windowStats([game({ rz_targets: null, rz_carries: null, rz_tds: null, gl_targets: null, gl_carries: null })], 'RB');
  assert.equal(w.rz_opportunities, null);
  assert.equal(w.rz_td_rate, null);
  assert.equal(w.rz_opportunities_pg, null);
});

test('genuinely zero red-zone work stays zero and does not become a TD rate', () => {
  const w = windowStats([game({ rz_targets: 0, rz_carries: 0, rz_tds: 0, gl_targets: 0, gl_carries: 0 })], 'WR');
  assert.equal(w.rz_opportunities, 0);
  assert.equal(w.rz_td_rate, null, 'no opportunities means an undefined rate, not 0%');
});

test('share of own touches inside the 20 is measured against total opportunities', () => {
  // 15 opportunities a game (5 targets + 10 carries), 4 of them in the red zone.
  const w = windowStats([game()], 'RB');
  assert.equal(w.rz_share_of_own_opportunities, r3(4 / 15));
});
const r3 = v => Math.round(v * 1000) / 1000;

// ---- team distribution ----

function rzPlayer(id, position, team, lines, extra = {}) {
  return {
    id, name: id, position, team, stats_team: team, meta: { injury_status: null }, ...extra,
    games: lines.map(([week, rz_targets, rz_carries, gl_carries = 0]) => ({
      week, stats_team: team, targets: rz_targets * 2, target_share: 0.2, carries: rz_carries * 2,
      receiving_air_yards: 0, fantasy_points: 10,
      rz_targets, rz_carries, rz_tds: 0, gl_targets: 0, gl_carries,
    })),
  };
}

test('red-zone share divides by the exact team total, not by tracked players', () => {
  // Our two tracked players account for 10 of the team's 20 red-zone touches;
  // the rest went to players outside the universe. Each tracked player must
  // therefore show 25%, not 50% — the denominator is the whole pie.
  const players = [
    rzPlayer('RB1', 'RB', 'ATL', [[1, 0, 5]]),
    rzPlayer('WR1', 'WR', 'ATL', [[1, 5, 0]]),
  ];
  const teamRedzone = { 1: { rz_targets: 10, rz_carries: 10, gl_targets: 2, gl_carries: 6 } };
  const ctx = buildTeamContext(players, 'ATL', { teamRedzone });

  assert.equal(ctx.redzone.team_rz_opportunities, 20);
  assert.equal(ctx.redzone.rows.find(r => r.id === 'RB1').rz_opportunity_share, 0.25);
  assert.equal(ctx.redzone.rows.find(r => r.id === 'WR1').rz_opportunity_share, 0.25);
  assert.equal(ctx.redzone.accounted_share, 0.5, 'the half we cannot see is reported, not hidden');
});

test('goal-line share is computed against the inside-5 pie, not the red-zone pie', () => {
  const players = [rzPlayer('RB1', 'RB', 'ATL', [[1, 0, 5, 4]])];
  const teamRedzone = { 1: { rz_targets: 10, rz_carries: 10, gl_targets: 0, gl_carries: 8 } };
  const ctx = buildTeamContext(players, 'ATL', { teamRedzone });
  const row = ctx.redzone.rows[0];
  assert.equal(row.rz_opportunity_share, 0.25);
  assert.equal(row.gl_opportunity_share, 0.5, '4 of the team\'s 8 goal-line touches');
});

test('vacated red-zone share counts only players who left', () => {
  const players = [
    rzPlayer('GONE', 'RB', 'ARI', [[1, 0, 5]]),   // played for ATL, now in ARI
    rzPlayer('STAY', 'RB', 'ATL', [[1, 0, 5]]),
  ];
  players[0].games[0].stats_team = 'ATL';
  const teamRedzone = { 1: { rz_targets: 0, rz_carries: 20, gl_targets: 0, gl_carries: 0 } };
  const ctx = buildTeamContext(players, 'ATL', { teamRedzone });
  assert.equal(ctx.roster_changes.vacated_rz_opportunity_share, 0.25);
});

test('team context still builds when the red-zone source is missing', () => {
  const players = [rzPlayer('RB1', 'RB', 'ATL', [[1, 2, 5]])];
  const ctx = buildTeamContext(players, 'ATL');
  assert.equal(ctx.redzone, null);
  assert.equal(ctx.roster_changes.vacated_rz_opportunity_share, null);
  assert.ok(ctx.season.rows.length, 'the rest of the page is unaffected');
});
