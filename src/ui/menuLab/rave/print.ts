/**
 * Rave-Flyer: Druck-Texturen (Halbton-Raster, Xerox-Korn) als Low-Res-Canvas, 1-Bit pro Pixel —
 * keine Kantenglättung, damit sie im Pixelraster des Menüs bleiben (look.md: harte Kanten).
 * Nur in mount()/resize aufrufen (DOM), nie pro Frame.
 */

/** Deterministischer Zufall (LCG) — das Korn sieht bei jedem Mount gleich aus, kein Flimmern beim Neuaufbau. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hex(c: string): Rgb {
  const n = Number.parseInt(c.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Halbton-Rampe: Punktraster (Zelle `cell` px), Punktradius wächst mit `amount(u, v)` (0..1, u/v = 0..1 über die Fläche).
 * Raster 45° gedreht wie im Offsetdruck; Punkte hart (Abstandstest je Pixel).
 */
function halftone(
  img: ImageData,
  cell: number,
  col: Rgb,
  alpha: number,
  amount: (u: number, v: number) => number,
): void {
  const { width: w, height: h, data } = img;
  const cos = Math.SQRT1_2;
  const sin = Math.SQRT1_2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Rasterkoordinaten 45° gedreht.
      const rx = (x * cos + y * sin) / cell;
      const ry = (-x * sin + y * cos) / cell;
      const fx = rx - Math.floor(rx) - 0.5;
      const fy = ry - Math.floor(ry) - 0.5;
      const a = amount(x / w, y / h);
      if (a <= 0.02) continue;
      // Radius² so, dass a = 1 die Zelle fast füllt.
      const r = a * 0.62;
      if (fx * fx + fy * fy > r * r) continue;
      const i = (y * w + x) * 4;
      data[i] = col.r;
      data[i + 1] = col.g;
      data[i + 2] = col.b;
      data[i + 3] = alpha;
    }
  }
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Flyer-Untergrund: zwei Halbton-Rampen (Magenta aus der linken unteren Ecke, Cyan von rechts oben) in einem
 * Canvas mit w×h Low-Res-Pixeln. Wird per CSS ganzzahlig hochskaliert.
 */
export function paintPrint(cv: HTMLCanvasElement, w: number, h: number, magenta: string, cyan: string): void {
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return;
  const img = g.createImageData(w, h);
  const asp = w / h;
  halftone(img, 5, hex(magenta), 120, (u, v) => {
    // Ecke unten links, elliptisch auslaufend.
    const dx = u * asp * 0.9;
    const dy = 1 - v;
    return 1 - smooth(0.05, 0.85, Math.sqrt(dx * dx + dy * dy * 1.4));
  });
  halftone(img, 4, hex(cyan), 70, (u, v) => {
    const dx = (1 - u) * asp * 1.1;
    const dy = v * 1.2;
    return 0.8 - smooth(0, 0.7, Math.sqrt(dx * dx + dy * dy));
  });
  g.putImageData(img, 0, 0);
}

/** Halbton-Kachel für das Xerox-Foto (gleichmäßiges Raster, Tinte auf transparent). */
export function paintDots(cv: HTMLCanvasElement, size: number, ink: string): void {
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  if (!g) return;
  const img = g.createImageData(size, size);
  // Gitterlinien-Raster: Punkte klein in der Mitte jeder 3-px-Zelle → "Druckraster" auf dem Foto.
  halftone(img, 3, hex(ink), 150, () => 0.34);
  g.putImageData(img, 0, 0);
}

/** Xerox-Korn: verstreute helle und dunkle Einzelpixel, sonst transparent. */
export function paintGrain(cv: HTMLCanvasElement, size: number): void {
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  if (!g) return;
  const img = g.createImageData(size, size);
  const d = img.data;
  const rnd = lcg(0x5eed132);
  for (let i = 0; i < size * size; i++) {
    const r = rnd();
    const o = i * 4;
    if (r < 0.035) {
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = 70;
    } else if (r < 0.1) {
      d[o] = d[o + 1] = d[o + 2] = 0;
      d[o + 3] = 120;
    }
  }
  g.putImageData(img, 0, 0);
}
