// Recommendations, Sleepers, Market, History, and Data/About views.
import { api, esc, pct, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';

export async function renderRecs(el, refresh) {
  const r = await api.recommendations();
  const season = r.mode === 'season';
  el.innerHTML = `
    <div class="panel">
      <h2>${season ? `Waiver targets · Week ${r.week ?? '?'}` : `Pick #${r.current_pick} · Round ${r.round}`}</h2>
      ${season ? '<p class="small">Free agents ranked by the same engine — usage evidence + roster fit + tier scarcity. Pick-value math is off (no draft in progress).</p>' : ''}
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
  const { sleepers, mode, week } = await api.sleepers();
  const season = mode === 'season';
  // Draft mode: split by ADP lateness. Season mode: free agents are the
  // waiver targets; rostered players with signals are context.
  const late = season ? sleepers.filter(s => !s.drafted) : sleepers.filter(s => s.late_round && !s.drafted);
  const early = season ? sleepers.filter(s => s.drafted) : sleepers.filter(s => !s.late_round && !s.drafted);
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
    <div class="panel"><h2>${season ? `Waiver radar · Week ${week ?? '?'}` : 'Sleeper radar'}</h2>
      <p class="small">SLEEPER SIGNAL = snap share AND opportunities both rising (market may be late). EMERGING = something interesting, evidence incomplete. Surfaced for your judgment — nothing is auto-added anywhere.</p></div>
    <h2 class="mt">${season ? 'Free agents with active signals — the waiver targets' : 'Late-round (ADP 61+) — the actual sleepers'}</h2>
    <div class="cards mt">${late.map(card).join('') || '<p class="small">None right now.</p>'}</div>
    <h2 class="mt">${season ? 'Rostered players with the same signals' : 'Early-round players with the same signals'}</h2>
    <div class="cards mt">${early.map(card).join('') || '<p class="small">None right now.</p>'}</div>`;
  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
}

export async function renderMarket(el, refresh) {
  const m = await api.market();
  el.innerHTML = `
    <div class="panel"><h2>Market disagreement</h2>
      <p class="small">Where ADP (FantasyFootballCalculator), expert consensus (FantasyPros), the trade market (<a href="https://statsguyfantasy.com" target="_blank" style="color:var(--accent)">Stats Guy Fantasy</a> — values from real Sleeper-league trades), and this app's AI assessment point in different directions. Positive Δ = AI is higher on the player than that source. All of them are evidence, not truth.</p></div>
    <table>
      <thead><tr><th>Player</th><th>ADP</th><th>Expert</th><th>Trade Mkt</th><th>AI</th><th>AI vs ADP</th><th>AI vs Expert</th><th>AI vs Trade</th><th>Verdict</th><th>Conf</th><th>Why the AI differs</th></tr></thead>
      <tbody>
        ${m.biggest.map(r => `
          <tr>
            <td class="name" data-id="${esc(r.id)}">${esc(r.name)}<span class="team">${esc(r.position)} · ${esc(r.team ?? 'FA')}</span></td>
            <td>${r.adp_rank ?? '—'}</td><td>${r.expert_rank ?? '—'}</td><td>${r.trade_rank ?? '—'}</td><td>${r.ai_rank ?? '—'}</td>
            ${[r.ai_vs_adp, r.ai_vs_expert, r.ai_vs_trade].map(d => `<td class="${d > 0 ? 'trend-up' : d < 0 ? 'trend-down' : ''}">${d == null ? '—' : (d > 0 ? '+' : '') + d}</td>`).join('')}
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

function yahooSection(y) {
  if (!y.configured) {
    return `<div class="panel"><h2>Yahoo draft sync — not configured</h2>
      <p class="small">Yahoo can track your draft picks automatically, but their Fantasy Sports API now requires an approved application first:</p>
      <ol class="small mt" style="margin-left:18px">
        <li>Apply at <a href="https://sports.yahoo.com/developer/access/" target="_blank" style="color:var(--accent)">sports.yahoo.com/developer/access</a>. Suggested wording: <em>"Draft Value Finder — a personal, open-source draft assistant for my own single Yahoo league (github.com/sniperdude24/DraftValueFinder). Needs read-only league settings, draft results, and rosters to track my draft picks automatically. Single user, personal use only."</em> User base: Small (&lt;1,000).</li>
        <li>Once approved, create the app (Confidential Client → Fantasy Sports, Read) with redirect URI <code class="src">https://localhost:8443/yahoo/callback</code>.</li>
        <li>Put <code class="src">YAHOO_CLIENT_ID</code> and <code class="src">YAHOO_CLIENT_SECRET</code> in <code class="src">.env</code> and restart the server.</li>
      </ol>
      <p class="small mt">Until then, manual pick tracking on the board works exactly as before.</p></div>`;
  }
  if (!y.connected) {
    return `<div class="panel"><h2>Yahoo draft sync — ready to connect</h2>
      <p class="small">Credentials found. Connecting opens Yahoo's consent page; your browser will warn once about a self-signed localhost certificate on the way back — that's expected, proceed through it.</p>
      <button class="rowbtn mt" id="yahoo-connect" style="padding:8px 14px">Connect Yahoo</button>
      <span class="small" id="yahoo-connect-status"></span></div>`;
  }
  return `<div class="panel"><h2>Yahoo draft sync — connected</h2>
    ${y.league?.league_key
      ? `<p class="small">League: <b>${esc(y.league.league_name ?? y.league.league_key)}</b> (${y.league.num_teams ?? '?'} teams) · Team: ${esc(y.league.team_key ?? '?')}
           ${y.league.last_sync ? ` · Last sync ${new Date(y.league.last_sync).toLocaleTimeString()} (${y.league.pick_count ?? 0} picks)` : ' · Never synced'}</p>
         ${(y.league.warnings ?? []).map(w => `<div class="warn mt">${esc(w)}</div>`).join('')}
         <div class="toolbar mt">
           <button class="rowbtn" id="yahoo-sync" style="padding:8px 14px">Sync now</button>
           <label><input type="checkbox" id="yahoo-autosync" ${y.autosync ? 'checked' : ''}> Auto-sync every 10s (during your draft)</label>
         </div>
         <p class="small mt">Sync mirrors Yahoo's draft results into the board — it replaces manual pick tracking while active. Personal ranks are never touched.</p>
         ${(y.league.unmatched ?? []).length ? `<div class="warn mt">Unmatched picks (outside the top-250 universe): ${y.league.unmatched.map(u => `#${u.pick} ${esc(u.name)} (${esc(u.position)})`).join(', ')}</div>` : ''}`
      : `<p class="small">Connected. Pick which league to track:</p><div id="yahoo-leagues" class="mt small">Loading leagues…</div>`}
    <p class="small mt" style="border-top:1px solid var(--line);padding-top:8px;color:var(--dim)">
      Yahoo attaches permissions at consent time, so a newly granted scope needs a fresh authorization.
      <button class="rowbtn" id="yahoo-reconnect" style="margin-left:6px">Re-authorize</button>
      <span id="yahoo-reconnect-status"></span>
    </p>
  </div>`;
}

async function wireYahoo(el, refresh) {
  const connectBtn = el.querySelector('#yahoo-connect');
  if (connectBtn) connectBtn.onclick = async () => {
    const { authorize_url } = await api.yahoo.connect();
    window.open(authorize_url, '_blank');
    el.querySelector('#yahoo-connect-status').textContent = ' Waiting for Yahoo…';
    const poll = setInterval(async () => {
      const s = await api.yahoo.status();
      if (s.connected) { clearInterval(poll); refresh(); }
    }, 2000);
    setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
  };
  // Re-authorize: needed whenever Yahoo grants a new scope, since scopes are
  // attached at consent time and an existing token never inherits them.
  // Success is polled against the leagues call — the only real proof of scope.
  const reconnectBtn = el.querySelector('#yahoo-reconnect');
  if (reconnectBtn) reconnectBtn.onclick = async () => {
    const status = el.querySelector('#yahoo-reconnect-status');
    const { authorize_url } = await api.yahoo.connect();
    window.open(authorize_url, '_blank');
    status.textContent = ' Approve in the new tab (click through the localhost certificate warning)…';
    const started = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) { clearInterval(poll); status.textContent = ' Timed out — try Re-authorize again.'; return; }
      try {
        await api.yahoo.leagues();
        clearInterval(poll);
        status.textContent = ' Fantasy access granted ✓';
        refresh();
      } catch { /* still pending — keep waiting */ }
    }, 3000);
  };

  const leaguesDiv = el.querySelector('#yahoo-leagues');
  if (leaguesDiv) {
    try {
      const { leagues } = await api.yahoo.leagues();
      leaguesDiv.innerHTML = leagues.length
        ? leagues.map(l => `<button class="rowbtn" style="margin:0 6px 6px 0;padding:6px 10px" data-league="${esc(l.league_key)}">${esc(l.name)} (${l.num_teams} teams, ${esc(l.season ?? '')})</button>`).join('')
        : 'No NFL leagues found on this Yahoo account.';
      leaguesDiv.querySelectorAll('[data-league]').forEach(b => b.onclick = async () => {
        await api.yahoo.setLeague(b.dataset.league);
        refresh();
      });
    } catch (err) {
      // Yahoo returns this when the token is valid but the app was never
      // granted the Fantasy Sports scope — i.e. the access review is pending.
      const scopePending = /additional_authorization_required/.test(err.message);
      leaguesDiv.innerHTML = scopePending
        ? `<div class="warn">Connected to Yahoo, but this app has <b>not been granted the Fantasy Sports scope</b> yet — that is the access review at
             <a href="https://sports.yahoo.com/developer/access/" target="_blank" style="color:var(--accent)">sports.yahoo.com/developer/access</a>, not a problem with the setup here.
             When it is approved, click <b>Re-authorize</b> below and then check again.</div>
           <button class="rowbtn mt" id="yahoo-recheck" style="padding:6px 12px">Check again</button>`
        : `Could not load leagues: ${esc(err.message)}`;
      const recheck = leaguesDiv.querySelector('#yahoo-recheck');
      if (recheck) recheck.onclick = () => refresh();
    }
  }
  const syncBtn = el.querySelector('#yahoo-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.textContent = 'Syncing…';
    try { await api.yahoo.sync(); } catch (err) { alert(`Sync failed: ${err.message}`); }
    refresh();
  };
  const auto = el.querySelector('#yahoo-autosync');
  if (auto) auto.onchange = async () => { await api.yahoo.autosync(auto.checked); };
}

export async function renderAbout(el, refresh) {
  const [m, y] = await Promise.all([api.meta(), api.yahoo.status()]);
  el.innerHTML = `
    ${yahooSection(y)}
    <div class="panel"><h2>Mode: ${m.mode === 'season' ? `Season · Week ${m.week ?? '?'} of ${m.season}` : `Draft prep for ${m.season}`}</h2>
      <p class="small">${m.mode === 'season'
        ? `Analyzing ${m.stats_season} weekly stats (updates all season); early-season trends compare against each player's ${m.baseline_season} baseline. Expert ranks are rest-of-season consensus.`
        : `Analyzing ${m.stats_season} stats for the ${m.season} draft. The app switches to season mode automatically once ${m.season} week-1 stats are published (refresh data after week 1).`}</p>
      <button class="rowbtn mt" id="data-refresh" style="padding:8px 14px">Refresh data now</button>
      <span class="small" id="data-refresh-status"></span>
      <p class="small mt">${m.auto_refresh?.enabled
        ? `Auto-refresh: on — the server re-fetches everything when the data is over 20 hours old${m.auto_refresh.last_attempt ? ` (last auto run ${new Date(m.auto_refresh.last_attempt).toLocaleString()}: ${esc(m.auto_refresh.last_result ?? '…')})` : ' (no auto run yet this session)'}.`
        : 'Auto-refresh: disabled (DVF_NO_AUTO_REFRESH is set).'}</p>
    </div>
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
    ${m.unmatched.veterans_without_stats.length ? `<div class="panel"><h2>Data gaps (visible, not hidden)</h2>
      <p class="small">Veterans with no ${m.stats_season} stats matched (injury/holdout or a name-matching gap):
      ${m.unmatched.veterans_without_stats.map(p => esc(p.name)).join(', ')}</p>
      ${m.unmatched.ffc_only.length ? `<p class="small mt">In ADP data but not expert rankings: ${m.unmatched.ffc_only.map(p => esc(p.name)).join(', ')}</p>` : ''}
    </div>` : ''}`;
  const refreshBtn = el.querySelector('#data-refresh');
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    const status = el.querySelector('#data-refresh-status');
    status.textContent = ' Fetching all sources… (can take a minute)';
    try {
      const r = await api.adminRefresh();
      status.textContent = ` Done — ${r.total - r.failures}/${r.total} sources OK, ${r.mode} mode, stats ${r.stats_season}.`;
      setTimeout(() => refresh?.(), 1200);
    } catch (err) {
      status.textContent = ` Failed: ${err.message}`;
      refreshBtn.disabled = false;
    }
  };
  await wireYahoo(el, refresh ?? (() => renderAbout(el, refresh)));
}
