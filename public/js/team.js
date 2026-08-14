// My Team: the lineup page — every rostered player in their slot, with the
// full stat grid, external projections and the app's own signals.
//
// The grid itself is the shared component (rosterTable.js), the same one each
// League team card renders. What is specific to this page is the header — the
// projected starter total and your bye-week conflicts — and the signals table
// underneath, which carries the things only this app computes: usage trend,
// AI rank and your own ranking. Those have no equivalent on a scoring page,
// so they sit beside the grid rather than being crammed into it.
import { api, esc, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';
import { assignSlots } from './lineup.js';
import { rosterTableHtml, wireRosterTable } from './rosterTable.js';

// The projected weekly detail Sleeper publishes, in the shape the position
// makes readable. External numbers, always labelled as such.
function projLine(p) {
  const d = p.projection?.detail;
  if (!d) return null;
  const has = k => d[k] != null;
  if (p.position === 'QB' && has('pass_yd')) return `${d.pass_cmp ?? '?'}/${d.pass_att ?? '?'} · ${d.pass_yd} yd · ${d.pass_td ?? 0} TD / ${d.pass_int ?? 0} INT`;
  if (p.position === 'RB' && (has('rush_yd') || has('rec'))) return `${d.rush_att ?? 0} car · ${d.rush_yd ?? 0} yd · ${d.rec ?? 0} rec ${d.rec_yd ?? 0} yd`;
  if (['WR', 'TE'].includes(p.position) && (has('rec') || has('rec_yd'))) return `${d.rec_tgt ?? 0} tgt · ${d.rec ?? 0} rec · ${d.rec_yd ?? 0} yd · ${d.rec_td ?? 0} TD`;
  if (p.position === 'K' && has('fgm')) return `${d.fgm} FG / ${d.xpm ?? 0} XP`;
  return null;
}

function signalRow(p) {
  const proj = projLine(p);
  return `<tr>
    <td><span class="poschip pos-${esc(p.position)}">${esc(p.position)}</span></td>
    <td class="name" data-signal-id="${esc(p.id)}">${esc(p.name)}<span class="team">${esc(p.team ?? 'FA')}</span>
      ${p.changed_team ? '<span class="badge newteam">NEW TEAM</span>' : ''}
      ${signalBadge(p.sleeper_state)}</td>
    <td>${trendArrow(p.usage_trend)}</td>
    <td>${p.ai_rank != null ? '#' + p.ai_rank : '<span class="aid">—</span>'}
      <span class="aid">${p.confidence != null ? p.confidence + '%' : ''}</span></td>
    <td>${p.personal_rank != null ? '#' + p.personal_rank : '<span class="aid">—</span>'}</td>
    <td class="small" style="white-space:normal;color:var(--dim)">${proj ? esc(proj) : '<span class="aid">no projection</span>'}</td>
  </tr>`;
}

export async function renderTeam(el, refresh) {
  const t = await api.team();
  const { filled } = assignSlots(t.players);
  const projWeek = t.players.find(p => p.projection)?.projection?.week ?? null;
  const starterProj = filled.reduce((s, x) => s + (x.player?.projection?.pts_ppr ?? 0), 0);
  const ctx = { key: 'my-team', mode: t.mode, statsSeason: t.stats_season, baselineSeason: t.baseline_season };

  el.innerHTML = `
    <div class="panel">
      <h2>My Team${t.mode === 'season' ? ` · Week ${t.week ?? '?'}` : ''}</h2>
      <p class="small">${t.players.length}/15 roster spots · Projected starter total: <b>${Math.round(starterProj * 10) / 10} pts</b>
        <span class="aid">(${projWeek ? `week ${projWeek} projections, Sleeper — external source` : 'no projections available'})</span></p>
      ${t.roster.byeConflicts.map(b => `<div class="warn mt">Bye week ${b.week}: ${b.players.join(', ')}</div>`).join('')}
      ${!t.players.length ? '<p class="small mt">No players yet — assign them on the League page, the Players explorer or the draft board.</p>' : ''}
    </div>
    <div id="my-grid">${rosterTableHtml(t.players, ctx)}</div>
    ${t.players.length ? `
      <div class="panel mt">
        <h2>Signals</h2>
        <p class="small">What this app computes rather than reports: usage trend, its own re-ranking, and your
          rankings. AI rank and confidence are this app's engine; confidence measures evidence strength, not
          win probability.</p>
        <table>
          <thead><tr><th>Pos</th><th>Player</th><th>Trend</th><th>AI rank</th><th>My rank</th><th>Projected line${projWeek ? ` (wk ${projWeek}, Sleeper)` : ''}</th></tr></thead>
          <tbody>${t.players.map(signalRow).join('')}</tbody>
        </table>
      </div>` : ''}`;

  wireRosterTable(el.querySelector('#my-grid'), { ...ctx, players: t.players }, refresh);
  el.querySelectorAll('[data-signal-id]').forEach(td => td.onclick = () => openProfile(td.dataset.signalId, refresh));
}
