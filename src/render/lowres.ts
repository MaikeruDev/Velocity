/**
 * Ganzzahlige Low-Res-Geometrie: jeder Low-Res-Pixel wird exakt s×s
 * Geräte-Pixel groß. Gerechnet wird in Geräte-Pixeln (CSS × devicePixelRatio),
 * sonst wäre ein Low-Res-Pixel bei 125 % Windows-Skalierung z. B. 3,75 Pixel
 * breit und das Raster ungleichmäßig.
 *
 * `pixelHeight` ist eine Obergrenze: s = ceil(devH / pixelHeight), also nie mehr
 * Zeilen als eingestellt, und eine größere Einstellung ergibt nie weniger Zeilen.
 * Mit Math.round lieferte '240' bei 1080p 216 Zeilen, '448' aber 540 — und
 * '270' bei 720p nur 240 (Look-Kritik 003). Die echte Zahl zeigt das Menü über
 * `effectiveLines()` an.
 */
export interface LowResLayout {
  /** Ganzzahliger Skalierungsfaktor Low-Res → Geräte-Pixel. */
  readonly scale: number;
  readonly lowW: number;
  readonly lowH: number;
  /** CSS-Größe und -Versatz des Canvas (zentriert, darf um < scale Pixel überstehen). */
  readonly cssW: number;
  readonly cssH: number;
  readonly cssLeft: number;
  readonly cssTop: number;
}

function devicePixels(css: number, dpr: number): number {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return Math.max(1, Math.round(css * ratio));
}

function scaleFor(devH: number, pixelHeight: number): number {
  return Math.max(1, Math.ceil(devH / Math.max(1, pixelHeight)));
}

export function computeLowRes(cssWidth: number, cssHeight: number, pixelHeight: number, dpr: number): LowResLayout {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const devW = devicePixels(cssWidth, ratio);
  const devH = devicePixels(cssHeight, ratio);
  const scale = scaleFor(devH, pixelHeight);
  const lowH = Math.max(1, Math.ceil(devH / scale));
  const lowW = Math.max(1, Math.ceil(devW / scale));
  const cssW = (lowW * scale) / ratio;
  const cssH = (lowH * scale) / ratio;
  return {
    scale,
    lowW,
    lowH,
    cssW,
    cssH,
    cssLeft: Math.floor(((cssWidth - cssW) / 2) * ratio) / ratio,
    cssTop: Math.floor(((cssHeight - cssH) / 2) * ratio) / ratio,
  };
}

/**
 * Echte Zeilenzahl für eine Pixelhöhe-Einstellung bei dieser Fenstergröße
 * (für die Menü-Anzeige "270 → 240 Zeilen"). Immer ≤ pixelHeight; ist das Fenster
 * niedriger als pixelHeight Geräte-Pixel, ist es die Fensterhöhe (Faktor 1).
 */
export function effectiveLines(cssHeight: number, pixelHeight: number, dpr: number): number {
  const devH = devicePixels(cssHeight, dpr);
  return Math.max(1, Math.ceil(devH / scaleFor(devH, pixelHeight)));
}
