// League page — every team's roster, editable without going near the draft.
//
// The draft board is one way to fill these rosters; it is not the only way,
// and in season mode it is the wrong one. Teams can be named, players
// assigned or dropped, and whole rosters pasted in.
import { api, esc } from './api.js';
import { openProfile } from './profile.js';
import { assignSlots } from './lineup.js';

const state = { open: null, paste: {} };

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

function teamCard(t, open) {
  const { filled, bench } = assignSlots(t.players);
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
        ${filled.map(s => s.player
          ? playerLine(s.player, t.id)
          : `<div class="slot open"><span class="poschip pos-${esc(s.pos === 'FLEX' ? 'FLEX' : s.pos)}">${esc(s.label)}</span><span class="who empty">open</span></div>`).join('')}
        ${bench.length ? `<div class="bench-label">Bench (${bench.length})</div>${bench.map(p => playerLine(p, t.id)).join('')}` : ''}
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

  el.innerHTML = `
    <div class="panel">
      <h2>League rosters</h2>
      <p class="small">Who actually holds each player. Rename a team by typing over its name; the radio marks
        which roster is yours, which is what My Team, the sidebar and every roster-aware recommendation follow.
        Rosters over ${lg.roster_limit} players are flagged, never blocked.</p>
    </div>
    ${lg.unknown_owner.length ? `<div class="panel">
      <div class="roster-head"><h2>Taken — owner unknown</h2><span class="aid">${lg.unknown_owner.length} players</span></div>
      <p class="small">These were marked as drafted before the app tracked which team took them, so their owner
        genuinely was not recorded. Assign them from the Players page or the draft board — they are listed here
        rather than guessed at.</p>
      ${lg.unknown_owner.map(p => playerLine(p, 'unknown')).join('')}
    </div>` : ''}
    ${lg.teams.map(t => teamCard(t, state.open === t.id)).join('')}`;

  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    state.open = state.open === b.dataset.toggle ? null : b.dataset.toggle;
    refresh();
  });
  el.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openProfile(x.dataset.id, refresh));
  el.querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    await api.setOwner(b.dataset.drop, null);
    refresh();
  });

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
