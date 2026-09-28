import { ACCENT_ROWS, CAP_HEIGHT, DESCENT_ROWS, GLYPHS, glyphFor } from './glyphs';
import type { Glyph } from './glyphs';

/**
 * Pixelgenauer Bitmap-Font für das Low-Res-HUD. Jede Glyphe wird je Stil
 * (Farbe, Kontur, Schatten, Skala) einmal per ImageData fertig komponiert und
 * danach 1:1 per drawImage kopiert — ein Blit pro Zeichen, keine Kantenglättung,
 * kein fillText, jedes Font-Pixel ist exakt scale×scale Canvas-Pixel.
 */

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  /** Ganzzahlige Vergrößerung (1 = 5×7 Pixel). */
  readonly scale?: number;
  /** CSS-Farbe. Default Weiß. */
  readonly color?: string;
  /** Schlagschatten nach rechts unten; true = Standard-Schattenfarbe. */
  readonly shadow?: boolean | string;
  /** Schattenversatz in Canvas-Pixeln (0..16). Default 1. */
  readonly shadowOffset?: number;
  /** 1-px-Kontur in alle 8 Richtungen; true = Standard-Konturfarbe. */
  readonly outline?: boolean | string;
  readonly align?: TextAlign;
  /** 0..1 Deckkraft (multipliziert mit ctx.globalAlpha). Blendet den Text als Ganzes aus. */
  readonly alpha?: number;
  /** Zusätzlicher Abstand zwischen Zeichen in Canvas-Pixeln. */
  readonly tracking?: number;
  /** Zeilenabstand in Font-Pixeln (bei '\n'). Default 11. */
  readonly lineHeight?: number;
}

export interface TextSize {
  readonly width: number;
  /** Höhe der Versalien (ohne Umlaut-Punkte über Versalien und Unterlängen). */
  readonly height: number;
}

export const DEFAULT_SHADOW = 'rgba(6, 3, 18, 0.85)';
export const DEFAULT_OUTLINE = '#07040f';

const ATLAS_ROWS = ACCENT_ROWS + CAP_HEIGHT + DESCENT_ROWS;
const DEFAULT_LINE_HEIGHT = 11;
/**
 * Obergrenze gecachter Stile (LRU). Zellen werden erst beim ersten Gebrauch
 * gebacken, ein Stil kostet also nur die Zeichen, die er wirklich zeigt — ein
 * verdrängter Stil ist beim nächsten Mal in Mikrosekunden wieder da.
 */
const MAX_STYLES = 160;
const MAX_SHADOW_OFFSET = 16;

type Rgba = readonly [number, number, number, number];

/** Jede Glyphe genau einmal (Aliase zeigen auf dieselbe), mit festem Index für die Zellen-Tabellen. */
const ALL_GLYPHS: readonly Glyph[] = [...new Set(GLYPHS.values())].filter((g) => g.rows.length > 0);
const GLYPH_INDEX: ReadonlyMap<Glyph, number> = new Map(ALL_GLYPHS.map((g, i) => [g, i]));

/** Ein fertig komponierter Stil: Zellen je Glyphe, lazy gebacken. */
interface StyledFont {
  readonly scale: number;
  readonly fill: Rgba;
  readonly outline: Rgba | null;
  readonly shadow: Rgba | null;
  readonly shadowOffset: number;
  /** Rand der Zelle um das Glyphen-Rechteck (Kontur links/oben, Kontur/Schatten rechts/unten). */
  readonly padL: number;
  readonly padT: number;
  readonly padR: number;
  readonly padB: number;
  /** RGBA je Layer-Kombination (Index = Bits Kontur 1 | Schatten 2 | Füllung 4). */
  readonly combos: Uint8ClampedArray;
  readonly cells: (HTMLCanvasElement | null)[];
  /** Schlüssel ohne String-Bau: Farbe steckt im Map-Schlüssel, der Rest wird direkt verglichen. */
  readonly outlineKey: string | null;
  readonly shadowKey: string | null;
  /** LRU-Stempel (bleibt Smi, siehe BitmapFont.touch). */
  used: number;
}

interface StyleMemo {
  color: string;
  outline: string | null;
  shadow: string | null;
  so: number;
  scale: number;
  font: StyledFont;
}

export class BitmapFont {
  readonly capHeight = CAP_HEIGHT;
  /**
   * Stile je Füllfarbe; innerhalb einer Farbe linear gesucht (meist 1–3 Einträge).
   * Früher ein Map-Schlüssel `${color}|…` — der String entstand bei jedem Farbwechsel
   * eines Stil-Objekts neu (Gain-Popups, Sync-Zeile) und war der größte HUD-Müll.
   */
  private readonly styles = new Map<string, StyledFont[]>();
  private styleCount = 0;
  private useClock = 0;
  private readonly colorCache = new Map<string, Rgba>();
  /** Letzter aufgelöster Stil je Stil-Objekt (Treffer ohne Key-String). */
  private readonly memo = new WeakMap<TextStyle, StyleMemo>();
  private probe: CanvasRenderingContext2D | null = null;
  private scratch: CanvasRenderingContext2D | null = null;

  /** Anzahl gecachter Stile (Diagnose). */
  get cachedStyles(): number {
    return this.styleCount;
  }

  /**
   * Zeichen eines Stils vorab backen (z. B. Ziffern aller Speedometer-Farben beim
   * Levelladen) — ein kalter Stil kostet sonst ~0.05–0.1 ms pro Zeichen mitten im Lauf.
   */
  prewarm(chars: string, style: TextStyle): void {
    const font = this.resolve(style);
    for (let i = 0; i < chars.length; i += charLength(chars, i)) this.cell(font, glyphAt(chars, i));
  }

  /** Nur die Breite (Canvas-Pixel, längste Zeile) — ohne Ergebnisobjekt, für den Frame-Pfad. */
  width(text: string, scale = 1, tracking = 0): number {
    const s = Math.max(1, Math.round(scale));
    let width = 0;
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      width = Math.max(width, lineWidth(text, start, end < 0 ? text.length : end, s, tracking));
      if (end < 0) return width;
      start = end + 1;
    }
  }

  /** Breite und Versalhöhe in Canvas-Pixeln. */
  measure(text: string, scale = 1, tracking = 0): TextSize {
    const s = Math.max(1, Math.round(scale));
    let width = 0;
    let lines = 0;
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      width = Math.max(width, lineWidth(text, start, end < 0 ? text.length : end, s, tracking));
      lines++;
      if (end < 0) break;
      start = end + 1;
    }
    const height = lines * CAP_HEIGHT * s + (lines - 1) * (DEFAULT_LINE_HEIGHT - CAP_HEIGHT) * s;
    return { width, height };
  }

  /**
   * Text zeichnen. (x, y) = links oben der Versalhöhe (bei align center/right
   * bezieht sich x auf Mitte bzw. rechten Rand). Gibt die Breite zurück.
   */
  drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: TextStyle = {}): number {
    const scale = Math.max(1, Math.round(style.scale ?? 1));
    const tracking = style.tracking ?? 0;
    const alpha = style.alpha ?? 1;
    if (!(alpha > 0) || text.length === 0) return 0;
    const lineStep = (style.lineHeight ?? DEFAULT_LINE_HEIGHT) * scale;
    const font = this.resolve(style);
    const align = style.align ?? 'left';

    let maxWidth = 0;
    let start = 0;
    for (let li = 0; ; li++) {
      const nl = text.indexOf('\n', start);
      const end = nl < 0 ? text.length : nl;
      const w = lineWidth(text, start, end, scale, tracking);
      maxWidth = Math.max(maxWidth, w);
      // Ganzzahlig runden: halbe Pixel würden beim Kopieren verschmieren.
      const lx = Math.round(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x);
      const ly = Math.round(y + li * lineStep);
      if (w > 0) {
        if (alpha >= 1) this.blitLine(ctx, font, text, start, end, lx, ly, tracking);
        else this.blitLineFaded(ctx, font, text, start, end, lx, ly, w, tracking, alpha);
      }
      if (nl < 0) break;
      start = nl + 1;
    }
    return maxWidth;
  }

  // ---------------------------------------------------------------- intern

  private blitLine(
    ctx: CanvasRenderingContext2D,
    font: StyledFont,
    text: string,
    start: number,
    end: number,
    x: number,
    y: number,
    tracking: number,
  ): void {
    const s = font.scale;
    let cx = x;
    const top = y - ACCENT_ROWS * s - font.padT;
    for (let i = start; i < end; i += charLength(text, i)) {
      const g = glyphAt(text, i);
      const cell = this.cell(font, g);
      if (cell) ctx.drawImage(cell, cx - font.padL, top);
      cx += g.width * s + s + tracking;
    }
  }

  /**
   * Verblassender Text: erst voll deckend in einen Scratch-Canvas, dann einmal
   * mit Deckkraft kopieren. Direkt mit globalAlpha gezeichnet summierten sich
   * die überlappenden Konturränder benachbarter Zeichen zu dunklen Streifen.
   */
  private blitLineFaded(
    ctx: CanvasRenderingContext2D,
    font: StyledFont,
    text: string,
    start: number,
    end: number,
    x: number,
    y: number,
    w: number,
    tracking: number,
    alpha: number,
  ): void {
    const sw = w + font.padL + font.padR;
    const sh = ATLAS_ROWS * font.scale + font.padT + font.padB;
    const sc = this.scratchCtx(sw, sh);
    sc.clearRect(0, 0, sw, sh);
    this.blitLine(sc, font, text, start, end, font.padL, ACCENT_ROWS * font.scale + font.padT, tracking);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.drawImage(sc.canvas, 0, 0, sw, sh, x - font.padL, y - ACCENT_ROWS * font.scale - font.padT, sw, sh);
    ctx.globalAlpha = prev;
  }

  private scratchCtx(w: number, h: number): CanvasRenderingContext2D {
    let sc = this.scratch;
    if (!sc) {
      const c = document.createElement('canvas');
      c.width = Math.max(64, w);
      c.height = Math.max(16, h);
      sc = c.getContext('2d');
      if (!sc) throw new Error('BitmapFont: 2D-Kontext nicht verfügbar');
      this.scratch = sc;
    }
    const c = sc.canvas;
    if (c.width < w || c.height < h) {
      // Nur wachsen: Größenänderung leert den Canvas ohnehin und kommt so höchstens ein paar Mal vor.
      c.width = Math.max(c.width, w);
      c.height = Math.max(c.height, h);
    }
    sc.imageSmoothingEnabled = false;
    return sc;
  }

  private resolve(style: TextStyle): StyledFont {
    const color = style.color ?? '#ffffff';
    const outline = style.outline === true ? DEFAULT_OUTLINE : style.outline || null;
    const shadow = style.shadow === true ? DEFAULT_SHADOW : style.shadow || null;
    const so = style.shadowOffset ?? 1;
    const scale = Math.max(1, Math.round(style.scale ?? 1));
    // Wiederverwendete Stil-Objekte (HUD) treffen hier ohne Key-String — keine Allokation pro Frame.
    const m = this.memo.get(style);
    if (m && m.color === color && m.outline === outline && m.shadow === shadow && m.so === so && m.scale === scale) return m.font;
    const font = this.styled(color, outline, shadow, so, scale);
    if (m) {
      m.color = color;
      m.outline = outline;
      m.shadow = shadow;
      m.so = so;
      m.scale = scale;
      m.font = font;
    } else this.memo.set(style, { color, outline, shadow, so, scale, font });
    return font;
  }

  /** Frame-Pfad: Suche ohne Allokation (kein Schlüssel-String, keine Map-Umordnung). */
  private styled(color: string, outline: string | null, shadow: string | null, shadowOffset: number, scale: number): StyledFont {
    const so = shadow ? Math.max(0, Math.min(MAX_SHADOW_OFFSET, Math.round(shadowOffset))) : 0;
    const list = this.styles.get(color);
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (f.outlineKey === outline && f.shadowKey === shadow && f.shadowOffset === so && f.scale === scale) {
          this.touch(f);
          return f;
        }
      }
    }
    return this.createStyle(color, outline, shadow, so, scale);
  }

  /** LRU-Stempel; & 0x3fffffff hält den Zähler im Smi-Bereich (sonst HeapNumber pro Schreiben). */
  private touch(f: StyledFont): void {
    this.useClock = (this.useClock + 1) & 0x3fffffff;
    f.used = this.useClock;
  }

  /** Selten (neuer Stil): darf allokieren. Bei vollem Cache fliegt der am längsten unbenutzte Stil. */
  private createStyle(
    color: string,
    outline: string | null,
    shadow: string | null,
    so: number,
    scale: number,
  ): StyledFont {
    const o = outline ? 1 : 0;
    const fill = this.parseColor(color);
    const outlineRgba = outline ? this.parseColor(outline) : null;
    const shadowRgba = shadow ? this.parseColor(shadow) : null;
    const font: StyledFont = {
      scale,
      fill,
      outline: outlineRgba,
      shadow: shadowRgba,
      shadowOffset: so,
      padL: o,
      padT: o,
      padR: Math.max(o, so),
      padB: Math.max(o, so),
      combos: composeCombos(fill, outlineRgba, shadowRgba),
      cells: new Array<HTMLCanvasElement | null>(ALL_GLYPHS.length).fill(null),
      outlineKey: outline,
      shadowKey: shadow,
      used: 0,
    };
    this.touch(font);
    if (this.styleCount >= MAX_STYLES) this.evictOldest();
    // Nach dem Verdrängen neu holen: die Liste dieser Farbe kann gerade gelöscht worden sein.
    const list = this.styles.get(color);
    if (list) list.push(font);
    else this.styles.set(color, [font]);
    this.styleCount++;
    return font;
  }

  /** Am längsten unbenutzten Stil entfernen (linear über alle — nur bei vollem Cache, also selten). */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestIdx = -1;
    let oldestUsed = Infinity;
    for (const [key, list] of this.styles) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].used < oldestUsed) {
          oldestUsed = list[i].used;
          oldestKey = key;
          oldestIdx = i;
        }
      }
    }
    if (oldestKey === null) return;
    const list = this.styles.get(oldestKey);
    if (!list) return;
    list.splice(oldestIdx, 1);
    if (list.length === 0) this.styles.delete(oldestKey);
    this.styleCount--;
  }

  private cell(font: StyledFont, g: Glyph): HTMLCanvasElement | null {
    const i = GLYPH_INDEX.get(g);
    if (i === undefined) return null; // Leerzeichen
    return (font.cells[i] ??= bakeCell(font, g));
  }

  /** Beliebige CSS-Farbe → RGBA über ein 1×1-Canvas (der Browser parst, wir nicht). */
  private parseColor(color: string): Rgba {
    const hit = this.colorCache.get(color);
    if (hit) return hit;
    if (!this.probe) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      this.probe = c.getContext('2d', { willReadFrequently: true });
    }
    let out: Rgba = [255, 255, 255, 255];
    const p = this.probe;
    if (p) {
      p.clearRect(0, 0, 1, 1);
      p.fillStyle = '#ffffff';
      p.fillStyle = color;
      p.fillRect(0, 0, 1, 1);
      const d = p.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3]];
    }
    if (this.colorCache.size > 256) this.colorCache.clear();
    this.colorCache.set(color, out);
    return out;
  }
}

/**
 * Eine Glyphe fertig komponieren: Kontur (Füllmaske um 1 px in alle 8 Richtungen
 * verschoben), darüber Schatten, darüber Füllung — dieselbe Reihenfolge wie früher
 * die einzelnen Blits, aber jeder Layer nur einmal (kein Aufsummieren halbtransparenter Kontur).
 */
function bakeCell(font: StyledFont, g: Glyph): HTMLCanvasElement {
  const s = font.scale;
  const cw = g.width * s + font.padL + font.padR;
  const ch = ATLAS_ROWS * s + font.padT + font.padB;
  const mask = new Uint8Array(cw * ch);
  for (let row = 0; row < g.rows.length; row++) {
    const bits = g.rows[row];
    const py = (row + g.top + ACCENT_ROWS) * s + font.padT;
    for (let col = 0; col < bits.length; col++) {
      if (bits.charCodeAt(col) !== 35) continue; // '#'
      const px = col * s + font.padL;
      for (let dy = 0; dy < s; dy++) mask.fill(1, (py + dy) * cw + px, (py + dy) * cw + px + s);
    }
  }
  // Layer-Bits je Pixel: 1 = Kontur, 2 = Schatten, 4 = Füllung. Vom Füllpixel aus markieren
  // (Kontur = 8 Nachbarn, Schatten = um shadowOffset verschoben) — die Ränder sind dafür reserviert.
  const layers = new Uint8Array(cw * ch);
  const so = font.shadowOffset;
  const outline = font.outline !== null;
  const shadow = font.shadow !== null;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      if (mask[i] !== 1) continue;
      layers[i] |= 4;
      if (outline) {
        for (let oy = -1; oy <= 1; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= ch) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            if ((ox !== 0 || oy !== 0) && nx >= 0 && nx < cw) layers[ny * cw + nx] |= 1;
          }
        }
      }
      if (shadow && y + so < ch && x + so < cw) layers[(y + so) * cw + x + so] |= 2;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, cw);
  canvas.height = Math.max(1, ch);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('BitmapFont: 2D-Kontext nicht verfügbar');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const data = img.data;
  const combos = font.combos;
  for (let i = 0; i < layers.length; i++) {
    const code = layers[i];
    if (code === 0) continue;
    const o = i * 4;
    const c = code * 4;
    data[o] = combos[c];
    data[o + 1] = combos[c + 1];
    data[o + 2] = combos[c + 2];
    data[o + 3] = combos[c + 3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Die 8 möglichen Layer-Kombinationen eines Stils einmal vorab komponieren
 * (source-over: Kontur, darüber Schatten, darüber Füllung) — backen ist danach reines Kopieren.
 */
function composeCombos(fill: Rgba, outline: Rgba | null, shadow: Rgba | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(8 * 4);
  for (let code = 1; code < 8; code++) {
    // Vormultipliziert akkumulieren, am Ende zurückrechnen.
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const layers: (Rgba | null)[] = [code & 1 ? outline : null, code & 2 ? shadow : null, code & 4 ? fill : null];
    for (const c of layers) {
      if (!c) continue;
      const sa = c[3] / 255;
      r = c[0] * sa + r * (1 - sa);
      g = c[1] * sa + g * (1 - sa);
      b = c[2] * sa + b * (1 - sa);
      a = sa + a * (1 - sa);
    }
    if (a <= 0) continue;
    out[code * 4] = Math.round(r / a);
    out[code * 4 + 1] = Math.round(g / a);
    out[code * 4 + 2] = Math.round(b / a);
    out[code * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

function lineWidth(text: string, start: number, end: number, scale: number, tracking: number): number {
  let w = 0;
  let n = 0;
  for (let i = start; i < end; i += charLength(text, i)) {
    w += glyphAt(text, i).width * scale;
    n++;
  }
  return n === 0 ? 0 : w + (n - 1) * (scale + tracking);
}

/** Surrogatpaare (Emoji u. Ä.) zählen als ein Zeichen — sonst zwei Ersatzkästchen. */
function charLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
}

/** Glyphe je UTF-16-Code (BMP), lazy: glyphFor allokiert (Zeichen-String, normalize) — pro Frame zu teuer. */
const GLYPH_BY_CODE: (Glyph | undefined)[] = [];

function glyphAt(text: string, i: number): Glyph {
  if (charLength(text, i) === 2) return glyphFor(text.slice(i, i + 2));
  const code = text.charCodeAt(i);
  return (GLYPH_BY_CODE[code] ??= glyphFor(text[i]));
}

/** Gemeinsame Instanz — ein Glyphen-Cache für das ganze HUD. */
export const pixelFont = new BitmapFont();

export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style?: TextStyle): number {
  return pixelFont.drawText(ctx, text, x, y, style);
}

export function measureText(text: string, scale = 1, tracking = 0): TextSize {
  return pixelFont.measure(text, scale, tracking);
}
