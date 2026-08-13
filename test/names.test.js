import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, normTeam, normPosition, playerId, samePositionGroup } from '../src/normalize/names.js';

test('nameKey strips punctuation, suffixes, diacritics, case', () => {
  assert.equal(nameKey("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(nameKey('D.J. Moore'), 'dj moore');
  assert.equal(nameKey('Kenneth Walker III'), 'kenneth walker');
  assert.equal(nameKey('Aaron Jones Sr.'), 'aaron jones');
  assert.equal(nameKey('José Ramírez Jr.'), 'jose ramirez');
  assert.equal(nameKey('Amon-Ra St. Brown'), 'amonra st brown');
});

test('nameKey applies cross-source aliases', () => {
  assert.equal(nameKey('Hollywood Brown'), nameKey('Marquise Brown'));
  assert.equal(nameKey('Cam Ward'), nameKey('Cameron Ward'));
});

test('normTeam unifies source abbreviation conventions', () => {
  assert.equal(normTeam('JAC'), 'JAX');
  assert.equal(normTeam('LA'), 'LAR');
  assert.equal(normTeam('WSH'), 'WAS');
  assert.equal(normTeam('KC'), 'KC');
  assert.equal(normTeam(null), null);
});

test('normPosition and position groups', () => {
  assert.equal(normPosition('DEF'), 'DST');
  assert.equal(normPosition('D/ST'), 'DST');
  assert.equal(normPosition('PK'), 'K');
  assert.ok(samePositionGroup('HB', 'RB'));
  assert.ok(!samePositionGroup('CB', 'WR'));
});

test('playerId is stable across spelling variants', () => {
  assert.equal(playerId("Ja'Marr Chase", 'WR'), 'WR-jamarr_chase');
  assert.equal(playerId('Jamarr Chase', 'wr'), 'WR-jamarr_chase');
});
