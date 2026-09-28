/**
 * Grobe Fake-Szene im Low-Res-Raster (nur für die UI-Preview): Dämmerungshimmel
 * mit hellem Horizont, Neon-Grid, ein paar Plattformen. Zweck: HUD-Lesbarkeit
 * vor hellen UND dunklen Flächen beurteilen, wie im echten Spiel.
 */

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function paintFakeScene(ctx: CanvasRenderingContext2D, w: number, h: number, time: number): void {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const top = hexRgb('#0e0826');
  const mid = hexRgb('#ff5e7a');
  const bottom = hexRgb('#1a0b2e');
  const horizon = Math.round(h * 0.56);
  const levels = 32; // 5 Bit pro Kanal wie das echte Post-Processing
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r: number;
      let g: number;
      let b: number;
      if (y < horizon) {
        const t = Math.pow(y / horizon, 1.6);
        r = lerp(top[0], mid[0], t);
        g = lerp(top[1], mid[1], t);
        b = lerp(top[2], mid[2], t);
        // Sonne mit Streifen (Synthwave-Klischee, aber hell genug für einen harten Lesbarkeitstest).
        const dx = x - w * 0.62;
        const dy = y - horizon * 0.78;
        if (dx * dx + dy * dy < (h * 0.16) ** 2 && !(y > horizon * 0.72 && y % 5 < 2)) {
          r = 255;
          g = lerp(230, 110, (y / horizon - 0.5) * 2);
          b = 120;
        }
      } else {
        const t = (y - horizon) / (h - horizon);
        r = lerp(mid[0] * 0.35, bottom[0], Math.min(1, t * 2));
        g = lerp(mid[1] * 0.35, bottom[1], Math.min(1, t * 2));
        b = lerp(mid[2] * 0.5, bottom[2], Math.min(1, t * 2));
        // Perspektivisches Grid.
        const z = 1 / Math.max(0.001, t);
        const gz = (z * 6 + time * 8) % 6;
        const gx = ((x - w / 2) / (w / 2)) * z * 3;
        const onLine = gz < 0.35 * z * 0.1 + 0.2 || Math.abs(gx - Math.round(gx)) < 0.02 * z;
        if (onLine && t > 0.02) {
          r = lerp(r, 51, 0.7);
          g = lerp(g, 240, 0.7);
          b = lerp(b, 255, 0.7);
        }
      }
      const th = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * (256 / levels);
      const q = (v: number): number => Math.max(0, Math.min(255, Math.round((v + th) / (256 / levels)) * (256 / levels)));
      const i = (y * w + x) * 4;
      d[i] = q(r);
      d[i + 1] = q(g);
      d[i + 2] = q(b);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Plattformen: dunkle Blöcke mit Neon-Trim an der Oberkante.
  const plats: [number, number, number, number, string][] = [
    [0.05, 0.62, 0.3, 0.2, '#33f0ff'],
    [0.42, 0.6, 0.16, 0.05, '#ff3fd0'],
    [0.66, 0.66, 0.34, 0.34, '#33f0ff'],
    [0.2, 0.9, 0.5, 0.1, '#ff3fd0'],
  ];
  for (const [px, py, pw, ph, trim] of plats) {
    const x = Math.round(px * w);
    const y = Math.round(py * h);
    const ww = Math.round(pw * w);
    const hh = Math.round(ph * h);
    ctx.fillStyle = '#241640';
    ctx.fillRect(x, y, ww, hh);
    ctx.fillStyle = '#3a2766';
    ctx.fillRect(x, y, ww, 2);
    ctx.fillStyle = trim;
    ctx.fillRect(x, y, ww, 1);
  }
}
