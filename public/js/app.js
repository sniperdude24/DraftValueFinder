import { renderBoard } from './board.js';
import { renderPlayers } from './players.js';
import { renderTeams } from './teams.js';
import { renderTeam } from './team.js';
import { renderRecs, renderSleepers, renderMarket, renderHistory, renderAbout } from './views.js';
import { renderRoster } from './roster.js';
import { initChat } from './chat.js';
import { api } from './api.js';

const VIEWS = {
  players: renderPlayers,
  teams: renderTeams,
  board: renderBoard,
  team: renderTeam,
  recs: renderRecs,
  sleepers: renderSleepers,
  market: renderMarket,
  history: renderHistory,
  about: renderAbout,
};

let current = 'players';
const viewEl = document.getElementById('view');

async function show(name) {
  current = name;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  viewEl.innerHTML = '<div class="loading">Loading…</div>';
  // Topbar status belongs to whichever view is showing; clear it so one
  // view's text can't linger on another.
  document.getElementById('draft-status').textContent = '';
  try {
    await VIEWS[name](viewEl, () => show(current));
  } catch (err) {
    viewEl.innerHTML = `<div class="warn">Failed to load: ${err.message}</div>`;
  }
  renderRoster(() => show(current)).catch(() => {});
}

document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.view));

// Sticky table headers pin just below the topbar, whose height varies when
// the nav wraps — measure it instead of hardcoding.
const setTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${document.getElementById('topbar').offsetHeight}px`);
setTopbarHeight();
window.addEventListener('resize', setTopbarHeight);

// Yahoo status chip + live board refresh while autosync is running.
async function pollYahoo() {
  const chip = document.getElementById('yahoo-chip');
  try {
    const y = await api.yahoo.status();
    chip.className = y.autosync ? 'on sync' : y.connected ? 'on' : '';
    chip.textContent = !y.configured ? '' : y.autosync ? 'Y! syncing ●' : y.connected ? 'Y! connected' : 'Y! not connected';
    if (y.autosync && ['board', 'players'].includes(current)) show(current);
  } catch { /* server briefly unavailable — chip keeps last state */ }
}
pollYahoo();
setInterval(pollYahoo, 10000);

initChat();
show('players');
