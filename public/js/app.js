import { renderBoard } from './board.js';
import { renderRecs, renderSleepers, renderMarket, renderHistory, renderAbout } from './views.js';
import { renderRoster } from './roster.js';
import { initChat } from './chat.js';

const VIEWS = {
  board: renderBoard,
  recs: renderRecs,
  sleepers: renderSleepers,
  market: renderMarket,
  history: renderHistory,
  about: renderAbout,
};

let current = 'board';
const viewEl = document.getElementById('view');

async function show(name) {
  current = name;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  viewEl.innerHTML = '<div class="loading">Loading…</div>';
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

initChat();
show('board');
