// Canonical name keys for cross-source matching.
// Sources spell names differently (Ja'Marr / Jamarr, D.J. / DJ, Jr. suffixes,
// diacritics), so every match goes through nameKey().

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Known cross-source spelling differences that survive normalization.
const ALIASES = new Map([
  ['hollywood brown', 'marquise brown'],
  ['gabe davis', 'gabriel davis'],
  ['josh palmer', 'joshua palmer'],
  ['cam ward', 'cameron ward'],
  ['chig okonkwo', 'chigoziem okonkwo'],
  ['tank dell', 'nathaniel dell'],
  ['bam knight', 'zonovan knight'],
]);

export function nameKey(name) {
  if (!name) return '';
  let k = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = k.split(' ').filter(p => !SUFFIXES.has(p));
  k = parts.join(' ');
  return ALIASES.get(k) ?? k;
}

// Team abbreviation conventions differ per source (JAC/JAX, LA/LAR, WSH/WAS).
const TEAM_ALIASES = { JAC: 'JAX', LA: 'LAR', WSH: 'WAS', OAK: 'LV', SD: 'LAC', STL: 'LAR', HST: 'HOU', BLT: 'BAL', CLV: 'CLE', ARZ: 'ARI' };

export function normTeam(team) {
  if (!team) return null;
  const t = team.toUpperCase();
  return TEAM_ALIASES[t] ?? t;
}

export function normPosition(pos) {
  if (!pos) return null;
  const p = pos.toUpperCase();
  if (p === 'DST' || p === 'DEF' || p === 'D/ST') return 'DST';
  if (p === 'PK') return 'K';
  return p;
}

// Position groups considered equivalent when joining stat rows to players.
export function samePositionGroup(a, b) {
  const g = p => (['HB', 'FB', 'RB'].includes(p) ? 'RB' : p);
  return g(normPosition(a)) === g(normPosition(b));
}

export function playerId(name, pos) {
  return `${normPosition(pos)}-${nameKey(name).replace(/ /g, '_')}`;
}
