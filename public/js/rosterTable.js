// The roster stat grid, shared by My Team and every League team card.
//
// One implementation, two callers — the same reason owners.js exists. A
// roster laid out one way on My Team and another way on League is two things
// to keep correct and two places to fix a column.
//
// The aggregation itself lives in src/analyze/rosterTable.js and is tested
// there; this file is layout, plus three display rules worth stating:
//
//  - A blank is not a zero. A week the player has no row for renders as BYE
//    or "no game", never as a line of noughts.
//  - Fan Pts is the user's own scoring. Proj Pts is Sleeper's, PPR, for one
//    week only, and is labelled as external wherever it appears.
//  - Column headers are short because the group header above them carries the
//    context; the full name is on the title attribute.
import { esc } from './api.js';
import { openProfile } from './profile.js';
import { assignSlots } from './lineup.js';
import {
  COLUMN_GROUPS, UNAVAILABLE_COLUMNS, statLineFor, projectionFor,
  weeksAvailable, defaultRange, describeField,
} from '/shared/rosterTable.js';   // the same module the server and tests use

// Per-table view state (which range, which week), keyed by the caller's id so
// several team cards can be open at once without sharing a week stepper.
const views = new Map();

export function viewFor(key, { mode, weeks }) {
  if (!views.has(key)) {
    const range = defaultRange(mode, weeks);
    views.set(key, { range, week: weeks.length ? weeks[weeks.length - 1] : null });
  }
  return views.get(key);
}

const num = v => (v == null ? '<span class="aid">—</span>' : String(v));

function rangeLabel(range, { statsSeason, baselineSeason }) {
  if (range === 'week') return 'Week';
  if (range === 'last4') return 'Last 4 Weeks';
  if (range === 'season') return `${statsSeason} Season`;
  return baselineSeason ? `${baselineSeason} Season` : 'Prior Season';
}

// "Final W 42-38 vs CHI" — every part of it from the schedules snapshot. With
// no result the line falls back to the matchup alone rather than inventing an
// outcome.
function gameLine(g) {
  if (!g) return '';
  const r = g.game_result;
  // `g.opponent` is the single home for who they played; `game_result` adds
  // only what the schedule alone knows (home/away, the score, the outcome).
  const matchup = `${r?.at ?? false ? '@' : 'vs'} ${esc(g.opponent ?? '')}`;
  if (!r) return `<span class="aid">wk ${g.week} ${matchup}</span>`;
  const cls = r.outcome === 'W' ? 'trend-up' : r.outcome === 'L' ? 'trend-down' : 'trend-flat';
  return `<span class="aid">Final <span class="${cls}">${r.outcome}</span> ${r.team_score}-${r.opp_score} ${matchup}</span>`;
}

function basisLine(line, view, seasons) {
  if (!line) return '';
  if (line.basis === 'game') return gameLine(line.game);
  if (line.basis === 'average') {
    // Said out loud because the column headers read like totals everywhere
    // else in this table — and because a threshold bonus cannot be recovered
    // from an average, so Fan Pts here genuinely leaves milestones out.
    return `<span class="aid" title="Only per-game averages are stored for this season, so game-milestone bonuses are excluded from Fan Pts here">${line.games ?? '?'}-game per-game avg · milestones excluded</span>`;
  }
  const w = line.weeks;
  const span = w.length > 1 ? `wk ${w[0]}–${w[w.length - 1]}` : `wk ${w[0]}`;
  return `<span class="aid">${line.games} game${line.games === 1 ? '' : 's'} · ${span} · totals</span>`;
}

function playerCell(p) {
  // My Team sends the whole player record; League sends a slimmed row with
  // the same facts flattened. Read both shapes rather than forcing one.
  const sid = p.meta?.sleeper_id ?? p.sleeper_id ?? null;
  const inj = p.meta?.injury_status ?? p.injury_status ?? null;
  return `
    ${sid ? `<img class="headshot" loading="lazy" alt="" src="https://sleepercdn.com/content/nfl/players/${encodeURIComponent(sid)}.jpg">` : ''}
    <span class="who">
      <span class="clickable" data-id="${esc(p.id)}">${esc(p.name)}</span>
      ${inj ? `<span class="badge inj">${esc(inj)}</span>` : ''}
      <span class="aid">${esc(p.team ?? 'FA')}</span>
    </span>`;
}

const STAT_COLS = COLUMN_GROUPS.flatMap(g => g.columns);

function row(slotLabel, slotPos, p, view, ctx) {
  if (!p) {
    return `<tr class="open-slot">
      <td><span class="poschip pos-${esc(slotPos === 'FLEX' ? 'FLEX' : slotPos)}">${esc(slotLabel)}</span></td>
      <td colspan="${3 + STAT_COLS.length + (ctx.onDrop ? 1 : 0)}" class="small" style="font-style:italic;color:var(--dim)">open slot</td>
    </tr>`;
  }

  const line = statLineFor(p, view.range, { week: view.week });
  const proj = projectionFor(p, view.range, { week: view.week });
  const head = `
    <td><span class="poschip pos-${esc(p.position)}">${esc(slotLabel)}</span></td>
    <td class="offense">${playerCell(p)}<div class="gameline">${line ? basisLine(line, view, ctx) : ''}</div></td>
    <td>${p.bye ?? '<span class="aid">—</span>'}</td>`;
  const tail = ctx.onDrop
    ? `<td><button class="drop" data-drop="${esc(p.id)}" title="Remove from this roster">✕</button></td>` : '';

  // No line for this range: say why rather than filling the row with zeros.
  if (!line) {
    const why = view.range === 'week' && p.bye === view.week ? 'BYE'
      : view.range === 'week' ? 'no game'
      : 'no data';
    return `<tr class="no-line">${head}
      <td colspan="${2 + STAT_COLS.length}" class="small" style="color:var(--dim)">${why}</td>${tail}</tr>`;
  }

  return `<tr>${head}
    <td><b>${line.points == null ? '<span class="aid">—</span>' : line.points}</b></td>
    <td>${proj ? proj.pts_ppr : '<span class="aid">—</span>'}</td>
    ${STAT_COLS.map(([key]) => `<td>${num(line.stats[key])}</td>`).join('')}
    ${tail}</tr>`;
}

/**
 * @param players roster in slot order
 * @param ctx { key, mode, statsSeason, baselineSeason, onDrop }
 */
export function rosterTableHtml(players, ctx) {
  const weeks = weeksAvailable(players);
  const view = viewFor(ctx.key, { mode: ctx.mode, weeks });
  const { filled, bench } = assignSlots(players);
  const actionCols = ctx.onDrop ? 1 : 0;
  const idx = weeks.indexOf(view.week);

  // A range with nothing behind it is offered as a disabled chip rather than
  // as a button that opens an empty table: in draft mode the stats season IS
  // last season, so there is no earlier baseline to show.
  const hasBaseline = players.some(p => p.baseline?.components);
  const chips = ['week', 'last4', 'season', 'prior'].map(r => {
    const disabled = (r === 'week' && !weeks.length) || (r === 'prior' && !hasBaseline);
    const why = disabled && r === 'prior' ? 'No earlier season stored — the stats season already is last season'
      : disabled ? 'No weekly data yet' : '';
    return `<button class="posbtn ${view.range === r ? 'active' : ''}" data-range="${r}"
      ${disabled ? 'disabled' : ''} title="${esc(why)}">${esc(rangeLabel(r, ctx))}</button>`;
  }).join('');

  const groupRow = `<tr>
    <th rowspan="2">Pos</th><th rowspan="2">Offense</th><th rowspan="2">Bye</th>
    <th colspan="2">Fantasy</th>
    ${COLUMN_GROUPS.map(g => `<th colspan="${g.columns.length}">${esc(g.group)}</th>`).join('')}
    ${actionCols ? '<th rowspan="2"></th>' : ''}
  </tr>`;
  const colRow = `<tr>
    <th title="Scored with your league's rules">Fan Pts</th>
    <th title="Sleeper weekly projection — external source, PPR">Proj Pts</th>
    ${STAT_COLS.map(([key, label]) => `<th title="${esc(describeField(key))}">${esc(label)}</th>`).join('')}
  </tr>`;

  return `
    <div class="grid-controls">
      ${view.range === 'week' ? `
        <span class="weeknav">
          <button class="rowbtn" data-step="-1" ${idx <= 0 ? 'disabled' : ''}>‹</button>
          <b>Week ${view.week ?? '—'}</b>
          <button class="rowbtn" data-step="1" ${idx < 0 || idx >= weeks.length - 1 ? 'disabled' : ''}>›</button>
        </span>` : ''}
      ${chips}
    </div>
    <div class="grid-scroll">
      <table class="roster-grid">
        <thead>${groupRow}${colRow}</thead>
        <tbody>
          ${filled.map(s => row(s.label, s.pos, s.player, view, ctx)).join('')}
          ${bench.length ? `<tr><td colspan="${5 + STAT_COLS.length + actionCols}" class="bench-label" style="border-bottom:none">Bench</td></tr>` : ''}
          ${bench.map(p => row('BN', p.position, p, view, ctx)).join('')}
        </tbody>
      </table>
    </div>
    <p class="small mt">Fan Pts uses your scoring rules. Proj Pts is an external Sleeper projection (PPR) and
      appears only on the week it was published for. Stats are nflverse; results and scores are the nflverse
      schedule. Not shown, because no source here carries them:
      ${UNAVAILABLE_COLUMNS.map(([name, why]) => `<b>${esc(name)}</b> — ${esc(why)}`).join('; ')}.</p>`;
}

// Wire one rendered table. `root` is the element containing it; `refresh`
// re-renders the page the same way every other view here does.
export function wireRosterTable(root, ctx, refresh) {
  const weeks = weeksAvailable(ctx.players ?? []);
  const view = viewFor(ctx.key, { mode: ctx.mode, weeks });

  root.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    view.range = b.dataset.range;
    if (view.range === 'week' && view.week == null && weeks.length) view.week = weeks[weeks.length - 1];
    refresh();
  });
  root.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const i = weeks.indexOf(view.week) + Number(b.dataset.step);
    if (i >= 0 && i < weeks.length) { view.week = weeks[i]; refresh(); }
  });
  root.querySelectorAll('.roster-grid [data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
  // A headshot that will not load leaves nothing behind, so the row degrades
  // to the layout it would have had without one (offline, or a player the CDN
  // has no image for).
  root.querySelectorAll('img.headshot').forEach(img => { img.onerror = () => img.remove(); });
  if (ctx.onDrop) {
    root.querySelectorAll('.roster-grid [data-drop]').forEach(b => b.onclick = () => ctx.onDrop(b.dataset.drop));
  }
}
