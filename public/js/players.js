// Players explorer — the season platform's main surface.
//
// Every metric shown is measured from real game logs (nflverse), never
// projected or invented. Rate stats come from window totals; share stats
// (target share, air-yards share, WOPR) are per-game averages. See
// src/analyze/playerStats.js for the rules.
import { api, esc, trendArrow, signalBadge } from './api.js';
import { openProfile } from './profile.js';
import { sortRows, headerCells, wireSort, wireSearch } from './table.js';

// key -> [label, format, tooltip]
const METRICS = {
  games: ['G', 'int', 'Games played in the window'],
  snap_pct: ['Snap%', 'pct', 'Share of team offensive snaps (per-game average)'],
  opportunities_pg: ['Opp/g', 'n1', 'Targets + carries per game'],
  targets_pg: ['Tgt/g', 'n1', 'Targets per game'],
  target_share: ['Tgt Sh', 'pct', 'Share of the team\'s targets (per-game average)'],
  air_yards_share: ['AY Sh', 'pct', 'Share of the team\'s air yards (per-game average)'],
  wopr: ['WOPR', 'n2', 'Weighted Opportunity Rating: 1.5×target share + 0.7×air-yards share'],
  air_yards_pg: ['AirYd/g', 'n1', 'Receiving air yards per game'],
  rec_pg: ['Rec/g', 'n1', 'Receptions per game'],
  rec_yards_pg: ['RecYd/g', 'n1', 'Receiving yards per game'],
  yards_per_target: ['Y/Tgt', 'n2', 'Receiving yards ÷ targets (window totals)'],
  catch_rate: ['Catch%', 'pct', 'Receptions ÷ targets (window totals)'],
  yac_per_reception: ['YAC/Rec', 'n2', 'Yards after catch per reception'],
  carries_pg: ['Car/g', 'n1', 'Carries per game'],
  rush_yards_pg: ['RushYd/g', 'n1', 'Rushing yards per game'],
  yards_per_carry: ['Y/Car', 'n2', 'Rushing yards ÷ carries (window totals)'],
  pass_yards_pg: ['PassYd/g', 'n1', 'Passing yards per game'],
  yards_per_attempt: ['Y/Att', 'n2', 'Passing yards ÷ attempts (window totals)'],
  cpoe: ['CPOE', 'n2', 'Completion percentage over expected'],
  first_downs_pg: ['1D/g', 'n1', 'First downs generated per game'],
  explosive_total: ['20+', 'int', 'Plays of 20+ yards in the window'],
  epa_per_play: ['EPA/play', 'n3', 'Expected points added per play'],
  // Labelled "Pts", not "PPR": scoring is configurable on the Data page, so
  // naming the format here would be wrong for anyone who changed it.
  ppr_pg: ['Pts/g', 'n1', 'Fantasy points per game under your scoring settings'],
  ppr_per_opportunity: ['Pts/Opp', 'n2', 'Fantasy points per target or carry — efficiency of usage'],
  racr: ['RACR', 'n2', 'Receiving yards ÷ air yards'],
  tds_total: ['TD', 'int', 'Total touchdowns in the window'],

  // Red zone (nflverse play-by-play). Counting stats lead and rates follow,
  // because red-zone samples are small enough that a rate without its
  // denominator beside it is misleading.
  rz_opportunities: ['RZ Opp', 'int', 'Targets + carries inside the 20'],
  rz_opportunities_pg: ['RZ Opp/g', 'n1', 'Red-zone targets + carries per game'],
  rz_targets: ['RZ Tgt', 'int', 'Targets inside the 20'],
  rz_carries: ['RZ Car', 'int', 'Carries inside the 20'],
  gl_opportunities: ['GL Opp', 'int', 'Targets + carries inside the 5 — the highest-leverage touches on the field'],
  gl_carries: ['GL Car', 'int', 'Carries inside the 5'],
  rz_tds: ['RZ TD', 'int', 'Touchdowns scored from inside the 20'],
  rz_td_rate: ['RZ TD%', 'pct', 'Touchdowns ÷ red-zone opportunities — read it next to RZ Opp, small samples swing wildly'],
  rz_share_of_own_opportunities: ['RZ%Own', 'pct', 'Share of this player\'s own touches that come inside the 20'],
};

const PRESETS = {
  Overview: ['games', 'snap_pct', 'opportunities_pg', 'wopr', 'ppr_pg', 'ppr_per_opportunity', 'epa_per_play'],
  Receiving: ['games', 'targets_pg', 'target_share', 'air_yards_share', 'wopr', 'air_yards_pg', 'rec_pg', 'rec_yards_pg', 'yards_per_target', 'catch_rate', 'yac_per_reception'],
  Rushing: ['games', 'carries_pg', 'rush_yards_pg', 'yards_per_carry', 'first_downs_pg', 'explosive_total', 'ppr_pg'],
  'Red zone': ['games', 'rz_opportunities', 'rz_opportunities_pg', 'rz_targets', 'rz_carries', 'gl_opportunities', 'gl_carries', 'rz_tds', 'rz_td_rate', 'rz_share_of_own_opportunities'],
  Passing: ['games', 'pass_yards_pg', 'yards_per_attempt', 'cpoe', 'epa_per_play', 'tds_total', 'ppr_pg'],
  Efficiency: ['games', 'yards_per_target', 'yards_per_carry', 'catch_rate', 'ppr_per_opportunity', 'epa_per_play', 'racr', 'yac_per_reception'],
};

const WINDOWS = [['season', 'Full season'], ['last3', 'Last 3 games'], ['last1', 'Last game']];

const state = { pos: 'ALL', search: '', preset: 'Overview', window: null, minGames: 3, sort: 'ppr_pg', dir: -1 };

function fmt(v, kind) {
  if (v == null) return '<span class="aid">—</span>';
  if (kind === 'pct') return `${Math.round(v * 100)}%`;
  if (kind === 'int') return String(v);
  if (kind === 'n1') return v.toFixed(1);
  if (kind === 'n2') return v.toFixed(2);
  if (kind === 'n3') return v.toFixed(3);
  return String(v);
}

export async function renderPlayers(el, refresh) {
  const { players, mode, week, stats_season } = await api.players();
  if (state.window == null) state.window = mode === 'season' ? 'last3' : 'season';

  const withData = players.filter(p => p.windows.season).length;
  document.getElementById('draft-status').textContent =
    `${stats_season} stats${mode === 'season' ? ` · week ${week ?? '?'}` : ''} · ${withData} players with game data`;

  const metricKeys = PRESETS[state.preset];
  const cols = [['name', 'Player'], ...metricKeys.map(k => [k, METRICS[k][0]]), ['ai_rank', 'AI'], ['usage_trend', 'Trend']];

  // Value accessor: metric keys read from the selected window, everything
  // else from the row itself.
  const valueOf = (row, key) => {
    if (key === 'name') return row.name.toLowerCase();
    if (METRICS[key]) return row.windows[state.window]?.[key] ?? null;
    if (key === 'usage_trend') return { rising: 4, 'mixed-up': 3, flat: 2, 'mixed-down': 1, falling: 0 }[row.usage_trend] ?? null;
    return row[key] ?? null;
  };

  const rows = sortRows(
    players
      .filter(p => state.pos === 'ALL' || p.position === state.pos)
      .filter(p => (p.windows[state.window]?.games ?? 0) >= state.minGames),
    state, valueOf);

  el.innerHTML = `
    <div class="toolbar">
      ${['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => `<button class="posbtn ${state.pos === p ? 'active' : ''}" data-pos="${p}">${p}</button>`).join('')}
      <select id="pl-window" title="Which games to measure">${WINDOWS.map(([k, l]) => `<option value="${k}" ${state.window === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="pl-preset" title="Which metrics to show">${Object.keys(PRESETS).map(p => `<option ${state.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <label title="Hide small samples — efficiency leaders are meaningless off one game">Min games <input type="number" id="pl-mingames" min="1" max="17" value="${state.minGames}" style="width:52px"></label>
      <input type="search" id="pl-search" placeholder="Search player…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="small">${rows.length} players</span>
    </div>
    <table>
      <thead><tr>${headerCells(cols, state)}</tr></thead>
      <tbody>
        ${rows.map(p => {
          const w = p.windows[state.window];
          return `<tr>
            <td class="name" data-id="${esc(p.id)}">${esc(p.name)}<span class="team">${esc(p.position)} · ${esc(p.team ?? 'FA')}</span>
              ${p.injury_status ? `<span class="badge inj">${esc(p.injury_status)}</span>` : ''}
              ${signalBadge(p.sleeper_state)}
              ${p.mine ? '<span class="badge newteam">MY TEAM</span>' : ''}</td>
            ${metricKeys.map(k => `<td>${fmt(w?.[k] ?? null, METRICS[k][1])}</td>`).join('')}
            <td>${p.ai_rank ?? '<span class="aid">—</span>'}</td>
            <td>${trendArrow(p.usage_trend)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="small mt">Measured from ${stats_season} game logs (nflverse) — nothing here is projected. Rate stats (Y/Tgt, Y/Car, Catch%) come from window totals; share stats (Tgt Sh, AY Sh, WOPR) are per-game averages. Hover a column header for its definition. Click a player for the full profile.
      ${state.preset === 'Red zone' ? '<br>Red-zone columns are counted from nflverse play-by-play: inside the 20 for RZ, inside the 5 for GL. A blank means the play-by-play source has not covered those games, not a zero.' : ''}</p>`;

  // Column tooltips
  el.querySelectorAll('th[data-sort]').forEach(th => {
    const m = METRICS[th.dataset.sort];
    if (m) th.title = m[2];
  });

  el.querySelectorAll('.posbtn').forEach(b => b.onclick = () => { state.pos = b.dataset.pos; refresh(); });
  el.querySelector('#pl-window').onchange = e => { state.window = e.target.value; refresh(); };
  el.querySelector('#pl-preset').onchange = e => {
    state.preset = e.target.value;
    // Sorting by a column the new preset doesn't show leaves the table in a
    // seemingly arbitrary order — fall back to its leading metric.
    const keys = PRESETS[state.preset];
    if (!keys.includes(state.sort) && state.sort !== 'name') {
      state.sort = keys.find(k => k !== 'games') ?? 'name';
      state.dir = -1;
    }
    refresh();
  };
  el.querySelector('#pl-mingames').onchange = e => { state.minGames = Math.max(1, Number(e.target.value) || 1); refresh(); };
  wireSearch(el.querySelector('#pl-search'), state, el);
  wireSort(el, state, refresh);
  el.querySelectorAll('td.name').forEach(td => td.onclick = () => openProfile(td.dataset.id, refresh));
}
