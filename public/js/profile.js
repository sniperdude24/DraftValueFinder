import { api, esc, pct, signalBadge } from './api.js';

const TABS = ['Overview', 'Game Log', 'Trends', 'AI Analysis'];

export async function openProfile(id, onChange) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-back"><div class="modal"><div class="loading">Loading…</div></div></div>';
  const data = await api.player(id);
  let tab = 'Overview';

  const render = () => {
    const { player: p, assessment: a } = data;
    root.innerHTML = `
      <div class="modal-back">
        <div class="modal">
          <div class="modal-head">
            <h2>${esc(p.name)}</h2>
            <span class="small">${esc(p.position)} · ${esc(p.team ?? 'FA')} · Bye ${p.bye ?? '?'}
              ${p.meta?.injury_status ? `<span class="badge inj">${esc(p.meta.injury_status)}</span>` : ''}
              ${p.changed_team ? `<span class="badge newteam">${esc(String(p.stats_season))}: ${esc(p.stats_team)}</span>` : ''}
              ${signalBadge(a.signal.state)}</span>
            <button class="close">✕</button>
          </div>
          <div class="modal-ranks">
            <span>ADP <b>${p.adp ? '#' + p.adp.rank : '—'}</b>${p.adp ? ` <span class="aid">(${esc(p.adp.formatted)}, ${p.adp.times_drafted} drafts)</span>` : ''}</span>
            <span>Expert <b>${p.expert ? '#' + p.expert.rank : '—'}</b>${p.expert ? ` <span class="aid">(${esc(p.expert.pos_rank)}, tier ${p.expert.tier})</span>` : ''}</span>
            ${p.trade_market ? `<span>Trade mkt <b>#${p.trade_market.rank}</b> <span class="aid">(value ${p.trade_market.value}, Stats Guy)</span></span>` : ''}
            <span>AI <b>${a.ai_rank ? '#' + a.ai_rank : '—'}</b> <span class="aid">(${a.confidence ?? '—'}% conf, AI-generated)</span></span>
            <span>My rank <input id="my-rank" type="number" min="1" max="500" value="${data.personal_rank ?? ''}" placeholder="—"> <button class="rowbtn" id="save-rank">Save</button></span>
          </div>
          <div class="tabs">${TABS.map(t => `<button class="${t === tab ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
          <div class="tabbody">${tabBody(data, tab)}</div>
        </div>
      </div>`;

    root.querySelector('.close').onclick = close;
    root.querySelector('.modal-back').onclick = e => { if (e.target.classList.contains('modal-back')) close(); };
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
    root.querySelector('#save-rank').onclick = async () => {
      const v = root.querySelector('#my-rank').value;
      await api.personalRank(id, v === '' ? null : Number(v));
      data.personal_rank = v === '' ? null : Number(v);
      render();
      onChange?.();
    };
  };

  const close = () => { root.innerHTML = ''; };
  render();
}

function tabBody(data, tab) {
  const { player: p, assessment: a } = data;
  if (tab === 'Overview') {
    const t = a.trend;
    return `
      ${t.available ? `
      <div class="statgrid">
        ${statCard('Snap share', pct(t.season.snap_pct), pct(t.recent.snap_pct), t.deltas.snap_pct)}
        ${statCard('Opportunities/g', t.season.opportunities, t.recent.opportunities, t.deltas.opportunities)}
        ${p.position !== 'QB' ? statCard('Targets/g', t.season.targets, t.recent.targets, null) : ''}
        ${['RB', 'QB'].includes(p.position) ? statCard('Carries/g', t.season.carries, t.recent.carries, null) : ''}
        ${statCard('PPR pts/g', t.season.ppr, t.recent.ppr, t.deltas.ppr)}
        <div class="stat"><div class="lab">${t.basis.type === 'prior-baseline' ? 'baseline games' : `${esc(String(p.stats_season))} games`}</div><div class="val">${t.season.games}</div></div>
      </div>
      <p class="small">${t.basis.type === 'prior-baseline'
        ? `Prior-season per-game baseline vs ${esc(String(p.stats_season))} games (weeks ${t.recent.weeks.join(', ')}).`
        : `Season average vs last 3 games played (weeks ${t.recent.weeks.join(', ')}).`} Source: nflverse weekly stats + snap counts.</p>
      ` : `<p>${esc(t.reason)}</p>`}
      ${p.meta ? `<p class="mt small">Age ${p.meta.age ?? '?'} · ${p.meta.years_exp === 0 ? 'Rookie' : (p.meta.years_exp ?? '?') + ' yrs experience'}${p.meta.depth_chart_order ? ` · Depth chart: ${esc(p.meta.depth_chart_position ?? p.position)}${p.meta.depth_chart_order}` : ''} <span class="aid">(Sleeper)</span></p>` : ''}
      ${p.conflicts?.length ? `<div class="warn mt">Source conflicts: ${p.conflicts.map(c => esc(c.note ?? `${c.field}: kept ${c.kept}`)).join(' · ')}</div>` : ''}`;
  }
  if (tab === 'Game Log') {
    if (!p.games?.length) return `<p>No ${esc(String(p.stats_season))} game data available.</p>`;
    const isQB = p.position === 'QB';
    return `<table><thead><tr>
      <th>Wk</th><th>Opp</th><th>Snap%</th>${isQB ? '<th>Cmp/Att</th><th>Pass Yd</th><th>Pass TD</th><th>INT</th>' : '<th>Tgt</th><th>Rec</th><th>Rec Yd</th><th>Rec TD</th>'}<th>Car</th><th>Rush Yd</th><th>Rush TD</th><th>PPR</th></tr></thead>
      <tbody>${p.games.map(g => `<tr>
        <td>${g.week}</td><td>${esc(g.opponent ?? '')}</td><td>${g.snap_pct != null ? Math.round(g.snap_pct * 100) + '%' : '—'}</td>
        ${isQB ? `<td>${g.completions ?? 0}/${g.attempts ?? 0}</td><td>${g.passing_yards ?? 0}</td><td>${g.passing_tds ?? 0}</td><td>${g.interceptions ?? 0}</td>`
               : `<td>${g.targets ?? 0}</td><td>${g.receptions ?? 0}</td><td>${g.receiving_yards ?? 0}</td><td>${g.receiving_tds ?? 0}</td>`}
        <td>${g.carries ?? 0}</td><td>${g.rushing_yards ?? 0}</td><td>${g.rushing_tds ?? 0}</td><td><b>${g.fantasy_points_ppr ?? '—'}</b></td>
      </tr>`).join('')}</tbody></table>
      <p class="small mt">${esc(String(p.stats_season))} regular season, games played. Source: nflverse.</p>`;
  }
  if (tab === 'Trends') {
    const t = a.trend;
    if (!t.available) return `<p>${esc(t.reason)}</p>`;
    const s = a.signal;
    return `
      <div class="evidence">
        <b>Snaps:</b> season ${pct(t.season.snap_pct)} → last 3: ${pct(t.recent.snap_pct)} (${t.directions.snaps})<br>
        <b>Opportunities:</b> season ${t.season.opportunities}/g → last 3: ${t.recent.opportunities}/g (${t.directions.opportunities})<br>
        <b>PPR points:</b> season ${t.season.ppr}/g → last 3: ${t.recent.ppr}/g<br>
        ${t.season.target_share != null ? `<b>Target share:</b> season ${pct(t.season.target_share)} → last 3: ${pct(t.recent.target_share)}<br>` : ''}
        <b>Window:</b> ${esc(t.basis.window_label)}
      </div>
      ${t.flags.unsustainable_spike ? '<div class="warn mt">Point spike without usage growth — treated as noise, not opportunity.</div>' : ''}
      ${t.flags.quiet_usage_rise ? '<div class="warn mt" style="border-color:var(--purple);color:var(--purple);background:rgba(181,140,255,.08)">Usage rose faster than production — the market may be slow to price this in.</div>' : ''}
      ${t.notes.map(n => `<div class="warn mt">${esc(n)}</div>`).join('')}
      <h3 class="mt">Sleeper assessment: ${esc(s.state === 'none' ? 'no signal' : s.state)}</h3>
      <p>${esc(s.reason)}</p>
      ${s.context?.length ? `<ul>${s.context.map(c => `<li>${esc(c.text)} <span class="aid">(${esc(c.source)})</span></li>`).join('')}</ul>` : ''}`;
  }
  // AI Analysis
  return `
    <p>AI rank <b>#${a.ai_rank ?? '—'}</b> · verdict vs market: <span class="verdict-${esc(a.verdict)}">${esc(a.verdict)}</span> · confidence <span class="conf">${a.confidence ?? '—'}%</span></p>
    <p class="small">Confidence measures how much evidence backs this assessment — it is NOT a probability of success. All items below are AI-generated interpretation of the sourced numbers.</p>
    <ul class="mt">
      ${a.factors.map(f => `<li class="${f.effect === 'up' ? 'why' : f.effect === 'down' ? 'risk' : ''}">${esc(f.text)}</li>`).join('')}
    </ul>
    ${data.personal_rank != null && a.ai_rank != null && data.personal_rank !== a.ai_rank ? `
      <div class="evidence mt">You rank this player <b>#${data.personal_rank}</b>; the AI ranks them <b>#${a.ai_rank}</b> —
      ${data.personal_rank < a.ai_rank
        ? `you are ${a.ai_rank - data.personal_rank} spots higher. The AI's caution comes from the factors above; your ranking stands.`
        : `you are ${data.personal_rank - a.ai_rank} spots lower. The AI sees more value than you do; your ranking stands.`}</div>` : ''}`;
}

function statCard(label, season, last3, delta) {
  const dir = delta == null ? '' : delta > 0 ? 'trend-up' : delta < 0 ? 'trend-down' : 'trend-flat';
  return `<div class="stat"><div class="lab">${label}</div>
    <div class="val">${season ?? '—'} <span class="delta ${dir}">→ ${last3 ?? '—'}</span></div>
    <div class="small">season → last 3</div></div>`;
}
