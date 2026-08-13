import { renderBoard } from './board.js';
import { renderRecs, renderSleepers, renderMarket, renderHistory, renderAbout } from './views.js';
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
}

document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.view));
initChat();
show('board');
