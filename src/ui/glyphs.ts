/**
 * Glyphen des HUD-Pixelfonts (5×7 Versalhöhe, proportional, Ziffern fest 5 breit).
 *
 * Jedes Sheet zeigt mehrere Zeichen nebeneinander, getrennt durch Leerzeichen —
 * so sieht man die Buchstaben direkt im Code. '#' = Pixel an, '.' = aus.
 * Zeile 0 = Oberkante der Versalien, Zeile 6 = Grundlinie, Zeilen 7–8 = Unterlänge.
 * `top` < 0 verschiebt das Sheet nach oben (Umlaut-Punkte über Versalien).
 *
 * DOM-frei, damit Parser und Validierung auch in Node laufen.
 */

export interface Glyph {
  /** Breite in Font-Pixeln. */
  readonly width: number;
  /** Zeilenversatz der ersten Zeile relativ zur Versal-Oberkante. */
  readonly top: number;
  /** Zeilen als Bitmuster ('#'/'.'). */
  readonly rows: readonly string[];
}

/** Font-Metrik in Font-Pixeln. */
export const CAP_HEIGHT = 7;
/** Platz über der Versalhöhe (Umlaut-Punkte). */
export const ACCENT_ROWS = 2;
/** Unterlänge (g, j, p, q, y, Komma). */
export const DESCENT_ROWS = 2;
export const SPACE_WIDTH = 3;

const UPPER_A_M = `
.###. ####. .###. ####. ##### ##### .###. #...# ### ..### #...# #.... #...#
#...# #...# #...# #...# #.... #.... #...# #...# .#. ...#. #..#. #.... ##.##
#...# #...# #.... #...# #.... #.... #.... #...# .#. ...#. #.#.. #.... #.#.#
##### ####. #.... #...# ####. ####. #.### ##### .#. ...#. ##... #.... #.#.#
#...# #...# #.... #...# #.... #.... #...# #...# .#. ...#. #.#.. #.... #...#
#...# #...# #...# #...# #.... #.... #...# #...# .#. #..#. #..#. #.... #...#
#...# ####. .###. ####. ##### #.... .#### #...# ### .##.. #...# ##### #...#
`;

const UPPER_N_Z = `
#...# .###. ####. .###. ####. .#### ##### #...# #...# #...# #...# #...# #####
#...# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# #...# #...# ....#
##..# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# .#.#. .#.#. ...#.
#.#.# #...# ####. #...# ####. .###. ..#.. #...# #...# #.#.# ..#.. ..#.. ..#..
#..## #...# #.... #.#.# #.#.. ....# ..#.. #...# #...# #.#.# .#.#. ..#.. .#...
#...# #...# #.... #..#. #..#. ....# ..#.. #...# .#.#. #.#.# #...# ..#.. #....
#...# .###. #.... .##.# #...# ####. ..#.. .###. ..#.. .#.#. #...# ..#.. #####
`;

const DIGITS = `
.###. ..#.. .###. .###. ...#. ##### ..##. ##### .###. .###.
#...# .##.. #...# #...# ..##. #.... .#... ....# #...# #...#
#...# ..#.. ....# ....# .#.#. ####. #.... ...#. #...# #...#
#...# ..#.. ...#. ..##. #..#. ....# ####. ..#.. .###. .####
#...# ..#.. ..#.. ....# ##### ....# #...# .#... #...# ....#
#...# ..#.. .#... #...# ...#. #...# #...# .#... #...# ...#.
.###. .###. ##### .###. ...#. .###. .###. .#... .###. .##..
`;

const LOWER_A_M = `
..... #.... ..... ....# ..... ..## ..... #.... # ..# #... # .....
..... #.... ..... ....# ..... .#.. ..... #.... . ... #... # .....
.###. ####. .###. .#### .###. #### .#### ####. # ..# #..# # ####.
....# #...# #.... #...# #...# .#.. #...# #...# # ..# #.#. # #.#.#
.#### #...# #.... #...# ##### .#.. #...# #...# # ..# ##.. # #.#.#
#...# #...# #.... #...# #.... .#.. #...# #...# # ..# #.#. # #.#.#
.#### ####. .###. .#### .###. .#.. .#### #...# # ..# #..# # #.#.#
..... ..... ..... ..... ..... .... ....# ..... . #.# .... . .....
..... ..... ..... ..... ..... .... .###. ..... . .#. .... . .....
`;

const LOWER_N_Z = `
..... ..... ..... ..... .... ..... .#.. ..... ..... ..... ..... ..... .....
..... ..... ..... ..... .... ..... .#.. ..... ..... ..... ..... ..... .....
####. .###. ####. .#### #.## .#### #### #...# #...# #...# #...# #...# #####
#...# #...# #...# #...# ##.. #.... .#.. #...# #...# #...# .#.#. #...# ...#.
#...# #...# #...# #...# #... .###. .#.. #...# #...# #.#.# ..#.. #...# ..#..
#...# #...# #...# #...# #... ....# .#.. #...# .#.#. #.#.# .#.#. #...# .#...
#...# .###. ####. .#### #... ####. ..## .#### ..#.. .#.#. #...# .#### #####
..... ..... #.... ....# .... ..... .... ..... ..... ..... ..... ....# .....
..... ..... #.... ....# .... ..... .... ..... ..... ..... ..... .###. .....
`;

/** Versal-Umlaute: volle Buchstabenhöhe, Punkte darüber (top = -2). */
const UMLAUT_UPPER = `
.#.#. .#.#. .#.#.
..... ..... .....
.###. .###. #...#
#...# #...# #...#
#...# #...# #...#
##### #...# #...#
#...# #...# #...#
#...# #...# #...#
#...# .###. .###.
`;

const UMLAUT_LOWER = `
.#.#. .#.#. .#.#. .##..
..... ..... ..... #..#.
.###. .###. #...# #..#.
....# #...# #...# #.##.
.#### #...# #...# #...#
#...# #...# #...# #...#
.#### .###. .#### #.##.
`;

// . , : ; ! ? + - − / % ( ) ' " # _ < > = * [ ] | · ×
const PUNCT = `
. .. . .. # .###. ..... .... ..... ....# ##..# ..# #.. # #.# .#.#. ..... ...# #... ..... ..... ### ### # . ...
. .. # .# # #...# ..#.. .... ..... ....# ##..# .#. .#. # #.# .#.#. ..... ..#. .#.. ..... #.#.# #.. ..# # . ...
. .. . .. # ....# ..#.. .... ..... ...#. ...#. #.. ..# . ... ##### ..... .#.. ..#. ##### .###. #.. ..# # . #.#
. .. . .. # ...#. ##### #### ##### ..#.. ..#.. #.. ..# . ... .#.#. ..... #... ...# ..... ##### #.. ..# # # .#.
. .. . .. # ..#.. ..#.. .... ..... .#... .#... #.. ..# . ... ##### ..... .#.. ..#. ##### .###. #.. ..# # . #.#
. .# # .# . ..... ..#.. .... ..... #.... #..## .#. .#. . ... .#.#. ..... ..#. .#.. ..... #.#.# #.. ..# # . ...
# .# . .# # ..#.. ..... .... ..... #.... #..## ..# #.. . ... .#.#. ..... ...# #... ..... ..... ### ### # . ...
. #. . #. . ..... ..... .... ..... ..... ..... ... ... . ... ..... ##### .... .... ..... ..... ... ... . . ...
. .. . .. . ..... ..... .... ..... ..... ..... ... ... . ... ..... ..... .... .... ..... ..... ... ... . . ...
`;

/** Unbekannte Zeichen: sichtbarer Kasten statt stiller Lücke. */
const FALLBACK = `
#####
#...#
#...#
#...#
#...#
#...#
#####
`;

const SHEETS: readonly { readonly chars: string; readonly top: number; readonly art: string }[] = [
  { chars: 'ABCDEFGHIJKLM', top: 0, art: UPPER_A_M },
  { chars: 'NOPQRSTUVWXYZ', top: 0, art: UPPER_N_Z },
  { chars: '0123456789', top: 0, art: DIGITS },
  { chars: 'abcdefghijklm', top: 0, art: LOWER_A_M },
  { chars: 'nopqrstuvwxyz', top: 0, art: LOWER_N_Z },
  { chars: 'ÄÖÜ', top: -ACCENT_ROWS, art: UMLAUT_UPPER },
  { chars: 'äöüß', top: 0, art: UMLAUT_LOWER },
  { chars: '.,:;!?+-−/%()\'"#_<>=*[]|·×', top: 0, art: PUNCT },
  { chars: '\u0000', top: 0, art: FALLBACK },
];

/** Typografische Varianten auf vorhandene Glyphen abbilden. */
const ALIASES: Readonly<Record<string, string>> = {
  '–': '-', // Halbgeviertstrich
  '—': '-', // Geviertstrich
  '‘': "'",
  '’': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  'ẞ': 'ß', // Versal-ß
  '•': '·',
};

/** Zerlegt ein Sheet in Glyphen und prüft es streng — ein vertipptes Sheet soll laut scheitern. */
export function parseSheet(chars: string, top: number, art: string): Map<string, Glyph> {
  const lines = art
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const table = lines.map((l) => l.split(/\s+/));
  const glyphChars = Array.from(chars);
  const out = new Map<string, Glyph>();
  table.forEach((tokens, r) => {
    if (tokens.length !== glyphChars.length) {
      throw new Error(`Glyph-Sheet "${chars}": Zeile ${r} hat ${tokens.length} Spalten, erwartet ${glyphChars.length}`);
    }
  });
  glyphChars.forEach((ch, i) => {
    const rows = table.map((tokens) => tokens[i]);
    const width = rows[0].length;
    for (const row of rows) {
      if (row.length !== width) throw new Error(`Glyph "${ch}": uneinheitliche Breite`);
      if (!/^[#.]+$/.test(row)) throw new Error(`Glyph "${ch}": ungültiges Zeichen in "${row}"`);
    }
    if (top < -ACCENT_ROWS || top + rows.length > CAP_HEIGHT + DESCENT_ROWS) {
      throw new Error(`Glyph "${ch}": ragt aus dem Glyphenkasten`);
    }
    out.set(ch, { width, top, rows });
  });
  return out;
}

function buildTable(): ReadonlyMap<string, Glyph> {
  const all = new Map<string, Glyph>();
  for (const s of SHEETS) {
    for (const [ch, g] of parseSheet(s.chars, s.top, s.art)) {
      if (all.has(ch)) throw new Error(`Glyph "${ch}" doppelt definiert`);
      all.set(ch, g);
    }
  }
  all.set(' ', { width: SPACE_WIDTH, top: 0, rows: [] });
  return all;
}

export const GLYPHS: ReadonlyMap<string, Glyph> = buildTable();
const FALLBACK_GLYPH: Glyph = GLYPHS.get('\u0000') ?? { width: 5, top: 0, rows: [] };

/** Glyphe für ein Zeichen: direkt, über Alias, über Unicode-Zerlegung (é → e) oder Kasten. */
export function glyphFor(ch: string): Glyph {
  const direct = GLYPHS.get(ch);
  if (direct) return direct;
  const alias = ALIASES[ch];
  if (alias !== undefined) {
    const g = GLYPHS.get(alias);
    if (g) return g;
  }
  const base = ch.normalize('NFD').charAt(0);
  if (base !== ch) {
    const g = GLYPHS.get(base);
    if (g) return g;
  }
  return FALLBACK_GLYPH;
}

export function hasGlyph(ch: string): boolean {
  return glyphFor(ch) !== FALLBACK_GLYPH;
}
