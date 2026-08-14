// Shared sortable/filterable table machinery, used by the players explorer
// and the draft board so there is one implementation rather than two.
//
// Null handling is deliberate: missing values sort LAST in both directions.
// Sorting by WOPR descending should lead with the highest WOPR, not with the
// players who have no WOPR at all.
export function sortRows(rows, state, valueOf) {
  return [...rows].sort((a, b) => {
    const va = valueOf(a, state.sort), vb = valueOf(b, state.sort);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
  });
}

// cols: [key, label] pairs. Keys in `unsortable` render as plain headers.
export function headerCells(cols, state, unsortable = []) {
  return cols.map(([key, label]) => unsortable.includes(key)
    ? `<th>${label}</th>`
    : `<th data-sort="${key}" title="Sort by ${label}">${label}${state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : ''}</th>`
  ).join('');
}

// firstClickDir decides the direction when a NEW column is selected.
// Stats read best high-first (-1); rank columns read best low-first (1),
// so each view supplies its own convention.
export function wireSort(el, state, rerender, { firstClickDir = key => (key === 'name' ? 1 : -1) } = {}) {
  el.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (state.sort === k) state.dir *= -1;
    else { state.sort = k; state.dir = firstClickDir(k); }
    rerender();
  });
}

// Filters rows in place without re-rendering, so the input keeps focus.
export function wireSearch(input, state, el, nameSelector = 'td.name') {
  input.oninput = () => {
    state.search = input.value.toLowerCase();
    el.querySelectorAll('tbody tr').forEach(tr => {
      const cell = tr.querySelector(nameSelector);
      if (!cell) return;
      tr.style.display = cell.textContent.toLowerCase().includes(state.search) ? '' : 'none';
    });
  };
}
