import { api, esc } from './api.js';

const history = [];

export function initChat() {
  const panel = document.getElementById('chat-panel');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');

  document.getElementById('chat-toggle').onclick = () => { panel.classList.toggle('hidden'); input.focus(); };
  document.getElementById('chat-close').onclick = () => panel.classList.add('hidden');

  const add = (role, text, note) => {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.innerHTML = esc(text) + (note ? `<span class="srcnote">${esc(note)}</span>` : '');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };

  form.onsubmit = async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    add('user', q);
    const pending = add('ai', '…');
    try {
      const res = await api.chat(q, history);
      pending.remove();
      add('ai', res.text, res.note ?? (res.source === 'claude' ? `answered by ${res.model ?? 'Claude'}` : null));
      history.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
      if (history.length > 20) history.splice(0, history.length - 20);
    } catch (err) {
      pending.remove();
      add('ai', `Error: ${err.message}`);
    }
  };
}
