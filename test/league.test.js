import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setOwner, setTeams, clearRosters, markDrafted, undoDraft, myTeamId,
  defaultTeams, migrate, toPersisted, UNKNOWN_OWNER,
} from '../src/store/state.js';
import { leagueView, rosterFor, resolveNames, parseNameList } from '../src/analyze/league.js';

// state.js reads and writes data/state.json, so exercise the pure writers
// against an in-memory state rather than the real file.
function freshState(over = {}) {
  return {
    league: { teams: defaultTeams() },
    owners: {}, picks: [], personalRanks: {},
    drafted: [], mine: [],
    ...over,
  };
}

const player = (id, position = 'RB', extra = {}) =>
  ({ id, name: id, position, team: 'ATL', bye: 11, meta: { injury_status: null }, ...extra });

// ---- migration from the pre-owner state file ----

test('a legacy state file keeps its roster and its pick order', () => {
  // This is real user data — a roster that took a draft to build. Losing it
  // on upgrade is the worst thing this module could do.
  const legacy = {
    drafted: ['RB-bijan_robinson', 'WR-rashee_rice', 'QB-someone'],
    mine: ['RB-bijan_robinson', 'WR-rashee_rice'],
    personalRanks: { 'WR-jamarr_chase': 1 },
  };
  const m = migrate(legacy);
  assert.equal(m.owners['RB-bijan_robinson'], 'team1');
  assert.equal(m.owners['WR-rashee_rice'], 'team1');
  assert.equal(m.owners['QB-someone'], UNKNOWN_OWNER,
    'drafted by someone else — which team was never recorded, so do not invent one');
  assert.deepEqual(m.picks, legacy.drafted, 'pick order survives');
  assert.deepEqual(m.personalRanks, legacy.personalRanks, 'personal ranks are untouched');
});

test('migration runs on the raw file, not on a defaults-merged object', () => {
  // The trap: an empty `owners: {}` from the defaults is truthy, so a
  // migrate() that ran after the merge would treat every legacy file as
  // already converted and silently discard the roster.
  const merged = { owners: {}, picks: [], drafted: ['p1'], mine: ['p1'] };
  assert.deepEqual(migrate(merged).owners, {},
    'already-migrated shape is returned untouched — which is exactly why it must not see defaults first');

  const raw = { drafted: ['p1'], mine: ['p1'] };
  assert.equal(migrate(raw).owners.p1, 'team1', 'the raw legacy file does convert');
});

test('an already-migrated state is not re-migrated', () => {
  const s = { league: { teams: defaultTeams() }, owners: { p1: 'team3' }, picks: ['p1'] };
  assert.deepEqual(migrate(s), s);
});

test('the derived views never reach disk', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');
  const persisted = toPersisted(s);
  assert.equal(persisted.drafted, undefined, 'drafted is derived, storing it invites drift');
  assert.equal(persisted.mine, undefined);
  assert.deepEqual(persisted.owners, { p1: 'team1' }, 'ownership is the single source of truth');
  assert.deepEqual(persisted.picks, ['p1']);
});

// ---- ownership ----

test('assigning an owner derives drafted and mine', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');          // team1 is mine by default
  setOwner(s, 'p2', 'team4');
  assert.deepEqual(s.drafted, ['p1', 'p2']);
  assert.deepEqual(s.mine, ['p1']);
  assert.equal(myTeamId(s), 'team1');
});

test('a player has exactly one owner after moving teams', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');
  setOwner(s, 'p1', 'team7');
  assert.equal(s.owners.p1, 'team7');
  assert.deepEqual(s.mine, [], 'no longer mine');
  assert.deepEqual(s.drafted, ['p1'], 'still owned, listed once');
  assert.deepEqual(s.picks, ['p1'], 'the pick is not duplicated');
});

test('changing owner keeps the original draft position', () => {
  const s = freshState();
  setOwner(s, 'a', 'team1');
  setOwner(s, 'b', 'team2');
  setOwner(s, 'c', 'team3');
  setOwner(s, 'a', 'team5');           // correcting a mistake, not a re-pick
  assert.deepEqual(s.picks, ['a', 'b', 'c'], 'pick numbers must not shuffle');
});

test('clearing an owner frees the player and removes the pick', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');
  setOwner(s, 'p1', null);
  assert.equal(s.owners.p1, undefined);
  assert.deepEqual(s.picks, []);
  assert.deepEqual(s.drafted, []);
});

test('unknown-owner is a real state, distinct from free agent', () => {
  const s = freshState();
  setOwner(s, 'p1', UNKNOWN_OWNER);
  assert.deepEqual(s.drafted, ['p1'], 'taken, so not available');
  assert.deepEqual(s.mine, [], 'but not mine');
  assert.equal(rosterFor([player('p1')], s, UNKNOWN_OWNER).length, 1);
});

test('assigning to a team that does not exist is rejected', () => {
  const s = freshState();
  assert.throws(() => setOwner(s, 'p1', 'team99'), /unknown team/);
  assert.deepEqual(s.drafted, [], 'nothing recorded on a rejected write');
});

test('the board buttons still work through the owner model', () => {
  const s = freshState();
  markDrafted(s, 'p1', { mine: true });
  markDrafted(s, 'p2', { mine: false });
  assert.deepEqual(s.mine, ['p1']);
  assert.equal(s.owners.p2, UNKNOWN_OWNER, 'someone took them, we do not know who');
  undoDraft(s, 'p1');
  assert.deepEqual(s.drafted, ['p2']);
});

// ---- teams ----

test('exactly one team is mine, however the input is shaped', () => {
  const s = freshState();
  setTeams(s, [{ id: 'team1', name: 'A', mine: true }, { id: 'team2', name: 'B', mine: true }]);
  assert.deepEqual(s.league.teams.map(t => t.mine), [true, false]);

  setTeams(s, [{ id: 'team1', name: 'A', mine: false }, { id: 'team2', name: 'B', mine: false }]);
  assert.equal(s.league.teams.filter(t => t.mine).length, 1, 'falls back to the first team');
});

test('removing a team frees its players instead of orphaning them', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');
  setOwner(s, 'p2', 'team9');
  setTeams(s, defaultTeams(4));       // team9 no longer exists
  assert.equal(s.owners.p1, 'team1');
  assert.equal(s.owners.p2, undefined, 'not left owned by a team that is gone');
  assert.deepEqual(s.picks, ['p1']);
});

test('clearing one roster leaves the others alone', () => {
  const s = freshState();
  setOwner(s, 'p1', 'team1');
  setOwner(s, 'p2', 'team2');
  clearRosters(s, { teamId: 'team1' });
  assert.deepEqual(s.drafted, ['p2']);
});

// ---- league view ----

test('roster warnings are reported, never enforced', () => {
  const s = freshState();
  const players = [];
  for (let i = 0; i < 17; i++) {                 // over the 15-man limit
    const p = player(`p${i}`, 'RB');
    players.push(p);
    setOwner(s, p.id, 'team1');
  }
  const view = leagueView(players, s);
  const mine = view.teams.find(t => t.mine);
  assert.equal(mine.count, 17, 'every player is still on the roster');
  assert.ok(mine.warnings.some(w => /over the 15-man limit/.test(w)));
});

test('players with no owner are counted as free agents', () => {
  const s = freshState();
  const players = [player('a'), player('b'), player('c')];
  setOwner(s, 'a', 'team1');
  assert.equal(leagueView(players, s).free_agents, 2);
});

// ---- bulk paste ----

test('pasted lines are cleaned of pick numbers, positions and team notes', () => {
  assert.deepEqual(
    parseNameList('1. Bijan Robinson RB\nDrake London (ATL - WR)\n\n3) Kyle Pitts'),
    ['Bijan Robinson', 'Drake London', 'Kyle Pitts']);
});

test('unmatched names are reported, never silently dropped', () => {
  const players = [player('RB-bijan', 'RB', { name: 'Bijan Robinson' })];
  const r = resolveNames('Bijan Robinson\nBijan Robbinson', players);
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.unmatched, ['Bijan Robbinson'],
    'a misspelling must surface, not vanish into a partially-applied roster');
});

test('an ambiguous name is reported rather than resolved by guesswork', () => {
  const players = [
    player('WR-mike', 'WR', { name: 'Mike Williams' }),
    player('TE-mike', 'TE', { name: 'Mike Williams' }),
  ];
  const r = resolveNames('Mike Williams', players);
  assert.equal(r.matched.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].candidates.length, 2);
});

test('the same player listed twice is added once', () => {
  const players = [player('RB-bijan', 'RB', { name: 'Bijan Robinson' })];
  const r = resolveNames('Bijan Robinson, bijan robinson', players);
  assert.equal(r.matched.length, 1);
});
