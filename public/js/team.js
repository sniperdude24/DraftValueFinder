// My Team: Yahoo-style lineup page — every rostered player in their slot
// with external projections, real stat lines, and the app's own signals.
import { api, esc, pct, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';
import { assignSlots } from './lineup.js';

function avg(games, field) {
  const vals = games.map(g => g[field]).filter(v => v != null);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
}

// Position-appropriate stat line from a games source (single game or averages).
function statLine(p, source) {
  if (!source) return '—';
  const n = f => source[f] ?? 0;
  if (p.position === 'QB') return `${n('completions')}/${n('attempts')} · ${n('passing_yards')} yd · ${n('passing_tds')} TD / ${n('interceptions')} INT · ${n('carries')} car ${n('rushing_yards')} yd`;
  if (p.position === 'RB') return `${n('carries')} car · ${n('rushing_yards')} yd · ${n('rushing_tds')} TD · ${n('targets')} tgt / ${n('receptions')} rec ${n('receiving_yards')} yd`;
  if (['WR', 'TE'].includes(p.position)) return `${n('targets')} tgt · ${n('receptions')} rec · ${n('receiving_yards')} yd · ${n('receiving_tds')} TD`;
  return '—';
}

function projLine(p) {
  const d = p.projection?.detail;
  if (!d) return null;
  const has = k => d[k] != null;
  if (p.position === 'QB' && has('pass_yd')) return `proj: ${d.pass_cmp ?? '?'}/${d.pass_att ?? '?'} · ${d.pass_yd} yd · ${d.pass_td ?? 0} TD / ${d.pass_int ?? 0} INT`;
  if (p.position === 'RB' && (has('rush_yd') || has('rec'))) return `proj: ${d.rush_att ?? 0} car · ${d.rush_yd ?? 0} yd · ${d.rec ?? 0} rec ${d.rec_yd ?? 0} yd`;
  if (['WR', 'TE'].includes(p.position) && (has('rec') || has('rec_yd'))) return `proj: ${d.rec_tgt ?? 0} tgt · ${d.rec ?? 0} rec · ${d.rec_yd ?? 0} yd · ${d.rec_td ?? 0} TD`;
  if (p.position === 'K' && has('fgm')) return `proj: ${d.fgm} FG / ${d.xpm ?? 0} XP`;
  return null;
}

export async function renderTeam(el, refresh) {
  const t = await api.team();
  const season = t.mode === 'season';
  const { filled, bench } = assignSlots(t.players);

  // Stat basis per player: latest actual game in season mode, per-game
  // averages of the stats season in draft mode.
  const basisFor = p => {
    if (!p.games?.length) return { source: null, label: 'no game data' };
    if (season) return { source: p.games[p.games.length - 1], label: `wk ${p.games[p.games.length - 1].week} actual` };
    return {
      source: {
        completions: avg(p.games, 'completions'), attempts: avg(p.games, 'attempts'),
        passing_yards: avg(p.games, 'passing_yards'), passing_tds: avg(p.games, 'passing_tds'),
        interceptions: avg(p.games, 'interceptions'), carries: avg(p.games, 'carries'),
        rushing_yards: avg(p.games, 'rushing_yards'), rushing_tds: avg(p.games, 'rushing_tds'),
        targets: avg(p.games, 'targets'), receptions: avg(p.games, 'receptions'),
        receiving_yards: avg(p.games, 'receiving_yards'), receiving_tds: avg(p.games, 'receiving_tds'),
      },
      label: `${t.stats_season} per-game avg`,
    };
  };

  const projWeekLabel = t.players.find(p => p.projection)?.projection;
  const row = (label, slotPos, p) => {
    if (!p) return `<tr class="open-slot"><td><span class="poschip pos-${esc(slotPos === 'FLEX' ? 'FLEX' : slotPos)}">${esc(label)}</span></td><td colspan="7" class="small" style="font-style:italic;color:var(--dim)">open slot</td></tr>`;
    const basis = basisFor(p);
    const proj = projLine(p);
    const pprAvg = avg(p.games ?? [], 'fantasy_points_ppr');
    const lastPpr = season && p.games?.length ? p.games[p.games.length - 1].fantasy_points_ppr : null;
    return `<tr>
      <td><span class="poschip pos-${esc(p.position)}">${esc(label)}</span></td>
      <td class="name" data-id="${esc(p.id)}">${esc(p.name)}<span class="team">${esc(p.team ?? 'FA')}</span>
        ${p.meta?.injury_status ? `<span class="badge inj">${esc(p.meta.injury_status)}</span>` : ''}
        ${p.changed_team ? '<span class="badge newteam">NEW TEAM</span>' : ''}
        ${signalBadge(p.sleeper_state)}</td>
      <td>${p.bye ?? '—'}</td>
      <td><b>${p.projection ? p.projection.pts_ppr : '—'}</b></td>
      <td>${season ? `${lastPpr ?? '—'} <span class="aid">(avg ${pprAvg ?? '—'})</span>` : (pprAvg ?? '—')}</td>
      <td style="white-space:normal"><div class="small">${esc(statLine(p, basis.source))} <span class="aid">(${esc(basis.label)})</span></div>
        ${proj ? `<div class="small" style="color:var(--dim)">${esc(proj)}</div>` : ''}</td>
      <td>${trendArrow(p.usage_trend)} <span class="aid">AI #${p.ai_rank ?? '—'} · ${p.confidence ?? '—'}%</span></td>
      <td>${p.personal_rank != null ? '#' + p.personal_rank : ''}</td>
    </tr>`;
  };

  const starterProj = filled.reduce((s, x) => s + (x.player?.projection?.pts_ppr ?? 0), 0);
  el.innerHTML = `
    <div class="panel">
      <h2>My Team${season ? ` · Week ${t.week ?? '?'}` : ''}</h2>
      <p class="small">${t.players.length}/15 picks · Projected starter total: <b>${Math.round(starterProj * 10) / 10} pts</b>
        <span class="aid">(${projWeekLabel ? `week ${projWeekLabel.week} projections, Sleeper — external source` : 'no projections available'})</span></p>
      ${t.roster.byeConflicts.map(b => `<div class="warn mt">Bye week ${b.week}: ${b.players.join(', ')}</div>`).join('')}
      ${!t.players.length ? '<p class="small mt">No players yet — mark picks as "My pick" on the draft board and they\'ll appear here.</p>' : ''}
    </div>
    <table>
      <thead><tr><th>Slot</th><th>Player</th><th>Bye</th><th>Proj Pts<span class="aid"> wk ${projWeekLabel?.week ?? '?'}</span></th><th>${season ? 'PPR (last / avg)' : `PPR/g ${t.stats_season}`}</th><th>Stat line</th><th>Trend · AI</th><th>My Rank</th></tr></thead>
      <tbody>
        ${filled.map(s => row(s.label, s.pos, s.player)).join('')}
        ${bench.length ? `<tr><td colspan="8" class="bench-label" style="border-bottom:none">Bench</td></tr>` : ''}
        ${bench.map(p => row('BN', p.position, p)).join('')}
      </tbody>
    </table>
    <p class="small mt">Projected points and stat lines marked "proj" are external Sleeper projections — not generated by this app. Actual lines are nflverse ${t.stats_season} data. AI rank & confidence are this app's engine.</p>`;

  el.querySelectorAll('td.name').forEach(td => td.onclick = () => openProfile(td.dataset.id, refresh));
}
