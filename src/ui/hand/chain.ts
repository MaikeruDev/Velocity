/**
 * Ebene Gelenk-Kette (Plan 008): bis zu 3 starre Glieder als Pendel hintereinander, das erste dreht um einen
 * bewegten Drehpunkt der "Basis" (z. B. der gehaltene Griff in der Hand). Die Basis gibt pro Zeitpunkt
 * Winkel, Winkelgeschwindigkeit, Drehpunkt-Beschleunigung und Schwerkraft in der Kettenebene vor (Antrieb
 * durch das Handgelenk: Flick = Basis-Drehung/-Beschleunigung). Die Glieder folgen mit Trägheit
 * (Lagrange-Gleichungen, Massenmatrix n×n), Lager-Reibung, Anschlägen (Gelenk-Grenzen mit Rückprall per
 * Impuls) und optionalen Zusatzkräften (Kontakte als Feder-Dämpfer, Fingerdruck, "Führung" zu einem
 * Zielwinkel).
 *
 * Zeit: festes Raster h (Standard 1/960 s) ab dem Start, Ausgabe zwischen den zwei Raster-Zuständen um die
 * Abfragezeit interpoliert → jede Framerate sieht dieselbe Bahn (bis auf die Interpolation). Keine Allokation
 * nach dem Konstruktor. DOM-/three-frei.
 *
 * Konvention: Winkel q absolut in der Ebene (gegen den Uhrzeigersinn), Glied-lokale Vektoren werden um q
 * gedreht. Relativwinkel ρ0 = q0 − θ (Glied 0 zur Basis), ρi = qi − q(i−1).
 */

export interface LinkDef {
  /** Masse (beliebige Einheit, nur Verhältnisse zählen) und Trägheit um den Schwerpunkt. */
  readonly mass: number;
  readonly inertia: number;
  /** Schwerpunkt im Glied (vom eigenen Drehpunkt). */
  readonly com: readonly [number, number];
  /** Drehpunkt des NÄCHSTEN Glieds im Glied. */
  readonly next?: readonly [number, number];
  /** Lager-Reibung (Drehmoment je rad/s Relativdrehung). */
  readonly friction?: number;
  /** Grenzen des Relativwinkels ρ (rad) und Rückprall 0..1; ohne = frei. */
  readonly limit?: readonly [lo: number, hi: number, restitution: number];
}

/** Basis-Zustand zur Zeit t (Kettenebene): [aPx, aPy, θ, θ̇, gx, gy]. */
export const BASE_AX = 0;
export const BASE_AY = 1;
export const BASE_ANGLE = 2;
export const BASE_RATE = 3;
export const BASE_GX = 4;
export const BASE_GY = 5;

/**
 * Antrieb der Kette. Die Zeit steht in chain.tEval (Feld statt Argument: Kommazahl-Argumente nicht geinlineter
 * Aufrufe boxt V8 je Aufruf — bei 2 × 960 Aufrufen/s spürbarer Müll, fallen.md #107).
 */
export interface ChainDriver {
  /** Basis zur Zeit chain.tEval in out (BASE_*). */
  base(chain: PlanarChain, out: Float64Array): void;
  /**
   * Zusatzkräfte (generalisiert, je Glied ein Drehmoment um seine Koordinate) zur Zeit chain.tEval — Kontakte,
   * Finger, Führung. Q ist vorbelegt mit 0; der Zustand der Kette ist lesbar (q, qd).
   */
  forces?(chain: PlanarChain, Q: Float64Array): void;
}

const MAXN = 3;

export class PlanarChain {
  readonly n: number;
  readonly q = new Float64Array(MAXN);
  readonly qd = new Float64Array(MAXN);
  /** Zeit des aktuellen Raster-Zustands und der vorige Zustand (Interpolation). */
  simT = 0.5;
  /** Zeit der laufenden Auswertung (für den Treiber, siehe ChainDriver). */
  tEval = 0.5;
  private readonly qPrev = new Float64Array(MAXN);
  private readonly qdPrev = new Float64Array(MAXN);
  readonly h: number;
  private readonly links: readonly LinkDef[];
  private driver: ChainDriver;
  // Scratch
  private readonly baseS = new Float64Array(6);
  private readonly M = new Float64Array(MAXN * MAXN);
  private readonly rhs = new Float64Array(MAXN);
  private readonly Q = new Float64Array(MAXN);
  private readonly acc = new Float64Array(MAXN);
  /** w[i][j]: Vektor (2D) vom Drehpunkt j zum nächsten Drehpunkt (j < i) bzw. zum Schwerpunkt (j = i). */
  private readonly w = new Float64Array(MAXN * MAXN * 2);
  private readonly Minv = new Float64Array(MAXN * MAXN);
  /** Anschläge seit dem letzten Abholen: Glied-Bitmaske und größte Aufprall-Relativgeschwindigkeit (rad/s). */
  hits = 0;
  hitSpeed = 0.5;
  /** Interpolierte Ausgabe (q, qd) zur letzten advanceTo-Zeit. */
  readonly outQ = new Float64Array(MAXN);
  readonly outQd = new Float64Array(MAXN);

  constructor(links: readonly LinkDef[], driver: ChainDriver, h = 1 / 960) {
    if (links.length < 1 || links.length > MAXN) throw new Error('PlanarChain: 1..3 Glieder');
    this.n = links.length;
    this.links = links;
    this.driver = driver;
    this.h = h;
    this.simT = 0;
    this.tEval = 0;
    this.hitSpeed = 0;
  }

  setDriver(d: ChainDriver): void {
    this.driver = d;
  }

  /** Start bei Zeit t0 mit RELATIVwinkeln rho (zur Basis/zum Vorgänger) und Relativ-Geschwindigkeit 0. */
  reset(t0: number, rho: ArrayLike<number>): void {
    this.tEval = t0;
    this.driver.base(this, this.baseS);
    let a = this.baseS[BASE_ANGLE];
    const rate = this.baseS[BASE_RATE];
    for (let i = 0; i < this.n; i++) {
      a += rho[i];
      this.q[i] = a;
      this.qd[i] = rate;
    }
    this.simT = t0;
    this.qPrev.set(this.q);
    this.qdPrev.set(this.qd);
    this.outQ.set(this.q);
    this.outQd.set(this.qd);
    this.hits = 0;
    this.hitSpeed = 0;
  }

  /** Relativwinkel ρi aus einem Absolut-Satz (Basiswinkel θ). */
  rel(i: number, theta: number, q: ArrayLike<number> = this.outQ): number {
    return i === 0 ? q[0] - theta : q[i] - q[i - 1];
  }

  /** Bis Zeit t rechnen (Raster), Ausgabe interpoliert in outQ/outQd. */
  advanceTo(t: number): void {
    const h = this.h;
    // Höchstens 2 s je Aufruf (Schutz bei Sprüngen der Zeit).
    let guard = Math.ceil(2 / h);
    while (this.simT < t && guard-- > 0) {
      this.qPrev.set(this.q);
      this.qdPrev.set(this.qd);
      this.step();
      this.simT += h;
    }
    const a = h > 0 ? 1 - (this.simT - t) / h : 1;
    const k = a < 0 ? 0 : a > 1 ? 1 : a;
    for (let i = 0; i < this.n; i++) {
      this.outQ[i] = this.qPrev[i] + (this.q[i] - this.qPrev[i]) * k;
      this.outQd[i] = this.qdPrev[i] + (this.qd[i] - this.qdPrev[i]) * k;
    }
  }

  /**
   * Ein Schritt (Geschwindigkeits-Verlet: halbe Geschwindigkeit, ganze Lage, Beschleunigung neu, halbe
   * Geschwindigkeit — symplektisch, Energie-Drift deutlich kleiner als Euler), danach Anschläge.
   */
  private step(): void {
    const n = this.n;
    const q = this.q;
    const qd = this.qd;
    const h = this.h;
    this.tEval = this.simT;
    this.accel();
    for (let i = 0; i < n; i++) {
      qd[i] += this.acc[i] * (h / 2);
      q[i] += qd[i] * h;
    }
    this.tEval = this.simT + h;
    this.accel();
    for (let i = 0; i < n; i++) qd[i] += this.acc[i] * (h / 2);
    this.limits();
  }

  /** Beschleunigungen (acc) im aktuellen Zustand zur Zeit tEval (Basis, Kräfte des Treibers). */
  private accel(): void {
    const n = this.n;
    const L = this.links;
    const B = this.baseS;
    this.driver.base(this, B);
    const q = this.q;
    const qd = this.qd;
    const w = this.w;
    // w[i][j]
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        const v = j < i ? (L[j].next ?? ZERO2) : L[i].com;
        const c = Math.cos(q[j]);
        const s = Math.sin(q[j]);
        const o = (i * MAXN + j) * 2;
        w[o] = v[0] * c - v[1] * s;
        w[o + 1] = v[0] * s + v[1] * c;
      }
    }
    // Massenmatrix M_kj = Σ_{i ≥ max(k,j)} m_i v_ik·v_ij + δ I_k, v = perp(w) → v_ik·v_ij = w_ik·w_ij (die Schleife
    // über i ≥ k, j ≤ i trifft genau diese Summanden, auch für j > k).
    const M = this.M;
    const rhs = this.rhs;
    const Q = this.Q;
    Q.fill(0);
    // Reibung an den Lagern (relativ), Führung/Kontakte per Treiber.
    for (let i = 0; i < n; i++) {
      const fr = L[i].friction ?? 0;
      if (fr > 0) {
        const rel = i === 0 ? qd[0] - B[BASE_RATE] : qd[i] - qd[i - 1];
        Q[i] -= fr * rel;
        if (i > 0) Q[i - 1] += fr * rel;
      }
    }
    this.driver.forces?.(this, Q);
    const ex = B[BASE_GX] - B[BASE_AX];
    const ey = B[BASE_GY] - B[BASE_AY];
    for (let k = 0; k < n; k++) {
      let r = Q[k];
      for (let j = 0; j < n; j++) M[k * MAXN + j] = j === k ? L[k].inertia : 0;
      for (let i = k; i < n; i++) {
        const m = L[i].mass;
        const ok = (i * MAXN + k) * 2;
        // v_ik = perp(w_ik) = (−wy, wx)
        const vx = -w[ok + 1];
        const vy = w[ok];
        let ax = ex;
        let ay = ey;
        for (let j = 0; j <= i; j++) {
          const oj = (i * MAXN + j) * 2;
          const qq = qd[j] * qd[j];
          ax += qq * w[oj];
          ay += qq * w[oj + 1];
          M[k * MAXN + j] += m * (w[ok] * w[oj] + w[ok + 1] * w[oj + 1]);
        }
        r += m * (vx * ax + vy * ay);
      }
      rhs[k] = r;
    }
    this.solve(M, rhs, this.acc, n);
  }

  /** Gelenk-Grenzen: Lage zurück auf die Grenze, Relativgeschwindigkeit per Impuls (Massenmatrix) umkehren. */
  private limits(): void {
    const theta = this.baseS[BASE_ANGLE];
    const rate = this.baseS[BASE_RATE];
    const n = this.n;
    const L = this.links;
    const q = this.q;
    const qd = this.qd;
    for (let i = 0; i < n; i++) {
      const lim = L[i].limit;
      if (!lim) continue;
      const rho = i === 0 ? q[0] - theta : q[i] - q[i - 1];
      const lo = lim[0];
      const hi = lim[1];
      if (rho >= lo && rho <= hi) continue;
      const target = rho < lo ? lo : hi;
      const C = rho - target;
      const vrel = i === 0 ? qd[0] - rate : qd[i] - qd[i - 1];
      // Zeile J: ∂ρ/∂q (i = 0: [1, 0, …]; sonst [… −1 bei i−1, +1 bei i …]).
      this.invertM(n);
      const Mi = this.Minv;
      // J M⁻¹ Jᵀ und M⁻¹ Jᵀ
      const ji = i;
      const jp = i - 1;
      let k = Mi[ji * MAXN + ji];
      if (jp >= 0) k += Mi[jp * MAXN + jp] - Mi[ji * MAXN + jp] - Mi[jp * MAXN + ji];
      if (!(k > 1e-12)) continue;
      // Lage projizieren
      for (let r = 0; r < n; r++) {
        const col = Mi[r * MAXN + ji] - (jp >= 0 ? Mi[r * MAXN + jp] : 0);
        q[r] -= (col * C) / k;
      }
      // Nur bei Bewegung in die Grenze hinein: Impuls mit Rückprall.
      const into = (rho < lo && vrel < 0) || (rho > hi && vrel > 0);
      if (into) {
        const e = lim[2];
        const lam = (-(1 + e) * vrel) / k;
        for (let r = 0; r < n; r++) {
          const col = Mi[r * MAXN + ji] - (jp >= 0 ? Mi[r * MAXN + jp] : 0);
          qd[r] += col * lam;
        }
        this.hits |= 1 << i;
        const sp = vrel < 0 ? -vrel : vrel;
        if (sp > this.hitSpeed) this.hitSpeed = sp;
      }
    }
  }

  /** Anschläge abholen (Bitmaske) und zurücksetzen. */
  takeHits(): number {
    const h = this.hits;
    this.hits = 0;
    return h;
  }

  private invertM(n: number): void {
    const M = this.M;
    const I = this.Minv;
    if (n === 1) {
      I[0] = 1 / M[0];
      return;
    }
    if (n === 2) {
      const a = M[0];
      const b = M[1];
      const c = M[MAXN];
      const d = M[MAXN + 1];
      const det = a * d - b * c;
      I[0] = d / det;
      I[1] = -b / det;
      I[MAXN] = -c / det;
      I[MAXN + 1] = a / det;
      return;
    }
    // 3×3 über die Adjunkte
    const m00 = M[0], m01 = M[1], m02 = M[2];
    const m10 = M[3], m11 = M[4], m12 = M[5];
    const m20 = M[6], m21 = M[7], m22 = M[8];
    const c00 = m11 * m22 - m12 * m21;
    const c01 = m12 * m20 - m10 * m22;
    const c02 = m10 * m21 - m11 * m20;
    const det = m00 * c00 + m01 * c01 + m02 * c02;
    I[0] = c00 / det;
    I[1] = (m02 * m21 - m01 * m22) / det;
    I[2] = (m01 * m12 - m02 * m11) / det;
    I[3] = c01 / det;
    I[4] = (m00 * m22 - m02 * m20) / det;
    I[5] = (m02 * m10 - m00 * m12) / det;
    I[6] = c02 / det;
    I[7] = (m01 * m20 - m00 * m21) / det;
    I[8] = (m00 * m11 - m01 * m10) / det;
  }

  private solve(M: Float64Array, b: Float64Array, x: Float64Array, n: number): void {
    this.invertM(n);
    const I = this.Minv;
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += I[r * MAXN + c] * b[c];
      x[r] = s;
    }
  }

  /**
   * Kraft F (2D, Kettenebene) an einem Punkt p (lokal im Glied `link`) → generalisierte Kräfte in Q
   * (für ChainDriver.forces: Kontakte, Fingerdruck). Liest den aktuellen Raster-Zustand.
   */
  applyForce(link: number, px: number, py: number, fx: number, fy: number, Q: Float64Array): void {
    const L = this.links;
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : px;
      const ly = v ? v[1] : py;
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      const wx = lx * c - ly * s;
      const wy = lx * s + ly * c;
      // Drehmoment = w × F (z-Komponente)
      Q[j] += wx * fy - wy * fx;
    }
  }

  /**
   * Wie pointOf/velocityOf/applyForce, lokaler Punkt (und Kraft) aus a[0..1] (bzw. a[2..3]) — Frame-Pfad ohne
   * Kommazahl-Argumente (V8 boxt sie bei nicht geinlineten Aufrufen, fallen.md #107).
   */
  pointOfA(link: number, a: Float64Array, out: Float64Array): void {
    const L = this.links;
    let x = 0;
    let y = 0;
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : a[0];
      const ly = v ? v[1] : a[1];
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      x += lx * c - ly * s;
      y += lx * s + ly * c;
    }
    out[0] = x;
    out[1] = y;
  }

  velocityOfA(link: number, a: Float64Array, out: Float64Array): void {
    const L = this.links;
    let vx = 0;
    let vy = 0;
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : a[0];
      const ly = v ? v[1] : a[1];
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      const wx = lx * c - ly * s;
      const wy = lx * s + ly * c;
      vx -= this.qd[j] * wy;
      vy += this.qd[j] * wx;
    }
    out[0] = vx;
    out[1] = vy;
  }

  applyForceA(link: number, a: Float64Array, Q: Float64Array): void {
    const L = this.links;
    const fx = a[2];
    const fy = a[3];
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : a[0];
      const ly = v ? v[1] : a[1];
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      Q[j] += (lx * c - ly * s) * fy - (lx * s + ly * c) * fx;
    }
  }

  /** Punkt p (lokal in Glied `link`) relativ zum Basis-Drehpunkt (aktueller Raster-Zustand) → out [x, y]. */
  pointOf(link: number, px: number, py: number, out: Float64Array): void {
    const L = this.links;
    let x = 0;
    let y = 0;
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : px;
      const ly = v ? v[1] : py;
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      x += lx * c - ly * s;
      y += lx * s + ly * c;
    }
    out[0] = x;
    out[1] = y;
  }

  /** Geschwindigkeit des Punkts p (lokal in `link`) relativ zum Basis-Drehpunkt → out [vx, vy]. */
  velocityOf(link: number, px: number, py: number, out: Float64Array): void {
    const L = this.links;
    let vx = 0;
    let vy = 0;
    for (let j = 0; j <= link; j++) {
      const v = j < link ? (L[j].next ?? ZERO2) : null;
      const lx = v ? v[0] : px;
      const ly = v ? v[1] : py;
      const c = Math.cos(this.q[j]);
      const s = Math.sin(this.q[j]);
      const wx = lx * c - ly * s;
      const wy = lx * s + ly * c;
      vx -= this.qd[j] * wy;
      vy += this.qd[j] * wx;
    }
    out[0] = vx;
    out[1] = vy;
  }

  /** Kinetische + potentielle Energie relativ zum Drehpunkt (ruhende Basis, Schwerkraft g) — Tests. */
  energy(gx: number, gy: number): number {
    const L = this.links;
    const p = this.e2;
    const v = this.e3;
    let E = 0;
    for (let i = 0; i < this.n; i++) {
      this.pointOf(i, L[i].com[0], L[i].com[1], p);
      this.velocityOf(i, L[i].com[0], L[i].com[1], v);
      E += 0.5 * L[i].mass * (v[0] * v[0] + v[1] * v[1]) + 0.5 * L[i].inertia * this.qd[i] * this.qd[i] - L[i].mass * (gx * p[0] + gy * p[1]);
    }
    return E;
  }

  private readonly e2 = new Float64Array(2);
  private readonly e3 = new Float64Array(2);
}

const ZERO2: readonly [number, number] = [0, 0];
