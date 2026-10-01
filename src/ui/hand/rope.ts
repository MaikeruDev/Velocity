import { VM_RIG } from '../../render/types';
import { HandShape } from './handShape';
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

/**
 * Schnur und Kugel/Jo-Jo nicht durch die Hand (Plan 008): die GEZEIGTEN Punkte werden aus dem Hand-Modell
 * (HandShape: Glied-Kapseln + Handfläche) entlang des Abstands-Gradienten herausgeschoben — eine stetige Abbildung
 * der gerechneten Schnur, keine Rückwirkung auf die Physik. Warum nicht als Kontakt in der Verlet-Kette: eine an
 * der Hand entlangrollende Kugel ist chaotisch (Fingerlücken, Haften/Gleiten) — 30/144 Hz liefen gegen 1440 Hz um
 * bis zu 2 Einheiten auseinander. Als Abbildung bleiben kleine Unterschiede klein (Framerate-Tests), und die Kugel
 * liegt sichtbar an Daumen/Fingern an statt in ihnen zu stecken.
 * Freies Ende mit eigenem Radius und weichem Minimum über die Finger (keine Kante zwischen zwei Fingern → stetig).
 * Die Hand setzt der Aufrufer je Frame (`hand.update(gelenke)`). Keine Allokation, Punkte über Puffer (#107/#199).
 */
/** Sehnen-Auflegen (RopeHandGuard.projectChords): Durchgänge und Teilung je Sehne. */
const CHORD_ITERS = 4;
const CHORD_SAMPLES = 8;

export class RopeHandGuard {
  readonly hand = new HandShape();
  /**
   * [0] Schnur-Radius, [1] Radius des Endes, [2] an/aus (0 = aus), [3] Glättung der Fingerkapseln für das Ende
   * (Einheiten, 0 = harte Form), [4] Übergangsbreite (Einheiten): bis so weit innerhalb wird nur teilweise geschoben
   * — sanft statt mit Knick an der Oberfläche.
   */
  readonly cfg = new Float64Array([0.2, 0.5, 1, 1.0, 0.6]);
  /** Größte Verschiebung des letzten Aufrufs (Tests/Tools, ≥ 0). */
  readonly worst = new Float64Array(1);
  private readonly fp = new Float64Array(3);
  private readonly pt = new Float64Array(3);
  /** field(): [0] Abstand, [1] Glättung des aktuellen Punkts. */
  private readonly fd = new Float64Array(2);
  /** Zuletzt gesetzte Gelenke (setJoints rechnet nur bei Änderung). */
  private readonly lastJ = new Float32Array(32).fill(Number.NaN);

  /**
   * Hand-Modell aus Gelenkwinkeln (wie HandShape.update, gleiche Kapseln) — ohne Kommazahl-Argumente: Glied-Ende als
   * Punkt bei y = 2 (ganzzahlig) entlang der Glied-Achse hochgerechnet (die Achse ist gerade, exakt). HandShape.update
   * übergibt die Gliedlänge als Argument und boxte im Frame-Pfad (Node: ~20 Scavenges je 100 000 Frames). Nur bei
   * geänderten Gelenken.
   */
  setJoints(j: ArrayLike<number>): void {
    const L = this.lastJ;
    let same = true;
    for (let i = 0; i < 23; i++) {
      if (L[i] !== j[i]) {
        same = false;
        L[i] = j[i];
      }
    }
    if (same) return;
    const hs = this.hand;
    const A = hs.a;
    const B = hs.b;
    const p = this.fp;
    for (let f = 0; f < 4; f++) {
      const len = VM_RIG.fingers[f].len;
      for (let sg = 0; sg < 3; sg++) {
        const i = (1 + f * 3 + sg) * 3;
        this.fkFinger(j, f, sg, 0);
        A[i] = p[0];
        A[i + 1] = p[1];
        A[i + 2] = p[2];
        this.fkFinger(j, f, sg, 2);
        const k = len[sg] / 2;
        B[i] = A[i] + (p[0] - A[i]) * k;
        B[i + 1] = A[i + 1] + (p[1] - A[i + 1]) * k;
        B[i + 2] = A[i + 2] + (p[2] - A[i + 2]) * k;
      }
    }
    const tl = VM_RIG.thumb.len;
    for (let sg = 0; sg < 3; sg++) {
      const i = (13 + sg) * 3;
      this.fkThumb(j, sg, 0);
      A[i] = p[0];
      A[i + 1] = p[1];
      A[i + 2] = p[2];
      this.fkThumb(j, sg, 2);
      const k = tl[sg] / 2;
      B[i] = A[i] + (p[0] - A[i]) * k;
      B[i + 1] = A[i + 1] + (p[1] - A[i + 1]) * k;
      B[i + 2] = A[i + 2] + (p[2] - A[i + 2]) * k;
    }
  }

  /**
   * Punkt (0, ly, 0) im Fingerglied → fp. Gleiche Rechnung wie fk.fingerPoint (tests vergleichen), aber eigene Kopie
   * mit ganzzahligem ly und festem Ausgabe-Puffer: fingerPoint wird mit vielerlei Puffern (Float32/64, Arrays)
   * gerufen und boxte hier je Aufruf (Node-Probe: Jo-Jo-Sleeper 24 Scavenges je 96 000 Frames).
   */
  private fkFinger(joints: ArrayLike<number>, finger: number, seg: number, ly: number): void {
    const f = VM_RIG.fingers[finger];
    const b = 7 + finger * 4;
    const g2 = seg >= 2 ? 1 : 0;
    const g1 = seg >= 1 ? 1 : 0;
    const a3 = -joints[b + 3] * g2;
    const l1 = f.len[1] * g2;
    const a2 = -joints[b + 2] * g1;
    const l0 = f.len[0] * g1;
    let c = Math.cos(a3);
    let s = Math.sin(a3);
    let y = ly * c + l1;
    let z = ly * s;
    c = Math.cos(a2);
    s = Math.sin(a2);
    let t = y * c - z * s + l0;
    z = y * s + z * c;
    y = t;
    c = Math.cos(-joints[b + 1]);
    s = Math.sin(-joints[b + 1]);
    t = y * c - z * s;
    z = y * s + z * c;
    y = t;
    c = Math.cos(joints[b] + f.splay);
    s = Math.sin(joints[b] + f.splay);
    const x = -y * s;
    y = y * c;
    const o = this.fp;
    o[0] = f.x + x;
    o[1] = f.y + y;
    o[2] = f.z + z;
  }

  /** Wie fkFinger für den Daumen (Rechnung wie fk.thumbPoint). */
  private fkThumb(joints: ArrayLike<number>, seg: number, ly: number): void {
    const th = VM_RIG.thumb;
    const g2 = seg >= 2 ? 1 : 0;
    const g1 = seg >= 1 ? 1 : 0;
    let c = Math.cos(-joints[6] * g2);
    let s = Math.sin(-joints[6] * g2);
    let x = 0;
    let y = ly * c + th.len[1] * g2;
    let z = ly * s;
    c = Math.cos(-joints[5] * g1);
    s = Math.sin(-joints[5] * g1);
    let u = y * c - z * s + th.len[0] * g1;
    z = y * s + z * c;
    y = u;
    c = Math.cos(th.baseY);
    s = Math.sin(th.baseY);
    u = x * c + z * s;
    z = -x * s + z * c;
    x = u;
    c = Math.cos(th.baseX - joints[4]);
    s = Math.sin(th.baseX - joints[4]);
    u = y * c - z * s;
    z = y * s + z * c;
    y = u;
    c = Math.cos(th.baseZ + joints[3]);
    s = Math.sin(th.baseZ + joints[3]);
    u = x * c - y * s;
    y = x * s + y * c;
    x = u;
    const o = this.fp;
    o[0] = th.x + x;
    o[1] = th.y + y;
    o[2] = th.z + z;
  }

  /**
   * Abstand von pt zur Hand → fd[0]. Mit Glättung fd[1] > 0: die Finger als weiches Minimum (Polynom-Smin, Lücken
   * zwischen Fingern verrundet; ein exponentielles Smin über 15 Glieder blähte die Hand um bis zu k·ln 15 auf), die
   * Handfläche hart (aus HandShape.measure).
   */
  private field(): void {
    const hs = this.hand;
    const pt = this.pt;
    hs.measure(pt);
    const dm = hs.res[0];
    const k = this.fd[1];
    if (!(k > 0)) {
      this.fd[0] = dm;
      return;
    }
    const A = hs.a;
    const B = hs.b;
    const R = hs.r;
    let m = 1e9;
    for (let i = 1; i < 16; i++) {
      const j = i * 3;
      const ax = A[j];
      const ay = A[j + 1];
      const az = A[j + 2];
      const dx = B[j] - ax;
      const dy = B[j + 1] - ay;
      const dz = B[j + 2] - az;
      const px = pt[0] - ax;
      const py = pt[1] - ay;
      const pz = pt[2] - az;
      const ll = dx * dx + dy * dy + dz * dz;
      let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx * t;
      const qy = py - dy * t;
      const qz = pz - dz * t;
      const di = Math.sqrt(qx * qx + qy * qy + qz * qz) - R[i];
      // Polynom-Smin (Quilez): verrundet nur, wo zwei Glieder näher als k beieinander liegen, höchstens k/4 dicker.
      const h = Math.max(k - Math.abs(m - di), 0) / k;
      m = (m < di ? m : di) - h * h * k * 0.25;
    }
    this.fd[0] = m < dm ? m : dm;
  }

  /**
   * Punkte 1..last von `pts` (n × xyz) aus der Hand schieben (Punkt 0 = Anker bleibt; Ende n−1 mit Radius cfg[1],
   * last = n − 2 lässt ein geführtes Ende in Ruhe). Zwei Durchgänge (gekrümmte Flächen).
   */
  project(pts: Float32Array | Float64Array, n: number, last: number): void {
    const W = this.worst;
    W[0] = 0;
    if (this.cfg[2] <= 0) return;
    const pt = this.pt;
    const fd = this.fd;
    for (let i = 1; i <= last; i++) {
      const k = i * 3;
      const isEnd = i === n - 1 ? 1 : 0;
      const r = this.cfg[isEnd];
      fd[1] = this.cfg[3] * isEnd;
      for (let pass = 0; pass < 2; pass++) {
        pt[0] = pts[k];
        pt[1] = pts[k + 1];
        pt[2] = pts[k + 2];
        this.field();
        const d = fd[0];
        const band = this.cfg[4];
        if (d >= r + band) break;
        // Gradient per zentraler Differenz.
        const h = 0.05;
        pt[0] = pts[k] + h;
        this.field();
        let gx = fd[0];
        pt[0] = pts[k] - h;
        this.field();
        gx -= fd[0];
        pt[0] = pts[k];
        pt[1] = pts[k + 1] + h;
        this.field();
        let gy = fd[0];
        pt[1] = pts[k + 1] - h;
        this.field();
        gy -= fd[0];
        pt[1] = pts[k + 1];
        pt[2] = pts[k + 2] + h;
        this.field();
        let gz = fd[0];
        pt[2] = pts[k + 2] - h;
        this.field();
        gz -= fd[0];
        const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (!(l > 1e-9)) break;
        // Weicher Übergang: Abstand d → max(d, r) mit gerundeter Ecke (Breite band), stetig differenzierbar.
        const x = (r + band - d) / (2 * band);
        const push = x >= 1 ? r - d : band * x * x;
        if (push <= 0) break;
        W[0] = Math.max(W[0], push);
        pts[k] += (gx / l) * push;
        pts[k + 1] += (gy / l) * push;
        pts[k + 2] += (gz / l) * push;
      }
    }
  }

  /**
   * Plan 008 (additiv, Animator Jo-Jo/Kendama): Sehnen auf die Hand legen. project() schiebt nur die 9 Punkte heraus —
   * zwei freie Punkte links und rechts eines Fingers ließen die Sehne dazwischen quer durch ihn laufen (die gerade
   * hängende Jo-Jo-Schnur durchstieß Ring- und kleinen Finger in jedem Frame, bis 1.4). Hier: CHORD_SAMPLES − 1 Stichproben
   * je Sehne ab `from` (1 = die Sehne an der Schlaufe auslassen, die liegt im Finger); steckt eine tiefer als der
   * Schnur-Radius cfg[0], wandern ihre beiden Endpunkte (nur Punkte 1..last) entlang des Abstands-Gradienten so, dass
   * die Stichprobe auf der Oberfläche liegt — die gezeigte Schnur drapiert sich über die Finger. Bis zu CHORD_ITERS Durchgänge.
   * Reine Abbildung der gerechneten Schnur (keine Rückwirkung), allokationsfrei.
   */
  projectChords(pts: Float32Array | Float64Array, n: number, last: number, from: number): void {
    if (this.cfg[2] <= 0) return;
    const pt = this.pt;
    const fd = this.fd;
    const r = this.cfg[0];
    const W = this.worst;
    fd[1] = 0;
    for (let it = 0; it < CHORD_ITERS; it++) {
      let moved = 0;
      for (let k = from; k < n - 1; k++) {
        const a = k * 3;
        const b = a + 3;
        const fa = k >= 1 && k <= last ? 1 : 0;
        const fb = k + 1 <= last ? 1 : 0;
        if (fa + fb === 0) continue;
        for (let q = 1; q < CHORD_SAMPLES; q++) {
          const u = q / CHORD_SAMPLES;
          const x = pts[a] + (pts[b] - pts[a]) * u;
          const y = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * u;
          const z = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * u;
          pt[0] = x;
          pt[1] = y;
          pt[2] = z;
          this.field();
          const d = fd[0];
          if (d >= r) continue;
          const h = 0.05;
          pt[0] = x + h;
          this.field();
          let gx = fd[0];
          pt[0] = x - h;
          this.field();
          gx -= fd[0];
          pt[0] = x;
          pt[1] = y + h;
          this.field();
          let gy = fd[0];
          pt[1] = y - h;
          this.field();
          gy -= fd[0];
          pt[1] = y;
          pt[2] = z + h;
          this.field();
          let gz = fd[0];
          pt[2] = z - h;
          this.field();
          gz -= fd[0];
          const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (!(l > 1e-9)) continue;
          const push = r - d;
          // Gewichte der Endpunkte an der Stichprobe; Verschiebung so, dass sie um `push` wandert (gedeckelt).
          const wa = (1 - u) * fa;
          const wb = u * fb;
          const s = Math.min(push / (wa * wa + wb * wb), 4 * push);
          const nx = gx / l;
          const ny = gy / l;
          const nz = gz / l;
          pts[a] += nx * s * wa;
          pts[a + 1] += ny * s * wa;
          pts[a + 2] += nz * s * wa;
          pts[b] += nx * s * wb;
          pts[b + 1] += ny * s * wb;
          pts[b + 2] += nz * s * wb;
          W[0] = Math.max(W[0], push);
          moved++;
        }
      }
      if (moved === 0) break;
    }
  }
}

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

/** Plätze in Rope.sc: Zeit-Rest, Unterschritt-Länge, -Anteil am Teil-Frame, am ganzen Frame (Drive), Ausgabe-Interpolation, Teil-Frame von/bis, Gesamtlänge. */
const R_ACC = 0;
const R_H = 1;
const R_FRAC = 2;
const R_DRIVE = 3;
const R_ALPHA = 4;
const R_F0 = 5;
const R_F1 = 6;
const R_LEN = 7;
/** Gespannt (setTaut): Faktor (0 = aus), kleinste und größte Länge. */
const R_TK = 8;
const R_TMIN = 9;
const R_TMAX = 10;
/** Segmentlänge. */
const R_SEG = 11;

export class Rope {
  readonly n: number;
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
  readonly sc = new Float64Array(12);
  private readonly iterations: number;
  private readonly h: number;
  private readonly keep240: number;
  /** Geschwindigkeits-Erhalt je Unterschritt (h fest) — einmal gerechnet, nicht je Unterschritt Math.pow. */
  private readonly keepH: number;
  private readonly endW: number;
  /** Gewichte [fest 0, Mitte 0.5, freies Ende endW]. */
  private readonly wts: Float64Array;

  private started = false;

  constructor(o: RopeOptions) {
    this.n = o.segments + 1;
    this.sc[R_LEN] = o.length;
    this.sc[R_SEG] = o.length / o.segments;
    this.p = new Float64Array(this.n * 3);
    this.q = new Float64Array(this.n * 3);
    this.prevP = new Float64Array(this.n * 3);
    this.out = new Float32Array(this.n * 3);
    this.iterations = o.iterations ?? 4;
    // Immer ein fester Unterschritt (> 0): der alte "ein Schritt je Frame"-Pfad wurde nicht mehr benutzt.
    this.h = o.substep !== undefined && o.substep > 0 ? o.substep : 1 / 240;
    this.keep240 = o.damping ?? 0.985;
    this.keepH = Math.pow(this.keep240, this.h * 240);
    this.endW = o.endWeight ?? 0.15;
    this.wts = new Float64Array([0, 0.5, this.endW]);
  }

  /**
   * Gesamt- und Segmentlänge — Plätze in sc wie der übrige Frame-Zustand: die gespannte Länge schreibt advance
   * je Frame, und Double-Felder boxten in Chromes Zwischenstufe (Review-Nachmessung: advance 1.0 KiB/s).
   */
  get length(): number {
    return this.sc[R_LEN];
  }

  get segLen(): number {
    return this.sc[R_SEG];
  }

  /** Länge ändern (Jo-Jo wickelt ab/auf) — in place, keine Allokation. */
  setLength(L: number): void {
    // !(L > 0) fängt auch NaN; L − L ≠ 0 fängt +∞ (ohne Number.isFinite, siehe advance).
    if (!(L > 0) || L - L !== 0) return;
    this.sc[R_LEN] = L;
    this.sc[R_SEG] = L / (this.n - 1);
  }

  /**
   * Geführtes Ende gespannt halten (Jo-Jo): in jedem Frame Länge = Abstand Anfang–Ende × k, geklemmt auf
   * [min, max]; k = 0 schaltet ab (Kendama: feste Länge, locker). Einmal setzen — advance() rechnet es: als
   * eigener kleiner Aufruf je Frame lief die Rechnung im Spiel minutenlang ohne TurboFan und boxte (Review:
   * 1.4 KiB/s nach 150 s); die Schleifen-Funktion advance ist früh optimiert.
   */
  setTaut(k: number, min: number, max: number): void {
    this.sc[R_TK] = k;
    this.sc[R_TMIN] = min;
    this.sc[R_TMAX] = max;
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
    // x − x ist nur für endliche x genau 0 (NaN/±∞ → NaN): Prüfung ohne Builtin-Aufruf — Number.isFinite
    // auf einer Kommazahl boxte im Spiel (Chrome-Zwischenstufe) jeden Wert, Rope.advance ~100 B/Frame.
    if (sx - sx + (sy - sy) + (sz - sz) + (ex - ex) + (ey - ey) + (ez - ez) !== 0) return;
    const tk = this.sc[R_TK];
    if (tk > 0 && !this.freeEnd) {
      const dx = ex - sx;
      const dy = ey - sy;
      const dz = ez - sz;
      const L = Math.min(this.sc[R_TMAX], Math.max(this.sc[R_TMIN], Math.sqrt(dx * dx + dy * dy + dz * dz) * tk));
      this.sc[R_LEN] = L;
      this.sc[R_SEG] = L / (this.n - 1);
    }
    if (!this.started) {
      this.reset(sx, sy, sz, ex, ey, ez);
      return;
    }
    // Ohne Verzweigungen um Kommazahlen (`c ? zahl : 0`): im ersten Spielminute läuft der Frame-Pfad in
    // Chrome noch nicht in TurboFan — die Zwischenstufe boxte jeden solchen Zusammenfluss (Rope 155 B/Frame).
    // NaN bleibt NaN und fällt unten heraus (!(dt > 0)), +∞ wird 0.1.
    const dt = Math.min(Math.max(dtRaw, 0), 0.1);
    if (!(dt > 0)) {
      // Frame ohne Dauer (Rest eines an seinem Ende geteilten Frames): die Ziele gelten ab jetzt — der
      // nächste Frame interpoliert von hier (sonst zöge er das geführte Ende vom alten Anker her).
      this.a0[0] = sx;
      this.a0[1] = sy;
      this.a0[2] = sz;
      this.a1[0] = ex;
      this.a1[1] = ey;
      this.a1[2] = ez;
      this.sc[R_ALPHA] = 1;
      this.writeOut();
      return;
    }
    // Nicht-endliche Kräfte (NaN aus einer kaputten Eingabe) würden die Kette vergiften.
    const acc = this.accel;
    const grv = this.gravity;
    for (let k = 0; k < 3; k++) {
      if (acc[k] - acc[k] !== 0) acc[k] = 0;
      if (grv[k] - grv[k] !== 0) grv[k] = k === 1 ? -ROPE_G : 0;
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

  /**
   * Plan 008 (additiv): Geschwindigkeit des Endes (Einheiten/s) für den nächsten Unterschritt setzen — beim Loslassen
   * mitten im Frame (nach updatePart) die exakte Geschwindigkeit der Zeitleiste statt der aus linear interpolierten
   * Frame-Lagen (bei 30 Hz ein Mittel über 33 ms: das freie Pendel startete je Framerate anders).
   */
  setEndVelocity(v: ArrayLike<number>): void {
    const e = (this.n - 1) * 3;
    const h = this.h;
    const p = this.p;
    const q = this.q;
    q[e] = p[e] - v[0] * h;
    q[e + 1] = p[e + 1] - v[1] * h;
    q[e + 2] = p[e + 2] - v[2] * h;
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
    const keep = this.keepH;
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
    const L = this.sc[R_SEG];
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
    const L = this.sc[R_SEG];
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
  // x − x ist nur für endliche x genau 0 (Number.isFinite auf Kommazahlen boxte im Spiel, siehe Rope.advance).
  const r = tiltDeg - tiltDeg === 0 ? (tiltDeg * Math.PI) / 180 : 0;
  const gs = Math.sin(r);
  const gc = Math.cos(r);
  for (let k = 0; k < 3; k++) rope.gravity[k] = ROPE_G * (-A.up[k] * gc - A.right[k] * gs);
  const m = motionFx > 0 ? (motionFx < 1 ? motionFx : 1) : 0;
  let x = ax - ax === 0 ? ROPE_CARTOON * ax * m : 0;
  let y = ay - ay === 0 ? ROPE_CARTOON * ay * m : 0;
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
/** Eingang dieses Frames (roh, vor der Prüfung): Anker x/y (Bildhöhen), Neigung (Grad). */
const D_NX = 11;
const D_NY = 12;
const D_NT = 13;

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
  private readonly d = new Float64Array(14);
  private primed = false;

  /** Neu beginnen (Respawn, Gegenstand gewechselt): der Folger steht an der nächsten Position. */
  reset(): void {
    this.primed = false;
  }

  /**
   * Wie setFrame, Werte aus der Frame-Eingabe (Frame-Pfad der Gegenstände): direkt in die Plätze, dann
   * commit() ohne Argumente — berechnete Kommazahlen als Argumente (vorher setFrame(fin(x), …)) und
   * Number.isFinite boxte V8 je Frame (Review: setFrameFrom 1.5 KiB/s nach 150 s).
   */
  setFrameFrom(inp: { readonly handX?: number; readonly handY?: number; readonly handTilt?: number }, motionFx: number): void {
    const d = this.d;
    d[D_NX] = inp.handX ?? 0;
    d[D_NY] = inp.handY ?? 0;
    d[D_NT] = inp.handTilt ?? 0;
    d[D_M] = motionFx > 0 ? (motionFx < 1 ? motionFx : 1) : 0;
    this.commit();
  }

  /** Einmal pro Frame VOR rope.update: Anker in Bildhöhen (x rechts, y unten), Neigung in Grad (+ = gegen den UZS). */
  setFrame(x: number, y: number, tiltDeg: number, motionFx: number): void {
    const d = this.d;
    d[D_NX] = x;
    d[D_NY] = y;
    d[D_NT] = tiltDeg;
    d[D_M] = motionFx > 0 ? (motionFx < 1 ? motionFx : 1) : 0;
    this.commit();
  }

  /** Eingang (D_N*) übernehmen. Nicht endlich → letzter Wert: danach ist im Unterschritt-Takt alles endlich. */
  private commit(): void {
    const d = this.d;
    const x = d[D_NX];
    const y = d[D_NY];
    const t = d[D_NT];
    // x − x ist nur für endliche x genau 0 (NaN/±∞ → NaN) — ohne Builtin-Aufruf.
    const X = x - x === 0 ? x * UNITS_PER_IMAGE_HEIGHT : d[D_X1];
    const Y = y - y === 0 ? -y * UNITS_PER_IMAGE_HEIGHT : d[D_Y1];
    const T = t - t === 0 ? t : d[D_T1];
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
