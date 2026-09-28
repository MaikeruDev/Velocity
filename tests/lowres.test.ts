import { describe, expect, it } from 'vitest';
import { computeLowRes, effectiveLines } from '../src/render/lowres';

/** Pixelhöhen aus engine/Settings.ts (PIXEL_HEIGHTS) — hier als Zahlen, der Test soll DOM-/Settings-frei bleiben. */
const STEPS = [224, 240, 270, 360, 448];
const WINDOWS: ReadonlyArray<readonly [number, number, number]> = [
  [1280, 720, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  // 125 %-Windows-Skalierung: 1536×864 CSS = 1920×1080 Geräte-Pixel.
  [1536, 864, 1.25],
  [1366, 768, 1],
  [3840, 2160, 1],
];

describe('computeLowRes (R3: Pixelhöhe ist eine Obergrenze)', () => {
  for (const [w, h, dpr] of WINDOWS) {
    it(`${w}×${h} @${dpr}: lowH ≤ Einstellung, monoton, ganzzahliges Raster`, () => {
      let prev = 0;
      for (const ph of STEPS) {
        const l = computeLowRes(w, h, ph, dpr);
        expect(l.lowH).toBeLessThanOrEqual(ph);
        expect(l.lowH).toBeGreaterThanOrEqual(prev);
        prev = l.lowH;
        // Raster deckt das Fenster (Geräte-Pixel) ganz ab, steht um < scale über.
        const devH = Math.round(h * dpr);
        const devW = Math.round(w * dpr);
        expect(l.lowH * l.scale).toBeGreaterThanOrEqual(devH);
        expect(l.lowH * l.scale - devH).toBeLessThan(l.scale);
        expect(l.lowW * l.scale).toBeGreaterThanOrEqual(devW);
        expect(l.lowW * l.scale - devW).toBeLessThan(l.scale);
        expect(Number.isInteger(l.scale)).toBe(true);
        expect(effectiveLines(h, ph, dpr)).toBe(l.lowH);
      }
    });
  }

  it('bekannte Fälle aus der Look-Kritik', () => {
    // 1080p: 270 bleibt exakt, 448 lieferte vorher 540 Zeilen (mehr als eingestellt).
    expect(computeLowRes(1920, 1080, 270, 1).lowH).toBe(270);
    expect(computeLowRes(1920, 1080, 448, 1).lowH).toBe(360);
    expect(computeLowRes(1920, 1080, 240, 1).lowH).toBe(216);
    // 720p: 270 → 240 (Faktor 3), 360 → 360.
    expect(computeLowRes(1280, 720, 270, 1).lowH).toBe(240);
    expect(computeLowRes(1280, 720, 360, 1).lowH).toBe(360);
  });

  it('Fenster niedriger als die Einstellung: Faktor 1, volle Fensterhöhe', () => {
    const l = computeLowRes(400, 200, 270, 1);
    expect(l.scale).toBe(1);
    expect(l.lowH).toBe(200);
    expect(effectiveLines(200, 270, 1)).toBe(200);
  });
});
