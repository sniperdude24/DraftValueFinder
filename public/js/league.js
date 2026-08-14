// League page — every team's roster, editable without going near the draft.
//
// The draft board is one way to fill these rosters; it is not the only way,
// and in season mode it is the wrong one. Teams can be named, players
// assigned or dropped, and whole rosters pasted in.
import { api, esc } from './api.js';
import { openProfile } from './profile.js';
import { assignSlots } from './lineup.js';
import { rosterTableHtml, wireRosterTable } from './rosterTable.js';

const state = { open: null, paste: {}, faPaste: '' };

// The free-agent paste is the one control here with league-wide consequences:
// everything NOT in the list becomes "rostered by somebody". So it says what it
// is about to do to the other 240-odd players before it does it.
function freeAgentPanel(lg) {
  const fa = lg.free_agent_pool;
  const age = fa?.as_of ? Math.floor((Date.now() - Date.parse(fa.as_of)) / 86400000) : null;
  const stale = age == null || age > 7;
  return `
    <div class="panel">
      <div class="roster-head"><h2>Who's available</h2>
        <span class="aid">${fa
          ? `${fa.count} free agents · pasted ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}`
          : 'never pasted'}</span></div>
      ${stale ? `<div class="warn" style="font-size:12px">${fa
        ? `This list is ${age} days old. Waivers clear weekly, so some of these are probably gone.`
        : 'The app does not know who is actually available, so every pickup suggestion is drawn from "nobody has claimed them here" — which is not the same thing.'}</div>` : ''}
      <p class="small">Paste Yahoo's available-players list (filter to <b>Available</b>, then copy the names).
        Everyone in the list is marked free; everyone else the app knows about is marked
        <b>rostered by somebody</b>. Teams you have already recorded are left alone — this never
        overwrites a roster you have filled in.</p>
      <textarea class="paste-box" id="fa-paste" rows="4"
        placeholder="One name per line, or comma separated. Positions, teams and (BYE) are ignored.">${esc(state.faPaste)}</textarea>
      <button class="rowbtn" id="fa-check">Check names</button>
      <div class="paste-result small" id="fa-result"></div>
    </div>`;
}

function playerLine(p, teamId) {
  return `<div class="slot filled pos-${esc(p.position)}-tint">
    <span class="poschip pos-${esc(p.position)}">${esc(p.position)}</span>
    <span class="who">
      <span class="clickable" data-id="${esc(p.id)}">${esc(p.name)}</span>
      <span class="aid">${esc(p.team ?? 'FA')} · bye ${p.bye ?? '?'}${p.injury_status ? ` · ${esc(p.injury_status)}` : ''}</span>
    </span>
    ${p.pick_number ? `<span class="roundchip" title="Pick #${p.pick_number}">#${p.pick_number}</span>` : ''}
    <button class="drop" data-drop="${esc(p.id)}" data-from="${esc(teamId)}" title="Remove from this roster">✕</button>
  </div>`;
}

function teamCard(t, open, ctx) {
  const { filled } = assignSlots(t.players);
  const starters = filled.filter(s => s.player).length;
  return `
    <div class="panel team-card ${t.mine ? 'my-team-card' : ''}">
      <div class="roster-head">
        <input class="team-name" data-rename="${esc(t.id)}" value="${esc(t.name)}" maxlength="40">
        <label class="small" title="Which roster is yours — drives My Team, the sidebar and every roster-aware recommendation">
          <input type="radio" name="mine" data-mine="${esc(t.id)}" ${t.mine ? 'checked' : ''}> mine
        </label>
        <span class="aid">${t.count} players · ${starters}/${filled.length} starters</span>
        <button class="rowbtn" data-toggle="${esc(t.id)}">${open ? 'Hide' : 'Show'}</button>
      </div>
      ${t.warnings.length ? t.warnings.map(w => `<div class="warn" style="font-size:12px">${esc(w)}</div>`).join('') : ''}
      ${open ? `
        <div data-grid="${esc(t.id)}">${rosterTableHtml(t.players, { ...ctx, key: t.id, onDrop: true })}</div>
        ${t.needs.length ? `<p class="small mt">Still needs: ${t.needs.map(n => `${n.missing}× ${esc(n.position)}`).join(', ')}</p>` : ''}
        <div class="mt">
          <textarea class="paste-box" data-paste="${esc(t.id)}" rows="3"
            placeholder="Paste a roster — one name per line, or comma separated. Pick numbers, positions and (TEAM) are ignored.">${esc(state.paste[t.id] ?? '')}</textarea>
          <button class="rowbtn" data-preview="${esc(t.id)}">Check names</button>
          <button class="rowbtn" data-clear="${esc(t.id)}">Clear roster</button>
          <div class="paste-result small" data-result="${esc(t.id)}"></div>
        </div>` : ''}
    </div>`;
}

export async function renderLeague(el, refresh) {
  const lg = await api.league();
  document.getElementById('draft-status').textContent =
    `${lg.team_count} teams · ${lg.free_agents} free agents`;

  const ctx = { mode: lg.mode, statsSeason: lg.stats_season, baselineSeason: lg.baseline_season };
  const onDrop = async id => { await api.setOwner(id, null); refresh(); };

  el.innerHTML = `
    <div class="panel">
      <h2>League rosters</h2>
      <p class="small">Who actually holds each player. Rename a team by typing over its name; the radio marks
        which roster is yours, which is what My Team, the sidebar and every roster-aware recommendation follow.
        Rosters over ${lg.roster_limit} players are flagged, never blocked.</p>
    </div>
    ${freeAgentPanel(lg)}
    ${lg.unknown_owner.length ? `<div class="panel">
      <div class="roster-head"><h2>Taken — owner unknown</h2><span class="aid">${lg.unknown_owner.length} players</span></div>
      <p class="small">These were marked as drafted before the app tracked which team took them, so their owner
        genuinely was not recorded. Assign them from the Players page or the draft board — they are listed here
        rather than guessed at.</p>
      ${lg.unknown_owner.map(p => playerLine(p, 'unknown')).join('')}
    </div>` : ''}
    ${lg.teams.map(t => teamCard(t, state.open === t.id, ctx)).join('')}`;

  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    state.open = state.open === b.dataset.toggle ? null : b.dataset.toggle;
    refresh();
  });
  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
  el.querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    await api.setOwner(b.dataset.drop, null);
    refresh();
  });

  // Each open team card owns its own week/range state, so two cards can sit
  // on different weeks at once.
  for (const t of lg.teams) {
    const grid = el.querySelector(`[data-grid="${t.id}"]`);
    if (grid) wireRosterTable(grid, { ...ctx, key: t.id, players: t.players, onDrop }, refresh);
  }

  const saveTeams = async () => {
    const teams = lg.teams.map(t => ({
      id: t.id,
      name: el.querySelector(`[data-rename="${t.id}"]`)?.value ?? t.name,
      mine: el.querySelector(`[data-mine="${t.id}"]`)?.checked ?? t.mine,
    }));
    await api.setTeams(teams);
    refresh();
  };
  el.querySelectorAll('[data-rename]').forEach(i => { i.onchange = saveTeams; });
  el.querySelectorAll('[data-mine]').forEach(r => { r.onchange = saveTeams; });

  el.querySelectorAll('[data-paste]').forEach(t => {
    t.oninput = () => { state.paste[t.dataset.paste] = t.value; };
  });

  // ---- free-agent list ----
  const faBox = el.querySelector('#fa-paste');
  faBox.oninput = () => { state.faPaste = faBox.value; };
  el.querySelector('#fa-check').onclick = async () => {
    const out = el.querySelector('#fa-result');
    if (!state.faPaste.trim()) { out.textContent = 'Nothing pasted yet.'; return; }
    const r = await api.freeAgents(state.faPaste, false);
    out.innerHTML = `
      <div class="mt"><b>${r.matched.length} matched</b> — these become free agents.</div>
      <div class="warn" style="font-size:12px">The other <b>${r.would_mark_rostered}</b> players the app
        tracks will be marked as rostered by somebody. Rosters you have already recorded are not changed.</div>
      ${r.unmatched.length ? `<div class="small mt">${r.unmatched.length} not found: ${r.unmatched.map(esc).join(', ')}
        <span class="aid">— outside the top-250 universe, or a spelling the matcher missed. Reported rather than dropped.</span></div>` : ''}
      ${r.ambiguous.length ? `<div class="warn" style="font-size:12px">${r.ambiguous.length} ambiguous:
        ${r.ambiguous.map(a => `${esc(a.input)} (${a.candidates.map(c => esc(c.position)).join('/')})`).join(', ')}
        — assign these individually.</div>` : ''}
      <button class="rowbtn mine mt" id="fa-commit">Apply — ${r.matched.length} free, ${r.would_mark_rostered} rostered</button>`;
    out.querySelector('#fa-commit').onclick = async () => {
      await api.freeAgents(state.faPaste, true);
      state.faPaste = '';
      refresh();
    };
  };

  // Two-step on purpose: resolve and show first, write only on confirm, so
  // nothing lands on a roster while names are still unmatched or ambiguous.
  el.querySelectorAll('[data-preview]').forEach(b => b.onclick = async () => {
    const teamId = b.dataset.preview;
    const box = el.querySelector(`[data-result="${teamId}"]`);
    const text = state.paste[teamId] ?? '';
    if (!text.trim()) { box.textContent = 'Nothing pasted yet.'; return; }
    const r = await api.bulkRoster(teamId, text, false);
    box.innerHTML = `
      <div class="mt"><b>${r.matched.length} matched</b>${r.matched.length ? `: ${r.matched.map(m => esc(m.name)).join(', ')}` : ''}</div>
      ${r.unmatched.length ? `<div class="warn" style="font-size:12px">${r.unmatched.length} not found: ${r.unmatched.map(esc).join(', ')} — check the spelling, or they may be outside the top-250 universe.</div>` : ''}
      ${r.ambiguous.length ? `<div class="warn" style="font-size:12px">${r.ambiguous.length} ambiguous: ${r.ambiguous.map(a => `${esc(a.input)} (${a.candidates.map(c => esc(c.position)).join('/')})`).join(', ')} — assign these individually.</div>` : ''}
      ${r.matched.length ? `<button class="rowbtn mine mt" data-commit="${esc(teamId)}">Add ${r.matched.length} to this roster</button>` : ''}`;
    const commit = box.querySelector('[data-commit]');
    if (commit) commit.onclick = async () => {
      await api.bulkRoster(teamId, text, true);
      state.paste[teamId] = '';
      refresh();
    };
  });

  el.querySelectorAll('[data-clear]').forEach(b => b.onclick = async () => {
    if (confirm('Remove every player from this roster?')) {
      await api.resetRoster(b.dataset.clear);
      refresh();
    }
  });
}
