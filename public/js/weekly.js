// This Week — the roster-management page.
//
// Order is deliberate: what the app does not know comes first. If the
// free-agent pool is stale or missing, every pickup suggestion below it is
// suspect, and burying that under the lineup would be the one presentation
// choice guaranteed to cost the user a claim.
import { api, esc, pct } from './api.js';
import { openProfile } from './profile.js';

const num = v => (v == null ? '<span class="aid">—</span>' : v);
const dir = d => (d === 'rising' ? '<span class="trend-up">▲</span>'
  : d === 'falling' ? '<span class="trend-down">▼</span>' : '<span class="trend-flat">—</span>');

function playerCell(p) {
  return `<span class="clickable" data-id="${esc(p.id)}">${esc(p.name)}</span>
    <span class="aid">${esc(p.position)} ${esc(p.team ?? 'FA')}${p.bye != null ? ` · bye ${p.bye}` : ''}</span>
    ${p.injury_status ? `<span class="badge inj">${esc(p.injury_status)}</span>` : ''}`;
}

function lineupTable(ss) {
  return `
    <table>
      <thead><tr><th>Slot</th><th>Player</th><th>Projected</th><th>Sleeper PPR</th></tr></thead>
      <tbody>
        ${ss.lineup.map(s => `<tr>
          <td><span class="poschip pos-${esc(s.position === 'FLEX' ? 'FLEX' : s.position)}">${esc(s.slot)}</span></td>
          ${s.player
            ? `<td>${playerCell(s.player)}</td><td><b>${num(s.player.projected)}</b></td><td class="aid">${num(s.player.projected_ppr)}</td>`
            : '<td colspan="3" class="small" style="font-style:italic;color:var(--dim)">no player for this slot</td>'}
        </tr>`).join('')}
        ${ss.bench.length ? `<tr><td colspan="4" class="bench-label" style="border-bottom:none">Bench</td></tr>` : ''}
        ${ss.bench.map(p => `<tr>
          <td><span class="poschip pos-${esc(p.position)}">BN</span></td>
          <td>${playerCell(p)}</td><td>${num(p.projected)}</td><td class="aid">${num(p.projected_ppr)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function evidenceLine(e) {
  if (!e) return '';
  const s = e.snaps ?? {}, o = e.opportunities ?? {};
  return `<div class="evidence small">
    Snaps ${pct(s.season)} → ${pct(s.recent)} ${dir(s.direction)} ·
    Opportunities ${num(o.season)} → ${num(o.recent)} ${dir(o.direction)}
    ${e.points ? `· Points ${num(e.points.season)} → ${num(e.points.recent)}` : ''}
    ${e.weeks?.length ? `<span class="aid"> (weeks ${e.weeks.join(', ')})</span>` : ''}
  </div>`;
}

export async function renderWeekly(el, refresh) {
  const w = await api.weekly();
  document.getElementById('draft-status').textContent =
    w.preview ? 'preseason preview' : `week ${w.week ?? '?'}`;

  const stateBadge = { fading: 'inj', slipping: 'emerging', noise: 'newteam' };

  el.innerHTML = `
    ${w.pool.stale ? `<div class="warn"><b>${w.pool.known ? 'Stale free-agent list.' : 'Availability unknown.'}</b>
      ${esc(w.pool.note)} Paste one on the League page.</div>` : ''}

    <div class="panel">
      <h2>This Week${w.preview ? '' : ` · Week ${w.week ?? '?'}`}</h2>
      ${w.preview ? `<p class="small">It is the preseason, so there is no live week to report on. This is a
        <b>worked example against completed ${esc(String(w.stats_season))} games</b> — real data and real
        arithmetic, but not advice about an upcoming matchup. It becomes live on its own once the season
        starts and the app flips to season mode.</p>` : ''}
      <p class="small">${w.pool.known ? esc(w.pool.note) : ''}
        ${w.available_count} players have no recorded owner.</p>
      ${w.empty ? '<p class="small mt">No players on your roster yet — assign them on the League page.</p>' : ''}
    </div>

    ${w.empty ? '' : `
    <div class="panel">
      <div class="roster-head"><h2>Start / sit</h2>
        <span class="aid">projected ${w.start_sit.projected_total} pts</span></div>
      <p class="small">Ranked by <b>Sleeper's projected components scored with your rules</b> — this app's
        arithmetic on someone else's projection, which is why Sleeper's own PPR number sits beside it
        untouched. Game milestones are excluded from a projection: it is an expectation, not a game, so it
        cannot say how often a threshold is actually crossed.</p>
      ${lineupTable(w.start_sit)}
      ${w.start_sit.flags.length ? `<div class="mt">${w.start_sit.flags.map(f =>
        `<div class="warn" style="font-size:12px">${esc(f.text)}</div>`).join('')}</div>` : ''}
      ${w.start_sit.close_calls.length ? `
        <h3 class="mt" style="font-size:14px">Close calls</h3>
        <p class="small">Within ${w.start_sit.close_calls[0].margin != null ? '2' : '2'} points, so this is
          your call rather than the app's.</p>
        ${w.start_sit.close_calls.map(c => `<div class="evidence">
          <b>${esc(c.slot)}</b>: ${esc(c.starting.name)} (${c.starting.projected}) over
          ${esc(c.alternative.name)} (${c.alternative.projected}) — margin ${c.margin} pts
        </div>`).join('')}` : ''}
      ${w.start_sit.unprojected.length ? `<p class="small mt aid">No projection available for
        ${w.start_sit.unprojected.map(p => esc(p.name)).join(', ')} — ranked last, not assumed to be zero.</p>` : ''}
    </div>

    <div class="panel">
      <h2>Usage watch</h2>
      <p class="small">Snap share and opportunities over the last 3 games played. A player is
        <b>fading</b> only when both are falling — the same evidence bar the sleeper detector uses in the
        other direction. A points collapse with steady usage is called <b>noise</b>, because dropping a
        good player after two quiet weeks is the expensive mistake this page could talk you into.</p>
      ${w.fading.length ? w.fading.map(f => `
        <div class="evidence mt">
          <div><span class="badge ${stateBadge[f.state] ?? ''}">${esc(f.state.toUpperCase())}</span>
            ${playerCell(f)}</div>
          <div class="small mt">${esc(f.reason)}</div>
          ${evidenceLine(f.evidence)}
        </div>`).join('')
        : '<p class="small mt">Nobody on your roster is losing usage.</p>'}
    </div>

    <div class="panel">
      <h2>Swap candidates</h2>
      <p class="small">The weakest hold paired against the best available riser <b>at the same position</b>.
        Never across positions — trading a tight end for a receiver changes your roster shape in ways this
        pairing cannot see. Both sides show their evidence; the app proposes, it does not decide.</p>
      ${w.swaps.length ? w.swaps.map(s => `
        <div class="evidence mt">
          <div><span class="trend-down">DROP</span> ${playerCell(s.drop)} — ${esc(s.drop.reason)}</div>
          ${evidenceLine(s.drop.evidence)}
          <div class="mt"><span class="trend-up">ADD</span> ${playerCell(s.add)}
            <span class="badge ${s.add.state === 'signal' ? 'signal' : 'emerging'}">${esc(s.add.state.toUpperCase())}</span>
            <span class="aid">AI #${num(s.add.ai_rank)} · ${num(s.add.confidence)}%</span></div>
          <div class="small">${esc(s.add.reason)}</div>
          ${evidenceLine(s.add.evidence)}
          ${s.add.context?.length ? `<div class="small aid">${s.add.context.map(c => esc(c.text)).join(' · ')}</div>` : ''}
        </div>`).join('')
        : '<p class="small mt">No swap worth proposing — either nobody is fading, or no riser is available at that position.</p>'}
    </div>

    ${w.roster.byeConflicts.length ? `<div class="panel">
      <h2>Bye conflicts</h2>
      ${w.roster.byeConflicts.map(b => `<div class="warn">Week ${b.week}: ${b.players.map(esc).join(', ')}</div>`).join('')}
    </div>` : ''}`}`;

  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
}
