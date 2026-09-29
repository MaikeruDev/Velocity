import { BufferAttribute, BufferGeometry } from 'three';

/**
 * Prozedurale Low-Poly-Körper für das Viewmodel (Plan 006): alles ist eine "Röhre" aus
 * elliptischen Ringen entlang +Y mit optionalen Polen. Daraus werden Handfläche, Finger-
 * Segmente (Kugel-Kappen → Gelenke überlappen weich wie ein Handschuh), Stulpe und Dose.
 *
 * Normalen sind GETEILT (glatt): Gouraud-Licht sieht dann nach weichem Handschuh aus, und
 * die Inverted-Hull-Kontur braucht glatte Normalen — mit Facetten-Normalen reißt die
 * ausgestülpte Hülle an jeder Kante auf. Die UV-Naht hat doppelte Vertices; deren Normalen
 * werden gemittelt, sonst klafft die Kontur genau dort.
 *
 * Plan 007 (Kosmetik v2): Superellipsen-Querschnitt (Metallhülsen, Feuerzeug, Handy), Lappen-
 * Profil (Spinner), Fell-Zacken (nur für Kontur-Geometrie), Vertex-Farbe und Zusammenführen
 * mehrerer Teile zu EINER Geometrie je Gelenk-Slot (gleiche Draw-Call-Zahl wie der Handschuh).
 * Ohne diese Optionen ist die Ausgabe bitgleich zu Plan 006 (Pixelvergleich K1/K2).
 */

export type Rgb = readonly [number, number, number];

export interface Ring {
  readonly y: number;
  /** Halbachsen quer (x) und in der Tiefe (z). */
  readonly rx: number;
  readonly rz: number;
  /** Mittelpunkt-Versatz (Standard 0). */
  readonly cx?: number;
  readonly cz?: number;
  /** Superellipsen-Exponent: 2 (Standard) = Ellipse, 4–8 = abgerundetes Rechteck. */
  readonly n?: number;
  /**
   * Zacken nur dieses Rings (wie TubeOptions.fur, überschreibt es): jeder zweite Vertex weiter außen — ein
   * gezackter Saum in der Silhouette statt einzelner Büschel (Katze, Review Phase 2). seg gerade.
   */
  readonly fur?: number;
  /** Welche Vertices außen liegen: 1 = ungerade (Standard), 0 = gerade — versetzte Zacken-Reihen (Katze). */
  readonly furPhase?: 0 | 1;
  /** Zacken-Vertices zusätzlich um so viel entlang y versetzt (−: Richtung Unterarm) — Büschel statt Sägeblatt. */
  readonly furDrop?: number;
}

export interface TubeOptions {
  /** Pol vor dem ersten / nach dem letzten Ring (y-Position), undefined = offen. */
  readonly poleStart?: number;
  readonly poleEnd?: number;
  /** v-Koordinate linear über y (für Etiketten), sonst über den Ringindex. */
  readonly uvByY?: boolean;
  /** Lappen: r(a) = r·(1 − depth + depth·max(0, cos(k·a))^0.6) — Spinner-Profil. */
  readonly lobes?: { readonly k: number; readonly depth: number };
  /** Jeder zweite Ring-Vertex um diesen Anteil weiter außen — Fell-Silhouette, nur für Hüllen (seg gerade). */
  readonly fur?: number;
  /** Vertex-Farbe (0..1, Anzeige-Werte); ohne color/colorAt bekommt die Geometrie kein color-Attribut. */
  readonly color?: Rgb;
  /** Farbe je Vertex aus der Position (Startwert = color bzw. Weiß). */
  readonly colorAt?: (x: number, y: number, z: number, out: [number, number, number]) => void;
}

export function tubeGeometry(rings: readonly Ring[], seg: number, opts: TubeOptions = {}): BufferGeometry {
  const n = rings.length;
  const row = seg + 1;
  const hasS = opts.poleStart !== undefined;
  const hasE = opts.poleEnd !== undefined;
  const count = n * row + (hasS ? 1 : 0) + (hasE ? 1 : 0);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const y0 = rings[0].y;
  const y1 = rings[n - 1].y;
  const span = Math.abs(y1 - y0) > 1e-6 ? y1 - y0 : 1;
  const lobes = opts.lobes;
  const fur = opts.fur ?? 0;
  // Naht-Vertex k = seg ist die Kopie von k = 0: bei ungeradem seg stünde er außen, k = 0 innen → Riss.
  if ((fur > 0 || rings.some((q) => (q.fur ?? 0) > 0)) && seg % 2 !== 0) throw new Error(`tubeGeometry: fur braucht gerades seg (${seg})`);
  for (let r = 0; r < n; r++) {
    const R = rings[r];
    const rf = R.fur ?? fur;
    const phase = R.furPhase ?? 1;
    // Exponent 2/n; bei der Ellipse exakt sin/cos (bitgleicher Pfad wie vor Plan 007).
    const e = R.n !== undefined && R.n !== 2 ? 2 / R.n : 0;
    for (let k = 0; k <= seg; k++) {
      // Winkel 0 zeigt nach +z (vorn), damit die Naht hinten (−z) liegt.
      const a = (k / seg) * Math.PI * 2;
      const i = r * row + k;
      const sa = e > 0 ? sgnPow(Math.sin(a), e) : Math.sin(a);
      const ca = e > 0 ? sgnPow(Math.cos(a), e) : Math.cos(a);
      let s = 1;
      if (lobes) s = 1 - lobes.depth + lobes.depth * Math.pow(Math.max(0, Math.cos(lobes.k * a)), 0.6);
      if (rf > 0 && k % 2 === phase) s *= 1 + rf;
      pos[i * 3] = (R.cx ?? 0) + sa * R.rx * s;
      pos[i * 3 + 1] = rf > 0 && k % 2 === phase ? R.y + (R.furDrop ?? 0) : R.y;
      pos[i * 3 + 2] = (R.cz ?? 0) + ca * R.rz * s;
      uv[i * 2] = k / seg;
      uv[i * 2 + 1] = opts.uvByY ? (R.y - y0) / span : r / Math.max(1, n - 1);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let k = 0; k < seg; k++) {
      const a = r * row + k;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // Außen gegen den Uhrzeigersinn (Winkel wächst von +z nach +x).
      idx.push(a, b, c, b, d, c);
    }
  }
  let next = n * row;
  let ps = -1;
  let pe = -1;
  if (hasS) {
    ps = next++;
    const R = rings[0];
    pos[ps * 3] = R.cx ?? 0;
    pos[ps * 3 + 1] = opts.poleStart ?? 0;
    pos[ps * 3 + 2] = R.cz ?? 0;
    uv[ps * 2] = 0.5;
    uv[ps * 2 + 1] = 0;
    for (let k = 0; k < seg; k++) idx.push(ps, k + 1, k);
  }
  if (hasE) {
    pe = next++;
    const R = rings[n - 1];
    pos[pe * 3] = R.cx ?? 0;
    pos[pe * 3 + 1] = opts.poleEnd ?? 0;
    pos[pe * 3 + 2] = R.cz ?? 0;
    uv[pe * 2] = 0.5;
    uv[pe * 2 + 1] = 1;
    const base = (n - 1) * row;
    for (let k = 0; k < seg; k++) idx.push(pe, base + k, base + k + 1);
  }
  // Ringe in −y-Richtung (Stulpe läuft vom Handgelenk nach unten): Winding umdrehen,
  // sonst zeigen alle Flächen nach innen und man sieht nur die schwarze Kontur-Hülle.
  if (y1 < y0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Naht: Normalen der doppelten Vertices mitteln.
  const nrm = g.getAttribute('normal') as BufferAttribute;
  const na = nrm.array as Float32Array;
  for (let r = 0; r < n; r++) {
    const a = r * row;
    const b = a + seg;
    for (let c = 0; c < 3; c++) {
      const m = (na[a * 3 + c] + na[b * 3 + c]) * 0.5;
      na[a * 3 + c] = m;
      na[b * 3 + c] = m;
    }
    normalize3(na, a);
    normalize3(na, b);
  }
  // Pole zeigen entlang der Achse (sonst mittelt computeVertexNormals schräg).
  if (ps >= 0) setAxisNormal(na, ps, rings[0].y > (opts.poleStart ?? 0) ? -1 : 1);
  if (pe >= 0) setAxisNormal(na, pe, (opts.poleEnd ?? 0) > rings[n - 1].y ? 1 : -1);
  nrm.needsUpdate = true;
  if (opts.color || opts.colorAt) paint(g, opts.color ?? WHITE, opts.colorAt);
  g.computeBoundingSphere();
  return g;
}

function sgnPow(v: number, p: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), p);
}

function normalize3(a: Float32Array, i: number): void {
  const x = a[i * 3];
  const y = a[i * 3 + 1];
  const z = a[i * 3 + 2];
  const l = Math.hypot(x, y, z) || 1;
  a[i * 3] = x / l;
  a[i * 3 + 1] = y / l;
  a[i * 3 + 2] = z / l;
}

function setAxisNormal(a: Float32Array, i: number, s: number): void {
  a[i * 3] = 0;
  a[i * 3 + 1] = s;
  a[i * 3 + 2] = 0;
}

const WHITE: Rgb = [1, 1, 1];

/** Hex → 0..1 ohne Farbraum-Umrechnung (wie hexVec der Materialien). */
export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Vertex-Farbe setzen (einfarbig oder je Position). Ladezeit, nicht im Frame-Pfad. */
export function paint(g: BufferGeometry, c: Rgb, at?: TubeOptions['colorAt']): BufferGeometry {
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const tmp: [number, number, number] = [c[0], c[1], c[2]];
  for (let i = 0; i < p.count; i++) {
    tmp[0] = c[0];
    tmp[1] = c[1];
    tmp[2] = c[2];
    if (at) at(p.getX(i), p.getY(i), p.getZ(i), tmp);
    col[i * 3] = tmp[0];
    col[i * 3 + 1] = tmp[1];
    col[i * 3 + 2] = tmp[2];
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/**
 * Kapsel-Ringe für ein Glied von y = 0 bis `len`: Kugelkappen mit r0 unten und r1 oben,
 * `squash` < 1 macht den Querschnitt flacher (z). Die Kappen überlappen die Nachbarglieder —
 * so sieht die Kette wie ein durchgehender, pummeliger Handschuhfinger aus. `n` = Superellipse.
 */
export function capsuleRings(len: number, r0: number, r1: number, squash = 1, capSteps = 2, n?: number): { rings: Ring[]; poleStart: number; poleEnd: number } {
  const rings: Ring[] = [];
  const ring = (y: number, rx: number, rz: number): Ring => (n === undefined ? { y, rx, rz } : { y, rx, rz, n });
  for (let i = capSteps; i >= 1; i--) {
    const th = (i / (capSteps + 1)) * (Math.PI / 2);
    rings.push(ring(-r0 * Math.sin(th), r0 * Math.cos(th), r0 * Math.cos(th) * squash));
  }
  rings.push(ring(0, r0, r0 * squash));
  const mid = (r0 + r1) * 0.5 * 1.02;
  rings.push(ring(len * 0.5, mid, mid * squash));
  rings.push(ring(len, r1, r1 * squash));
  for (let i = 1; i <= capSteps; i++) {
    const th = (i / (capSteps + 1)) * (Math.PI / 2);
    rings.push(ring(len + r1 * Math.sin(th), r1 * Math.cos(th), r1 * Math.cos(th) * squash));
  }
  return { rings, poleStart: -r0 * 0.96, poleEnd: len + r1 * 0.96 };
}

/** Zusatz-Optionen für Kapseln/Knochen (Pole setzt die Form selbst). */
export type ShapeOptions = Omit<TubeOptions, 'poleStart' | 'poleEnd' | 'uvByY'> & { readonly n?: number };

export function capsuleGeometry(len: number, r0: number, r1: number, seg: number, squash = 1, capSteps = 2, opts: ShapeOptions = {}): BufferGeometry {
  const c = capsuleRings(len, r0, r1, squash, capSteps, opts.n);
  return tubeGeometry(c.rings, seg, { ...opts, poleStart: c.poleStart, poleEnd: c.poleEnd });
}

/** Knochen/Stab: dicke Gelenkknöpfe an beiden Enden, schmaler Schaft (Skelett, Kendama-Griff). */
export function boneGeometry(len: number, knob: number, shaft: number, seg: number, opts: ShapeOptions = {}): BufferGeometry {
  const rings: Ring[] = [
    { y: -knob * 0.55, rx: knob * 0.6, rz: knob * 0.55 },
    { y: -knob * 0.1, rx: knob, rz: knob * 0.85 },
    { y: knob * 0.55, rx: shaft * 1.15, rz: shaft },
    { y: len * 0.5, rx: shaft, rz: shaft * 0.9 },
    { y: len - knob * 0.55, rx: shaft * 1.15, rz: shaft },
    { y: len + knob * 0.1, rx: knob, rz: knob * 0.85 },
    { y: len + knob * 0.55, rx: knob * 0.6, rz: knob * 0.55 },
  ];
  return tubeGeometry(rings, seg, { ...opts, poleStart: -knob * 0.8, poleEnd: len + knob * 0.8 });
}

/**
 * Mehrere Teile (position, normal, color, uv, Index) zu EINER Geometrie — je Gelenk-Slot ein
 * Mesh plus eine Hülle. Teile ohne color-Attribut werden `fallback` (Standard Weiß). Hat ein Teil ein
 * Skalar-Attribut aus SCALAR_ATTRS (Katze: Krallen `aClaw`, Tigerstreifen `aTabby`), bekommt die
 * Geometrie es für alle (fehlend = 0); sonst wie vorher.
 */
export function mergeGeometries(parts: readonly BufferGeometry[], fallback: Rgb = WHITE): BufferGeometry {
  let vc = 0;
  let ic = 0;
  for (const p of parts) {
    const P = p.getAttribute('position');
    vc += P.count;
    ic += p.getIndex()?.count ?? P.count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = new Uint32Array(ic);
  const extra = SCALAR_ATTRS.filter((a) => parts.some((p) => p.getAttribute(a) !== undefined)).map((name) => ({ name, data: new Float32Array(vc) }));
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const P = p.getAttribute('position');
    const N = p.getAttribute('normal');
    const C = p.getAttribute('color');
    const U = p.getAttribute('uv');
    for (const x of extra) {
      const K = p.getAttribute(x.name);
      if (K) for (let i = 0; i < P.count; i++) x.data[vo + i] = K.getX(i);
    }
    for (let i = 0; i < P.count; i++) {
      const k = (vo + i) * 3;
      pos[k] = P.getX(i);
      pos[k + 1] = P.getY(i);
      pos[k + 2] = P.getZ(i);
      nrm[k] = N ? N.getX(i) : 0;
      nrm[k + 1] = N ? N.getY(i) : 1;
      nrm[k + 2] = N ? N.getZ(i) : 0;
      col[k] = C ? C.getX(i) : fallback[0];
      col[k + 1] = C ? C.getY(i) : fallback[1];
      col[k + 2] = C ? C.getZ(i) : fallback[2];
      uv[(vo + i) * 2] = U ? U.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = U ? U.getY(i) : 0;
    }
    const I = p.getIndex();
    if (I) for (let i = 0; i < I.count; i++) idx[io + i] = I.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io + i] = vo + i;
    vo += P.count;
    io += I?.count ?? P.count;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  for (const x of extra) g.setAttribute(x.name, new BufferAttribute(x.data, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Skalar-Attribute je Vertex, die mergeGeometries mitnimmt (Shader-Masken der Katze). */
const SCALAR_ATTRS = ['aClaw', 'aTabby'] as const;

/** Krallen-Gewicht für alle Vertices setzen (1 = fährt mit uClaw aus/ein). Ladezeit. */
export function markClaw(g: BufferGeometry, w = 1): BufferGeometry {
  g.setAttribute('aClaw', new BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(w), 1));
  return g;
}

/**
 * Tigerstreifen-Muster eines Teils (Katze, Shader TABBY): 1 = Pfote/Finger (Querstreifen auf Rücken
 * und Seiten), 2 = Bein (breite, gewellte Ringe), 0 = keine. Je Teil konstant — so bleibt der Wert
 * nach der Interpolation exakt und die Streifen enden an den Teilgrenzen scharf. Ladezeit.
 */
export function markTabby(g: BufferGeometry, mode: 0 | 1 | 2): BufferGeometry {
  g.setAttribute('aTabby', new BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(mode), 1));
  return g;
}

/**
 * Quader mit Normalen je Fläche (Karte, Messergriffe). Gruppen in three-Reihenfolge
 * +x, −x, +y, −y, +z, −z — Materialarrays funktionieren wie bei BoxGeometry.
 * Für die Kontur zusätzlich `smoothBox` (geteilte, gemittelte Normalen).
 */
export function smoothBoxGeometry(w: number, h: number, d: number): BufferGeometry {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const pos = new Float32Array([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]);
  const nrm = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    // Ecken-Normale exakt diagonal (Vorzeichen, NICHT Position): bei dünnen/langen Quadern
    // (Karte, Griff) zeigte die Positions-Normale fast nur entlang der langen Achse — die
    // Kontur an den langen Kanten fehlte dann.
    const k = 1 / Math.sqrt(3);
    nrm[i * 3] = Math.sign(pos[i * 3]) * k;
    nrm[i * 3 + 1] = Math.sign(pos[i * 3 + 1]) * k;
    nrm[i * 3 + 2] = Math.sign(pos[i * 3 + 2]) * k;
  }
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Scheibe in der xz-Ebene (Deckel, Boden), Normale +y. */
export function discGeometry(r: number, seg: number, y = 0): BufferGeometry {
  const pos = new Float32Array((seg + 1) * 3);
  const uv = new Float32Array((seg + 1) * 2);
  const nrm = new Float32Array((seg + 1) * 3);
  pos[1] = y;
  uv[0] = 0.5;
  uv[1] = 0.5;
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const i = k + 1;
    pos[i * 3] = Math.sin(a) * r;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.cos(a) * r;
    uv[i * 2] = 0.5 + Math.sin(a) * 0.5;
    uv[i * 2 + 1] = 0.5 + Math.cos(a) * 0.5;
  }
  for (let i = 0; i <= seg; i++) nrm[i * 3 + 1] = 1;
  const idx: number[] = [];
  for (let k = 0; k < seg; k++) idx.push(0, k + 1, ((k + 1) % seg) + 1);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Ring (Kreisband) in der xz-Ebene zwischen r0 und r1, Normale +y — Unschärfe-Ring des Spinners. */
export function annulusGeometry(r0: number, r1: number, seg: number): BufferGeometry {
  const pos = new Float32Array((seg + 1) * 2 * 3);
  const nrm = new Float32Array((seg + 1) * 2 * 3);
  const uv = new Float32Array((seg + 1) * 2 * 2);
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const i = k * 2;
    pos[i * 3] = s * r0;
    pos[i * 3 + 2] = c * r0;
    pos[(i + 1) * 3] = s * r1;
    pos[(i + 1) * 3 + 2] = c * r1;
    nrm[i * 3 + 1] = 1;
    nrm[(i + 1) * 3 + 1] = 1;
    uv[i * 2] = k / seg;
    uv[(i + 1) * 2] = k / seg;
    uv[(i + 1) * 2 + 1] = 1;
  }
  const idx: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = k * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
