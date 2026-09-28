import { DataTexture, NearestFilter, NoColorSpace, RGBAFormat, RepeatWrapping, ClampToEdgeWrapping, UnsignedByteType } from 'three';

/**
 * Prozedurale Texturen der Viewmodel-Gegenstände (Plan 006): kleine Pixelpuffer mit fester
 * Palette, Nearest, keine Mipmaps (look.md). Zeile 0 = unten (v = 0) — so liest sich der
 * Code wie die UV-Koordinaten. Alpha 128 = selbstleuchtend (wie die Welt-Texturen).
 *
 * Alle Motive sind EIGENE Entwürfe: keine Markenlogos, kein Schriftzug, keine bekannten
 * Figuren (Nutzerwunsch). "Text" auf Karte und Dose sind nur Pixelblöcke.
 */

type C = readonly [number, number, number];

const hex = (h: number): C => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

class Px {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }

  set(x: number, y: number, c: C, emissive = false): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = emissive ? 128 : 255;
  }

  /** Waagerecht umlaufend (Dosen-Etikett). */
  setWrap(x: number, y: number, c: C, emissive = false): void {
    this.set(((Math.round(x) % this.w) + this.w) % this.w, y, c, emissive);
  }

  rect(x: number, y: number, w: number, h: number, c: C, emissive = false): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, emissive);
  }

  fill(c: C): void {
    this.rect(0, 0, this.w, this.h, c);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: C, emissive = false): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c, emissive);
      }
    }
  }

  /** Gefülltes Dreieck (Pixelmitten-Test, ohne Antialiasing). */
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: C, emissive = false, wrap = false): void {
    const minX = Math.floor(Math.min(ax, bx, cx));
    const maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy));
    const maxY = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
          if (wrap) this.setWrap(x, y, c, emissive);
          else this.set(x, y, c, emissive);
        }
      }
    }
  }

  /** 1-px-Kontur um alle Pixel der Farbe `inner` (in Farbe `edge`), nur auf `onto`-Pixeln. */
  outline(inner: C, edge: C, onto: (c: C) => boolean, wrap = false): void {
    const hits: number[] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!onto(this.get(x, y))) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const xx = wrap ? (x + dx + this.w) % this.w : x + dx;
            if (xx < 0 || xx >= this.w || y + dy < 0 || y + dy >= this.h) continue;
            if (same(this.get(xx, y + dy), inner)) near = true;
          }
        }
        if (near) hits.push(x, y);
      }
    }
    for (let i = 0; i < hits.length; i += 2) this.set(hits[i], hits[i + 1], edge);
  }

  get(x: number, y: number): C {
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  toTexture(wrapS = false): DataTexture {
    const t = new DataTexture(this.data, this.w, this.h, RGBAFormat, UnsignedByteType);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = wrapS ? RepeatWrapping : ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.colorSpace = NoColorSpace;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  }
}

function same(a: C, b: C): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// ------------------------------------------------------------------ Dose

const CAN_WHITE = hex(0xf2f3ee);
const CAN_ALU = hex(0xb9bec8);
const CAN_ALU_DARK = hex(0x7d8390);
const CAN_GREEN = hex(0x5dff4a);
const CAN_GREEN_DARK = hex(0x1f9e2c);
const INK = hex(0x121418);
const CAN_GREY = hex(0x9aa0a8);

/**
 * Etikett der Energy-Drink-Dose, 64 × 64, u = rundherum, v = unten → oben.
 * Eigenes Motiv: zwei neongrüne Zacken-Blitze mit schwarzer Kante (umlaufend zweimal, damit
 * man aus jeder Richtung einen sieht), zwei grüne Ringe, Alu-Hals und -Boden. Kein Schriftzug.
 */
export function canLabelTexture(): DataTexture {
  const p = new Px(64, 64);
  p.fill(CAN_WHITE);
  p.rect(0, 0, 64, 3, CAN_ALU);
  p.rect(0, 0, 64, 1, CAN_ALU_DARK);
  p.rect(0, 57, 64, 7, CAN_ALU);
  p.rect(0, 62, 64, 2, CAN_ALU_DARK);
  // Ringe
  p.rect(0, 5, 64, 2, CAN_GREEN, true);
  p.rect(0, 52, 64, 2, CAN_GREEN, true);
  for (const u0 of [8, 40]) {
    // Zacken-Blitz: drei schräge Balken, oben breit, unten spitz.
    p.tri(u0 + 4, 48, u0 + 14, 48, u0 + 6, 33, CAN_GREEN, true, true);
    p.tri(u0 + 6, 33, u0 + 14, 48, u0 + 12, 33, CAN_GREEN, true, true);
    p.tri(u0 + 3, 35, u0 + 15, 35, u0 + 5, 22, CAN_GREEN, true, true);
    p.tri(u0 + 5, 22, u0 + 15, 35, u0 + 12, 22, CAN_GREEN, true, true);
    p.tri(u0 + 4, 24, u0 + 13, 24, u0 + 9, 10, CAN_GREEN, true, true);
    // Pseudo-Schrift: kleine graue Blöcke unter dem Motiv.
    p.rect(u0 + 2, 15, 3, 1, CAN_GREY);
    p.rect(u0 + 13, 15, 4, 1, CAN_GREY);
  }
  p.outline(CAN_GREEN, INK, (c) => same(c, CAN_WHITE), true);
  // Innenkante des Blitzes dunkler grün (Tiefe).
  for (const u0 of [8, 40]) p.rect(u0 + 8, 28, 1, 5, CAN_GREEN_DARK, true);
  return p.toTexture(true);
}

/** Deckel: Alu mit Rand und Niete (16 × 16). */
export function canLidTexture(): DataTexture {
  const p = new Px(16, 16);
  p.fill(CAN_ALU);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 6.6) p.set(x, y, CAN_ALU_DARK);
      else if (d > 5.6) p.set(x, y, hex(0xd6dae0));
    }
  }
  return p.toTexture();
}

// ------------------------------------------------------------------ Sammelkarte

const CARD_W = 48;
const CARD_H = 64;
const NAVY = hex(0x161a3a);
const NAVY_2 = hex(0x242b5e);
const CYAN = hex(0x39f0ff);
const MAGENTA = hex(0xff4fd8);
const PAPER = hex(0xf0ecd8);
const PAPER_2 = hex(0xd8d2b8);
const MON_GREEN = hex(0x6fe36a);
const MON_GREEN_D = hex(0x2f9a4a);
const MON_BELLY = hex(0xd9f7a8);
const WHITE = hex(0xffffff);
const GOLD = hex(0xffd23a);

/**
 * Vorderseite (48 × 64): eigenes Monster "Blitzmolch" — runder grüner Kerl mit zwei
 * Hörnchen, großen Augen und Blitzschwanz auf Magenta-Violett-Verlauf (Holo-Fenster, der
 * Shader legt dort Regenbogen-Streifen darüber), Namensleiste und Attacken als Pixelblöcke,
 * Rahmen Navy mit Cyan-Linie. Bewusst KEIN gelber Rahmen, kein Logo einer echten Serie.
 */
export function cardFrontTexture(): DataTexture {
  const p = new Px(CARD_W, CARD_H);
  p.fill(NAVY);
  p.rect(2, 2, CARD_W - 4, CARD_H - 4, CYAN, true);
  p.rect(3, 3, CARD_W - 6, CARD_H - 6, PAPER);
  // Namensleiste oben
  p.rect(4, 55, CARD_W - 8, 6, NAVY_2);
  p.rect(6, 57, 14, 2, WHITE);
  p.rect(22, 57, 5, 2, WHITE);
  p.ellipse(39, 58, 2.5, 2.5, GOLD, true);
  p.rect(38, 56, 2, 4, NAVY_2);
  // Holo-Fenster (uv y 0.47..0.9 ≈ Zeile 30..57, x 0.08..0.92 → Spalte 4..44)
  for (let y = 31; y < 54; y++) {
    const k = (y - 31) / 23;
    const c: C = [Math.round(255 * (0.55 + 0.35 * k)), Math.round(255 * (0.18 + 0.1 * k)), Math.round(255 * (0.62 - 0.1 * k))];
    p.rect(5, y, CARD_W - 10, 1, c);
  }
  // Sterne im Hintergrund
  for (const [x, y] of [
    [8, 50],
    [40, 48],
    [11, 36],
    [37, 34],
    [30, 51],
  ] as const)
    p.set(x, y, WHITE, true);
  // Monster: Körper, Bauch, Hörnchen, Augen, Mund, Ärmchen, Blitzschwanz.
  p.tri(33, 40, 43, 47, 36, 44, GOLD, true);
  p.tri(36, 44, 43, 47, 38, 38, GOLD, true);
  p.ellipse(24, 40, 10, 8.5, MON_GREEN);
  p.ellipse(24, 37.5, 6.5, 5, MON_BELLY);
  p.tri(15, 46, 18, 53, 20, 47, MON_GREEN_D);
  p.tri(28, 47, 30, 53, 33, 46, MON_GREEN_D);
  p.ellipse(20.5, 43, 2.6, 3, WHITE);
  p.ellipse(27.5, 43, 2.6, 3, WHITE);
  p.rect(21, 42, 2, 2, INK);
  p.rect(27, 42, 2, 2, INK);
  p.rect(22, 37, 5, 1, INK);
  p.set(21, 38, INK);
  p.set(27, 38, INK);
  p.ellipse(14.5, 38, 2, 1.6, MON_GREEN_D);
  p.ellipse(33.5, 38, 2, 1.6, MON_GREEN_D);
  p.ellipse(19, 32.5, 2.5, 1.5, MON_GREEN_D);
  p.ellipse(29, 32.5, 2.5, 1.5, MON_GREEN_D);
  p.outline(MON_GREEN, INK, (c) => !same(c, MON_GREEN) && !same(c, MON_BELLY) && !same(c, WHITE) && !same(c, INK) && !same(c, MON_GREEN_D) && !same(c, GOLD));
  // Rahmen des Fensters
  p.rect(4, 30, CARD_W - 8, 1, PAPER_2);
  p.rect(4, 54, CARD_W - 8, 1, PAPER_2);
  // Attacken: Energie-Punkt + Pixelzeile + Schaden
  for (const y of [22, 14]) {
    p.ellipse(8, y + 1, 1.6, 1.6, MAGENTA, true);
    p.rect(12, y + 1, 18, 2, NAVY_2);
    p.rect(34, y, 7, 3, NAVY);
  }
  p.rect(6, 9, CARD_W - 12, 1, PAPER_2);
  p.rect(7, 6, 12, 1, PAPER_2);
  // Seltenheit: kleiner Stern unten rechts
  p.set(39, 6, GOLD, true);
  p.set(38, 6, GOLD, true);
  p.set(40, 6, GOLD, true);
  p.set(39, 7, GOLD, true);
  p.set(39, 5, GOLD, true);
  return p.toTexture();
}

/** Rückseite: Navy mit Cyan-Spirale um ein "V"-Emblem — deutlich anders als vorn (Spin lesbar). */
export function cardBackTexture(): DataTexture {
  const p = new Px(CARD_W, CARD_H);
  p.fill(NAVY);
  p.rect(2, 2, CARD_W - 4, CARD_H - 4, MAGENTA, true);
  p.rect(3, 3, CARD_W - 6, CARD_H - 6, NAVY_2);
  const cx = CARD_W / 2 - 0.5;
  const cy = CARD_H / 2 - 0.5;
  // Spirale aus Punkten (archimedisch), gedrittelt in Cyan/Magenta.
  for (let a = 0; a < Math.PI * 7; a += 0.05) {
    const r = 2 + a * 1.05;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 1.25;
    if (x < 4 || x > CARD_W - 5 || y < 4 || y > CARD_H - 5) continue;
    p.set(x, y, a % 2.1 < 1.4 ? CYAN : MAGENTA, true);
  }
  // Emblem: Kreis mit V
  p.ellipse(cx, cy, 8, 8, NAVY);
  p.ellipse(cx, cy, 7, 7, GOLD, true);
  p.ellipse(cx, cy, 5.6, 5.6, NAVY);
  p.tri(cx - 4, cy + 3.5, cx - 1.5, cy + 3.5, cx + 0.25, cy - 4, WHITE, true);
  p.tri(cx - 1.5, cy + 3.5, cx + 0.25, cy - 4, cx + 0.25, cy - 1, WHITE, true);
  p.tri(cx + 4.5, cy + 3.5, cx + 2, cy + 3.5, cx + 0.25, cy - 4, WHITE, true);
  p.tri(cx + 2, cy + 3.5, cx + 0.25, cy - 4, cx + 0.25, cy - 1, WHITE, true);
  return p.toTexture();
}

// ------------------------------------------------------------------ Butterfly-Messer

const STEEL = hex(0xc8ced8);
const STEEL_D = hex(0x8a92a0);
const STEEL_L = hex(0xeef2f8);

/** Griff (8 × 64): Aluminium-Trainer mit Langlöchern und Neon-Nietstreifen. */
export function knifeHandleTexture(): DataTexture {
  const p = new Px(8, 64);
  p.fill(hex(0x5a6078));
  p.rect(0, 0, 1, 64, hex(0x7a82a0));
  p.rect(7, 0, 1, 64, hex(0x262938));
  for (const y of [8, 22, 36]) p.rect(2, y, 4, 9, hex(0x15161f));
  p.rect(3, 52, 2, 2, MAGENTA, true);
  p.rect(3, 58, 2, 2, CYAN, true);
  return p.toTexture();
}

/** Klinge (16 × 64): stumpfe Trainer-Klinge mit Löchern, Rücken dunkler, Kante hell. */
export function knifeBladeTexture(): DataTexture {
  const p = new Px(16, 64);
  p.fill(STEEL);
  p.rect(0, 0, 3, 64, STEEL_D);
  p.rect(13, 0, 3, 64, STEEL_L);
  for (const y of [18, 32, 46]) p.ellipse(7.5, y, 2.4, 2.4, hex(0x1c1e26));
  return p.toTexture();
}
