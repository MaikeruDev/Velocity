/**
 * Kamera-Kritik: Mini-Plotter. Zeichnet Panels (je eine y-Achse, gemeinsame x-Achse) auf ein
 * Canvas im Browser und speichert das PNG. Farben: Referenz-Palette (dataviz), feste Reihenfolge.
 */
export const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fcfcfb;font-family:Segoe UI,Arial,sans-serif}
canvas{display:block}
</style></head><body><canvas id="c"></canvas><script>
window.draw = (fig) => {
  const W = fig.width, PH = fig.panelHeight, top = 64, gap = 26, L = 78, R = 190;
  const H = top + fig.panels.length * (PH + gap) + 44;
  const c = document.getElementById('c');
  const dpr = 1;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d');
  g.fillStyle = '#fcfcfb'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b0b0b'; g.font = '600 20px Segoe UI, Arial'; g.fillText(fig.title, L, 30);
  g.fillStyle = '#52514e'; g.font = '13px Segoe UI, Arial'; g.fillText(fig.subtitle || '', L, 50);
  const [x0, x1] = fig.xRange;
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  fig.panels.forEach((p, pi) => {
    const py = top + pi * (PH + gap) + 12;
    let [y0, y1] = p.yRange || [Infinity, -Infinity];
    if (!p.yRange) {
      for (const s of p.series) for (const [x, y] of s.pts) if (x >= x0 && x <= x1 && Number.isFinite(y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
      const m = (y1 - y0) * 0.08; y0 -= m; y1 += m;
    }
    const Y = (y) => py + PH - ((y - y0) / (y1 - y0)) * PH;
    // Raster
    g.strokeStyle = '#e4e3df'; g.lineWidth = 1; g.fillStyle = '#52514e'; g.font = '12px Segoe UI, Arial';
    const ticks = niceTicks(y0, y1, 4);
    for (const t of ticks) { g.beginPath(); g.moveTo(L, Math.round(Y(t)) + 0.5); g.lineTo(W - R, Math.round(Y(t)) + 0.5); g.stroke(); g.textAlign = 'right'; g.fillText(fmt(t), L - 8, Y(t) + 4); }
    g.textAlign = 'left';
    // Events
    if (p.marks) { for (const m of p.marks) { g.strokeStyle = m.color || 'rgba(82,81,78,0.28)'; g.beginPath(); g.moveTo(Math.round(X(m.x)) + 0.5, py); g.lineTo(Math.round(X(m.x)) + 0.5, py + PH); g.stroke(); } }
    // Bänder
    if (p.bands) for (const b of p.bands) { g.fillStyle = b.color; g.fillRect(X(b.x0), py, X(b.x1) - X(b.x0), PH); }
    // Referenzlinien
    if (p.hlines) for (const h of p.hlines) { if (h.y < y0 || h.y > y1) continue; g.strokeStyle = '#8a8984'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(h.y)); g.lineTo(W - R, Y(h.y)); g.stroke(); g.setLineDash([]); g.fillStyle = '#52514e'; g.fillText(h.label, W - R + 8, Y(h.y) + 4); }
    // Serien
    p.series.forEach((s, si) => {
      g.strokeStyle = s.color; g.lineWidth = s.width || 2; g.lineJoin = 'round';
      if (s.dots) {
        g.fillStyle = s.color;
        for (const [x, y] of s.pts) { if (x < x0 || x > x1) continue; g.beginPath(); g.arc(X(x), Y(y), 4, 0, 7); g.fill(); }
      } else {
        g.beginPath(); let pen = false;
        for (const [x, y] of s.pts) { if (x < x0 || x > x1 || !Number.isFinite(y)) { pen = false; continue; } if (!pen) { g.moveTo(X(x), Y(y)); pen = true; } else g.lineTo(X(x), Y(y)); }
        g.stroke();
      }
    });
    // Achsentitel + Legende rechts (Text in Textfarbe, Farbmarke daneben)
    g.save(); g.translate(18, py + PH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillStyle = '#0b0b0b'; g.font = '600 12px Segoe UI, Arial'; g.fillText(p.ylabel, 0, 0); g.restore();
    g.font = '12px Segoe UI, Arial';
    const legendTop = py + 4 + (p.hlines ? 0 : 0);
    p.series.forEach((s, si) => { if (!s.label) return; const ly = legendTop + si * 18 + 8; g.fillStyle = s.color; g.fillRect(W - R + 8, ly - 5, 14, 4); g.fillStyle = '#0b0b0b'; g.fillText(s.label, W - R + 28, ly); });
    if (p.note) { g.fillStyle = '#52514e'; g.font = 'italic 12px Segoe UI, Arial'; g.fillText(p.note, L + 6, py + 14); }
    // Rahmen unten
    g.strokeStyle = '#b9b8b2'; g.beginPath(); g.moveTo(L, py + PH + 0.5); g.lineTo(W - R, py + PH + 0.5); g.stroke();
  });
  // x-Achse
  const yb = top + fig.panels.length * (PH + gap) + 2;
  g.fillStyle = '#52514e'; g.font = '12px Segoe UI, Arial'; g.textAlign = 'center';
  for (const t of niceTicks(x0, x1, 10)) g.fillText(fmt(t), X(t), yb);
  g.fillStyle = '#0b0b0b'; g.font = '600 12px Segoe UI, Arial'; g.fillText(fig.xlabel, L + (W - L - R) / 2, yb + 22);
  return [W, H];
  function niceTicks(a, b, n) { const span = b - a; const step0 = span / n; const mag = Math.pow(10, Math.floor(Math.log10(step0))); const f = step0 / mag; const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag; const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v); return out; }
  function fmt(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(2); }
};
</script></body></html>`;

export async function renderFigures(browser, figs) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.setContent(PAGE);
  for (const f of figs) {
    const [w, h] = await page.evaluate((fig) => window.draw(fig), f.fig);
    await page.setViewportSize({ width: w, height: h });
    await page.locator('#c').screenshot({ path: f.path });
    console.log('PNG', f.path);
  }
  await page.close();
}
