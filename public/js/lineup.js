// Lineup slot assignment shared by the roster sidebar and the My Team page.
// 10-team PPR Yahoo-default slots; players claim dedicated slots in draft
// order, then flex, then bench.
export const SLOTS = [
  ['QB', 'QB'], ['RB', 'RB1'], ['RB', 'RB2'], ['WR', 'WR1'], ['WR', 'WR2'], ['WR', 'WR3'],
  ['TE', 'TE'], ['FLEX', 'FLX'], ['K', 'K'], ['DST', 'DEF'],
];
export const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export function assignSlots(minePlayers) {
  const pool = [...minePlayers];
  const filled = SLOTS.map(([pos, label]) => {
    const idx = pool.findIndex(p => pos === 'FLEX' ? FLEX_ELIGIBLE.includes(p.position) : p.position === pos);
    return { pos, label, player: idx === -1 ? null : pool.splice(idx, 1)[0] };
  });
  return { filled, bench: pool };
}
