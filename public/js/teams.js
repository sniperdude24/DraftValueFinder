// Team context — how each offense divides its opportunity, how that
// division is moving, and who is gaining alongside an absence.
//
// Opportunity is a fixed pie: when a player leaves or sits, his targets and
// touches go somewhere. This page makes that redistribution visible.
import { api, esc, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';

const state = { team: null };

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
// Sign off the ROUNDED value: a +0.004 delta rounds to zero, and "+0 pts"
// next to a plain "0 pts" reads as a distinction that isn't there.
const deltaPts = v => {
  if (v == null) return '—';
  const p = Math.round(v * 100);
  return p === 0 ? 'no change' : `${p > 0 ? '+' : ''}${p} ${Math.abs(p) === 1 ? 'pt' : 'pts'}`;
};
const bar = (share, cls = 'bar-tgt') =>
  `<span class="sharebar"><span class="${cls}" style="width:${Math.min(100, Math.round((share ?? 0) * 100))}%"></span></span>`;

function distributionTable(rows, { title, note }) {
  if (!rows.length) return `<div class="panel"><h2>${esc(title)}</h2><p class="small">No data.</p></div>`;
  return `
    <div class="panel">
      <h2>${esc(title)}</h2>
      <p class="small">${note}</p>
      <table class="mt">
        <thead><tr><th>Player</th><th>G</th><th>Tgt</th><th>Tgt Share</th><th></th><th>Car</th><th>Car Share</th><th>PPR/g</th><th>Trend</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.still_on_team ? '' : 'departed-row'}">
            <td class="name" data-id="${esc(r.id)}">${esc(r.name)}<span class="team">${esc(r.position)}</span>
              ${r.still_on_team ? '' : '<span class="badge inj">GONE</span>'}
              ${r.injury_status ? `<span class="badge inj">${esc(r.injury_status)}</span>` : ''}
              ${signalBadge(r.sleeper_state)}</td>
            <td>${r.games}</td>
            <td>${r.targets}</td>
            <td>${pct(r.target_share)}</td>
            <td style="width:110px">${bar(r.target_share)}</td>
            <td>${r.carries}</td>
            <td>${pct(r.carry_share)}</td>
            <td>${r.ppr_pg ?? '—'}</td>
            <td>${trendArrow(r.usage_trend)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

export async function renderTeams(el, refresh) {
  const { teams, stats_season } = await api.teams();
  if (!state.team) {
    // Default to a team the user actually cares about: the first player on
    // their roster, else the first team alphabetically.
    const board = await api.board();
    state.team = board.players.find(p => p.mine)?.team ?? teams[0]?.team ?? null;
  }
  const ctx = state.team ? await api.teamContext(state.team) : null;
  document.getElementById('draft-status').textContent =
    ctx ? `${ctx.team} · ${ctx.games} tracked games (${stats_season})` : '';

  const picker = `
    <div class="toolbar">
      ${teams.map(t => `<button class="posbtn ${state.team === t.team ? 'active' : ''}" data-team="${esc(t.team)}" title="${t.players} tracked players${t.injured ? ` · ${t.injured} out` : ''}${t.incoming ? ` · ${t.incoming} new` : ''}">${esc(t.team)}${t.injured ? ' <span class="trend-down">•</span>' : ''}</button>`).join('')}
    </div>`;

  if (!ctx) { el.innerHTML = picker + '<p class="small">No team selected.</p>'; return; }

  const rc = ctx.roster_changes;
  const unaccounted = ctx.season.accounted_target_share != null ? 1 - ctx.season.accounted_target_share : null;

  el.innerHTML = `
    ${picker}
    <div class="panel">
      <h2>${esc(ctx.team)} offense · ${ctx.games} games (${stats_season})</h2>
      <p class="small">
        ~<b>${ctx.season.team_targets_pg ?? '—'}</b> targets per game reconstructed from player shares ·
        <b>${ctx.season.tracked_carries_pg ?? '—'}</b> tracked carries per game ·
        top-250 players account for <b>${pct(ctx.season.accounted_target_share)}</b> of targets${unaccounted != null ? ` (${pct(unaccounted)} goes to players outside the universe)` : ''}.
      </p>
      ${rc.vacated_target_share > 0.01 || rc.vacated_carries > 0 ? `<div class="warn mt">
        <b>Vacated opportunity:</b> players no longer on this team accounted for
        <b>${pct(rc.vacated_target_share)}</b> of ${stats_season} targets${rc.vacated_carries ? ` and <b>${rc.vacated_carries}</b> carries` : ''} —
        ${rc.departed.map(d => `${esc(d.name)} (${esc(d.position)} → ${esc(d.now_with ?? '?')})`).join(', ')}.
        That work has to go somewhere.
      </div>` : ''}
      ${rc.arrived.length ? `<div class="warn mt" style="border-color:var(--accent);color:var(--accent);background:rgba(77,163,255,.08)">
        <b>New arrivals</b> competing for it: ${rc.arrived.map(a => `${esc(a.name)} (${esc(a.position)}, from ${esc(a.came_from ?? '?')})`).join(', ')}.
      </div>` : ''}
    </div>

    ${distributionTable(ctx.season.rows, {
      title: 'Full-season distribution',
      note: `Share of the team's targets over all ${ctx.games} tracked games, computed from window totals — a player who missed games shows a correspondingly smaller share. Carry share is of tracked carries only.`,
    })}

    ${ctx.recent.rows.length ? distributionTable(ctx.recent.rows, {
      title: `Recent distribution — last ${ctx.recent.weeks.length} games (weeks ${ctx.recent.weeks.join(', ')})`,
      note: 'The same pie over the most recent games. Compare against the full season to see who is taking over.',
    }) : ''}

    ${ctx.movement.length ? `<div class="panel">
      <h2>Share movement — recent vs full season</h2>
      <p class="small">Change in each player's slice of the target pie, in percentage points.</p>
      <table class="mt">
        <thead><tr><th>Player</th><th>Season</th><th>Recent</th><th>Δ</th><th>Carries/g</th></tr></thead>
        <tbody>${ctx.movement.map(m => `<tr>
          <td class="name" data-id="${esc(m.id)}">${esc(m.name)}<span class="team">${esc(m.position)}</span>${m.still_on_team ? '' : '<span class="badge inj">GONE</span>'}</td>
          <td>${pct(m.target_share_from)}</td><td>${pct(m.target_share_to)}</td>
          <td class="${(m.target_share_delta ?? 0) > 0.02 ? 'trend-up' : (m.target_share_delta ?? 0) < -0.02 ? 'trend-down' : ''}">
            ${deltaPts(m.target_share_delta)}</td>
          <td>${m.carries_pg_from ?? '—'} → ${m.carries_pg_to ?? '—'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    ${ctx.ripple.length ? `<div class="panel">
      <h2>Ripple watch</h2>
      <p class="small">Players who are out or gone, paired with teammates whose usage rose over the same stretch.
        This is <b>observed co-movement, not proven causation</b> — the numbers are here so you can judge whether the role actually transferred.</p>
      ${ctx.ripple.map(r => `<div class="evidence mt">
        <b>${esc(r.disrupted.name)}</b> (${esc(r.disrupted.position)}) — ${esc(r.disrupted.reason)}${r.disrupted.vacated_target_share ? `, vacating ${pct(r.disrupted.vacated_target_share)} of targets` : ''}${r.disrupted.vacated_carries ? ` and ${r.disrupted.vacated_carries} carries` : ''}.
        ${r.beneficiaries.length ? `<ul class="mt">${r.beneficiaries.map(b => `<li class="why">${esc(b.name)} (${esc(b.position)}): target share ${pct(b.target_share_from)} → ${pct(b.target_share_to)}${(b.carries_pg_to ?? 0) > 0 ? `, carries ${b.carries_pg_from ?? 0} → ${b.carries_pg_to}/g` : ''}</li>`).join('')}</ul>`
          : '<div class="small mt">No teammate shows a clear usage gain yet — the work may be going to players outside the top-250 universe.</div>'}
      </div>`).join('')}
    </div>` : ''}`;

  el.querySelectorAll('[data-team]').forEach(b => b.onclick = () => { state.team = b.dataset.team; refresh(); });
  el.querySelectorAll('td.name').forEach(td => td.onclick = () => openProfile(td.dataset.id, refresh));
}
