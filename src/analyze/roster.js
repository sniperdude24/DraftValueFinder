// Roster model for a 10-team PPR Yahoo-default league:
// QB, RB×2, WR×3, TE, FLEX (W/R/T), K, DEF, 6 bench — 15 picks total.
export const LEAGUE = {
  teams: 10,
  rounds: 15,
  starters: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ['RB', 'WR', 'TE'],
};

export function rosterSummary(myPlayers) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
  const byeMap = {};
  for (const p of myPlayers) {
    if (counts[p.position] !== undefined) counts[p.position]++;
    if (p.bye != null) (byeMap[p.bye] ??= []).push(p.name);
  }

  const s = LEAGUE.starters;
  const needs = [];
  if (counts.QB < s.QB) needs.push({ position: 'QB', missing: s.QB - counts.QB, kind: 'starter' });
  if (counts.RB < s.RB) needs.push({ position: 'RB', missing: s.RB - counts.RB, kind: 'starter' });
  if (counts.WR < s.WR) needs.push({ position: 'WR', missing: s.WR - counts.WR, kind: 'starter' });
  if (counts.TE < s.TE) needs.push({ position: 'TE', missing: s.TE - counts.TE, kind: 'starter' });
  const flexBodies = Math.max(0, counts.RB - s.RB) + Math.max(0, counts.WR - s.WR) + Math.max(0, counts.TE - s.TE);
  if (flexBodies < s.FLEX && counts.RB >= s.RB && counts.WR >= s.WR && counts.TE >= s.TE) {
    needs.push({ position: 'FLEX', missing: s.FLEX - flexBodies, kind: 'starter' });
  }
  if (counts.K < s.K) needs.push({ position: 'K', missing: s.K - counts.K, kind: 'starter' });
  if (counts.DST < s.DST) needs.push({ position: 'DST', missing: s.DST - counts.DST, kind: 'starter' });

  const byeConflicts = Object.entries(byeMap)
    .filter(([, names]) => names.length >= 3)
    .map(([week, names]) => ({ week: Number(week), players: names }));

  return { counts, needs, byes: byeMap, byeConflicts, picksUsed: myPlayers.length };
}
