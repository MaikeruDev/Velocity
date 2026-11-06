// Erreichbarkeit per Pad (tools/pad/menu-check.ts): vom aktuellen Pad-Fokus aus mit denselben Regeln wie ui/padNav
// (pickInDirection, Slider schlucken links/rechts) alle bedienbaren Elemente ablaufen. Ergebnis: {total, unreachable[]}.
// Als Funktionsrumpf-Text übergeben (fallen.md #238); arguments[0] = Selektor des Bereichs.
async (rootSel) => {
  const m = await import('/src/ui/padNav.ts');
  const root = document.querySelector(rootSel);
  if (!root) return { total: 0, unreachable: [`(kein ${rootSel})`] };
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
  const start = root.querySelector('.is-padfocus') ?? els[0];
  if (!start) return { total: 0, unreachable: [] };
  const seen = new Set([start]);
  const queue = [start];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length > 0) {
    const cur = queue.shift();
    const range = cur instanceof HTMLInputElement && cur.type === 'range';
    const others = els.filter((e) => e !== cur);
    const rects = others.map(rect);
    for (const [dx, dy] of dirs) {
      if (range && dx !== 0) continue;
      const i = m.pickInDirection(rect(cur), rects, dx, dy);
      if (i >= 0 && !seen.has(others[i])) {
        seen.add(others[i]);
        queue.push(others[i]);
      }
    }
  }
  const label = (e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(/\s+/)[0]} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  return { total: els.length, unreachable: els.filter((e) => !seen.has(e)).map(label) };
}
