import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFreeAgentList, freeAgentAge, UNKNOWN_OWNER, defaultTeams } from '../src/store/state.js';
import { toPersisted } from '../src/store/state.js';

const baseState = (owners = {}) => ({
  league: { teams: defaultTeams() },
  owners: { ...owners },
  picks: Object.keys(owners),
  personalRanks: {},
});

test('players in the list become free, everyone else becomes rostered', () => {
  const s = applyFreeAgentList(baseState(), ['a', 'b'], { now: new Date('2026-09-10T12:00:00Z') });
  // 'a' and 'b' were pasted as available.
  assert.equal(s.owners.a, undefined);
  assert.equal(s.owners.b, undefined);
});

test('a roster already recorded is NOT overwritten by a paste', () => {
  // The load-bearing rule. Without it, pasting a free-agent list silently
  // reassigns every roster the user has filled in to "owner unknown", which
  // is a total loss of real work with no error and no undo.
  const s = applyFreeAgentList(
    baseState({ starA: 'team3', mineA: 'team1', unknownA: UNKNOWN_OWNER }),
    ['freeA'],
  );
  assert.equal(s.owners.starA, 'team3', 'team 3 keeps their player');
  assert.equal(s.owners.mineA, 'team1', 'my roster is untouched');
  assert.equal(s.owners.unknownA, UNKNOWN_OWNER);
  assert.equal(s.owners.freeA, undefined, 'the pasted player is free');
});

test('a player in the list who was on a roster is freed — that is a drop', () => {
  const s = applyFreeAgentList(baseState({ x: 'team4' }), ['x']);
  assert.equal(s.owners.x, undefined);
  assert.ok(!s.picks.includes('x'), 'and leaves the pick order with them');
});

test('the complement covers the WHOLE player universe, not just known players', () => {
  // The bug this pins, found live: without allIds the function only iterates
  // the pasted names plus players it already had an owner for, so the ~240 it
  // had never heard of stayed "free" — which is precisely the fiction the
  // free-agent list exists to end. It looked like it worked; the count barely
  // moved and nothing errored.
  const allIds = ['a', 'b', 'c', 'd', 'e'];
  const s = applyFreeAgentList(baseState({ b: 'team2' }), ['a'], { allIds });
  assert.equal(s.owners.a, undefined, 'pasted → free');
  assert.equal(s.owners.b, 'team2', 'recorded roster → untouched');
  assert.equal(s.owners.c, UNKNOWN_OWNER, 'never seen and not pasted → rostered by somebody');
  assert.equal(s.owners.d, UNKNOWN_OWNER);
  assert.equal(s.owners.e, UNKNOWN_OWNER);
});

test('without a universe it can only speak about players it knows', () => {
  const s = applyFreeAgentList({ ...baseState(), owners: {} }, []);
  assert.deepEqual(s.owners, {}, 'an empty paste cannot invent owners out of nothing');
});

test('derived views follow the new ownership', () => {
  const s = applyFreeAgentList(baseState({ mineA: 'team1', otherA: 'team5' }), []);
  assert.ok(s.mine.includes('mineA'));
  assert.ok(s.drafted.includes('otherA'));
  assert.ok(!s.mine.includes('otherA'));
});

test('the as-of stamp is recorded and never reaches disk as a derived view', () => {
  const s = applyFreeAgentList(baseState(), ['a'], { week: 3, now: new Date('2026-09-10T12:00:00Z') });
  assert.equal(s.freeAgents.as_of, '2026-09-10T12:00:00.000Z');
  assert.equal(s.freeAgents.week, 3);
  assert.equal(s.freeAgents.count, 1);
  const persisted = toPersisted(s);
  assert.ok(persisted.freeAgents, 'the pool fact IS persisted');
  assert.equal(persisted.drafted, undefined, 'the derived views are not');
});

test('pool age is reported in whole days, and null when never pasted', () => {
  const s = applyFreeAgentList(baseState(), ['a'], { now: new Date('2026-09-01T00:00:00Z') });
  assert.equal(freeAgentAge(s, Date.parse('2026-09-01T06:00:00Z')), 0);
  assert.equal(freeAgentAge(s, Date.parse('2026-09-09T00:00:00Z')), 8);
  assert.equal(freeAgentAge(baseState()), null, 'never pasted is not "zero days old"');
});
