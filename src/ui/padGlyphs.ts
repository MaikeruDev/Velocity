/**
 * Tasten-Symbole fürs Menü (Plan 011 §1.6): Hinweis × Gerät → Glyphe, und DOM dafür im PS2-Pixel-Look.
 * Keine Marken-Logos — Tastatur = Kappe mit Text, Xbox = Buchstabe in Gerätefarbe, PlayStation = eigene
 * 7×7-Pixelformen (Kreuz/Kreis/Quadrat/Dreieck), D-Pad als Pixel-Kreuz. Formen als SVG-Raster mit crispEdges,
 * ganzzahlig skaliert (CSS-Größe = Vielfaches von 7 px).
 *
 * Auflösung und Tabellen sind DOM-frei (Vitest); nur glyphNode/fillGlyphs bauen DOM (Menü-Code, kein Frame-Pfad).
 */
import type { FrontDoorGlyph, FrontDoorGlyphFamily, FrontDoorPrompt } from './menuLab/types';
import type { GlyphStyle, InputDevice, PadBindAction, PadBinds, PadButtonCode } from '../engine/pad/types';

export type { FrontDoorGlyph, FrontDoorGlyphFamily, FrontDoorPrompt } from './menuLab/types';

/** Familie aus zuletzt benutztem Gerät + Einstellung: die Einstellung schlägt die Erkennung, generic → Xbox. */
export function glyphFamily(device: InputDevice, pref: GlyphStyle): FrontDoorGlyphFamily {
  if (device === 'keyboard') return 'keyboard';
  if (pref !== 'auto') return pref;
  return device === 'playstation' ? 'playstation' : 'xbox';
}

type PadFamily = Exclude<FrontDoorGlyphFamily, 'keyboard'>;

// Gerätefarben (eigene Werte, nur die übliche Zuordnung Farbe ↔ Position).
const XBOX_FACE: Readonly<Record<'PadA' | 'PadB' | 'PadX' | 'PadY', { text: string; color: string }>> = {
  PadA: { text: 'A', color: '#5dff7a' },
  PadB: { text: 'B', color: '#ff4a5e' },
  PadX: { text: 'X', color: '#4aa8ff' },
  PadY: { text: 'Y', color: '#ffd84a' },
};

const PS_FACE: Readonly<Record<'PadA' | 'PadB' | 'PadX' | 'PadY', { text: string; symbol: 'cross' | 'circle' | 'square' | 'triangle'; color: string; name: string }>> = {
  PadA: { text: '✕', symbol: 'cross', color: '#8fb4ff', name: 'Kreuz' },
  PadB: { text: '○', symbol: 'circle', color: '#ff5a6e', name: 'Kreis' },
  PadX: { text: '□', symbol: 'square', color: '#ff7ad8', name: 'Quadrat' },
  PadY: { text: '△', symbol: 'triangle', color: '#4affb0', name: 'Dreieck' },
};

function g(family: FrontDoorGlyphFamily, text: string, kind: FrontDoorGlyph['kind'], name: string, extra: Partial<Pick<FrontDoorGlyph, 'symbol' | 'arms' | 'color'>> = {}): FrontDoorGlyph {
  return { family, text, kind, name, symbol: extra.symbol ?? null, arms: extra.arms ?? null, color: extra.color ?? null };
}

/** Glyphe eines Pad-Knopfs (Belegungs-Anzeige, Hinweise). */
export function padCodeGlyph(code: PadButtonCode, fam: PadFamily): FrontDoorGlyph {
  switch (code) {
    case 'PadA':
    case 'PadB':
    case 'PadX':
    case 'PadY': {
      if (fam === 'playstation') {
        const f = PS_FACE[code];
        return g(fam, f.text, 'face', f.name, { symbol: f.symbol, color: f.color });
      }
      const f = XBOX_FACE[code];
      return g(fam, f.text, 'face', `Taste ${f.text}`, { color: f.color });
    }
    case 'PadLB':
      return g(fam, fam === 'playstation' ? 'L1' : 'LB', 'shoulder', fam === 'playstation' ? 'L1' : 'Linke Schultertaste');
    case 'PadRB':
      return g(fam, fam === 'playstation' ? 'R1' : 'RB', 'shoulder', fam === 'playstation' ? 'R1' : 'Rechte Schultertaste');
    case 'PadLT':
      return g(fam, fam === 'playstation' ? 'L2' : 'LT', 'trigger', fam === 'playstation' ? 'L2' : 'Linker Trigger');
    case 'PadRT':
      return g(fam, fam === 'playstation' ? 'R2' : 'RT', 'trigger', fam === 'playstation' ? 'R2' : 'Rechter Trigger');
    case 'PadView':
      return g(fam, fam === 'playstation' ? 'CREATE' : 'VIEW', 'system', fam === 'playstation' ? 'Create-Taste' : 'View-Taste');
    case 'PadMenu':
      return g(fam, fam === 'playstation' ? 'OPTIONS' : 'MENU', 'system', fam === 'playstation' ? 'Options-Taste' : 'Menü-Taste');
    case 'PadL3':
      return g(fam, 'L3', 'stick', 'Linker Stick drücken');
    case 'PadR3':
      return g(fam, 'R3', 'stick', 'Rechter Stick drücken');
    case 'PadUp':
      return g(fam, '▲', 'dpad', 'Steuerkreuz oben', { arms: 'up' });
    case 'PadDown':
      return g(fam, '▼', 'dpad', 'Steuerkreuz unten', { arms: 'down' });
    case 'PadLeft':
      return g(fam, '◀', 'dpad', 'Steuerkreuz links', { arms: 'left' });
    case 'PadRight':
      return g(fam, '▶', 'dpad', 'Steuerkreuz rechts', { arms: 'right' });
    case 'PadHome':
      return g(fam, 'HOME', 'system', 'Home-Taste');
  }
}

/** Was die Auflösung außer der Familie braucht: Tastatur-Kürzel der Vorführung, Pad-Belegung (null = Defaults). */
export interface GlyphSource {
  readonly demoKey: string;
  readonly padBinds: PadBinds | null;
}

const key = (text: string, name = text): FrontDoorGlyph => g('keyboard', text, 'key', name);

/** Pad-Belegung einer Spiel-Aktion als Glyphe (erste Belegung), sonst der feste Default-Knopf. */
function bound(a: PadBindAction, fallback: PadButtonCode, fam: PadFamily, src: GlyphSource): FrontDoorGlyph[] {
  const list = src.padBinds?.[a] ?? [fallback];
  const c = list[0];
  return c !== undefined ? [padCodeGlyph(c, fam)] : [];
}

/**
 * Symbole eines Hinweises. Menü-Knöpfe am Pad sind fest (A bestätigt, B zurück, LB/RB Reiter, Steuerkreuz/Stick
 * navigiert — Plan 011 §2.2.8); Spiel-Aktionen (Neustart, Checkpoint, Vorführung) folgen der Belegung.
 */
export function promptGlyphs(p: FrontDoorPrompt, fam: FrontDoorGlyphFamily, src: GlyphSource): readonly FrontDoorGlyph[] {
  if (fam === 'keyboard') {
    switch (p) {
      case 'confirm':
        return [key('Enter')];
      case 'back':
        return [key('Esc')];
      case 'restart':
        return [key('R')];
      case 'respawn':
        return [key('F')];
      case 'demo':
        return [key(src.demoKey)];
      case 'nav':
        return [key('◀', 'Pfeil links'), key('▶', 'Pfeil rechts'), key('▲', 'Pfeil hoch'), key('▼', 'Pfeil runter')];
      case 'navX':
        return [key('◀', 'Pfeil links'), key('▶', 'Pfeil rechts')];
      case 'navY':
        return [key('▲', 'Pfeil hoch'), key('▼', 'Pfeil runter')];
      // Reiter haben auf der Tastatur keine eigene Taste (Maus oder Pfeile im Stil).
      case 'tabs':
      case 'tabPrev':
      case 'tabNext':
        return [];
    }
  }
  switch (p) {
    case 'confirm':
      return [padCodeGlyph('PadA', fam)];
    case 'back':
      return [padCodeGlyph('PadB', fam)];
    case 'restart':
      return bound('restart', 'PadView', fam, src);
    case 'respawn':
      return bound('respawn', 'PadY', fam, src);
    case 'demo':
      return bound('demo', 'PadX', fam, src);
    case 'nav':
      return [g(fam, '✚', 'dpad', 'Steuerkreuz oder Stick', { arms: 'all' })];
    case 'navX':
      return [g(fam, '◀▶', 'dpad', 'Steuerkreuz links/rechts', { arms: 'x' })];
    case 'navY':
      return [g(fam, '▲▼', 'dpad', 'Steuerkreuz hoch/runter', { arms: 'y' })];
    case 'tabs':
      return [padCodeGlyph('PadLB', fam), padCodeGlyph('PadRB', fam)];
    case 'tabPrev':
      return [padCodeGlyph('PadLB', fam)];
    case 'tabNext':
      return [padCodeGlyph('PadRB', fam)];
  }
}

// ------------------------------------------------------------------ Pixel-Formen (7×7, '#' = Pixel)

const SPRITES: Readonly<Record<'cross' | 'circle' | 'square' | 'triangle', readonly string[]>> = {
  cross: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
  circle: ['..###..', '.#...#.', '#.....#', '#.....#', '#.....#', '.#...#.', '..###..'],
  square: ['.......', '.#####.', '.#...#.', '.#...#.', '.#...#.', '.#####.', '.......'],
  triangle: ['...#...', '...#...', '..#.#..', '..#.#..', '.#...#.', '.#...#.', '#######'],
};

/** D-Pad 7×7: Arme 3 breit; je Arm die Zellen, die leuchten. */
const DPAD_ARMS: Readonly<Record<'up' | 'down' | 'left' | 'right', readonly [number, number][]>> = {
  up: [[2, 0], [3, 0], [4, 0], [2, 1], [3, 1], [4, 1]],
  down: [[2, 5], [3, 5], [4, 5], [2, 6], [3, 6], [4, 6]],
  left: [[0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4]],
  right: [[5, 2], [5, 3], [5, 4], [6, 2], [6, 3], [6, 4]],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgGrid(): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 7 7');
  s.setAttribute('shape-rendering', 'crispEdges');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('vel-pg-px');
  return s;
}

function px(s: SVGSVGElement, x: number, y: number, fill: string): void {
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', '1');
  r.setAttribute('height', '1');
  r.setAttribute('fill', fill);
  s.append(r);
}

function shapeSvg(symbol: 'cross' | 'circle' | 'square' | 'triangle', color: string): SVGSVGElement {
  const s = svgGrid();
  SPRITES[symbol].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') px(s, x, y, color);
  });
  return s;
}

function dpadSvg(arms: NonNullable<FrontDoorGlyph['arms']>): SVGSVGElement {
  const s = svgGrid();
  const lit = new Set<string>();
  const on = (a: 'up' | 'down' | 'left' | 'right'): void => {
    for (const [x, y] of DPAD_ARMS[a]) lit.add(`${x},${y}`);
  };
  if (arms === 'all' || arms === 'y' || arms === 'up') on('up');
  if (arms === 'all' || arms === 'y' || arms === 'down') on('down');
  if (arms === 'all' || arms === 'x' || arms === 'left') on('left');
  if (arms === 'all' || arms === 'x' || arms === 'right') on('right');
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const inCross = (x >= 2 && x <= 4) || (y >= 2 && y <= 4);
      if (!inCross) continue;
      // Mitte bleibt dunkel (Drehpunkt), leuchtende Arme hell, Rest gedämpft.
      const fill = x === 3 && y === 3 ? 'var(--pg-hub, #2a2f55)' : lit.has(`${x},${y}`) ? 'var(--pg-lit, #ffffff)' : 'var(--pg-dim, #6a72a8)';
      px(s, x, y, fill);
    }
  }
  return s;
}

/** Eine Glyphe als Element (Klassen vel-pg …; Aussehen in menu.css, Stile dürfen umfärben). */
export function glyphNode(gl: FrontDoorGlyph): HTMLElement {
  const e = document.createElement('span');
  e.className = `vel-pg vel-pg--${gl.kind} vel-pg--${gl.family}`;
  e.title = gl.name;
  e.setAttribute('aria-label', gl.name);
  if (gl.color) e.style.setProperty('--pg-c', gl.color);
  if (gl.kind === 'dpad' && gl.arms) e.append(dpadSvg(gl.arms));
  else if (gl.kind === 'face' && gl.symbol) e.append(shapeSvg(gl.symbol, gl.color ?? '#ffffff'));
  else e.textContent = gl.text;
  return e;
}

/**
 * Hinweis-Halter füllen: Tastatur → Text wie bisher (Kappen-Optik macht der Halter selbst), Pad → Glyph-Knoten.
 * `is-pad` am Halter schaltet die Kappen-Optik ab. Leere Liste → Halter versteckt.
 */
export function fillGlyphs(host: HTMLElement, list: readonly FrontDoorGlyph[], keyNode?: (gl: FrontDoorGlyph) => HTMLElement): void {
  const pad = list.length > 0 && list[0].family !== 'keyboard';
  host.classList.toggle('is-pad', pad);
  host.hidden = list.length === 0;
  if (!pad) {
    if (keyNode) host.replaceChildren(...list.map(keyNode));
    else host.textContent = list.map((x) => x.text).join(' ');
    return;
  }
  host.replaceChildren(...list.map(glyphNode));
}

/** Alle Halter unter root (data-glyph="<prompt>") neu füllen — beim Gerätewechsel, ohne Neuaufbau des Screens. */
export function refreshGlyphs(root: ParentNode, glyphs: (p: FrontDoorPrompt) => readonly FrontDoorGlyph[], keyNode?: (gl: FrontDoorGlyph) => HTMLElement): void {
  for (const host of root.querySelectorAll<HTMLElement>('[data-glyph]')) {
    const p = host.dataset.glyph;
    // Halter mit eigenem Kappen-Bauer (data-keys="own") füllt nur der Stil selbst.
    const own = host.dataset.keys === 'own';
    if (own && !keyNode) continue;
    if (p !== undefined && isPrompt(p)) fillGlyphs(host, glyphs(p), own ? keyNode : undefined);
  }
}

export function isPrompt(s: string): s is FrontDoorPrompt {
  return (
    s === 'confirm' || s === 'back' || s === 'restart' || s === 'respawn' || s === 'demo' || s === 'nav' || s === 'navX' || s === 'navY' || s === 'tabs' || s === 'tabPrev' || s === 'tabNext'
  );
}

/** Stick als Glyphe (Steuerungs-Übersicht): "L"/"R" im Ring. */
export function stickGlyph(side: 'L' | 'R', fam: PadFamily): FrontDoorGlyph {
  return g(fam, side === 'L' ? 'L' : 'R', 'stick', side === 'L' ? 'Linker Stick' : 'Rechter Stick');
}
