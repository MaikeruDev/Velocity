/**
 * Stage-"Porträts" für die Karten (wie die Bilder einer Player-Select-Seite): je Level ein kleines Pixelbild,
 * 68×18 Kunst-Pixel, nur fillRect, beim Aufbau der Karten gezeichnet (nie pro Frame). Motive sind Anspielungen
 * auf das Level (Dämmerung + Plattformen, Schleife, Surf-Rampen, Turm), kein Screenshot.
 */
export const THUMB_W = 68;
export const THUMB_H = 18;

type G = CanvasRenderingContext2D;

function sky(g: G, bands: readonly string[], h: number): void {
  for (let y = 0; y < h; y++) {
    g.fillStyle = bands[Math.min(bands.length - 1, Math.floor((y / h) * bands.length))];
    g.fillRect(0, y, THUMB_W, 1);
  }
}

function stars(g: G, color: string, n: number, maxY: number, seed: number): void {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) g.fillRect((i * 29 + seed * 7) % THUMB_W, (i * 11 + seed) % maxY, 1, 1);
}

/** L1 GRUNDKURS: Sonne über dem Horizont, schwebende Plattformen mit grünen Trims. */
function grundkurs(g: G): void {
  sky(g, ['#1a0838', '#3a0c56', '#6a1268', '#a8206a', '#e0506a', '#ff8a5a'], 12);
  // Sonne mit Outrun-Streifen
  g.fillStyle = '#ffd84a';
  const cx = 44;
  for (let y = 3; y < 12; y++) {
    const d = 12 - y;
    const w = Math.round(Math.sqrt(Math.max(0, 49 - (d - 4) * (d - 4))) * 1.2);
    if (y === 8 || y === 10) continue;
    g.fillRect(cx - w, y, w * 2, 1);
  }
  g.fillStyle = '#120a26';
  g.fillRect(0, 12, THUMB_W, 6);
  // Plattformen
  const plats: readonly (readonly [number, number, number])[] = [
    [2, 14, 12],
    [18, 12, 9],
    [31, 13, 10],
    [46, 11, 8],
    [58, 13, 9],
  ];
  for (const [x, y, w] of plats) {
    g.fillStyle = '#2a2050';
    g.fillRect(x, y, w, THUMB_H - y);
    g.fillStyle = '#5dff9a';
    g.fillRect(x, y, w, 1);
  }
}

/** L2 SCHLEIFE: Nachthimmel, große Schleifen-Bahn in Magenta. */
function schleife(g: G): void {
  sky(g, ['#0a0420', '#140830', '#200a40', '#300c4a'], THUMB_H);
  stars(g, '#5a4a9a', 14, 10, 3);
  // Ellipse (Rand) getreppt
  const cx = 34;
  const cy = 9;
  const rx = 22;
  const ry = 6;
  g.fillStyle = '#ff3fd0';
  for (let a = 0; a < 96; a++) {
    const t = (a / 96) * Math.PI * 2;
    g.fillRect(Math.round(cx + Math.cos(t) * rx), Math.round(cy + Math.sin(t) * ry), 1, 1);
  }
  g.fillStyle = '#8a1f74';
  for (let a = 0; a < 96; a++) {
    const t = (a / 96) * Math.PI * 2;
    g.fillRect(Math.round(cx + Math.cos(t) * (rx - 2)), Math.round(cy + 1 + Math.sin(t) * (ry - 1)), 1, 1);
  }
  // Fahrer-Punkt auf der Bahn
  g.fillStyle = '#ffffff';
  g.fillRect(cx + rx - 3, cy + 3, 2, 2);
  g.fillStyle = '#120a26';
  g.fillRect(0, 16, THUMB_W, 2);
  g.fillStyle = '#ff3fd0';
  g.fillRect(0, 16, THUMB_W, 1);
}

/** L3 BRANDUNG: Surf-Rampen (Keile) in Türkis/Koralle über dunklem Wasser. */
function brandung(g: G): void {
  sky(g, ['#061a2a', '#0a2a3a', '#143a4a', '#2a4a5a'], 10);
  g.fillStyle = '#040c18';
  g.fillRect(0, 10, THUMB_W, 8);
  g.fillStyle = '#0c2a3a';
  for (let x = 0; x < THUMB_W; x += 4) g.fillRect(x + ((x / 4) % 2), 15, 2, 1);
  // Keile: Spitze oben, Flanken getreppt
  const ramps: readonly (readonly [number, string, string])[] = [
    [10, '#33f0ff', '#1a8a9c'],
    [28, '#ff8a5a', '#a04a2a'],
    [46, '#33f0ff', '#1a8a9c'],
    [62, '#ff8a5a', '#a04a2a'],
  ];
  for (const [cx, c, c2] of ramps) {
    for (let y = 4; y < 15; y++) {
      const w = y - 3;
      g.fillStyle = c2;
      g.fillRect(cx - w, y, w, 1);
      g.fillStyle = c;
      g.fillRect(cx, y, w, 1);
    }
    g.fillStyle = '#ffffff';
    g.fillRect(cx, 4, 1, 1);
  }
}

/** L4 TURM: Wendel-Turm mit goldenen Kanten vor dunklem Himmel. */
function turm(g: G): void {
  sky(g, ['#140a04', '#2a1408', '#3a1c0a', '#4a240c'], THUMB_H);
  stars(g, '#6a4a2a', 10, 8, 5);
  g.fillStyle = '#1a1008';
  g.fillRect(28, 2, 12, 16);
  for (let i = 0; i < 6; i++) {
    const y = 16 - i * 3;
    const left = i % 2 === 0;
    g.fillStyle = '#3a2814';
    g.fillRect(left ? 18 : 34, y, 16, 2);
    g.fillStyle = '#ffd84a';
    g.fillRect(left ? 18 : 34, y, 16, 1);
  }
  g.fillStyle = '#ff4d6d';
  g.fillRect(33, 0, 2, 1);
}

function generic(g: G, i: number): void {
  sky(g, ['#0a0420', '#1a0838', '#2a0a48'], THUMB_H);
  g.fillStyle = i % 2 === 0 ? '#33f0ff' : '#ff3fd0';
  for (let x = 0; x < THUMB_W; x += 6) g.fillRect(x, 12 - ((x / 6) % 3) * 2, 4, 1);
}

const MOTIFS: readonly ((g: G) => void)[] = [grundkurs, schleife, brandung, turm];

export function drawThumb(canvas: HTMLCanvasElement, index: number): void {
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const g = canvas.getContext('2d');
  if (!g) return;
  const m = MOTIFS[index];
  if (m) m(g);
  else generic(g, index);
}
