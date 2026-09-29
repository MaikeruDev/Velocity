/**
 * Messung (Plan 007 K9): hängendes Pendel (freies Schnur-Ende) an der ECHTEN HandMotion — Bhop-Kette
 * mit A/D-Wechsel, harte Landung, Maus-Flick — über RopeDrive aus src/ui/hand/rope.ts.
 *   npx tsx tools/cosmetics/rope-hang.ts [--grid]
 * Ausgabe je Framerate: Abweichung der Pendel-Position gegen 2400 Hz (Low-Res-px bei 270 Zeilen),
 * höchster Punkt über dem Anker (Bild-oben, muss < 0 bleiben) und Ausschlag im Bild — einmal mit
 * DERSELBEN Handbahn für alle Frameraten (2400-Hz-HandMotion abgetastet: misst nur die Schnur) und
 * einmal mit HandMotion je Framerate (ganze Kette = Maßstab des Entwurfs, ≤ 2.5 / 1.3 px bei 30/60 Hz).
 * Zum Vergleich die alte Methode (zweite Differenz je Frame, Prototyp).
 * Eingaben wie im Spiel: Events und Zustand am Frame-Ende (Snapshot nach dem Tick), Blick-Delta als
 * Drehung im Frame-Intervall. Außerhalb des Rasters bleibt eine Rest-Abweichung, weil ein Frame nicht
 * weiß, WANN in seinem Intervall ein Event lag (#77: am Ende).
 * --grid legt alle Ereignisse auf das 1/6-s-Raster (fallen.md #77), sonst der Takt aus
 * tools/critique/v2/kosmetik/rope-bench.ts (0.66 s). tests/rope.test.ts nutzt dieselben Funktionen.
 */
import { HandMotion, makeHandInput } from '../../src/ui/hand/handMotion';
import { Rope, RopeDrive, UNITS_PER_IMAGE_HEIGHT, driveRope } from '../../src/ui/hand/rope';
import { VIEW_AXES } from '../../src/ui/hand/rot';
import type { GameEvent } from '../../src/engine/events';

export const PX_PER_UNIT = 270 / UNITS_PER_IMAGE_HEIGHT;
export type RopeMethod = 'drive' | 'diff';

export interface HangOptions {
  readonly method?: RopeMethod;
  /** Ereignisse auf dem 1/6-s-Raster. */
  readonly grid?: boolean;
  /** Handbahn vorgeben (statt HandMotion je Framerate): Aufnahme aus recordHandPath(). */
  readonly path?: HandPath | null;
  readonly motionFx?: number;
}

export interface HangRun {
  readonly x: number[];
  readonly y: number[];
  readonly z: number[];
  readonly t: number[];
  /** Höchster Punkt des Endes über dem Anker in Bild-oben (Einheiten). */
  top: number;
  /** Ausschlag des Endes in Bild-rechts während der Bhop-Kette (Einheiten). */
  swing: number;
}

export interface HandPath {
  readonly fps: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly tilt: Float64Array;
}

const WARMUP = 2;
const DURATION = 3.4;

/** Szenario: je Frame HandMotion füttern (Ereignisse, Luft, A/D, Maus). */
function handScenario(grid: boolean): (hm: HandMotion, t: number, dt: number, active: boolean) => void {
  const per = grid ? 5 / 6 : 0.66;
  const air = grid ? 4 / 6 : 0.62;
  const end = grid ? 2.5 : 2.3;
  const f0 = grid ? 2.5 : 2.6;
  const f1 = grid ? 16 / 6 : 2.7;
  const inp = makeHandInput();
  const hops = new Set<number>();
  // Blick-Delta ist wie im Spiel ein Intervall-Maß: Integral der Drehrate über (t − dt, t]. Aus dem
  // Zustand am Frame-Ende abgeleitet lag die Drehung bei 30 Hz einen ganzen Frame zu früh.
  const overlap = (a: number, b: number, T: number): number => clamp01(Math.min(b, T) - a, b - a);
  const yawAt = (T: number): number => {
    let y = 2.2 * overlap(f0, f1, T);
    for (let k = 0; 0.5 + k * per < end; k++) {
      const a = 0.5 + k * per;
      y += (k % 2 === 0 ? 1 : -1) * 1.6 * overlap(a, Math.min(a + air, end), T);
    }
    return y;
  };
  return (hm, t, dt, active) => {
    let onGround = true;
    let side = 0;
    let airT = 0;
    if (active && t >= 0.5 && t < end) {
      const k = Math.floor((t - 0.5 + 1e-9) / per);
      const u = t - 0.5 - k * per;
      onGround = u >= air - 1e-9;
      side = k % 2 === 0 ? 1 : -1;
      airT = onGround ? 0 : u;
      if (!hops.has(k)) {
        hops.add(k);
        const e: GameEvent = { type: 'jump', speed: 450 + 40 * k, gain: 20, perfect: k > 0, clean: k > 0, chain: k + 1, sync: 0.9, crouched: false, coyote: false };
        hm.onEvent(e);
      }
      if (onGround && !hops.has(k + 100)) {
        hops.add(k + 100);
        const e: GameEvent = { type: 'land', impact: k === 2 ? 650 : 300, speed: 500, airTime: air, jumpQueued: k !== 2 };
        hm.onEvent(e);
      }
    }
    inp.onGround = onGround;
    inp.airTime = airT;
    inp.side = side;
    inp.yawDelta = active ? yawAt(t) - yawAt(t - dt) : 0;
    hm.update(dt, inp);
  };
}

function clamp01(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v;
}

/** Handbahn (x, y in Bildhöhen, Neigung in Grad) bei `fps`, inkl. Einschwingen. */
export function recordHandPath(fps: number, grid = false): HandPath {
  const n = Math.round(WARMUP * fps) + Math.round(DURATION * fps);
  const p: HandPath = { fps, x: new Float64Array(n), y: new Float64Array(n), tilt: new Float64Array(n) };
  const hm = new HandMotion();
  const drive = handScenario(grid);
  const dt = 1 / fps;
  for (let i = 0; i < n; i++) {
    const w = i < Math.round(WARMUP * fps);
    drive(hm, w ? 0 : (i - Math.round(WARMUP * fps) + 1) * dt, dt, !w);
    p.x[i] = hm.x;
    p.y[i] = hm.y;
    p.tilt[i] = hm.tilt;
  }
  return p;
}

export function hang(fps: number, o: HangOptions = {}): HangRun {
  const method = o.method ?? 'drive';
  const hm = new HandMotion();
  hm.motionFx = o.motionFx ?? 1;
  const scenario = handScenario(o.grid ?? false);
  const acc = new HandAccel();
  const drive = new RopeDrive();
  const rope = new Rope({ segments: 8, length: 9, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  if (method === 'drive') rope.drive = drive;
  rope.freeEnd = true;
  driveRope(rope, 0, 0, 0);
  const A = VIEW_AXES;
  rope.reset(0, 0, 0, -A.up[0] * 8.99, -A.up[1] * 8.99, -A.up[2] * 8.99);
  const dt = 1 / fps;
  const out: HangRun = { x: [], y: [], z: [], t: [], top: -Infinity, swing: 0 };
  const warm = Math.round(WARMUP * fps);
  const n = warm + Math.round(DURATION * fps);
  const m = o.motionFx ?? 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const active = i >= warm;
    const t = active ? (i - warm + 1) * dt : 0;
    let hx: number;
    let hy: number;
    let ht: number;
    const path = o.path;
    if (path) {
      // Gleiche Bahn für alle Frameraten: Probe der Aufnahme zur selben Zeit (Frame-Ende).
      const j = Math.min(path.x.length - 1, Math.round(((i + 1) * path.fps) / fps) - 1);
      hx = path.x[j];
      hy = path.y[j];
      ht = path.tilt[j];
    } else {
      scenario(hm, t, dt, active);
      hx = hm.x;
      hy = hm.y;
      ht = hm.tilt;
    }
    if (method === 'drive') drive.setFrame(hx, hy, ht, m);
    else {
      acc.update(dt, hx, hy);
      driveRope(rope, acc.ax, acc.ay, ht, m);
    }
    rope.update(dt, 0, 0, 0, 0, 0, 0);
    if (!active) continue;
    out.x.push(rope.endX);
    out.y.push(rope.endY);
    out.z.push(rope.endZ);
    out.t.push(t);
    const up = rope.endX * A.up[0] + rope.endY * A.up[1] + rope.endZ * A.up[2];
    out.top = Math.max(out.top, up);
    if (t > 0.5 && t < 2.5) {
      const r = rope.endX * A.right[0] + rope.endY * A.right[1] + rope.endZ * A.right[2];
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
  }
  out.swing = hi - lo;
  return out;
}

/**
 * Alte Methode (Prototyp, nur zum Vergleich): Anker-Beschleunigung als zweite Differenz je Frame —
 * x/y in Bildhöhen (y unten) → ax/ay in Hand-Einheiten/s² (x rechts, y oben). Die ersten zwei
 * Frames liefern 0. Nicht im Spiel: ein Sprung-Kick wird so zu einer Ein-Frame-Spitze, die der
 * Deckel je Framerate anders abschneidet (deshalb RopeDrive, fallen.md #110).
 */
class HandAccel {
  ax = 0;
  ay = 0;
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  private primed = 0;

  update(dt: number, x: number, y: number): void {
    if (!(dt > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const X = x * UNITS_PER_IMAGE_HEIGHT;
    const Y = -y * UNITS_PER_IMAGE_HEIGHT;
    if (this.primed === 0) {
      this.px = X;
      this.py = Y;
      this.primed = 1;
      return;
    }
    const nvx = (X - this.px) / dt;
    const nvy = (Y - this.py) / dt;
    if (this.primed >= 2) {
      this.ax = (nvx - this.vx) / dt;
      this.ay = (nvy - this.vy) / dt;
    } else this.primed = 2;
    this.px = X;
    this.py = Y;
    this.vx = nvx;
    this.vy = nvy;
  }
}

/** Größte Abweichung (Einheiten) gegen die Referenz zum selben Zeitpunkt. */
export function deviation(r: HangRun, ref: HangRun, refFps: number): number {
  let worst = 0;
  for (let i = 0; i < r.t.length; i++) {
    const j = Math.min(ref.t.length - 1, Math.max(0, Math.round(r.t[i] * refFps) - 1));
    worst = Math.max(worst, Math.hypot(r.x[i] - ref.x[j], r.y[i] - ref.y[j], r.z[i] - ref.z[j]));
  }
  return worst;
}

if (process.argv[1]?.includes('rope-hang')) {
  const grid = process.argv.includes('--grid');
  const REF = 2400;
  const path = recordHandPath(REF, grid);
  for (const method of ['drive', 'diff'] as const) {
    const ref = hang(REF, { method, grid });
    console.log(`${method}${grid ? ' (1/6-s-Raster)' : ''}: Ausschlag ${(ref.swing * PX_PER_UNIT).toFixed(1)} px, höchster Punkt ${ref.top.toFixed(2)} u über dem Anker`);
    for (const fps of [30, 60, 144, 240]) {
      const same = hang(fps, { method, grid, path });
      const own = hang(fps, { method, grid });
      console.log(
        `  ${fps} Hz: gleiche Handbahn ${(deviation(same, ref, REF) * PX_PER_UNIT).toFixed(2)} px · ganze Kette ${(deviation(own, ref, REF) * PX_PER_UNIT).toFixed(2)} px · höchster ${Math.max(same.top, own.top).toFixed(2)} u`,
      );
    }
  }
  // Nur die Hand: wie weit weicht HandMotion selbst je Framerate ab (Bildposition in Einheiten)?
  for (const fps of [30, 60, 144, 240]) {
    const p = recordHandPath(fps, grid);
    let w = 0;
    const warm = Math.round(WARMUP * fps);
    for (let i = warm; i < p.x.length; i++) {
      const j = Math.min(path.x.length - 1, Math.round(((i + 1) * REF) / fps) - 1);
      w = Math.max(w, Math.hypot(p.x[i] - path.x[j], p.y[i] - path.y[j]) * UNITS_PER_IMAGE_HEIGHT);
    }
    console.log(`  Hand allein ${fps} Hz: ${(w * PX_PER_UNIT).toFixed(2)} px`);
  }
}
