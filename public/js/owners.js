// One owner control, shared by the draft board and the Players explorer.
// Having a single implementation is the point: two copies would drift the
// moment the team list gains an option.
import { api, esc } from './api.js';

export const UNKNOWN_OWNER = 'unknown';

// `ownerId` is a team id, the unknown sentinel, or null for a free agent.
export function ownerSelect(playerId, ownerId, teams) {
  const opt = (value, label) =>
    `<option value="${esc(value)}" ${(ownerId ?? '') === value ? 'selected' : ''}>${esc(label)}</option>`;
  return `<select class="ownersel" data-owner-for="${esc(playerId)}" title="Which league team holds this player">
    ${opt('', 'Free agent')}
    ${teams.map(t => opt(t.id, t.mine ? `${t.name} (me)` : t.name)).join('')}
    ${opt(UNKNOWN_OWNER, 'Taken — unknown')}
  </select>`;
}

// Wire every owner select inside `el`. `onDone` is called after a successful
// write so the caller can re-render.
export function wireOwnerSelects(el, onDone) {
  el.querySelectorAll('.ownersel').forEach(sel => {
    sel.onchange = async () => {
      const prev = sel.dataset.prev ?? '';
      sel.disabled = true;
      try {
        await api.setOwner(sel.dataset.ownerFor, sel.value === '' ? null : sel.value);
        onDone?.();
      } catch (err) {
        // Put the control back where it was rather than showing an owner
        // the server did not accept.
        sel.value = prev;
        sel.disabled = false;
        alert(`Could not set owner: ${err.message}`);
      }
    };
    sel.dataset.prev = sel.value;
  });
}

export function ownerLabel(ownerId, teams) {
  if (!ownerId) return 'Free agent';
  if (ownerId === UNKNOWN_OWNER) return 'Taken — unknown';
  return teams.find(t => t.id === ownerId)?.name ?? ownerId;
}
