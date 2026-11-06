// Weg per Steuerkreuz vom aktuellen Pad-Fokus zu einem Ziel (tools/pad/menu-check.ts) — dieselben Regeln wie
// ui/padNav (pickInDirection). Ergebnis: Liste von 'Up'|'Down'|'Left'|'Right' oder null (unerreichbar).
// arguments: (rootSel, targetSel, targetText?) — targetText filtert nach enthaltenem Text.
async (rootSel, targetSel, targetText) => {
  const m = await import('/src/ui/padNav.ts');
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const valid = (e) => {
    if (e.closest('[data-pad-skip], [hidden], [inert]')) return false;
    if (e instanceof HTMLButtonElement && e.disabled) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(e);
    return st.visibility !== 'hidden' && st.pointerEvents !== 'none';
  };
  const els = Array.from(root.querySelectorAll(m.PAD_FOCUSABLE)).filter(valid);
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const isTarget = (e) => e.matches(targetSel) && (!targetText || (e.textContent || '').includes(targetText));
  const start = root.querySelector('.is-padfocus');
  if (!start) return null;
  if (isTarget(start)) return [];
  const prev = new Map([[start, null]]);
  const queue = [start];
  const dirs = [[1, 0, 'Right'], [-1, 0, 'Left'], [0, 1, 'Down'], [0, -1, 'Up']];
  while (queue.length > 0) {
    const cur = queue.shift();
    const range = cur instanceof HTMLInputElement && cur.type === 'range';
    const others = els.filter((e) => e !== cur);
    const rects = others.map(rect);
    for (const [dx, dy, name] of dirs) {
      if (range && dx !== 0) continue;
      const i = m.pickInDirection(rect(cur), rects, dx, dy);
      if (i < 0 || prev.has(others[i])) continue;
      prev.set(others[i], [cur, name]);
      if (isTarget(others[i])) {
        const out = [];
        let n = others[i];
        while (prev.get(n)) {
          const [p, d] = prev.get(n);
          out.unshift(d);
          n = p;
        }
        return out;
      }
      queue.push(others[i]);
    }
  }
  return null;
}
