// Persistent roster sidebar: my starting lineup filling up as I draft.
// Slot layout mirrors the league settings (10-team PPR Yahoo default).
import { api, esc } from './api.js';
import { openProfile } from './profile.js';

const SLOTS = [
  ['QB', 'QB'], ['RB', 'RB1'], ['RB', 'RB2'], ['WR', 'WR1'], ['WR', 'WR2'], ['WR', 'WR3'],
  ['TE', 'TE'], ['FLEX', 'W/R/T'], ['K', 'K'], ['DST', 'DEF'],
];
const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export async function renderRoster(refresh) {
  const el = document.getElementById('roster');
  const { players } = await api.board();
  // Keep draft order so earlier picks claim starting slots first.
  const mine = players.filter(p => p.mine);

  // Assign players to slots: dedicated position slots first, then flex,
  // everything else to the bench.
  const pool = [...mine];
  const filled = SLOTS.map(([pos, label]) => {
    const idx = pool.findIndex(p => pos === 'FLEX' ? FLEX_ELIGIBLE.includes(p.position) : p.position === pos);
    return { pos, label, player: idx === -1 ? null : pool.splice(idx, 1)[0] };
  });
  const bench = pool;

  // Byes shared by 3+ of my players get flagged in the panel.
  const byeCounts = {};
  for (const p of mine) if (p.bye != null) byeCounts[p.bye] = (byeCounts[p.bye] ?? 0) + 1;

  const row = (label, p) => `
    <div class="slot">
      <span class="pos">${esc(label)}</span>
      ${p ? `<span class="who"><span class="clickable" data-id="${esc(p.id)}">${esc(p.name)}</span>
               <span class="aid">${esc(p.position)} · ${esc(p.team ?? 'FA')} · <span class="${byeCounts[p.bye] >= 3 ? 'byewarn' : ''}">bye ${p.bye ?? '?'}</span></span></span>
             <button class="drop" data-drop="${esc(p.id)}" title="Remove from my roster">✕</button>`
          : '<span class="who empty">—</span>'}
    </div>`;

  el.innerHTML = `
    <h2>My Team <span class="aid">${mine.length}/15 picks</span></h2>
    ${filled.map(s => row(s.label, s.player)).join('')}
    ${bench.length ? `<div class="bench-label">Bench</div>${bench.map(p => row('BN', p)).join('')}` : ''}
    ${Object.entries(byeCounts).filter(([, n]) => n >= 3).map(([w, n]) => `<div class="warn mt" style="font-size:12px">${n} players share the week-${w} bye</div>`).join('')}`;

  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
  el.querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    await api.undraft(b.dataset.drop);
    refresh();
  });
}
