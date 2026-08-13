// Attach Stats Guy trade-market values to the player database.
// Pure so the name/position matching is unit-testable. Unmatched rankings
// are returned (not dropped) so the build can surface them.
import { nameKey, normPosition } from './names.js';

export function matchTradeMarket(players, statsguy) {
  const rankings = statsguy?.rankings ?? [];
  const asOf = statsguy?.asOf ?? null;
  const byKey = new Map(players.map(p => [`${normPosition(p.position)}|${nameKey(p.name)}`, p]));
  const unmatched = [];
  for (const p of players) p.trade_market = null;
  for (const r of rankings) {
    const player = byKey.get(`${normPosition(r.position)}|${nameKey(r.name)}`);
    if (player) {
      player.trade_market = { rank: r.rank, value: r.value, pos_rank: r.positionRank ?? null, as_of: asOf };
    } else {
      unmatched.push({ rank: r.rank, name: r.name, position: r.position });
    }
  }
  return { matched: rankings.length - unmatched.length, unmatched };
}
