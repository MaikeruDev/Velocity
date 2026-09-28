/**
 * PROTOTYP (Kosmetik v2, nicht im Spiel): Schnur für Jo-Jo und Kendama als Verlet-Kette.
 * DOM-/three-frei, keine Allokation pro Frame.
 *
 * Entscheidungen, die der Bench (rope-bench.ts) belegt:
 * - Anfang (Finger/Ken) ist immer KINEMATISCH. Das Ende (Jo-Jo/Kugel) ist kinematisch, solange
 *   eine Trick-Zeitleiste es führt (Wurf, Fang, Around-the-World) — das Trick-Ergebnis hängt so
 *   nie an der Framerate. Nur in "Hänge"-Phasen (Sleeper, Kendama in Ruhe) ist es FREI
 *   (`freeEnd`), ein schweres Pendel, das auf die Hand reagiert. Die nächste Zeitleiste startet
 *   dann an der aktuellen Pendelposition (`endX/endY/endZ`).
 * - Fester Unterschritt (Default 1/240 s) mit Akkumulator; kinematische Enden werden innerhalb des
 *   Frames linear interpoliert, die Ausgabe zwischen den letzten zwei Unterschritten. Kinematische
 *   Enden liegen in der Ausgabe EXAKT auf den Frame-Werten (kein Nachhängen am Finger).
 * - Scheinkraft `accel` (Beschleunigung des Handgelenks, Einheiten/s², vom Aufrufer aus der
 *   Anker-Bewegung): die Kette rechnet im mitbewegten Handraum und schwingt trotzdem nach.
 */

export interface RopeOptions {
  /** Anzahl Segmente (Punkte = segments + 1). */
  readonly segments: number;
  /** Gesamtlänge (Hand-Einheiten). */
  readonly length: number;
  readonly iterations?: number;
  /** Unterschritt (s); 0 = ein Schritt pro Frame mit dt (naiv, nur zum Vergleich). */
  readonly substep?: number;
  /** Geschwindigkeits-Erhalt pro 1/240 s (wird auf den Unterschritt umgerechnet). */
  readonly damping?: number;
  /** Gewicht des freien Endes beim Längenausgleich (0 = unbeweglich, 0.5 = wie ein Kettenglied). */
  readonly endWeight?: number;
}

export class Rope {
  readonly n: number;
  segLen: number;
  length: number;
  /** Ausgabe für den Renderer: n × xyz im Handgelenk-Raum. */
  readonly out: Float32Array;
  /** Schwerkraft (Einheiten/s²) und Scheinkraft (Handbeschleunigung), vom Aufrufer gesetzt. */
  readonly gravity = new Float64Array([0, -980, 0]);
  readonly accel = new Float64Array(3);
  /** Ende frei (Pendel) statt von der Zeitleiste geführt. */
  freeEnd = false;
  /** Größte relative ÜBERlänge eines Segments im letzten Frame (lockere Schnur zählt nicht). */
  stretch = 0;

  private readonly p: Float64Array;
  private readonly q: Float64Array;
  private readonly prevP: Float64Array;
  private readonly a0 = new Float64Array(3);
  private readonly a1 = new Float64Array(3);
  private readonly iterations: number;
  private readonly h: number;
  private readonly keep240: number;
  private readonly endW: number;
  private acc = 0;
  private started = false;

  constructor(o: RopeOptions) {
    this.n = o.segments + 1;
    this.length = o.length;
    this.segLen = o.length / o.segments;
    this.p = new Float64Array(this.n * 3);
    this.q = new Float64Array(this.n * 3);
    this.prevP = new Float64Array(this.n * 3);
    this.out = new Float32Array(this.n * 3);
    this.iterations = o.iterations ?? 4;
    this.h = o.substep ?? 1 / 240;
    this.keep240 = o.damping ?? 0.985;
    this.endW = o.endWeight ?? 0.15;
  }

  /** Länge ändern (Jo-Jo wickelt ab/auf) — in place, keine Allokation. */
  setLength(L: number): void {
    if (!Number.isFinite(L) || L <= 0) return;
    this.length = L;
    this.segLen = L / (this.n - 1);
  }

  get endX(): number {
    return this.out[(this.n - 1) * 3];
  }
  get endY(): number {
    return this.out[(this.n - 1) * 3 + 1];
  }
  get endZ(): number {
    return this.out[(this.n - 1) * 3 + 2];
  }

  /**
   * Neu auslegen (Respawn, Gegenstand gewechselt): locker durchhängend in Schwerkraftrichtung
   * (V-Tiefe aus Länge und Abstand), damit eine lockere Schnur nicht kollinear "klemmt".
   */
  reset(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    const n = this.n;
    const D = Math.hypot(ex - sx, ey - sy, ez - sz);
    const sag = 0.5 * Math.sqrt(Math.max(0, this.length * this.length - D * D));
    const g = Math.hypot(this.gravity[0], this.gravity[1], this.gravity[2]) || 1;
    const gx = this.gravity[0] / g;
    const gy = this.gravity[1] / g;
    const gz = this.gravity[2] / g;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const k = i * 3;
      const s = sag * 4 * u * (1 - u);
      this.p[k] = sx + (ex - sx) * u + gx * s;
      this.p[k + 1] = sy + (ey - sy) * u + gy * s;
      this.p[k + 2] = sz + (ez - sz) * u + gz * s;
    }
    this.q.set(this.p);
    this.prevP.set(this.p);
    this.a0[0] = sx;
    this.a0[1] = sy;
    this.a0[2] = sz;
    this.a1[0] = ex;
    this.a1[1] = ey;
    this.a1[2] = ez;
    this.acc = 0;
    this.started = true;
    this.writeOut(1, sx, sy, sz, ex, ey, ez);
  }

  /** Ein Frame: Anfang (und bei geführtem Ende auch das Ende) stehen am Frame-Ende bei s/e. */
  update(dtRaw: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    if (!(Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz) && Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(ez))) return;
    if (!this.started) {
      this.reset(sx, sy, sz, ex, ey, ez);
      return;
    }
    const dt = Number.isFinite(dtRaw) ? Math.min(Math.max(dtRaw, 0), 0.1) : 0;
    if (dt <= 0) {
      this.writeOut(1, sx, sy, sz, ex, ey, ez);
      return;
    }
    const h = this.h > 0 ? this.h : dt;
    this.acc += dt;
    // Nie mehr als 40 Unterschritte pro Frame (Hänger im Browser): Rest verwerfen.
    let guard = 40;
    while (this.acc >= h - 1e-12 && guard-- > 0) {
      this.acc -= h;
      const f = this.h > 0 ? Math.min(1, Math.max(0, (dt - this.acc) / dt)) : 1;
      this.prevP.set(this.p);
      this.stepOnce(h, f, sx, sy, sz, ex, ey, ez);
    }
    if (guard <= 0) this.acc = 0;
    const alpha = this.h > 0 ? 1 - this.acc / h : 1;
    this.a0[0] = sx;
    this.a0[1] = sy;
    this.a0[2] = sz;
    this.a1[0] = ex;
    this.a1[1] = ey;
    this.a1[2] = ez;
    this.writeOut(alpha, sx, sy, sz, ex, ey, ez);
  }

  private stepOnce(h: number, f: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    const p = this.p;
    const q = this.q;
    const n = this.n;
    const free = this.freeEnd;
    const keep = Math.pow(this.keep240, h * 240);
    const gx = (this.gravity[0] - this.accel[0]) * h * h;
    const gy = (this.gravity[1] - this.accel[1]) * h * h;
    const gz = (this.gravity[2] - this.accel[2]) * h * h;
    const last = free ? n : n - 1;
    for (let i = 1; i < last; i++) {
      const k = i * 3;
      const vx = (p[k] - q[k]) * keep;
      const vy = (p[k + 1] - q[k + 1]) * keep;
      const vz = (p[k + 2] - q[k + 2]) * keep;
      q[k] = p[k];
      q[k + 1] = p[k + 1];
      q[k + 2] = p[k + 2];
      p[k] += vx + gx;
      p[k + 1] += vy + gy;
      p[k + 2] += vz + gz;
    }
    const a0 = this.a0;
    q[0] = p[0];
    q[1] = p[1];
    q[2] = p[2];
    p[0] = a0[0] + (sx - a0[0]) * f;
    p[1] = a0[1] + (sy - a0[1]) * f;
    p[2] = a0[2] + (sz - a0[2]) * f;
    const e = (n - 1) * 3;
    if (!free) {
      const a1 = this.a1;
      q[e] = p[e];
      q[e + 1] = p[e + 1];
      q[e + 2] = p[e + 2];
      p[e] = a1[0] + (ex - a1[0]) * f;
      p[e + 1] = a1[1] + (ey - a1[1]) * f;
      p[e + 2] = a1[2] + (ez - a1[2]) * f;
    }
    const L = this.segLen;
    const ew = this.endW;
    for (let it = 0; it < this.iterations; it++) {
      // Abwechselnd vorwärts/rückwärts: gleichmäßigere Verteilung bei gespannter Schnur.
      const fwd = (it & 1) === 0;
      for (let s = 0; s < n - 1; s++) {
        const i = fwd ? s : n - 2 - s;
        const k0 = i * 3;
        const k1 = k0 + 3;
        const dx = p[k1] - p[k0];
        const dy = p[k1 + 1] - p[k0 + 1];
        const dz = p[k1 + 2] - p[k0 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) continue;
        const diff = (d - L) / d;
        const isEnd = i + 1 === n - 1;
        // Gewichte: Anfang fest; Ende fest (geführt) oder schwer (frei).
        let w0 = i === 0 ? 0 : 0.5;
        let w1 = isEnd ? (free ? ew : 0) : 0.5;
        const sum = w0 + w1;
        if (sum <= 0) continue;
        w0 /= sum;
        w1 /= sum;
        p[k0] += dx * diff * w0;
        p[k0 + 1] += dy * diff * w0;
        p[k0 + 2] += dz * diff * w0;
        p[k1] -= dx * diff * w1;
        p[k1 + 1] -= dy * diff * w1;
        p[k1 + 2] -= dz * diff * w1;
      }
    }
  }

  private writeOut(alpha: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    const n = this.n;
    const o = this.out;
    const p = this.p;
    const pp = this.prevP;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      o[k] = pp[k] + (p[k] - pp[k]) * alpha;
      o[k + 1] = pp[k + 1] + (p[k + 1] - pp[k + 1]) * alpha;
      o[k + 2] = pp[k + 2] + (p[k + 2] - pp[k + 2]) * alpha;
    }
    o[0] = sx;
    o[1] = sy;
    o[2] = sz;
    if (!this.freeEnd) {
      const e = (n - 1) * 3;
      o[e] = ex;
      o[e + 1] = ey;
      o[e + 2] = ez;
    }
    let worst = 0;
    for (let i = 0; i < n - 1; i++) {
      const k = i * 3;
      const d = Math.hypot(p[k + 3] - p[k], p[k + 4] - p[k + 1], p[k + 5] - p[k + 2]);
      const r = (d - this.segLen) / this.segLen;
      if (r > worst) worst = r;
    }
    this.stretch = worst;
  }
}
