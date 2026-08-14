// Lineup slots — the canonical definition, shared by the server, the tests
// and (via the /shared/ route) the browser.
//
// This used to be a hardcoded array in public/js/lineup.js sitting beside
// LEAGUE.starters in roster.js, saying the same thing twice. The slots are
// derived from LEAGUE.starters now, so a league-size change has one home.
import { LEAGUE } from './roster.js';

// Dedicated slots first, FLEX after them, then K/DEF. The order is load
// bearing: `assignSlots` is greedy, so a player only reaches FLEX once their
// own position's slots are taken.
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];
const LABELS = { FLEX: 'FLX', DST: 'DEF' };

export const SLOTS = SLOT_ORDER.flatMap(pos => {
  const n = LEAGUE.starters[pos] ?? 0;
  return Array.from({ length: n }, (_, i) => [
    pos,
    n > 1 ? `${pos}${i + 1}` : (LABELS[pos] ?? pos),
  ]);
});

export const FLEX_ELIGIBLE = LEAGUE.flexEligible;

// Fill the lineup from a pool, taking the first eligible player for each slot
// in turn. The CALLER's ordering is the priority: pass the roster in pick
// order and you get the roster sidebar's view; pass it sorted by projected
// points and you get the best lineup those projections support.
//
// Greedy, not globally optimal — but with exactly one shared slot (FLEX) that
// comes after every dedicated slot, greedy and optimal coincide.
export function assignSlots(players) {
  const pool = [...(players ?? [])];
  const filled = SLOTS.map(([pos, label]) => {
    const idx = pool.findIndex(p => (pos === 'FLEX' ? FLEX_ELIGIBLE.includes(p.position) : p.position === pos));
    return { pos, label, player: idx === -1 ? null : pool.splice(idx, 1)[0] };
  });
  return { filled, bench: pool };
}
