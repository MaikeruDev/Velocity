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
 */

export interface Ring {
  readonly y: number;
  /** Halbachsen quer (x) und in der Tiefe (z). */
  readonly rx: number;
  readonly rz: number;
  /** Mittelpunkt-Versatz (Standard 0). */
  readonly cx?: number;
  readonly cz?: number;
}

export interface TubeOptions {
  /** Pol vor dem ersten / nach dem letzten Ring (y-Position), undefined = offen. */
  readonly poleStart?: number;
  readonly poleEnd?: number;
  /** v-Koordinate linear über y (für Etiketten), sonst über den Ringindex. */
  readonly uvByY?: boolean;
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
  for (let r = 0; r < n; r++) {
    const R = rings[r];
    for (let k = 0; k <= seg; k++) {
      // Winkel 0 zeigt nach +z (vorn), damit die Naht hinten (−z) liegt.
      const a = (k / seg) * Math.PI * 2;
      const i = r * row + k;
      pos[i * 3] = (R.cx ?? 0) + Math.sin(a) * R.rx;
      pos[i * 3 + 1] = R.y;
      pos[i * 3 + 2] = (R.cz ?? 0) + Math.cos(a) * R.rz;
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
  g.computeBoundingSphere();
  return g;
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

/**
 * Kapsel-Ringe für ein Glied von y = 0 bis `len`: Kugelkappen mit r0 unten und r1 oben,
 * `squash` < 1 macht den Querschnitt flacher (z). Die Kappen überlappen die Nachbarglieder —
 * so sieht die Kette wie ein durchgehender, pummeliger Handschuhfinger aus.
 */
export function capsuleRings(len: number, r0: number, r1: number, squash = 1, capSteps = 2): { rings: Ring[]; poleStart: number; poleEnd: number } {
  const rings: Ring[] = [];
  for (let i = capSteps; i >= 1; i--) {
    const th = (i / (capSteps + 1)) * (Math.PI / 2);
    rings.push({ y: -r0 * Math.sin(th), rx: r0 * Math.cos(th), rz: r0 * Math.cos(th) * squash });
  }
  rings.push({ y: 0, rx: r0, rz: r0 * squash });
  const mid = (r0 + r1) * 0.5 * 1.02;
  rings.push({ y: len * 0.5, rx: mid, rz: mid * squash });
  rings.push({ y: len, rx: r1, rz: r1 * squash });
  for (let i = 1; i <= capSteps; i++) {
    const th = (i / (capSteps + 1)) * (Math.PI / 2);
    rings.push({ y: len + r1 * Math.sin(th), rx: r1 * Math.cos(th), rz: r1 * Math.cos(th) * squash });
  }
  return { rings, poleStart: -r0 * 0.96, poleEnd: len + r1 * 0.96 };
}

export function capsuleGeometry(len: number, r0: number, r1: number, seg: number, squash = 1, capSteps = 2): BufferGeometry {
  const c = capsuleRings(len, r0, r1, squash, capSteps);
  return tubeGeometry(c.rings, seg, { poleStart: c.poleStart, poleEnd: c.poleEnd });
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
