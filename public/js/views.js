// Recommendations, Sleepers, Market, History, and Data/About views.
import { api, esc, pct, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';

const PRESET_LABELS = { ppr: 'PPR', half_ppr: 'Half PPR', standard: 'Standard', custom: 'Custom' };

// Show rare cross-position categories (a receiver's TD pass) only when the
// user asks — they are real and scoreable, but they would triple the length
// of every table if shown by default.
const scoringUi = { showRare: {} };

// One category row: FF Pts and Per Unit, laid out the way a league settings
// page writes it. "1 point per 20 yards" stays 1 and 20 here rather than
// being flattened to 0.05.
function ruleRow(s, positions, key) {
  const c = s.categories[key] ?? { label: key, short: key };
  return `<tr>
    <td>${esc(c.label)}</td>
    <td class="aid">${esc(c.short)}</td>
    ${positions.map(pos => {
      const [pts, per] = s.rules[pos]?.[key] ?? [0, 1];
      return `<td><input type="number" step="any" class="rule-pts" data-pos="${pos}" data-field="${key}" value="${pts}"></td>
              <td><input type="number" step="any" class="rule-per" data-pos="${pos}" data-field="${key}" value="${per}"></td>`;
    }).join('')}
  </tr>`;
}

const isRate = (s, k) => (s.categories[k]?.kind ?? 'rate') === 'rate';

function ruleTable(s, positions, title) {
  // Rate rules only — milestones live in their own table, because their second
  // column is a threshold and a column that means two things by row is exactly
  // the confusion this editor exists to avoid.
  const keys = Object.keys(s.categories).filter(k => isRate(s, k));
  const primary = keys.filter(k => positions.some(p => s.primary[p].includes(k)));
  const rare = keys.filter(k => !primary.includes(k));
  const key = positions.join('-');
  const open = !!scoringUi.showRare[key];
  return `
    <table class="mt scoring-grid">
      <thead>
        <tr><th></th><th></th>${positions.map(p => `<th colspan="2" class="posgroup">${esc(p)}</th>`).join('')}</tr>
        <tr><th>Scoring category</th><th>Short</th>${positions.map(() => '<th>FF Pts</th><th>Per Unit</th>').join('')}</tr>
      </thead>
      <tbody>
        ${primary.map(k => ruleRow(s, positions, k)).join('')}
        ${open ? rare.map(k => ruleRow(s, positions, k)).join('') : ''}
      </tbody>
      <tfoot>
        <tr><td colspan="${2 + positions.length * 2}" class="small">
          <button class="rowbtn" data-rare="${esc(key)}">${open ? 'Hide' : 'Show'} rare categories</button>
          <span class="aid">${esc(title)} — rare rows cover cross-position plays (a receiver's TD pass, a quarterback's catch). They score too; they are just hidden by default.</span>
          ${positions.length > 1 ? positions.slice(1).map((p, i) =>
            `<button class="rowbtn" data-copy-from="${esc(positions[i])}" data-copy-to="${esc(p)}">Same scoring as ${esc(positions[i])}</button>`).join('') : ''}
        </td></tr>
      </tfoot>
    </table>`;
}

// Milestones: a threshold crossed once in a game, not a rate. Same stored
// shape as every other rule, but the second number is "at least this much"
// rather than "per this many", so they get their own headers.
function milestoneTable(s) {
  const keys = Object.keys(s.categories).filter(k => !isRate(s, k));
  if (!keys.length) return '';
  const positions = s.positions;
  return `
    <table class="mt scoring-grid">
      <thead>
        <tr><th></th><th></th>${positions.map(p => `<th colspan="2" class="posgroup">${esc(p)}</th>`).join('')}</tr>
        <tr><th>Game milestone</th><th>Short</th>${positions.map(() => '<th>FF Pts</th><th>At Least</th>').join('')}</tr>
      </thead>
      <tbody>${keys.map(k => ruleRow(s, positions, k)).join('')}</tbody>
      <tfoot>
        <tr><td colspan="${2 + positions.length * 2}" class="small aid">
          Paid once per game when the line reaches the mark — a 195-yard game pays a
          100-yard bonus once, not twice. Change "At Least" if your league uses a different
          number. These are excluded from the prior-season column on roster pages, where only
          per-game averages are stored and a threshold cannot be recovered from an average.
        </td></tr>
      </tfoot>
    </table>`;
}

function scoringSection(s) {
  const active = s.preset;
  return `
    <div class="panel"><h2>Scoring</h2>
      <p class="small">Points are computed from each game's component stats, not taken from a
        precomputed total — so changing these values re-scores every game log and flows through
        trends, the AI rank, team pages and the chat. Each position has its own column, so a
        per-carry bonus can pay running backs and nothing to quarterbacks. Changing scoring
        re-scores in memory; it does not re-download anything.</p>
      <div class="toolbar mt">
        ${Object.keys(PRESET_LABELS).filter(p => p !== 'custom').map(p =>
          `<button class="posbtn ${active === p ? 'active' : ''}" data-preset="${p}">${PRESET_LABELS[p]}</button>`).join('')}
        <span class="small">Active: <b>${PRESET_LABELS[active] ?? esc(active)}</b></span>
      </div>
      ${ruleTable(s, ['QB'], 'Quarterback')}
      ${ruleTable(s, ['RB', 'WR', 'TE'], 'Running back · Wide receiver · Tight end')}
      ${milestoneTable(s)}
      <button class="rowbtn mine mt" id="scoring-apply" style="padding:8px 14px">Save scoring</button>
      <span class="small" id="scoring-status"></span>
      ${active !== 'ppr' ? `<div class="warn mt">
        <b>ADP and expert ranks are still PPR.</b> Those columns come from PPR-specific sources
        (Fantasy Football Calculator and FantasyPros) and cannot be converted to your scoring.
        The app's own numbers — points, trends, AI rank — do use it, so any disagreement with the
        market partly reflects the format difference, not just opinion. This is shown rather than
        silently corrected.
      </div>` : ''}
      <p class="small mt">Verified rather than assumed: set to PPR, this engine reproduces nflverse's
        own points figure for every game log in the database, including the trick plays where a
        receiver throws a touchdown.</p>
    </div>`;
}

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
        <b>Pts:</b> ${s.evidence.points.season}/g → ${s.evidence.points.last3}/g · weeks ${s.evidence.window_weeks.join(', ')}
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

// A signed number where the sign is the whole point: green above zero, red
// below, and never rendered without the baseline it is measured against.
const signed = v => (v == null ? '<span class="aid">—</span>'
  : `<span class="${v > 0 ? 'trend-up' : v < 0 ? 'trend-down' : 'trend-flat'}">${v > 0 ? '+' : ''}${v}</span>`);

function backtestSection(b, statsSeason) {
  const row = (label, g, note) => `<tr>
    <td><b>${esc(label)}</b>${note ? `<div class="aid">${esc(note)}</div>` : ''}</td>
    <td>${g.n}<span class="aid"> (${g.players} players)</span></td>
    <td>${g.trailing_pg ?? '—'}</td>
    <td>${g.recent_pg ?? '—'}</td>
    <td><b>${g.forward_pg ?? '—'}</b></td>
    <td>${signed(g.delta)}</td>
    <td>${signed(g.delta_vs_recent)}</td>
  </tr>`;

  return `
    <div class="panel">
      <h2>Does the signal predict? · ${esc(String(statsSeason))} replay</h2>
      <p class="small">The season replayed one game at a time. At each cut the signal is computed from
        <b>only the games played up to that point</b>, then measured against the next ${b.horizon} games.
        ${b.cuts.toLocaleString()} cut points.</p>
      <table>
        <thead>
          <tr><th>Group</th><th>Cuts</th><th>Season/g</th><th>Last 3/g</th><th>Next ${b.horizon}/g</th>
            <th>vs season</th><th>vs last 3</th></tr>
        </thead>
        <tbody>
          ${row('Sleeper signal', b.groups.signal, 'snaps AND opportunities rising')}
          ${row('Emerging', b.groups.emerging, 'one of the two rising')}
          ${row('No signal', b.groups.none, 'the rest of the universe')}
          <tr><td colspan="7" class="bench-label" style="border-bottom:none">Separate claim</td></tr>
          ${row('Flagged as noise', b.spike, 'points spiked, usage did not — the engine rejects these')}
        </tbody>
      </table>

      <div class="evidence mt">
        <b>Reading it.</b> Everyone gives back some of a hot three-game window — that is regression, not a
        verdict. What separates the groups is where they land relative to their own prior form.
        Signal players finished <b>${signed(b.groups.signal.delta)}</b> against their season rate while
        unflagged players were <b>${signed(b.groups.none.delta)}</b>: a lift of
        <b>${b.lift ?? '—'}</b> points per game.
        Players the engine dismissed as noise gave back <b>${signed(b.spike.delta_vs_recent)}</b> from the
        burst that would have tempted you — the largest give-back of any group, which is the rejection
        doing its job.
      </div>

      <h3 class="mt" style="font-size:14px">What would make this wrong</h3>
      <ul class="small" style="margin-left:18px">
        ${b.caveats.map(c => `<li style="margin-bottom:4px">${esc(c)}</li>`).join('')}
      </ul>
    </div>`;
}

function gradingSection(g) {
  if (!g.available) {
    return `
      <div class="panel">
        <h2>Did it work for you?</h2>
        <p class="small">${esc(g.reason ?? 'Nothing to grade yet.')}</p>
        <p class="small aid">${g.pending.total} logged recommendation${g.pending.total === 1 ? '' : 's'} waiting —
          ${g.pending.no_week} without a recorded week, ${g.pending.no_games_yet} with no games played since.
          This section fills itself in; nothing to do.</p>
      </div>`;
  }
  return `
    <div class="panel">
      <h2>Did it work for you?</h2>
      <p class="small">Every recommendation the app actually made, against what the player did in the
        following ${g.horizon} games. This is the log grading itself — not a replay.</p>
      <p class="small"><b>${g.summary.n}</b> graded · ${g.summary.forward_pg} pts/g after ·
        <b>${signed(g.summary.delta)}</b> against their form at the time</p>
      <table>
        <thead><tr><th>Week</th><th>Player</th><th>Signal</th><th>AI</th><th>Before/g</th><th>After/g</th><th>Delta</th></tr></thead>
        <tbody>${g.graded.slice(-40).reverse().map(r => `<tr>
          <td>${r.week ?? '—'}</td>
          <td>${esc(r.player ?? '')}<span class="team">${esc(r.position ?? '')}</span></td>
          <td>${r.state === 'none' ? '<span class="aid">—</span>' : esc(r.state)}</td>
          <td>${r.ai_rank != null ? '#' + r.ai_rank : '—'}</td>
          <td>${r.trailing_pg ?? '—'}</td><td><b>${r.forward_pg ?? '—'}</b></td>
          <td>${signed(r.delta)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

export async function renderHistory(el) {
  const { events, backtest, grading, stats_season } = await api.history();
  el.innerHTML = `
    <div class="panel"><h2>Accountability</h2>
      <p class="small">Two different questions, and they need different evidence.
        <b>Does the signal predict?</b> is answered by replaying a finished season against itself.
        <b>Did it work for you?</b> is answered by grading the calls this app actually made — which needs
        games to have been played since it made them.</p></div>
    ${backtestSection(backtest, stats_season)}
    ${gradingSection(grading)}
    <div class="panel"><h2>The log</h2>
      <p class="small">Every recommendation recorded with the market state and evidence at the time it was
        made. Append-only — this is the record the grading above reads.</p></div>
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
  const [m, y, s] = await Promise.all([api.meta(), api.yahoo.status(), api.scoring()]);
  el.innerHTML = `
    ${scoringSection(s)}
    ${yahooSection(y)}
    <div class="panel"><h2>Mode: ${m.mode === 'season' ? `Season · Week ${m.week ?? '?'} of ${m.season}` : `Draft prep for ${m.season}`}</h2>
      <p class="small">${m.mode === 'season'
        ? `Analyzing ${m.stats_season} weekly stats (updates all season); early-season trends compare against each player's ${m.baseline_season} baseline. Expert ranks are rest-of-season consensus.`
        : `Analyzing ${m.stats_season} stats for the ${m.season} draft. The app switches to season mode automatically once ${m.season} week-1 stats are published (refresh data after week 1).`}</p>
      <button class="rowbtn mt" id="data-refresh" style="padding:8px 14px">Refresh data now</button>
      <button class="rowbtn mt" id="data-refresh-force" style="padding:8px 14px" title="Ignore cached validators and re-download every source. Only needed if a source republished without changing its ETag.">Force full re-download</button>
      <span class="small" id="data-refresh-status"></span>
      <p class="small mt">${m.auto_refresh?.enabled
        ? `Auto-refresh: on — the server re-checks every source when the data is over 20 hours old${m.auto_refresh.last_attempt ? ` (last auto run ${new Date(m.auto_refresh.last_attempt).toLocaleString()}: ${esc(m.auto_refresh.last_result ?? '…')})` : ' (no auto run yet this session)'}.`
        : 'Auto-refresh: disabled (DVF_NO_AUTO_REFRESH is set).'}</p>
      <p class="small">Each source is asked whether our copy is still current before anything is downloaded. A source
        reported as <b>unchanged</b> answered "still current" and sent no data at all — that is a successful check,
        not a skipped one. Only the play-by-play reduction is version-tracked separately, so a change to its counting
        rules re-derives it even when the file upstream is byte-identical.</p>
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
  const forceBtn = el.querySelector('#data-refresh-force');
  const runRefresh = async (force) => {
    refreshBtn.disabled = forceBtn.disabled = true;
    const status = el.querySelector('#data-refresh-status');
    status.textContent = force ? ' Re-downloading every source…' : ' Checking all sources…';
    try {
      const r = await api.adminRefresh({ force });
      const parts = [`${r.downloaded ?? 0} updated`];
      if (r.unchanged) parts.push(`${r.unchanged} already current (no data transferred)`);
      if (r.failures) parts.push(`${r.failures} failed`);
      status.textContent = ` Done — ${parts.join(', ')}. ${r.mode} mode, stats ${r.stats_season}.`;
      setTimeout(() => refresh?.(), 1500);
    } catch (err) {
      status.textContent = ` Failed: ${err.message}`;
      refreshBtn.disabled = forceBtn.disabled = false;
    }
  };
  refreshBtn.onclick = () => runRefresh(false);
  forceBtn.onclick = () => runRefresh(true);

  const scoringStatus = el.querySelector('#scoring-status');
  const applyScoring = async (body) => {
    scoringStatus.textContent = ' Re-scoring…';
    try {
      const r = await api.setScoring(body);
      scoringStatus.textContent = ` Saved — now scoring as ${PRESET_LABELS[r.preset] ?? r.preset}.`;
      setTimeout(() => refresh?.(), 900);
    } catch (err) {
      scoringStatus.textContent = ` Failed: ${err.message}`;
    }
  };
  el.querySelectorAll('[data-preset]').forEach(b =>
    b.onclick = () => applyScoring({ preset: b.dataset.preset }));

  // Collect the whole grid, not just the visible rows: hidden rare rows are
  // still rendered when open and must not be dropped when they are not.
  const collectRules = () => {
    const rules = {};
    for (const input of el.querySelectorAll('.rule-pts')) {
      (rules[input.dataset.pos] ??= {})[input.dataset.field] = [Number(input.value), 1];
    }
    for (const input of el.querySelectorAll('.rule-per')) {
      const cell = rules[input.dataset.pos]?.[input.dataset.field];
      if (cell) cell[1] = Number(input.value);
    }
    // Rows not currently rendered keep whatever the server already holds.
    for (const pos of s.positions) {
      for (const [key, val] of Object.entries(s.rules[pos] ?? {})) {
        (rules[pos] ??= {})[key] ??= val;
      }
    }
    return rules;
  };
  el.querySelector('#scoring-apply').onclick = () => applyScoring({ preset: 'custom', rules: collectRules() });

  el.querySelectorAll('[data-rare]').forEach(b => b.onclick = () => {
    scoringUi.showRare[b.dataset.rare] = !scoringUi.showRare[b.dataset.rare];
    refresh?.();
  });
  el.querySelectorAll('[data-copy-from]').forEach(b => b.onclick = async () => {
    scoringStatus.textContent = ' Copying…';
    try {
      await api.copyScoring(b.dataset.copyFrom, b.dataset.copyTo);
      setTimeout(() => refresh?.(), 600);
    } catch (err) {
      scoringStatus.textContent = ` Failed: ${err.message}`;
    }
  });
  await wireYahoo(el, refresh ?? (() => renderAbout(el, refresh)));
}
