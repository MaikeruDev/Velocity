import { CanvasTexture, NearestFilter, NoColorSpace, RepeatWrapping } from 'three';
import type { MaterialId } from '../world/level/LevelFormat';
import { hashString, mulberry32 } from './util';

/**
 * Prozedurale PS2-Texturen: 64×64 px, begrenzte Palette, Nearest, Repeat.
 * 1 Texel ≈ 4 u → eine Kachel = 256 u (siehe TEXTURE_WORLD_SIZE).
 *
 * Gemalt wird in einen eigenen RGBA-Puffer statt mit Canvas-Pfaden: Canvas-
 * Linien/Kreise wären antialiased und bringen Zwischenfarben außerhalb der Palette.
 *
 * Alpha-Kanal = Emissiv-Maske: 255 = beleuchtet, 128 = selbstleuchtend
 * (Markierungen auf Start/Ziel, Lichtstreifen). Der Weltshader liest das aus.
 */

export const TEXTURE_SIZE = 64;
export const TEXTURE_WORLD_SIZE = 256;

type C = readonly [number, number, number];

const hex = (h: string): C => {
  const n = Number.parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

class Pixels {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  constructor(readonly size: number) {
    this.data = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  }
  set(x: number, y: number, c: C, emissive = false): void {
    const s = this.size;
    const xi = ((x % s) + s) % s;
    const yi = ((y % s) + s) % s;
    const i = (yi * s + xi) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = emissive ? 128 : 255;
  }
  get(x: number, y: number): C {
    const s = this.size;
    const i = ((((y % s) + s) % s) * s + (((x % s) + s) % s)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }
  fill(c: C): void {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, c);
  }
  rect(x: number, y: number, w: number, h: number, c: C, emissive = false): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, emissive);
  }
  /** Sprenkel aus einer kleinen Farbliste — bricht große Flächen auf, ohne die Palette zu sprengen. */
  speckle(rng: () => number, p: number, colors: readonly C[], skip?: (x: number, y: number) => boolean): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (skip?.(x, y)) continue;
        if (rng() < p) this.set(x, y, colors[Math.floor(rng() * colors.length)]);
      }
    }
  }
  /** Mittelwert RGBA 0..1 — Fernfarbe gegen Moiré (siehe worldMaterial). */
  average(): [number, number, number, number] {
    const acc = [0, 0, 0, 0];
    const n = this.size * this.size;
    for (let i = 0; i < n * 4; i += 4) {
      acc[0] += this.data[i];
      acc[1] += this.data[i + 1];
      acc[2] += this.data[i + 2];
      acc[3] += this.data[i + 3];
    }
    return [acc[0] / n / 255, acc[1] / n / 255, acc[2] / n / 255, acc[3] / n / 255];
  }
  toTexture(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = this.size;
    canvas.height = this.size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D-Canvas nicht verfügbar');
    ctx.putImageData(new ImageData(this.data, this.size, this.size), 0, 0);
    const tex = new CanvasTexture(canvas);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.colorSpace = NoColorSpace;
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    return tex;
  }
}

export interface MaterialTextures {
  readonly top: CanvasTexture;
  readonly side: CanvasTexture;
  /** Durchschnittsfarbe (RGBA, A = Emissiv-Maske) — ersetzt die Textur, wo sie stark verkleinert wird. */
  readonly avgTop: readonly [number, number, number, number];
  readonly avgSide: readonly [number, number, number, number];
}

// Farben der Markierungen — gleiche Töne wie Trims/Trigger (siehe palette.ts).
const START_GLOW = hex('#46ff9e');
const CHECK_GLOW = hex('#ffc23d');
const FINISH_GLOW = hex('#fff27a');

// ---------- Muster ----------

function floorTop(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const tiles = [hex('#7c7797'), hex('#8580a0'), hex('#736e8d')];
  const joint = hex('#3a3451');
  const bevel = hex('#9691ae');
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      p.rect(tx * 16, ty * 16, 16, 16, tiles[Math.floor(rng() * tiles.length)]);
    }
  }
  p.speckle(rng, 0.07, [hex('#8f8aa8'), hex('#6a6583')]);
  for (let i = 0; i < 64; i++) {
    for (let k = 0; k < 4; k++) {
      p.set(i, k * 16, joint);
      p.set(k * 16, i, joint);
      p.set(i, k * 16 + 1, bevel);
      p.set(k * 16 + 1, i, bevel);
    }
  }
  // Große Kachelgrenze alle 256 u etwas kräftiger: Tempo-Referenz am Boden.
  for (let i = 0; i < 64; i++) {
    p.set(i, 0, hex('#2a2540'));
    p.set(0, i, hex('#2a2540'));
  }
  return p;
}

function floorSide(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#5a5474'));
  p.speckle(rng, 0.08, [hex('#625c7d'), hex('#504a69')]);
  // Oberkante: heller Lippenstreifen (Zeile 0 = Brush-Oberkante, siehe levelMesh).
  p.rect(0, 0, 64, 1, hex('#8a85a4'));
  p.rect(0, 1, 64, 2, hex('#625c7d'));
  p.rect(0, 3, 64, 1, hex('#2f2a44'));
  for (let y = 4; y < 64; y++) {
    p.set(0, y, hex('#35304b'));
    p.set(32, y, hex('#35304b'));
  }
  for (let x = 0; x < 64; x++) p.set(x, 34, hex('#3d3854'));
  return p;
}

function wallSide(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const base = [hex('#2c2843'), hex('#302b49'), hex('#29253f')];
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 2; px++) p.rect(px * 32, py * 16, 32, 16, base[Math.floor(rng() * base.length)]);
  }
  p.speckle(rng, 0.05, [hex('#34304f'), hex('#25213a')]);
  for (let py = 0; py < 4; py++) {
    for (let x = 0; x < 64; x++) {
      p.set(x, py * 16, hex('#18152a'));
      p.set(x, py * 16 + 1, hex('#3d3860'));
    }
  }
  for (let y = 0; y < 64; y++) {
    p.set(0, y, hex('#18152a'));
    p.set(32, y, hex('#18152a'));
    p.set(1, y, hex('#38335a'));
    p.set(33, y, hex('#38335a'));
  }
  // Vereinzelte Status-LEDs in den Paneelen.
  for (let i = 0; i < 3; i++) {
    const x = 4 + Math.floor(rng() * 56);
    const y = 4 + Math.floor(rng() * 56);
    if (x % 32 > 2 && y % 16 > 2) p.set(x, y, hex('#8a6cff'), true);
  }
  return p;
}

function wallTop(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#37324f'));
  p.speckle(rng, 0.06, [hex('#3e3959'), hex('#2f2b46')]);
  for (let i = 0; i < 64; i++) {
    for (let k = 0; k < 2; k++) {
      p.set(i, k * 32, hex('#221e36'));
      p.set(k * 32, i, hex('#221e36'));
    }
  }
  return p;
}

function metalTop(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#5d6376'));
  p.speckle(rng, 0.04, [hex('#62687b'), hex('#565c6e')]);
  const hi = hex('#838a9e');
  const lo = hex('#40455a');
  // Riffelblech: versetzte kurze Diagonalen im 8-px-Raster.
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const x = cx * 8 + ((cy & 1) * 4) + 2;
      const y = cy * 8 + 2;
      const flip = (cx + cy) & 1;
      for (let k = 0; k < 3; k++) {
        const xx = flip ? x + k : x + 2 - k;
        p.set(xx, y + k, hi);
        p.set(xx, y + k + 1, lo);
      }
    }
  }
  for (let i = 0; i < 64; i++) {
    p.set(i, 0, hex('#353a4b'));
    p.set(0, i, hex('#353a4b'));
    p.set(i, 32, hex('#353a4b'));
    p.set(32, i, hex('#353a4b'));
  }
  for (const [x, y] of [[3, 3], [29, 3], [3, 29], [29, 29]] as const) {
    for (const [ox, oy] of [[0, 0], [32, 0], [0, 32], [32, 32]] as const) {
      p.set(x + ox, y + oy, hex('#b4b9c8'));
      p.set(x + ox + 1, y + oy + 1, hex('#3a3f50'));
    }
  }
  return p;
}

function metalSide(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const ribs = [hex('#5a6072'), hex('#6c7285'), hex('#4f5566'), hex('#474c5d')];
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) p.set(x, y, ribs[x & 3]);
  }
  p.speckle(rng, 0.03, [hex('#5f6578')]);
  p.rect(0, 0, 64, 1, hex('#a0a6b6'));
  p.rect(0, 1, 64, 2, hex('#3c4152'));
  for (let x = 0; x < 64; x++) {
    p.set(x, 32, hex('#383d4e'));
    p.set(x, 33, hex('#7a8093'));
  }
  for (let x = 4; x < 64; x += 16) {
    p.set(x, 6, hex('#c0c5d2'));
    p.set(x, 37, hex('#c0c5d2'));
  }
  return p;
}

/**
 * Surf-Flanke: Flow-Streifen parallel zum Grat statt 45°-Diagonalen (die wurden
 * nah vor der Kamera zu 30–40 px großen Treppenzähnen, Look-Kritik). levelMesh
 * legt auf Surf-Flanken eine eigene UV: Zeile 0 = Grat, Zeile 63 = Fuß (eine
 * Kachel pro Flankenhöhe), Spalten = 4 u entlang der Achse. Zeilen sind in der
 * Textur gerade — auf dem Schirm also gerade Linien, egal wie groß ein Texel wird.
 * Streifen ≥ 3 Zeilen, Kontrast etwa halb so hoch wie vorher, eine helle
 * Lichtbahn auf 1/3 der Höhe (Zeilen 20–22) als Linie, an der man sich halten
 * kann — beleuchtet, nicht selbstleuchtend: nah an der Flanke füllt sie sonst
 * ein Viertel des Bildes. Leise Querfugen alle 32 Spalten
 * (128 u) geben beim Surfen ein Tempo-Signal.
 * dark = Stirnkappen/Unterseite (Welt-Projektion wie jede Seitenfläche).
 */
function surfTex(rng: () => number, dark: boolean): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const a = dark ? hex('#18226e') : hex('#2233a2');
  const b = dark ? hex('#1f2d8c') : hex('#2d48c6');
  const mid = dark ? hex('#1b267c') : hex('#273db4');
  const deep = dark ? hex('#141c5c') : hex('#1c2a88');
  const light = dark ? hex('#3a58c0') : hex('#5a86ec');
  // Streifenfolge von oben (Grat) nach unten (Fuß), jede ≥ 3 Zeilen.
  const bands: ReadonlyArray<readonly [number, (typeof a)]> = [
    [3, b], [6, a], [4, mid], [5, a], [2, deep], [3, light], [2, deep], [6, a], [4, b], [6, a], [4, mid], [6, a], [5, b], [8, deep],
  ];
  let y = 0;
  for (const [h, c] of bands) {
    for (let j = 0; j < h && y < 64; j++, y++) for (let x = 0; x < 64; x++) p.set(x, y, c);
  }
  for (; y < 64; y++) for (let x = 0; x < 64; x++) p.set(x, y, deep);
  const isLight = (_x: number, yy: number): boolean => yy >= 20 && yy <= 22;
  p.speckle(rng, 0.025, [dark ? hex('#1d2982') : hex('#2a42bc')], isLight);
  for (let yy = 0; yy < 64; yy++) {
    if (isLight(0, yy)) continue;
    for (const x of [0, 32]) {
      const c = p.get(x, yy);
      p.set(x, yy, [Math.max(0, c[0] - 8), Math.max(0, c[1] - 10), Math.max(0, c[2] - 18)]);
    }
  }
  return p;
}

function accentTex(rng: () => number, top: boolean): Pixels {
  // Neutral hell — die Farbe kommt aus dem Brush-Tint (Default pink, siehe palette.ts).
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#c9c2dc'));
  p.speckle(rng, 0.05, [hex('#d2cce3'), hex('#bdb5d2')]);
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 64; i++) {
      p.set(i, k * 32, hex('#6e6788'));
      p.set(k * 32, i, hex('#6e6788'));
      p.set(i, k * 32 + 1, hex('#ece8f6'));
      p.set(k * 32 + 1, i, hex('#ece8f6'));
    }
  }
  if (!top) {
    // Leuchtstreifen quer durch jedes Paneel.
    for (let k = 0; k < 2; k++) {
      for (let x = 0; x < 64; x++) {
        if (x % 32 > 3 && x % 32 < 29) p.set(x, k * 32 + 14, hex('#ffffff'), true);
      }
    }
  } else {
    for (let k = 0; k < 2; k++) {
      for (let j = 0; j < 2; j++) p.rect(k * 32 + 14, j * 32 + 14, 4, 4, hex('#ffffff'), true);
    }
  }
  return p;
}

function hazardTex(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const y1 = hex('#f2c230');
  const y2 = hex('#d9a824');
  const k1 = hex('#1b1719');
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) p.set(x, y, ((x + y) & 15) < 8 ? (rng() < 0.08 ? y2 : y1) : k1);
  }
  return p;
}

/** Glyphe aus Zeichenkunst ('#' = Texel) ab Zeile y0, Spalte x0 setzen (wrappt über die Kachelkante). */
function glyph(p: Pixels, x0: number, y0: number, rows: readonly string[], c: C, emissive: boolean): void {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] === '#') p.set(x0 + i, y0 + j, c, emissive);
  });
}

/**
 * "↑C": Pfeil hoch und Taste C — gefüllt, Striche 2 Texel (fallen.md #25), 8 Texel
 * (32 u) hoch. Früher 12 Texel und je zwei Doppel-Chevrons: direkt vor der Wand
 * füllten Glyphen und Kanten-Trim ~19 % des Bildes mit flachem Cyan (Polish-Runde 2);
 * die Absprungzone trägt jetzt eine Bodenmarkierung auf H7 (level1.ts).
 */
const DUCK_ARROW = ['..#..', '.###.', '#####', '.###.', '.###.', '.###.', '.###.', '.###.'];
const DUCK_C = ['.###.', '##.##', '##...', '##...', '##...', '##...', '##.##', '.###.'];
/** Chevron nach oben, Arme 2 Texel breit (eine 1-Texel-Diagonale zerfällt nah vor der Kamera). */
const DUCK_CHEVRON = ['...#...', '..###..', '.##.##.', '##...##'];

/**
 * Crouch-Kante: sagt "Duck-Sprung hier" statt "Gefahr". Dunkles Paneel, darauf
 * selbstleuchtend das Piktogramm ↑C mittig auf Spalte 0 (Welt x = 0 = Linie der
 * Route; die Kopien 256 u daneben liegen außerhalb der 448 u breiten Wand) und
 * je ein Chevron nach oben links und rechts davon. Neutral weiß/grau —
 * der Brush-Tint färbt es in die Trim-Farbe des Levels. Nur die oberen 16 Zeilen
 * (64 u) sind sichtbar: die Wand ragt 64 u über die Absprung-Insel.
 */
function duckSide(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#34343f'));
  p.speckle(rng, 0.05, [hex('#3a3a46'), hex('#2e2e38')]);
  p.rect(0, 0, 64, 1, hex('#5a5a68'));
  for (let x = 0; x < 64; x++) p.set(x, 16, hex('#22222b'));
  const glow = hex('#ffffff');
  // Zeilen 4…11 (mittig in den sichtbaren 16), Chevrons auf halber Höhe daneben.
  glyph(p, -6, 4, DUCK_ARROW, glow, true);
  glyph(p, 1, 4, DUCK_C, glow, true);
  for (const cx of [20, 44]) glyph(p, cx - 3, 6, DUCK_CHEVRON, glow, true);
  return p;
}

/** Oberseite der Crouch-Kante: dunkel, ohne Leuchtlinien — an der Lippe bleibt nur der Trim. */
function duckTop(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#2c2c36'));
  p.speckle(rng, 0.06, [hex('#32323d'), hex('#27272f')]);
  for (let i = 0; i < 64; i++) {
    p.set(i, 0, hex('#1e1e26'));
    p.set(0, i, hex('#1e1e26'));
  }
  return p;
}

/**
 * Leuchtkörper ('light'): fast ganz selbstleuchtend, neutral hell — die Farbe kommt
 * aus dem Brush-Tint. Eine dunkle Fuge alle 128 u lässt lange Balken nicht zur
 * strukturlosen Fläche verschwimmen.
 */
function lightTex(): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) p.set(x, y, (x & 31) === 0 ? hex('#8c8c8c') : hex('#ffffff'), (x & 31) !== 0);
  return p;
}

function markedTop(rng: () => number, glow: C, base: readonly C[], joint: C, arrow = true): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) p.rect(tx * 16, ty * 16, 16, 16, base[Math.floor(rng() * base.length)]);
  }
  p.speckle(rng, 0.05, [base[0]]);
  for (let i = 0; i < 64; i++) {
    for (let k = 0; k < 4; k++) {
      p.set(i, k * 16, joint);
      p.set(k * 16, i, joint);
    }
  }
  // Gestrichelte Leuchtlinie am Kachelrand (alle 256 u).
  for (let i = 0; i < 64; i++) {
    if ((i >> 2) & 1) {
      p.set(i, 2, glow, true);
      p.set(2, i, glow, true);
    }
  }
  // Gefüllter Pfeil in der Mitte, Spitze im Bild oben = Welt −Z; levelMesh dreht die
  // UV auf die Laufrichtung. Bei 4 u/Texel werden dünne Diagonal-LINIEN nah vor der
  // Kamera zu Sägezähnen (Nearest-Vergrößerung, nicht affines Mapping) — die Treppe
  // zerlegt die Linie. Bei einer gefüllten Form trägt die Fläche die Gestalt; feine
  // 1-Texel-Stufen am Kopf lesen sich dann als glatteste mögliche Diagonale.
  // Start: ohne Pfeil — mittig je 256-u-Kachel lagen die Pfeile neben dem Spawn und
  // zeigten sich angeschnitten; die Level setzen dort Leucht-Chevrons (mat 'marking').
  if (!arrow) return p;
  for (let j = 0; j < 12; j++) {
    const hw = 1 + j;
    p.rect(32 - hw, 18 + j, 2 * hw, 1, glow, true);
  }
  p.rect(28, 30, 8, 16, glow, true);
  return p;
}

function markedSide(rng: () => number, glow: C, base: C, seam: C): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(base);
  p.speckle(rng, 0.05, [seam]);
  p.rect(0, 0, 64, 1, hex('#8c96a8'));
  p.rect(0, 2, 64, 2, glow, true);
  for (let y = 5; y < 64; y++) {
    p.set(0, y, seam);
    p.set(32, y, seam);
  }
  for (let x = 0; x < 64; x++) {
    if (((x >> 2) & 1) === 0) p.set(x, 8, glow, true);
  }
  return p;
}

function finishTop(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const w = [hex('#e4e0ee'), hex('#d8d3e4')];
  const k = hex('#1c1a26');
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const on = ((x >> 4) + (y >> 4)) & 1;
      p.set(x, y, on ? w[rng() < 0.1 ? 1 : 0] : k);
    }
  }
  for (let i = 0; i < 64; i++) {
    if ((i >> 2) & 1) {
      p.set(i, 0, FINISH_GLOW, true);
      p.set(0, i, FINISH_GLOW, true);
    }
  }
  return p;
}

function finishSide(): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  const w = hex('#dcd8e6');
  const k = hex('#1c1a26');
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) p.set(x, y, ((x >> 3) + (y >> 3)) & 1 ? w : k);
  }
  p.rect(0, 0, 64, 1, hex('#ffffff'));
  p.rect(0, 1, 64, 2, FINISH_GLOW, true);
  return p;
}

function darkTex(rng: () => number): Pixels {
  const p = new Pixels(TEXTURE_SIZE);
  p.fill(hex('#15111d'));
  p.speckle(rng, 0.08, [hex('#1a1523'), hex('#110e18')]);
  return p;
}

function build(mat: MaterialId): { top: Pixels; side: Pixels } {
  const rng = mulberry32(hashString(`velocity-tex-${mat}`));
  switch (mat) {
    case 'floor':
      return { top: floorTop(rng), side: floorSide(rng) };
    case 'wall':
      return { top: wallTop(rng), side: wallSide(rng) };
    case 'metal':
      return { top: metalTop(rng), side: metalSide(rng) };
    case 'surf':
      return { top: surfTex(rng, false), side: surfTex(rng, true) };
    case 'accent':
      return { top: accentTex(rng, true), side: accentTex(rng, false) };
    case 'hazard': {
      const t = hazardTex(rng);
      return { top: t, side: t };
    }
    case 'duck':
      return { top: duckTop(rng), side: duckSide(rng) };
    case 'light': {
      const t = lightTex();
      return { top: t, side: t };
    }
    case 'marking': {
      // Wird nie mit dem Weltmaterial gezeichnet (levelMesh überspringt es, trims.ts
      // malt die Oberseite) — neutral weiß, falls doch jemand danach fragt.
      const t = new Pixels(TEXTURE_SIZE);
      t.fill(hex('#ffffff'));
      return { top: t, side: t };
    }
    case 'start':
      return {
        top: markedTop(rng, START_GLOW, [hex('#2a3f4a'), hex('#2f4652'), hex('#273a44')], hex('#18252d'), false),
        side: markedSide(rng, START_GLOW, hex('#22323b'), hex('#18242b')),
      };
    case 'checkpoint':
      return {
        top: markedTop(rng, CHECK_GLOW, [hex('#453a2e'), hex('#4b4033'), hex('#3f352a')], hex('#2a221a')),
        side: markedSide(rng, CHECK_GLOW, hex('#3a3128'), hex('#271f18')),
      };
    case 'finish':
      return { top: finishTop(rng), side: finishSide() };
    case 'dark': {
      const t = darkTex(rng);
      return { top: t, side: t };
    }
  }
}

/** Texturen werden einmal pro Renderer gebaut und über Level-Wechsel hinweg wiederverwendet. */
export class TextureLibrary {
  private readonly cache = new Map<MaterialId, MaterialTextures>();

  get(mat: MaterialId): MaterialTextures {
    let t = this.cache.get(mat);
    if (!t) {
      const px = build(mat);
      const top = px.top.toTexture();
      const side = px.side === px.top ? top : px.side.toTexture();
      t = { top, side, avgTop: px.top.average(), avgSide: px.side.average() };
      this.cache.set(mat, t);
    }
    return t;
  }

  dispose(): void {
    for (const t of this.cache.values()) {
      t.top.dispose();
      if (t.side !== t.top) t.side.dispose();
    }
    this.cache.clear();
  }
}
