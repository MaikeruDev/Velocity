import { VIEW_AXES } from './rot';

/**
 * Schnur für Jo-Jo und Kendama (Plan 007, K9) als Verlet-Kette. DOM-/three-frei, keine
 * Allokation pro Frame. Prototyp und Messungen: tools/critique/v2/kosmetik/rope(-bench).ts.
 *
 * - Anfang (Finger/Ken) ist immer KINEMATISCH. Das Ende (Jo-Jo/Kugel) ist geführt, solange eine
 *   Trick-Zeitleiste es führt (Wurf, Fang, Around-the-World) — das Trick-Ergebnis hängt so nie an
 *   der Framerate. Nur in Hänge-Phasen (Sleeper, Kendama in Ruhe) ist es FREI (`freeEnd`): ein
 *   schweres Pendel (Gewicht `endWeight`), das auf die Hand reagiert. Die nächste Zeitleiste startet
 *   an der aktuellen Pendelposition (`endX/endY/endZ`).
 * - Fester Unterschritt 1/240 s mit Akkumulator, 4 Iterationen (vor/zurück im Wechsel); geführte
 *   Enden werden im Frame linear interpoliert, die Ausgabe zwischen den letzten zwei Unterschritten.
 *   Geführte Enden liegen in der Ausgabe EXAKT auf den Frame-Werten (kein Nachhängen am Finger).
 * - Die Kette rechnet im mitbewegten Handraum: Scheinkraft `accel` = Beschleunigung des Handgelenks
 *   (vom Aufrufer, siehe driveRope — × ROPE_CARTOON, gedeckelt auf ROPE_CAP_G), Schwerkraft = Bild-
 *   unten um die Hand-Neigung gedreht. Ohne Deckel wird die Schnur beim Sprung-Kick schlaff und das
 *   Pendel überschlägt sich (+6.4 u über dem Finger, Framerate-Abweichung 103 px).
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

/** Schwerkraft im Handraum (Einheiten/s², 1 Einheit ≈ 1 cm). */
export const ROPE_G = 980;
/** Scheinkraft-Faktor (Cartoon: das Pendel reagiert deutlicher als echt) und Deckel in g. */
export const ROPE_CARTOON = 1.5;
export const ROPE_CAP_G = 0.6;
/** Hand-Einheiten je Bildhöhe am Spiel-Anker (Tiefe 40, vFOV 54°): 2·tan(27°)·40. */
export const UNITS_PER_IMAGE_HEIGHT = 2 * Math.tan((27 * Math.PI) / 180) * 40;
/** Größte Unterschritte pro Frame (Hänger im Browser): Rest verwerfen. */
const MAX_SUBSTEPS = 40;

/** Plätze in Rope.sc: Zeit-Rest, Unterschritt-Länge, -Anteil am Teil-Frame, am ganzen Frame (Drive), Ausgabe-Interpolation, Teil-Frame von/bis. */
const R_ACC = 0;
const R_H = 1;
const R_FRAC = 2;
const R_DRIVE = 3;
const R_ALPHA = 4;
const R_F0 = 5;
const R_F1 = 6;

export class Rope {
  readonly n: number;
  segLen: number;
  length: number;
  /** Ausgabe für den Renderer: n × xyz im Handgelenk-Raum. */
  readonly out: Float32Array;
  /** Schwerkraft (Einheiten/s²) und Scheinkraft (Handbeschleunigung), vom Aufrufer gesetzt. */
  readonly gravity = new Float64Array([0, -ROPE_G, 0]);
  readonly accel = new Float64Array(3);
  /** Ende frei (Pendel) statt von der Zeitleiste geführt. */
  freeEnd = false;
  /** Größte relative ÜBERlänge eines Segments im letzten Frame (lockere Schnur zählt nicht). */
  stretch = 0;
  /** Kräfte je Unterschritt aus der Hand-Bewegung (RopeDrive); null = accel/gravity wie gesetzt. */
  drive: RopeDrive | null = null;

  private readonly p: Float64Array;
  private readonly q: Float64Array;
  private readonly prevP: Float64Array;
  private readonly a0 = new Float64Array(3);
  private readonly a1 = new Float64Array(3);
  /**
   * Ziele am Ende dieses (Teil-)Frames: Anfang s1, Ende e1, Anteil des Frames f0..f1 (RopeDrive). Als
   * Felder statt Argumente: jede Kommazahl als Argument eines nicht geinlineten Aufrufs wird in V8 zur
   * HeapNumber (alloc-probe Jo-Jo: Rope.update 11.8 KiB/s, fk 16.4 KiB/s).
   */
  private readonly s1 = new Float64Array(3);
  private readonly e1 = new Float64Array(3);
  /**
   * Kommazahl-Zustand des Frame-Pfads als Float64Array statt Objekt-Felder (Index R_*): in der ersten
   * Spielminute läuft der Pfad in Chrome in der Zwischenstufe (Maglev), die jedes Double-Feld-Schreiben und
   * jede Schleifen-Variable mit Kommazahl boxte (Rope.advance 145 B/Frame); Typed-Array-Plätze nie.
   */
  readonly sc = new Float64Array(7);
  private readonly iterations: number;
  private readonly h: number;
  private readonly keep240: number;
  private readonly endW: number;
  /** Gewichte [fest 0, Mitte 0.5, freies Ende endW]. */
  private readonly wts: Float64Array;

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
    // Immer ein fester Unterschritt (> 0): der alte "ein Schritt je Frame"-Pfad wurde nicht mehr benutzt.
    this.h = o.substep !== undefined && o.substep > 0 ? o.substep : 1 / 240;
    this.keep240 = o.damping ?? 0.985;
    this.endW = o.endWeight ?? 0.15;
    this.wts = new Float64Array([0, 0.5, this.endW]);
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
    this.sc[R_ACC] = 0;
    this.started = true;
    const S = this.s1;
    const E = this.e1;
    S[0] = sx;
    S[1] = sy;
    S[2] = sz;
    E[0] = ex;
    E[1] = ey;
    E[2] = ez;
    this.sc[R_ALPHA] = 1;
    this.writeOut();
  }

  /**
   * Ein Frame: Anfang (und bei geführtem Ende auch das Ende) stehen am Frame-Ende bei s/e.
   * f0/f1: welcher Anteil des Frames das ist (für die Hand-Kräfte des RopeDrive) — nur bei geteilten
   * Frames (updatePart) anders als 0/1.
   */
  update(dtRaw: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, f0 = 0, f1 = 1): void {
    const s = this.s1;
    const e = this.e1;
    s[0] = sx;
    s[1] = sy;
    s[2] = sz;
    e[0] = ex;
    e[1] = ey;
    e[2] = ez;
    this.sc[R_F0] = f0;
    this.sc[R_F1] = f1;
    this.advance(dtRaw);
  }

  /** Wie update, Anfang/Ende aus Puffern (Frame-Pfad der Gegenstände: keine Kommazahl-Argumente). */
  updateV(dt: number, s: ArrayLike<number>, e: ArrayLike<number>): void {
    this.setTargets(s, e, 0, 1);
    this.advance(dt);
  }

  private setTargets(s: ArrayLike<number>, e: ArrayLike<number>, f0: number, f1: number): void {
    const S = this.s1;
    const E = this.e1;
    S[0] = s[0];
    S[1] = s[1];
    S[2] = s[2];
    E[0] = e[0];
    E[1] = e[1];
    E[2] = e[2];
    this.sc[R_F0] = f0;
    this.sc[R_F1] = f1;
  }

  /** Frame-Schritt mit den gesetzten Zielen (s1, e1, f0/f1). */
  private advance(dtRaw: number): void {
    const S = this.s1;
    const E = this.e1;
    const sx = S[0];
    const sy = S[1];
    const sz = S[2];
    const ex = E[0];
    const ey = E[1];
    const ez = E[2];
    if (!(Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz) && Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(ez))) return;
    if (!this.started) {
      this.reset(sx, sy, sz, ex, ey, ez);
      return;
    }
    // Ohne Verzweigungen um Kommazahlen (`c ? zahl : 0`): im ersten Spielminute läuft der Frame-Pfad in
    // Chrome noch nicht in TurboFan — die Zwischenstufe boxte jeden solchen Zusammenfluss (Rope 155 B/Frame).
    const dt = Math.min(Math.max(Number.isFinite(dtRaw) ? dtRaw : 0, 0), 0.1);
    if (dt <= 0) {
      this.sc[R_ALPHA] = 1;
      this.writeOut();
      return;
    }
    // Nicht-endliche Kräfte (NaN aus einer kaputten Eingabe) würden die Kette vergiften.
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(this.accel[k])) this.accel[k] = 0;
      if (!Number.isFinite(this.gravity[k])) this.gravity[k] = k === 1 ? -ROPE_G : 0;
    }
    const h = this.h;
    const sc = this.sc;
    sc[R_H] = h;
    // Zahl der Unterschritte vorab (ganzzahlig), Rest-Zeit je Schritt aus dem Index — keine Schleifen-
    // Variable mit Kommazahl.
    const total = sc[R_ACC] + dt;
    const steps = Math.min(MAX_SUBSTEPS, Math.floor((total + 1e-12) / h));
    for (let i = 1; i <= steps; i++) {
      sc[R_FRAC] = Math.min(1, Math.max(0, (dt - (total - i * h)) / dt));
      this.keepPrev();
      this.stepOnce();
    }
    // Hänger (mehr als MAX_SUBSTEPS fällig): Rest verwerfen.
    sc[R_ACC] = (total - steps * h) * (steps < MAX_SUBSTEPS ? 1 : 0);
    sc[R_ALPHA] = 1 - sc[R_ACC] / h;
    this.a0[0] = sx;
    this.a0[1] = sy;
    this.a0[2] = sz;
    this.a1[0] = ex;
    this.a1[1] = ey;
    this.a1[2] = ez;
    this.writeOut();
  }



  /**
   * Erster Teil eines Frames bis zu einem Moduswechsel mitten im Frame (geführt ↔ frei, z. B. Wurf-Ende):
   * Anteil k des Frames, Anfang linear zwischen dem letzten und diesem Anker (wie die Unterschritte), Ende
   * (falls geführt) bei e. Danach schaltet der Aufrufer freeEnd um und rechnet den Rest mit
   * update(dt·(1 − k), …, k, 1). So fällt der Wechsel bei jeder Framerate auf dieselbe Zeit (vorher auf das
   * Frame-Ende: bei 30 Hz fiel die Kendama-Kugel bis 30 ms zu früh aus dem Becher, 2.5 Einheiten).
   */
  updatePart(dt: number, k: number, s: ArrayLike<number>, e: ArrayLike<number>): void {
    const a = this.a0;
    const S = this.s1;
    this.setTargets(s, e, 0, k);
    for (let i = 0; i < 3; i++) S[i] = a[i] + (s[i] - a[i]) * k;
    this.advance(dt * k);
  }

  /** Rest eines geteilten Frames (nach updatePart und Moduswechsel): Anteil k..1, Dauer dt·(1 − k). */
  updateRest(dt: number, k: number, s: ArrayLike<number>, e: ArrayLike<number>): void {
    this.setTargets(s, e, k, 1);
    this.advance(dt * (1 - k));
  }

  /** prevP ← p als Schleife: TypedArray.set allokierte im Unterschritt-Takt (Chrome-Zwischenstufe, ~4 je Frame). */
  private keepPrev(): void {
    const p = this.p;
    const q = this.prevP;
    for (let i = 0; i < p.length; i++) q[i] = p[i];
  }

  private stepOnce(): void {
    const sc = this.sc;
    const h = sc[R_H];
    const p = this.p;
    const q = this.q;
    const n = this.n;
    const free = this.freeEnd;
    const f = sc[R_FRAC];
    const S = this.s1;
    const E = this.e1;
    const sx = S[0];
    const sy = S[1];
    const sz = S[2];
    const ex = E[0];
    const ey = E[1];
    const ez = E[2];
    if (this.drive) {
      sc[R_DRIVE] = sc[R_F0] + (sc[R_F1] - sc[R_F0]) * f;
      this.drive.substep(this);
    }
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
        // Schnur, kein Stab: nur Dehnung wird korrigiert — locker hängt sie durch statt sich zu stemmen.
        if (d <= L) continue;
        const diff = (d - L) / d;
        const isEnd = i + 1 === n - 1;
        // Gewichte: Anfang fest; Ende fest (geführt) oder schwer (frei). Als neue Konstanten statt
        // `w0 /= sum`: eine Kommazahl zurück in eine gemischt belegte Variable boxte in Chrome (Rope 10 KiB/s).
        // Gewichte als Tabellenwerte (Anfang 0, Ende ew/0, sonst 0.5) — kein Zusammenfluss aus Konstanten.
        const WT = this.wts;
        const w0 = WT[i === 0 ? 0 : 1];
        const w1 = WT[isEnd ? (free ? 2 : 0) : 1];
        const sum = w0 + w1;
        if (sum <= 0) continue;
        const c0 = (diff * w0) / sum;
        const c1 = (diff * w1) / sum;
        p[k0] += dx * c0;
        p[k0 + 1] += dy * c0;
        p[k0 + 2] += dz * c0;
        p[k1] -= dx * c1;
        p[k1 + 1] -= dy * c1;
        p[k1 + 2] -= dz * c1;
      }
    }
  }

  /** Größte Überlänge als Puffer statt Schleifen-Variable (kein gemischter Zusammenfluss, s. advance). */
  private readonly worst = new Float64Array(1);

  private writeOut(): void {
    const alpha = this.sc[R_ALPHA];
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
    const S = this.s1;
    o[0] = S[0];
    o[1] = S[1];
    o[2] = S[2];
    if (!this.freeEnd) {
      const E = this.e1;
      const e = (n - 1) * 3;
      o[e] = E[0];
      o[e + 1] = E[1];
      o[e + 2] = E[2];
    }
    const W = this.worst;
    W[0] = 0;
    const L = this.segLen;
    for (let i = 0; i < n - 1; i++) {
      const k = i * 3;
      const dx = p[k + 3] - p[k];
      const dy = p[k + 4] - p[k + 1];
      const dz = p[k + 5] - p[k + 2];
      // sqrt statt Math.hypot: der Builtin allokiert je Aufruf (Frame-Pfad).
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      W[0] = Math.max(W[0], (d - L) / L);
    }
    this.stretch = W[0];
  }
}

/**
 * Hand-Bewegung → Schnur-Kräfte im Handgelenk-Raum: Schwerkraft = Bild-unten, um die Hand-Neigung
 * gedreht (tilt in Grad, + = gegen den Uhrzeigersinn); Scheinkraft = ROPE_CARTOON × Anker-
 * Beschleunigung (Bildachsen, Einheiten/s², x rechts, y oben), gedeckelt auf ROPE_CAP_G · g.
 * motionFx 0 → keine Scheinkraft (die Schnur hängt still).
 */
export function driveRope(rope: Rope, ax: number, ay: number, tiltDeg: number, motionFx = 1): void {
  const A = VIEW_AXES;
  const r = Number.isFinite(tiltDeg) ? (tiltDeg * Math.PI) / 180 : 0;
  const gs = Math.sin(r);
  const gc = Math.cos(r);
  for (let k = 0; k < 3; k++) rope.gravity[k] = ROPE_G * (-A.up[k] * gc - A.right[k] * gs);
  const m = motionFx > 0 ? (motionFx < 1 ? motionFx : 1) : 0;
  let x = Number.isFinite(ax) ? ROPE_CARTOON * ax * m : 0;
  let y = Number.isFinite(ay) ? ROPE_CARTOON * ay * m : 0;
  const l = Math.sqrt(x * x + y * y);
  const cap = ROPE_CAP_G * ROPE_G;
  if (l > cap) {
    x *= cap / l;
    y *= cap / l;
  }
  for (let k = 0; k < 3; k++) rope.accel[k] = A.right[k] * x + A.up[k] * y;
}

/** Plätze in RopeDrive.d. */
const D_X0 = 0;
const D_Y0 = 1;
const D_X1 = 2;
const D_Y1 = 3;
const D_T0 = 4;
const D_T1 = 5;
const D_FX = 6;
const D_FY = 7;
const D_VX = 8;
const D_VY = 9;
const D_M = 10;

/** Eigenfrequenz des Glättungs-Folgers der Hand-Bewegung (rad/s, kritisch gedämpft). */
const FOLLOW_OMEGA = 2 * Math.PI * 8;

/**
 * Hand-Bewegung → Schnur-Kräfte, framerate-unabhängig (Plan 007 K9): Der Anker (Bildposition der
 * Hand je Frame) wird innerhalb des Frames linear interpoliert und in JEDEM Unterschritt (1/240 s)
 * von einem kritisch gedämpften Folger (8 Hz) nachgeführt; dessen Beschleunigung ist die
 * Scheinkraft (× ROPE_CARTOON, gedeckelt auf ROPE_CAP_G · g). Warum nicht die zweite Differenz je
 * Frame: ein Sprung-/Lande-Kick ist ein Geschwindigkeits-Sprung der Hand; je Frame gemessen wird er
 * zu einer Spitze von Δv/dt über EINEN Frame, und der Deckel schneidet bei 30 Hz 33 ms ab, bei
 * 2400 Hz nur 0.4 ms — das Pendel lief je Framerate anders (30 Hz 3.3 px). Der Folger macht aus dem
 * Kick einen glatten Puls, den der Deckel überall gleich trifft.
 * Schwerkraft = Bild-unten, um die (ebenfalls interpolierte) Hand-Neigung gedreht.
 */
export class RopeDrive {
  /**
   * Zustand als Float64Array (Plätze D_*): Anker/Neigung am Anfang und Ende des Frames, Folger (Lage,
   * Geschwindigkeit), motionFx. In der Chrome-Zwischenstufe boxten Double-Felder und `c ? zahl : 0`
   * im Unterschritt-Takt (~70 B/Frame); Typed-Array-Plätze und verzweigungsfreie Rechnung nicht.
   */
  private readonly d = new Float64Array(11);
  private primed = false;

  /** Neu beginnen (Respawn, Gegenstand gewechselt): der Folger steht an der nächsten Position. */
  reset(): void {
    this.primed = false;
  }

  /** Wie setFrame, Werte aus der Frame-Eingabe (Frame-Pfad der Gegenstände: keine Kommazahl-Argumente). */
  setFrameFrom(inp: { readonly handX?: number; readonly handY?: number; readonly handTilt?: number }, motionFx: number): void {
    const x = inp.handX ?? 0;
    const y = inp.handY ?? 0;
    const t = inp.handTilt ?? 0;
    this.setFrame(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(t) ? t : 0, motionFx);
  }

  /** Einmal pro Frame VOR rope.update: Anker in Bildhöhen (x rechts, y unten), Neigung in Grad (+ = gegen den UZS). */
  setFrame(x: number, y: number, tiltDeg: number, motionFx: number): void {
    const d = this.d;
    // Nicht endlich → letzter Wert: danach ist im Unterschritt-Takt alles endlich (keine Prüfung dort).
    const X = Number.isFinite(x) ? x * UNITS_PER_IMAGE_HEIGHT : d[D_X1];
    const Y = Number.isFinite(y) ? -y * UNITS_PER_IMAGE_HEIGHT : d[D_Y1];
    const T = Number.isFinite(tiltDeg) ? tiltDeg : d[D_T1];
    d[D_M] = motionFx > 0 ? (motionFx < 1 ? motionFx : 1) : 0;
    if (!this.primed) {
      d[D_X0] = X;
      d[D_X1] = X;
      d[D_FX] = X;
      d[D_Y0] = Y;
      d[D_Y1] = Y;
      d[D_FY] = Y;
      d[D_T0] = T;
      d[D_T1] = T;
      d[D_VX] = 0;
      d[D_VY] = 0;
      this.primed = true;
      return;
    }
    d[D_X0] = d[D_X1];
    d[D_Y0] = d[D_Y1];
    d[D_T0] = d[D_T1];
    d[D_X1] = X;
    d[D_Y1] = Y;
    d[D_T1] = T;
  }

  /** Ein Unterschritt (Länge rope.sc[R_H], Anteil rope.sc[R_DRIVE] des aktuellen Frames): Kräfte in `rope` setzen. */
  substep(rope: Rope): void {
    const d = this.d;
    const h = rope.sc[R_H];
    const f = rope.sc[R_DRIVE];
    const w = FOLLOW_OMEGA;
    const tx = d[D_X0] + (d[D_X1] - d[D_X0]) * f;
    const ty = d[D_Y0] + (d[D_Y1] - d[D_Y0]) * f;
    const ax = w * w * (tx - d[D_FX]) - 2 * w * d[D_VX];
    const ay = w * w * (ty - d[D_FY]) - 2 * w * d[D_VY];
    d[D_VX] += ax * h;
    d[D_VY] += ay * h;
    d[D_FX] += d[D_VX] * h;
    d[D_FY] += d[D_VY] * h;
    // Wie driveRope (gleiche Formel), ohne Verzweigungen: Deckel als Faktor min(1, cap/l).
    const A = VIEW_AXES;
    const r = ((d[D_T0] + (d[D_T1] - d[D_T0]) * f) * Math.PI) / 180;
    const gs = Math.sin(r);
    const gc = Math.cos(r);
    for (let k = 0; k < 3; k++) rope.gravity[k] = ROPE_G * (-A.up[k] * gc - A.right[k] * gs);
    const m = d[D_M];
    const x = ROPE_CARTOON * ax * m;
    const y = ROPE_CARTOON * ay * m;
    const s = Math.min(1, (ROPE_CAP_G * ROPE_G) / Math.max(1e-9, Math.sqrt(x * x + y * y)));
    for (let k = 0; k < 3; k++) rope.accel[k] = (A.right[k] * x + A.up[k] * y) * s;
  }
}
