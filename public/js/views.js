// Recommendations, Sleepers, Market, History, and Data/About views.
import { api, esc, pct, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';

export async function renderRecs(el, refresh) {
  const r = await api.recommendations();
  el.innerHTML = `
    <div class="panel">
      <h2>Pick #${r.current_pick} · Round ${r.round}</h2>
      <p class="small">Roster: ${Object.entries(r.roster.counts).map(([p, n]) => `${p} ${n}`).join(' · ')}
        ${r.roster.needs.length ? ' · Needs: ' + r.roster.needs.map(n => `${n.missing} ${n.position}`).join(', ') : ' · All starting slots covered'}</p>
      ${r.roster.byeConflicts?.length ? r.roster.byeConflicts.map(b => `<div class="warn mt">Bye week ${b.week} stack: ${b.players.join(', ')}</div>`).join('') : ''}
      ${r.position_warnings.map(w => `<div class="warn mt">${esc(w)}</div>`).join('')}
    </div>
    <div class="cards">
      ${r.recommendations.map((rec, i) => `
        <div class="card">
          <h3>${i === 0 ? 'RECOMMEND — ' : ''}<span class="clickable" data-id="${esc(rec.id)}">${esc(rec.name)}</span>
            <span class="small">${esc(rec.position)} · ${esc(rec.team ?? 'FA')} · bye ${rec.bye ?? '?'}</span></h3>
          <div class="meta">ADP #${rec.adp_rank ?? '—'} · Expert #${rec.expert_rank ?? '—'} · AI #${rec.ai_rank}
            · Confidence <span class="conf">${rec.confidence}%</span> <span class="aid">(AI-generated)</span>
            ${signalBadge(rec.sleeper_state)}</div>
          <b class="why">Why:</b>
          <ul>${rec.why.map(w => `<li class="why">${esc(w)}</li>`).join('') || '<li class="small">Solid value at market price.</li>'}</ul>
          ${rec.risk.length ? `<b class="risk">Risk:</b><ul>${rec.risk.map(w => `<li class="risk">${esc(w)}</li>`).join('')}</ul>` : ''}
        </div>`).join('')}
    </div>
    <p class="small mt">Every recommendation set is logged to the accountability history with its full context.</p>`;
  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
}

export async function renderSleepers(el, refresh) {
  const { sleepers } = await api.sleepers();
  const late = sleepers.filter(s => s.late_round && !s.drafted);
  const early = sleepers.filter(s => !s.late_round && !s.drafted);
  const card = s => `
    <div class="card">
      <h3><span class="clickable" data-id="${esc(s.id)}">${esc(s.name)}</span>
        <span class="small">${esc(s.position)} · ${esc(s.team ?? 'FA')} · bye ${s.bye ?? '?'}</span> ${signalBadge(s.state)}</h3>
      <div class="meta">ADP #${s.adp_rank ?? '—'} · Expert #${s.expert_rank ?? '—'} · AI #${s.ai_rank ?? '—'} · conf ${s.confidence}% <span class="aid">(AI)</span></div>
      <p>${esc(s.reason)}</p>
      ${s.evidence ? `<div class="evidence">
        <b>Snaps:</b> ${pct(s.evidence.snaps.season)} → ${pct(s.evidence.snaps.last3)} (${s.evidence.snaps.direction})<br>
        <b>Opportunities:</b> ${s.evidence.opportunities.season}/g → ${s.evidence.opportunities.last3}/g (${s.evidence.opportunities.direction})<br>
        <b>PPR:</b> ${s.evidence.ppr.season}/g → ${s.evidence.ppr.last3}/g · weeks ${s.evidence.window_weeks.join(', ')}
      </div>` : ''}
      ${s.context?.length ? `<ul class="mt">${s.context.map(c => `<li class="small">${esc(c.text)} <span class="aid">(${esc(c.source)})</span></li>`).join('')}</ul>` : ''}
    </div>`;
  el.innerHTML = `
    <div class="panel"><h2>Sleeper radar</h2>
      <p class="small">SLEEPER SIGNAL = snap share AND opportunities both rising over the last 3 games of 2025 (market may be late). EMERGING = something interesting, evidence incomplete. Surfaced for your judgment — nothing is auto-added anywhere.</p></div>
    <h2 class="mt">Late-round (ADP 61+) — the actual sleepers</h2>
    <div class="cards mt">${late.map(card).join('') || '<p class="small">None right now.</p>'}</div>
    <h2 class="mt">Early-round players with the same signals</h2>
    <div class="cards mt">${early.map(card).join('') || '<p class="small">None right now.</p>'}</div>`;
  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
}

export async function renderMarket(el, refresh) {
  const m = await api.market();
  el.innerHTML = `
    <div class="panel"><h2>Market disagreement</h2>
      <p class="small">Where ADP (FantasyFootballCalculator), expert consensus (FantasyPros), and this app's AI assessment point in different directions. Positive Δ = AI is higher on the player than that source. Experts are evidence, not truth.</p></div>
    <table>
      <thead><tr><th>Player</th><th>ADP</th><th>Expert</th><th>AI</th><th>AI vs ADP</th><th>AI vs Expert</th><th>Expert vs ADP</th><th>Verdict</th><th>Conf</th><th>Why the AI differs</th></tr></thead>
      <tbody>
        ${m.biggest.map(r => `
          <tr>
            <td class="name" data-id="${esc(r.id)}">${esc(r.name)}<span class="team">${esc(r.position)} · ${esc(r.team ?? 'FA')}</span></td>
            <td>${r.adp_rank ?? '—'}</td><td>${r.expert_rank ?? '—'}</td><td>${r.ai_rank ?? '—'}</td>
            ${[r.ai_vs_adp, r.ai_vs_expert, r.expert_vs_adp].map(d => `<td class="${d > 0 ? 'trend-up' : d < 0 ? 'trend-down' : ''}">${d == null ? '—' : (d > 0 ? '+' : '') + d}</td>`).join('')}
            <td class="verdict-${esc(r.ai_verdict)}">${esc(r.ai_verdict)}</td>
            <td>${r.confidence ?? '—'}%</td>
            <td style="white-space:normal;min-width:280px" class="small">${r.factors.filter(f => ['up', 'down'].includes(f.effect)).map(f => esc(f.text)).join(' · ') || '<span class="aid">market sources disagree with each other</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  el.querySelectorAll('td.name').forEach(td => td.onclick = () => openProfile(td.dataset.id, refresh));
}

export async function renderHistory(el) {
  const { events } = await api.history();
  el.innerHTML = `
    <div class="panel"><h2>Recommendation history (accountability log)</h2>
      <p class="small">Every recommendation is recorded with the market state and evidence at the time it was made, so the system's calls can later be compared against real outcomes.</p></div>
    ${events.length ? `<table>
      <thead><tr><th>When</th><th>Event</th><th>Player</th><th>Pick</th><th>ADP</th><th>Expert</th><th>AI</th><th>Conf</th><th>Top reason</th></tr></thead>
      <tbody>${events.map(e => `<tr>
        <td class="small">${new Date(e.at).toLocaleString()}</td>
        <td>${esc(e.trigger)}</td>
        <td>${esc(e.player ?? '')}</td>
        <td>${e.current_pick ?? e.pick ?? '—'}</td>
        <td>${e.adp_rank ?? '—'}</td><td>${e.expert_rank ?? '—'}</td><td>${e.ai_rank ?? '—'}</td>
        <td>${e.confidence != null ? e.confidence + '%' : '—'}</td>
        <td style="white-space:normal" class="small">${esc(e.why?.[0] ?? '')}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<p class="small">No history yet — visit the Recommendations page or make draft picks.</p>'}`;
}

export async function renderAbout(el) {
  const m = await api.meta();
  el.innerHTML = `
    <div class="panel"><h2>Data sources & freshness</h2>
      <table class="mt">
        <thead><tr><th>Role</th><th>Source</th><th>Fetched</th><th>Detail</th></tr></thead>
        <tbody>${Object.entries(m.sources).map(([k, v]) => `<tr>
          <td>${esc(k)}</td><td>${esc(v?.source ?? '?')}</td>
          <td class="small">${v?.fetched_at ? new Date(v.fetched_at).toLocaleString() : '?'}</td>
          <td class="small" style="white-space:normal">${esc(v?.detail ?? '')}</td></tr>`).join('')}</tbody>
      </table>
      <p class="small mt">Database built ${new Date(m.built_at).toLocaleString()} · ${m.counts.players} players (${m.counts.core} core + ${m.counts.players - m.counts.core} watch) · ${m.counts.with_adp} with ADP · ${m.counts.with_expert} with expert rank · ${m.counts.with_stats} with 2025 stats.</p>
      <p class="small mt">Refresh data: run <code class="src">npm run refresh</code> in the project folder, then restart the server.</p>
    </div>
    ${m.unmatched.veterans_without_2025_stats.length ? `<div class="panel"><h2>Data gaps (visible, not hidden)</h2>
      <p class="small">Veterans with no 2025 stats matched (injury/holdout or a name-matching gap):
      ${m.unmatched.veterans_without_2025_stats.map(p => esc(p.name)).join(', ')}</p>
      ${m.unmatched.ffc_only.length ? `<p class="small mt">In ADP data but not expert rankings: ${m.unmatched.ffc_only.map(p => esc(p.name)).join(', ')}</p>` : ''}
    </div>` : ''}`;
}
