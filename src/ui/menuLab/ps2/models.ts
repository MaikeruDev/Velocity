/**
 * Low-Poly-Modelle der PS2-Front-Door: Menüpunkte (Disc, Pylon, Memory Card, Pokal, Kristall, Zahnrad) und Level-Discs.
 * Alles flach schattiert (nicht-indizierte Dreiecke, Flächennormalen) mit Farbe JE DREIECK — harte Facetten wie 2002.
 * Einheit: Modell passt in eine Kugel mit Radius ~0.5 (der Aufrufer skaliert auf die Pixelgröße des Ankers).
 * Attribute: position, normal, color (roh, kein Farbraum-Umrechnen), aFx (0 matt, 1 irisierend, 2 selbstleuchtend).
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, ExtrudeGeometry, LatheGeometry, Shape, TorusGeometry, Vector2 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Rgb = readonly [number, number, number];

/** '#rrggbb' → rohe 0..1-Werte (bewusst ohne three.Color: die würde sRGB → linear umrechnen). */
export function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface Face {
  /** Schwerpunkt */
  x: number;
  y: number;
  z: number;
  /** Flächennormale */
  nx: number;
  ny: number;
  nz: number;
}
interface Ink {
  c: Rgb;
  fx: number;
}
type Painter = (f: Face, out: Ink) => void;

/** Geometrie flach machen und je Dreieck bemalen. Wird nur beim Aufbau benutzt (Allokation egal). */
function paint(src: BufferGeometry, painter: Painter): BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const fx = new Float32Array(n);
  const f: Face = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  const ink: Ink = { c: [1, 1, 1], fx: 0 };
  for (let i = 0; i < n; i += 3) {
    f.x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    f.y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    f.z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    f.nx = nor.getX(i);
    f.ny = nor.getY(i);
    f.nz = nor.getZ(i);
    ink.fx = 0;
    painter(f, ink);
    for (let k = 0; k < 3; k++) {
      col[(i + k) * 3] = ink.c[0];
      col[(i + k) * 3 + 1] = ink.c[1];
      col[(i + k) * 3 + 2] = ink.c[2];
      fx[i + k] = ink.fx;
    }
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('aFx', new BufferAttribute(fx, 1));
  return g;
}

function solid(c: Rgb, fx = 0): Painter {
  return (_f, o) => {
    o.c = c;
    o.fx = fx;
  };
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('ps2: mergeGeometries fehlgeschlagen');
  return m;
}

/**
 * Drehkörper mit Normalen nach außen: Je nach Laufrichtung des Profils zeigt die Wicklung nach innen
 * (Pylon war deshalb blau — Licht von hinten, voller Rim). Vorzeichen des Volumens entscheidet, ggf. umdrehen.
 */
function lathe(profile: readonly (readonly [number, number])[], segments: number): BufferGeometry {
  const src = new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), segments);
  const g = src.toNonIndexed();
  src.dispose();
  const p = g.getAttribute('position');
  let vol = 0;
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
    const bx = p.getX(i + 1), by = p.getY(i + 1), bz = p.getZ(i + 1);
    const cx = p.getX(i + 2), cy = p.getY(i + 2), cz = p.getZ(i + 2);
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0) {
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
  }
  return g;
}

// ---------------------------------------------------------------- Disc

const SILVER = rgb('#c9cfe6');
const HUB = rgb('#e8ecff');

/**
 * Spiel-Disc: Etikett oben in der Level-Farbe (Ringe + ein Keil als "Artwork"), Datenseite unten irisierend.
 * Liegt in der XZ-Ebene (Achse Y) — der Aufrufer kippt sie zur Kamera.
 */
export function discGeometry(label: Rgb, accent: Rgb): BufferGeometry {
  const t = 0.022;
  // Profil von innen nach außen über die Oberseite, dann zurück über die Unterseite — viele Radien = Ringe im Etikett.
  const top: [number, number][] = [
    [0.075, t * 0.6],
    [0.15, t * 0.6],
    [0.17, t],
    [0.25, t],
    [0.29, t],
    [0.42, t],
    [0.45, t],
    [0.5, t * 0.6],
  ];
  const profile: [number, number][] = [[0.075, -t * 0.6], ...top, [0.5, -t * 0.6], [0.45, -t], [0.17, -t], [0.15, -t * 0.6], [0.075, -t * 0.6]];
  const dark: Rgb = [label[0] * 0.45, label[1] * 0.45, label[2] * 0.5];
  return paint(lathe(profile, 28), (f, o) => {
    const r = Math.hypot(f.x, f.z);
    const ang = Math.atan2(f.z, f.x);
    if (f.ny < -0.5) {
      // Datenseite: Spiegel + Regenbogen (Shader), Nabe klar
      o.c = r < 0.16 ? HUB : SILVER;
      o.fx = r < 0.16 ? 0 : 1;
      return;
    }
    if (Math.abs(f.ny) < 0.5) {
      o.c = SILVER;
      o.fx = 1;
      return;
    }
    if (r < 0.16) o.c = HUB;
    else if (r < 0.25) o.c = dark;
    else if (r < 0.29) o.c = accent;
    else if (r < 0.42) {
      // Keil: zwei Segmente in der Akzentfarbe — liest sich beim Drehen als Bewegung
      const seg = ((ang + Math.PI) / (Math.PI * 2)) * 28;
      o.c = seg > 3 && seg < 8 ? accent : label;
    } else if (r < 0.45) o.c = [0.96, 0.95, 1];
    else o.c = label;
  });
}

// ---------------------------------------------------------------- Pylon (Training)

export function coneGeometry(): BufferGeometry {
  const orange = rgb('#ff6a2a');
  const white = rgb('#fff4ec');
  // Mantel an den Streifengrenzen unterteilt — sonst trägt ein Dreieck den ganzen Mantel und färbt alles weiß
  const rAt = (y: number): number => 0.07 + ((0.42 - y) / 0.72) * 0.18;
  const prof: [number, number][] = [[0, 0.48], [0.07, 0.42]];
  for (const y of [0.24, 0.12, 0.0, -0.12]) prof.push([rAt(y), y]);
  prof.push([0.25, -0.3], [0.27, -0.34], [0, -0.34]);
  const cone = paint(lathe(prof, 8), (f, o) => {
    o.c = (f.y > 0.12 && f.y < 0.24) || (f.y > -0.12 && f.y < 0.0) ? white : orange;
  });
  const base = new BoxGeometry(0.66, 0.08, 0.66);
  base.translate(0, -0.38, 0);
  const foot = paint(base, solid(rgb('#d24a16')));
  return merge([cone, foot]);
}

// ---------------------------------------------------------------- Memory Card (Profil)

export function cardGeometry(): BufferGeometry {
  // Eigene Form: Steckkarte mit abgeschrägter Ecke oben rechts, Griffmulde unten, Etikett + Kontakte. Kein echtes Gerät.
  const w = 0.6;
  const h = 0.82;
  const s = new Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2 - 0.14);
  s.lineTo(w / 2 - 0.14, h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  const bodyG = new ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: false });
  bodyG.translate(0, 0, -0.07);
  const body = paint(bodyG, (f, o) => {
    o.c = f.nz > 0.5 ? rgb('#5a66a6') : Math.abs(f.nz) > 0.5 ? rgb('#3a4278') : rgb('#7a86c8');
  });
  const labelG = new BoxGeometry(0.48, 0.4, 0.02);
  labelG.translate(-0.02, 0.04, 0.075);
  const label = paint(labelG, (f, o) => {
    if (f.nz < 0.5) {
      o.c = rgb('#bfc6e8');
      return;
    }
    o.c = f.y > 0.12 ? rgb('#ff3fd0') : rgb('#33f0ff');
  });
  // Kontakte oben (selbstleuchtend gold, damit sie auch im Schatten funkeln)
  const pins: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const p = new BoxGeometry(0.05, 0.08, 0.02);
    p.translate(-0.22 + i * 0.075, h / 2 - 0.08, 0.075);
    pins.push(paint(p, solid(rgb('#ffd84a'), 2)));
  }
  const gripG = new BoxGeometry(0.36, 0.05, 0.02);
  gripG.translate(0, -h / 2 + 0.1, 0.075);
  const grip = paint(gripG, solid(rgb('#11131f')));
  const ledG = new BoxGeometry(0.05, 0.05, 0.02);
  ledG.translate(0.2, -h / 2 + 0.1, 0.075);
  const led = paint(ledG, solid(rgb('#5dff9a'), 2));
  return merge([body, label, ...pins, grip, led]);
}

// ---------------------------------------------------------------- Pokal (Bestenliste)

export function trophyGeometry(): BufferGeometry {
  const gold = rgb('#ffcc3a');
  const deep = rgb('#c98a12');
  const cup = paint(
    lathe(
      [
        [0, -0.44],
        [0.24, -0.44],
        [0.24, -0.36],
        [0.13, -0.33],
        [0.05, -0.24],
        [0.05, -0.08],
        [0.12, -0.02],
        [0.26, 0.12],
        [0.3, 0.42],
        [0.26, 0.42],
        [0.22, 0.16],
        [0, 0.1],
      ],
      8,
    ),
    (f, o) => {
      o.c = f.y < -0.32 ? deep : f.y > 0.36 ? rgb('#fff0a8') : gold;
    },
  );
  const handle = (side: number): BufferGeometry => {
    const t = new TorusGeometry(0.11, 0.028, 4, 8, Math.PI);
    t.rotateZ(side > 0 ? -Math.PI / 2 : Math.PI / 2);
    t.translate(side * 0.29, 0.22, 0);
    return paint(t, solid(gold));
  };
  const plateG = new BoxGeometry(0.34, 0.07, 0.02);
  plateG.translate(0, -0.4, 0.2);
  const plate = paint(plateG, solid(rgb('#33f0ff'), 2));
  return merge([cup, handle(1), handle(-1), plate]);
}

// ---------------------------------------------------------------- Kristall (Kosmetik)

export function gemGeometry(): BufferGeometry {
  const a = rgb('#ff3fd0');
  const b = rgb('#a63bff');
  const c = rgb('#ffd0f6');
  return paint(
    lathe(
      [
        [0, -0.48],
        [0.4, 0.06],
        [0.42, 0.12],
        [0.26, 0.3],
        [0, 0.3],
      ],
      8,
    ),
    (f, o) => {
      const seg = Math.floor(((Math.atan2(f.z, f.x) + Math.PI) / (Math.PI * 2)) * 8);
      if (f.ny > 0.95) o.c = c;
      else if (f.y > 0.08) o.c = seg % 2 === 0 ? c : a;
      else o.c = seg % 2 === 0 ? a : b;
    },
  );
}

// ---------------------------------------------------------------- Zahnrad-Paar (System)

export interface GearSpec {
  readonly teeth: number;
  readonly rTip: number;
  readonly rRoot: number;
  /** Innenkante des Zahnkranzes (dahinter Speichen und Löcher). */
  readonly rRim: number;
  readonly rHub: number;
  readonly depth: number;
  readonly spokes: number;
}

/** Anteile einer Zahnteilung: Lücke, Flanke, Kopf, Flanke (Summe 1). Zahnmitte bei GAP + FLANK + TIP/2. */
const GEAR_GAP = 0.42;
const GEAR_FLANK = 0.14;
const GEAR_TIP = 0.3;
const GEAR_TOOTH_CENTER = GEAR_GAP + GEAR_FLANK + GEAR_TIP / 2;

const GK = 0.68; // beide Räder zusammen in die Einheitskugel
const BIG: GearSpec = { teeth: 12, rTip: 0.5 * GK, rRoot: 0.41 * GK, rRim: 0.31 * GK, rHub: 0.12 * GK, depth: 0.17 * GK, spokes: 5 };
const SMALL: GearSpec = { teeth: 8, rTip: 0.348 * GK, rRoot: 0.258 * GK, rRim: 0.19 * GK, rHub: 0.085 * GK, depth: 0.14 * GK, spokes: 4 };
const MESH_DIR = (35 * Math.PI) / 180;
const CENTER_DIST = ((BIG.rTip + BIG.rRoot) / 2 + (SMALL.rTip + SMALL.rRoot) / 2) * 1.01;
const BIG_AT: readonly [number, number] = [-0.22 * GK, -0.14 * GK];
const RATIO = BIG.teeth / SMALL.teeth;
const WS = (Math.PI * 2) / SMALL.teeth;

/**
 * Großes Rad (12 Zähne) + kleines (8), das unter 35° eingreift. phase: Zahn des großen trifft Lücke des kleinen
 * (Herleitung: Zahnphase an der Berührungsrichtung beider Räder gegengleich, um eine halbe Teilung versetzt).
 */
export const GEAR_PAIR = {
  big: BIG,
  small: SMALL,
  bigAt: BIG_AT,
  smallAt: [BIG_AT[0] + Math.cos(MESH_DIR) * CENTER_DIST, BIG_AT[1] + Math.sin(MESH_DIR) * CENTER_DIST] as const,
  ratio: RATIO,
  phase: MESH_DIR * (1 + RATIO) + Math.PI - (2 * GEAR_TOOTH_CENTER + 0.5) * WS,
} as const;

function polyShape(r: number, n: number, rot = 0): Shape {
  const s = new Shape();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}

/**
 * Zahnrad: Zahnkranz mit trapezförmigen Zähnen und gefasten Kanten (Extrude-Bevel = eine Facette, liest sich als
 * Glanzkante), Speichen mit offenen Löchern dazwischen, erhabene Nabe mit Sechskant-Achsloch und Leucht-Ring.
 * Farben je Fläche nach Lage: Kopf hell, Flanken mittel, Grund/Innenwand dunkel, Fasen fast weiß.
 */
/** Metall je Rad: Stahl (groß) und Messing (klein) — zwei Materialien lesen sich als zwei Teile. */
export type GearMetal = 'steel' | 'brass';

const METALS: Readonly<Record<GearMetal, readonly [string, string, string, string, string, string, string]>> = {
  // face, tip, flank, deep, bevel, spokeFace, spokeSide
  steel: ['#c6cdea', '#f2f5ff', '#8792c2', '#3e4576', '#e8ecff', '#b4bde4', '#6a74a8'],
  brass: ['#e8b04a', '#fff0b0', '#b07a22', '#5e3a10', '#ffe28a', '#d89a38', '#8a5a1a'],
};

export function gearGeometry(g: GearSpec, metal: GearMetal = 'steel'): BufferGeometry {
  const M = METALS[metal];
  const w = (Math.PI * 2) / g.teeth;
  const ring = new Shape();
  for (let i = 0; i < g.teeth; i++) {
    const a0 = i * w;
    const pts: [number, number][] = [
      [g.rRoot, a0],
      [g.rRoot, a0 + GEAR_GAP * w],
      [g.rTip, a0 + (GEAR_GAP + GEAR_FLANK) * w],
      [g.rTip, a0 + (GEAR_GAP + GEAR_FLANK + GEAR_TIP) * w],
    ];
    for (const [r, a] of pts) {
      if (i === 0 && r === g.rRoot && a === a0) ring.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ring.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  ring.closePath();
  ring.holes.push(polyShape(g.rRim, g.teeth * 2, w * 0.25));
  const bev = g.depth * 0.16;
  const rimG = new ExtrudeGeometry(ring, { depth: g.depth - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.8, bevelSegments: 1, curveSegments: 1 });
  rimG.translate(0, 0, -(g.depth - bev * 2) / 2);

  const steel = rgb(M[0]);
  const tip = rgb(M[1]);
  const flank = rgb(M[2]);
  const deep = rgb(M[3]);
  const bevel = rgb(M[4]);
  const rim = paint(rimG, (f, o) => {
    const r = Math.hypot(f.x, f.y);
    const az = Math.abs(f.nz);
    if (az > 0.92) o.c = steel;
    else if (az > 0.25) o.c = bevel;
    else if (r > g.rTip - (g.rTip - g.rRoot) * 0.2) o.c = tip;
    else if (r > g.rRoot + (g.rTip - g.rRoot) * 0.1) o.c = flank;
    else if (r < g.rRim + 0.02) o.c = deep;
    else o.c = deep;
  });

  // Speichen (etwas flacher als der Kranz → Kranz steht als Kante vor)
  const spokes: BufferGeometry[] = [];
  const len = g.rRim - g.rHub + 0.02;
  for (let i = 0; i < g.spokes; i++) {
    const a = (i / g.spokes) * Math.PI * 2 + Math.PI / 2;
    const sg = new BoxGeometry(len, (g.rRim - g.rHub) * 0.62, g.depth * 0.7);
    sg.translate(g.rHub + len / 2 - 0.01, 0, 0);
    sg.rotateZ(a);
    spokes.push(
      paint(sg, (f, o) => {
        o.c = Math.abs(f.nz) > 0.9 ? rgb(M[5]) : rgb(M[6]);
      }),
    );
  }

  // Nabe: erhaben, Sechskant-Achsloch, gefast
  const hubS = polyShape(g.rHub, 12);
  hubS.holes.push(polyShape(g.rHub * 0.42, 6));
  const hd = g.depth * 1.25;
  const hubG = new ExtrudeGeometry(hubS, { depth: hd - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.7, bevelSegments: 1, curveSegments: 1 });
  hubG.translate(0, 0, -(hd - bev * 2) / 2);
  const hub = paint(hubG, (f, o) => {
    const r = Math.hypot(f.x, f.y);
    const az = Math.abs(f.nz);
    if (r < g.rHub * 0.5) o.c = rgb('#14172a');
    else if (az > 0.92) o.c = rgb('#5a6396');
    else if (az > 0.25) o.c = rgb('#9aa6dc');
    else o.c = rgb('#3a4170');
  });

  // Leucht-Ring auf der Nabe (wie die Level-Trims)
  const glowS = polyShape(g.rHub * 0.86, 12);
  glowS.holes.push(polyShape(g.rHub * 0.66, 12));
  const glowG = new ExtrudeGeometry(glowS, { depth: 0.012, bevelEnabled: false, curveSegments: 1 });
  glowG.translate(0, 0, hd / 2 + 0.002);
  const glow = paint(glowG, solid(rgb('#33f0ff'), 2));

  return merge([rim, ...spokes, hub, glow]);
}

// ---------------------------------------------------------------- Halo (Leuchtfläche hinter der Auswahl)

/** Quadrat −0.5..0.5 mit uv — der Halo-Shader macht daraus gestufte Leuchtringe. */
export function quadGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  return g;
}
