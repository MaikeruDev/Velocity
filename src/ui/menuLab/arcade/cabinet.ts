/**
 * Arcade-Gehäuse als Pixel-Art auf einem Low-Res-Canvas (1 Kunst-Pixel = 2·s Bildschirm-Pixel, Nearest).
 * Wird nur bei Größenänderung gezeichnet, nie pro Frame. Das Canvas liegt ÜBER dem Bildschirm-DOM
 * (pointer-events: none): das Röhren-Loch ist ausgestanzt, Röhrenrand-Schatten und Glas-Reflex fallen
 * so direkt auf den Inhalt — eine Form für Rahmen und Wölbung, kein clip-path nötig.
 *
 * Alle Pfade liegen auf ganzen Kunst-Pixeln und sind achsparallel getreppt → keine Kantenglättung.
 */

/** Bühne (Marquee + Rahmen + Pult) in Kunst-Pixeln; das DOM rechnet dieselben Maße in em (1 Kunst-Pixel = 0.125em). */
export const STAGE_W = 388;
export const STAGE_H = 360;
export const MARQUEE = { x: -16, y: 0, w: 420, h: 42 } as const;
export const BEZEL = { x: 0, y: 44, w: 388, h: 296, r: 8 } as const;
export const GLASS = { x: 10, y: 54, w: 368, h: 276, r: 14 } as const;
export const DECK_Y = 340;
/** Gehäusefront rechts/links neben dem Rahmen höchstens so breit, dahinter dunkle Halle. */
const FACE_MAX = 150;

/** Getreppte Viertelkreis-Einrückung je Zeile (Zeile 0 = äußerste). */
function insets(r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < r; i++) {
    const d = r - i - 0.5;
    out.push(r - Math.round(Math.sqrt(Math.max(0, r * r - d * d))));
  }
  return out;
}

/** Rechteck mit getreppten runden Ecken als Pfad (an den aktuellen Pfad angehängt). */
function roundPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = insets(Math.max(1, Math.min(r, Math.floor(w / 2), Math.floor(h / 2))));
  const n = k.length;
  g.moveTo(x + k[0], y);
  g.lineTo(x + w - k[0], y);
  for (let i = 0; i < n; i++) {
    g.lineTo(x + w - k[i], y + i);
    g.lineTo(x + w - k[i], y + i + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    g.lineTo(x + w - k[i], y + h - 1 - i);
    g.lineTo(x + w - k[i], y + h - i);
  }
  for (let i = 0; i < n; i++) {
    g.lineTo(x + k[i], y + h - i);
    g.lineTo(x + k[i], y + h - 1 - i);
  }
  for (let i = n - 1; i >= 0; i--) {
    g.lineTo(x + k[i], y + i + 1);
    g.lineTo(x + k[i], y + i);
  }
  g.closePath();
}

function fillRound(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, color: string): void {
  g.beginPath();
  roundPath(g, x, y, w, h, r);
  g.fillStyle = color;
  g.fill();
}

/** 4×4-Bayer-Punkte als Muster: Laminat-Struktur ohne Rauschen (deterministisch, ruhig). */
function ditherPattern(g: CanvasRenderingContext2D, base: string, dot: string): CanvasPattern | string {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const p = c.getContext('2d');
  if (!p) return base;
  p.fillStyle = base;
  p.fillRect(0, 0, 4, 4);
  p.fillStyle = dot;
  p.fillRect(0, 0, 1, 1);
  p.fillRect(2, 2, 1, 1);
  return g.createPattern(c, 'repeat') ?? base;
}

export interface CabinetLayout {
  /** Canvas-Größe in Kunst-Pixeln. */
  readonly cw: number;
  readonly ch: number;
  /** Bühnen-Ursprung in Kunst-Pixeln. */
  readonly ox: number;
  readonly oy: number;
}

/** Ganzes Gehäuse zeichnen. ox/oy = linke obere Ecke der Bühne. */
export function drawCabinet(g: CanvasRenderingContext2D, L: CabinetLayout): void {
  const { cw, ch, ox, oy } = L;
  g.clearRect(0, 0, cw, ch);
  g.imageSmoothingEnabled = false;

  // --- Halle: fast schwarz, damit der Automat darin steht.
  g.fillStyle = '#030108';
  g.fillRect(0, 0, cw, ch);

  const side = Math.max(0, Math.min(ox, cw - ox - STAGE_W));
  const face = Math.min(FACE_MAX, side);
  const fx0 = ox - face;
  const fx1 = ox + STAGE_W + face;

  // --- Nachbar-Automaten in der Halle (nur wenn Platz ist, z. B. 21:9/32:9): Silhouetten mit Marquee- und Röhrenlicht.
  if (side > face + 24) {
    const room = side - face;
    for (let s = 0; s < 2; s++) {
      const right = s === 1;
      const gap = 14;
      const w = Math.min(150, room - gap - 2);
      if (w < 24) break;
      const x0 = right ? fx1 + gap : fx0 - gap - w;
      const top = oy + 16;
      const mq = right ? '#4a1040' : '#0e3048';
      const mq2 = right ? '#7a1c60' : '#16506a';
      const scr = right ? '#140a30' : '#081a30';
      const scr2 = right ? '#1e1046' : '#0c2646';
      // Korpus
      g.fillStyle = '#07051a';
      g.fillRect(x0, top, w, ch - top);
      // Marquee-Kasten (leuchtet, ohne Schrift)
      g.fillStyle = mq;
      g.fillRect(x0 + 4, top + 4, w - 8, 24);
      g.fillStyle = mq2;
      g.fillRect(x0 + 4, top + 15, w - 8, 3);
      g.fillRect(x0 + 4, top + 4, w - 8, 1);
      // Rahmen + Röhre mit Zeilen (Attract-Bild des Nachbarn: nur Licht, unscharf durch Abstand)
      const sy = top + 36;
      const sh = Math.min(150, ch - sy - 60);
      g.fillStyle = '#030208';
      g.fillRect(x0 + 6, sy - 4, w - 12, sh + 8);
      g.fillStyle = scr;
      g.fillRect(x0 + 12, sy, w - 24, sh);
      g.fillStyle = scr2;
      for (let y = sy + 1; y < sy + sh; y += 2) g.fillRect(x0 + 12, y, w - 24, 1);
      // Licht der Röhre fällt auf den Boden davor (getreppt).
      g.fillStyle = right ? 'rgba(120,40,140,0.08)' : 'rgba(40,120,160,0.08)';
      for (let k = 0; k < 3; k++) g.fillRect(x0 - 8 - k * 6, ch - 30 + k * 8, w + 16 + k * 12, 30 - k * 8);
      // Aus der Ferne: Titelbalken + Tabellenzeilen des Nachbar-Attract-Modes (nur Farbflächen, keine Schrift).
      const rows = right ? ['#5a2a6a', '#3a4a8a', '#5a3a2a', '#2a5a5a', '#4a2a5a'] : ['#2a5a6a', '#5a2a5a', '#5a5a2a', '#2a4a6a', '#3a2a6a'];
      g.fillStyle = right ? '#8a2a70' : '#1a6a80';
      g.fillRect(x0 + 24, sy + 12, w - 48, 6);
      for (let i = 0; i < rows.length; i++) {
        g.fillStyle = rows[i];
        const ry = sy + 30 + i * 12;
        if (ry + 4 > sy + sh - 8) break;
        g.fillRect(x0 + 20, ry, 10, 4);
        g.fillRect(x0 + 36, ry, w - 76, 4);
        g.fillRect(x0 + w - 34, ry, 14, 4);
      }
      // Pult
      const py = sy + sh + 14;
      g.fillStyle = '#100a24';
      g.fillRect(x0 - 4, py, w + 8, 6);
      g.fillStyle = mq2;
      g.fillRect(x0 - 4, py, w + 8, 1);
      // T-Molding des Nachbarn auf der uns zugewandten Kante
      g.fillStyle = right ? '#5a1650' : '#14485a';
      g.fillRect(right ? x0 : x0 + w - 1, top, 1, ch - top);
    }
  }

  // --- Gehäusefront (Laminat) über volle Höhe.
  g.fillStyle = ditherPattern(g, '#0b0620', '#120a2c');
  g.fillRect(fx0, 0, fx1 - fx0, ch);

  // --- Front-Art hinter den Bändern: Sterne oben, Skyline am Pult (die Stadt der Level-Welt), deterministisch.
  const baseY0 = oy + DECK_Y;
  let seed = 0x9e3779b1;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let side2 = 0; side2 < 2; side2++) {
    const a = side2 === 0 ? fx0 + 3 : ox + STAGE_W + 1;
    const e = side2 === 0 ? ox - 1 : fx1 - 3;
    if (e - a < 4) continue;
    // Sterne
    for (let i = 0; i < Math.floor((e - a) * 0.5); i++) {
      const x = a + Math.floor(rnd() * (e - a));
      const y = Math.floor(rnd() * (baseY0 * 0.55));
      g.fillStyle = rnd() < 0.2 ? '#6a5aa8' : '#2c2458';
      g.fillRect(x, y, 1, 1);
    }
    // Skyline: von innen (Röhre) nach außen niedriger werdend.
    let x = side2 === 0 ? e : a;
    while (side2 === 0 ? x > a : x < e) {
      const bw = 6 + Math.floor(rnd() * 12);
      const dist = side2 === 0 ? e - x : x - a;
      const fall = Math.max(0.35, 1 - dist / 260);
      const bh = Math.floor((24 + rnd() * 70) * fall);
      const x0 = side2 === 0 ? Math.max(a, x - bw) : x;
      const x1 = side2 === 0 ? x : Math.min(e, x + bw);
      g.fillStyle = '#060312';
      g.fillRect(x0, baseY0 - bh, x1 - x0, bh);
      g.fillStyle = '#1a1238';
      g.fillRect(x0, baseY0 - bh, x1 - x0, 1);
      // Fenster: 1×1 im 3er-Raster, wenige leuchten.
      for (let wy = baseY0 - bh + 3; wy < baseY0 - 2; wy += 3) {
        for (let wx = x0 + 2; wx < x1 - 1; wx += 3) {
          const r = rnd();
          if (r < 0.16) {
            g.fillStyle = r < 0.015 ? '#ff3fd0' : r < 0.03 ? '#33f0ff' : '#3a2c6c';
            g.fillRect(wx, wy, 1, 1);
          }
        }
      }
      // Antenne mit rotem Licht auf hohen Häusern
      if (bh > 60) {
        g.fillStyle = '#060312';
        g.fillRect(x0 + Math.floor((x1 - x0) / 2), baseY0 - bh - 5, 1, 5);
        g.fillStyle = '#ff4d6d';
        g.fillRect(x0 + Math.floor((x1 - x0) / 2), baseY0 - bh - 6, 1, 1);
      }
      x = side2 === 0 ? x0 - 1 - Math.floor(rnd() * 3) : x1 + 1 + Math.floor(rnd() * 3);
    }
  }

  // --- Seiten-Art: drei Neon-Bänder, die vom Pult aus nach außen steigen — zusammen ein großes V um die Röhre.
  const bands: readonly { readonly off: number; readonly w: number; readonly c: string; readonly c2: string }[] = [
    { off: 4, w: 9, c: '#33f0ff', c2: '#1a8a9c' },
    { off: 16, w: 5, c: '#ff3fd0', c2: '#8a1f74' },
    { off: 24, w: 2, c: '#ffd84a', c2: '#8a6a1a' },
  ];
  const baseY = oy + DECK_Y;
  for (let y = 0; y < baseY; y++) {
    const rise = Math.floor((baseY - y) / 2);
    for (const b of bands) {
      // Kante: 1 px dunklere Stufe außen = harter "Glanz", keine Verläufe.
      const lx = ox - b.off - rise - b.w;
      const rx = ox + STAGE_W + b.off + rise;
      if (lx + b.w > fx0) {
        const a = Math.max(fx0, lx);
        const e = Math.min(ox - 2, lx + b.w);
        if (e > a) {
          g.fillStyle = b.c;
          g.fillRect(a, y, e - a, 1);
          g.fillStyle = b.c2;
          if (lx >= fx0) g.fillRect(lx, y, 1, 1);
        }
      }
      if (rx < fx1) {
        const a = Math.max(ox + STAGE_W + 2, rx);
        const e = Math.min(fx1, rx + b.w);
        if (e > a) {
          g.fillStyle = b.c;
          g.fillRect(a, y, e - a, 1);
          g.fillStyle = b.c2;
          if (rx + b.w - 1 < fx1) g.fillRect(rx + b.w - 1, y, 1, 1);
        }
      }
    }
  }

  // --- Lautsprecher-Gitter links/rechts neben der Marquee (Schlitze).
  for (let s = 0; s < 2; s++) {
    const x0 = s === 0 ? ox + MARQUEE.x - 4 - 40 : ox + MARQUEE.x + MARQUEE.w + 4;
    if (s === 0 ? x0 < fx0 + 2 : x0 + 40 > fx1 - 2) continue;
    g.fillStyle = '#05030c';
    g.fillRect(x0, oy + 6, 40, 30);
    g.fillStyle = '#1a1236';
    for (let y = oy + 9; y < oy + 34; y += 4) g.fillRect(x0 + 3, y, 34, 2);
  }

  // --- T-Molding an den Kanten der Front (leuchtende Kunststoffkante).
  if (fx0 > 0) {
    g.fillStyle = '#ff3fd0';
    g.fillRect(fx0, 0, 2, ch);
    g.fillStyle = '#5a1650';
    g.fillRect(fx0 + 2, 0, 1, ch);
  }
  if (fx1 < cw) {
    g.fillStyle = '#ff3fd0';
    g.fillRect(fx1 - 2, 0, 2, ch);
    g.fillStyle = '#5a1650';
    g.fillRect(fx1 - 3, 0, 1, ch);
  }

  // --- Marquee: hinterleuchteter Kasten, Dämmerungs-Himmel + Gitterboden (passt zur Level-1-Welt).
  const mx = ox + MARQUEE.x;
  const my = oy + MARQUEE.y;
  g.fillStyle = '#2a2342';
  g.fillRect(mx - 2, my, MARQUEE.w + 4, MARQUEE.h + 2);
  g.fillStyle = '#4a4068';
  g.fillRect(mx - 2, my, MARQUEE.w + 4, 1);
  const ix = mx + 1;
  const iy = my + 2;
  const iw = MARQUEE.w - 2;
  const ih = MARQUEE.h - 3;
  const sky = ['#12062e', '#1a0838', '#250a48', '#340c58', '#4a0f66', '#661270', '#8a1878', '#b02078', '#d8306e'];
  const horizon = iy + 27;
  for (let y = iy; y < horizon; y++) {
    const t = (y - iy) / (horizon - iy);
    g.fillStyle = sky[Math.min(sky.length - 1, Math.floor(t * sky.length))];
    g.fillRect(ix, y, iw, 1);
  }
  // Sterne oben
  g.fillStyle = '#c8b8ff';
  for (let i = 0; i < 26; i++) {
    const sx = ix + ((i * 97 + 13) % iw);
    const sy = iy + ((i * 37) % 10);
    g.fillRect(sx, sy, 1, 1);
  }
  g.fillStyle = '#ff9a5a';
  g.fillRect(ix, horizon, iw, 1);
  g.fillStyle = '#1a0630';
  g.fillRect(ix, horizon + 1, iw, iy + ih - horizon - 1);
  // Gitterboden: Querlinien enger zum Horizont, Längslinien in einen Fluchtpunkt.
  g.fillStyle = '#b0207f';
  for (let k = 1, y = horizon + 2; y < iy + ih; k++, y += k) g.fillRect(ix, y, iw, 1);
  const cx = ix + Math.floor(iw / 2);
  for (let y = horizon + 1; y < iy + ih; y++) {
    const d = y - horizon;
    for (let l = -14; l <= 14; l++) {
      const x = cx + Math.round(l * d * 2.4);
      if (x >= ix && x < ix + iw) g.fillRect(x, y, 1, 1);
    }
  }
  // Chromleiste zwischen Marquee und Rahmen
  g.fillStyle = '#1b1530';
  g.fillRect(mx - 2, my + MARQUEE.h + 2, MARQUEE.w + 4, 2);

  // --- Rahmen (Bezel) um die Röhre: schwarzer Kunststoff mit 1-px-Kantenlicht.
  const bx = ox + BEZEL.x;
  const by = oy + BEZEL.y;
  fillRound(g, bx - 1, by - 1, BEZEL.w + 2, BEZEL.h + 2, BEZEL.r + 1, '#2c2446');
  fillRound(g, bx, by, BEZEL.w, BEZEL.h, BEZEL.r, '#07050d');
  // Aufgedruckte Linien im Rahmen (Bezel-Art): dünne Cyan-/Magenta-Linie um das Glas.
  const gx = ox + GLASS.x;
  const gy = oy + GLASS.y;
  fillRound(g, gx - 5, gy - 5, GLASS.w + 10, GLASS.h + 10, GLASS.r + 5, '#1c6f80');
  fillRound(g, gx - 4, gy - 4, GLASS.w + 8, GLASS.h + 8, GLASS.r + 4, '#07050d');
  fillRound(g, gx - 3, gy - 3, GLASS.w + 6, GLASS.h + 6, GLASS.r + 3, '#6a1a5c');
  fillRound(g, gx - 2, gy - 2, GLASS.w + 4, GLASS.h + 4, GLASS.r + 2, '#020104');

  // --- Röhre ausstanzen: dahinter liegt das Bildschirm-DOM (und durch dessen Tönung die Level-Kulisse).
  g.save();
  g.globalCompositeOperation = 'destination-out';
  fillRound(g, gx, gy, GLASS.w, GLASS.h, GLASS.r, '#000');
  g.restore();

  // Wölbung: getreppter Randschatten in der Röhre (Ringe, außen dunkel) — liest sich als gebogenes Glas.
  const ring = [0.62, 0.42, 0.3, 0.2, 0.13, 0.08, 0.05, 0.03];
  for (let k = 0; k < ring.length; k++) {
    g.beginPath();
    roundPath(g, gx + k, gy + k, GLASS.w - 2 * k, GLASS.h - 2 * k, Math.max(2, GLASS.r - k));
    roundPath(g, gx + k + 1, gy + k + 1, GLASS.w - 2 * k - 2, GLASS.h - 2 * k - 2, Math.max(2, GLASS.r - k - 1));
    g.fillStyle = `rgba(0,0,0,${ring[k]})`;
    g.fill('evenodd');
  }
  // Ecken zusätzlich dunkler (Röhren-Vignette), getreppt.
  for (let k = 0; k < 4; k++) {
    const r = 40 - k * 9;
    g.fillStyle = `rgba(0,0,0,${0.1})`;
    for (let c = 0; c < 4; c++) {
      const right = c === 1 || c === 2;
      const bottom = c >= 2;
      const ins = insets(r);
      for (let i = 0; i < r; i++) {
        const w = r - ins[r - 1 - i];
        const yy = bottom ? gy + GLASS.h - 1 - i : gy + i;
        const xx = right ? gx + GLASS.w - w : gx;
        g.fillRect(xx, yy, w, 1);
      }
    }
  }
  // Glas-Reflex: schräges, getrepptes Band oben links, sehr leise.
  g.fillStyle = 'rgba(255,255,255,0.045)';
  for (let y = 0; y < 110; y++) {
    const x = gx + 40 + Math.floor((110 - y) * 1.1);
    const w = 22 + Math.floor(y / 8);
    g.fillRect(x, gy + 4 + y, w, 1);
  }
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = 0; y < 90; y++) {
    const x = gx + 96 + Math.floor((90 - y) * 1.1);
    g.fillRect(x, gy + 4 + y, 6, 1);
  }

  // --- Pult (Control Deck): Oberkante als Lichtkante, darunter dunkles Blech, Münzschlitz rechts.
  const dy = oy + DECK_Y;
  g.fillStyle = '#ff3fd0';
  g.fillRect(fx0, dy, fx1 - fx0, 1);
  g.fillStyle = '#2a1f48';
  g.fillRect(fx0, dy + 1, fx1 - fx0, 1);
  g.fillStyle = ditherPattern(g, '#120b26', '#17102f');
  g.fillRect(fx0, dy + 2, fx1 - fx0, ch - dy - 2);
  // Münzschlitz-Platte
  const cx0 = ox + STAGE_W - 44;
  g.fillStyle = '#3a3252';
  g.fillRect(cx0, dy + 4, 26, 13);
  g.fillStyle = '#6a6090';
  g.fillRect(cx0, dy + 4, 26, 1);
  g.fillStyle = '#05030a';
  g.fillRect(cx0 + 11, dy + 6, 4, 9);
  g.fillStyle = '#ff7a2a';
  g.fillRect(cx0 + 12, dy + 7, 2, 7);
  g.fillStyle = '#ffd84a';
  g.fillRect(cx0 + 12, dy + 7, 2, 2);

  // --- Halle dunkelt nach außen ab (getreppte Vignette an den Bildrändern).
  const steps = 6;
  for (let k = 0; k < steps; k++) {
    const w = Math.max(0, Math.floor((side - face) * 0.15) + 6) * (steps - k);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, 0, w, ch);
    g.fillRect(cw - w, 0, w, ch);
  }
  if (oy > 0) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, cw, Math.min(oy, 8));
  }
}
