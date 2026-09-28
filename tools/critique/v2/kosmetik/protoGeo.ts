import { BufferAttribute, BufferGeometry } from 'three';

/**
 * PROTOTYP (Kosmetik v2): Geometrie-Bausteine für Skins und neue Gegenstände. Erweitert die Idee
 * von render/viewmodel/vmGeometry.tubeGeometry um
 * - Superellipsen-Querschnitt (`n`: 2 = Ellipse, 4–8 = abgerundetes Rechteck: Metallplatten,
 *   Feuerzeug, Handy),
 * - beliebiges Radius-Profil (`lobes`: Fidget-Spinner),
 * - Kontur-Zacken (`fur`: nur für die Hülle — Fell-Silhouette der Katzenpfote),
 * - Farbe je Teil (Vertex-Farben) und Zusammenführen mehrerer Teile zu EINER Geometrie je
 *   Gelenk-Slot (gleiche Zahl Draw Calls wie der Handschuh).
 * Normalen geteilt + Naht gemittelt wie im Original (Inverted Hull braucht glatte Normalen).
 */

export interface PRing {
  readonly y: number;
  readonly rx: number;
  readonly rz: number;
  readonly cx?: number;
  readonly cz?: number;
  /** Superellipsen-Exponent (2 = Ellipse). */
  readonly n?: number;
}

export interface PTubeOptions {
  readonly poleStart?: number;
  readonly poleEnd?: number;
  /** Lappen: Anzahl und Tiefe (Anteil von rx/rz) — r(a) = r·(1 − depth + depth·max(0, cos(k·a))^0.6). */
  readonly lobes?: { readonly k: number; readonly depth: number };
  /** Hülle mit Zacken: jeder zweite Vertex um diesen Anteil nach außen (nur für Konturgeometrie). */
  readonly fur?: number;
  readonly color?: readonly [number, number, number];
  /** Farbe je Vertex aus Position (überschreibt color). */
  readonly colorAt?: (x: number, y: number, z: number, out: [number, number, number]) => void;
}

const sgnPow = (v: number, p: number): number => Math.sign(v) * Math.pow(Math.abs(v), p);

export function ptube(rings: readonly PRing[], seg: number, o: PTubeOptions = {}): BufferGeometry {
  const n = rings.length;
  const row = seg + 1;
  const hasS = o.poleStart !== undefined;
  const hasE = o.poleEnd !== undefined;
  const count = n * row + (hasS ? 1 : 0) + (hasE ? 1 : 0);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let r = 0; r < n; r++) {
    const R = rings[r];
    const e = 2 / (R.n ?? 2);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      let s = 1;
      if (o.lobes) s = 1 - o.lobes.depth + o.lobes.depth * Math.pow(Math.max(0, Math.cos(o.lobes.k * a)), 0.6);
      if (o.fur && k % 2 === 1) s *= 1 + o.fur;
      const i = r * row + k;
      pos[i * 3] = (R.cx ?? 0) + sgnPow(Math.sin(a), e) * R.rx * s;
      pos[i * 3 + 1] = R.y;
      pos[i * 3 + 2] = (R.cz ?? 0) + sgnPow(Math.cos(a), e) * R.rz * s;
      uv[i * 2] = k / seg;
      uv[i * 2 + 1] = r / Math.max(1, n - 1);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let k = 0; k < seg; k++) {
      const a = r * row + k;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  let next = n * row;
  let ps = -1;
  let pe = -1;
  if (hasS) {
    ps = next++;
    pos[ps * 3] = rings[0].cx ?? 0;
    pos[ps * 3 + 1] = o.poleStart ?? 0;
    pos[ps * 3 + 2] = rings[0].cz ?? 0;
    for (let k = 0; k < seg; k++) idx.push(ps, k + 1, k);
  }
  if (hasE) {
    pe = next++;
    const R = rings[n - 1];
    pos[pe * 3] = R.cx ?? 0;
    pos[pe * 3 + 1] = o.poleEnd ?? 0;
    pos[pe * 3 + 2] = R.cz ?? 0;
    const base = (n - 1) * row;
    for (let k = 0; k < seg; k++) idx.push(pe, base + k, base + k + 1);
  }
  if (rings[n - 1].y < rings[0].y) {
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
  }
  const setAxis = (i: number, s: number): void => {
    na[i * 3] = 0;
    na[i * 3 + 1] = s;
    na[i * 3 + 2] = 0;
  };
  if (ps >= 0) setAxis(ps, rings[0].y > (o.poleStart ?? 0) ? -1 : 1);
  if (pe >= 0) setAxis(pe, (o.poleEnd ?? 0) > rings[n - 1].y ? 1 : -1);
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(na[i * 3], na[i * 3 + 1], na[i * 3 + 2]) || 1;
    na[i * 3] /= l;
    na[i * 3 + 1] /= l;
    na[i * 3 + 2] /= l;
  }
  nrm.needsUpdate = true;
  paint(g, o.color ?? [1, 1, 1], o.colorAt);
  g.computeBoundingSphere();
  return g;
}

/** Kapsel (Glied) von 0 bis len mit Kugelkappen, optional Superellipse. */
export function pcapsule(len: number, r0: number, r1: number, seg: number, o: PTubeOptions & { readonly squash?: number; readonly n?: number } = {}): BufferGeometry {
  const sq = o.squash ?? 1;
  const rings: PRing[] = [];
  const caps = 2;
  for (let i = caps; i >= 1; i--) {
    const th = (i / (caps + 1)) * (Math.PI / 2);
    rings.push({ y: -r0 * Math.sin(th), rx: r0 * Math.cos(th), rz: r0 * Math.cos(th) * sq, n: o.n });
  }
  rings.push({ y: 0, rx: r0, rz: r0 * sq, n: o.n });
  const mid = (r0 + r1) * 0.51;
  rings.push({ y: len * 0.5, rx: mid, rz: mid * sq, n: o.n });
  rings.push({ y: len, rx: r1, rz: r1 * sq, n: o.n });
  for (let i = 1; i <= caps; i++) {
    const th = (i / (caps + 1)) * (Math.PI / 2);
    rings.push({ y: len + r1 * Math.sin(th), rx: r1 * Math.cos(th), rz: r1 * Math.cos(th) * sq, n: o.n });
  }
  return ptube(rings, seg, { ...o, poleStart: -r0 * 0.96, poleEnd: len + r1 * 0.96 });
}

/** Knochen: dicke Gelenkknöpfe an beiden Enden, schmaler Schaft. */
export function pbone(len: number, knob: number, shaft: number, seg: number, o: PTubeOptions = {}): BufferGeometry {
  const rings: PRing[] = [
    { y: -knob * 0.55, rx: knob * 0.6, rz: knob * 0.55 },
    { y: -knob * 0.1, rx: knob, rz: knob * 0.85 },
    { y: knob * 0.55, rx: shaft * 1.15, rz: shaft },
    { y: len * 0.5, rx: shaft, rz: shaft * 0.9 },
    { y: len - knob * 0.55, rx: shaft * 1.15, rz: shaft },
    { y: len + knob * 0.1, rx: knob, rz: knob * 0.85 },
    { y: len + knob * 0.55, rx: knob * 0.6, rz: knob * 0.55 },
  ];
  return ptube(rings, seg, { ...o, poleStart: -knob * 0.8, poleEnd: len + knob * 0.8 });
}

function paint(g: BufferGeometry, c: readonly [number, number, number], at?: PTubeOptions['colorAt']): void {
  const p = g.getAttribute('position') as BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const tmp: [number, number, number] = [c[0], c[1], c[2]];
  for (let i = 0; i < p.count; i++) {
    if (at) {
      tmp[0] = c[0];
      tmp[1] = c[1];
      tmp[2] = c[2];
      at(p.getX(i), p.getY(i), p.getZ(i), tmp);
    }
    col[i * 3] = tmp[0];
    col[i * 3 + 1] = tmp[1];
    col[i * 3 + 2] = tmp[2];
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

/** Farbe als Hex → 0..1 (Anzeige-Werte, keine Farbraum-Umrechnung wie hexVec). */
export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Mehrere Teile (position, normal, color, Index) zu einer Geometrie. */
export function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  let vc = 0;
  let ic = 0;
  for (const p of parts) {
    vc += p.getAttribute('position').count;
    ic += p.getIndex()?.count ?? 0;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const P = p.getAttribute('position');
    const N = p.getAttribute('normal');
    const C = p.getAttribute('color');
    const U = p.getAttribute('uv');
    for (let i = 0; i < P.count; i++) {
      const k = (vo + i) * 3;
      pos[k] = P.getX(i);
      pos[k + 1] = P.getY(i);
      pos[k + 2] = P.getZ(i);
      nrm[k] = N.getX(i);
      nrm[k + 1] = N.getY(i);
      nrm[k + 2] = N.getZ(i);
      col[k] = C ? C.getX(i) : 1;
      col[k + 1] = C ? C.getY(i) : 1;
      col[k + 2] = C ? C.getZ(i) : 1;
      uv[(vo + i) * 2] = U ? U.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = U ? U.getY(i) : 0;
    }
    const I = p.getIndex();
    if (I) for (let i = 0; i < I.count; i++) idx[io + i] = I.getX(i) + vo;
    vo += P.count;
    io += I?.count ?? 0;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export function triCount(g: BufferGeometry): number {
  return (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;
}
