/**
 * Prototyp "Momentum & Flow" (Linse Arcade-Movement, 28.09.): Varianten als Patch auf
 * PlayerMovement.prototype — NICHT Projektcode. Alle Schalter aus = bitgleich zum Original
 * (geprüft: levels:check mit geladenem Patch, MOM leer → identische Ausgabe).
 *
 * Nutzung:
 *   - in Mess-Skripten: `import { MOM, setMomentum } from './patch'` und umschalten
 *   - für die echten Level-Werkzeuge prozessweit:
 *       MOM=slope,grace npx tsx --import ./tools/critique/v2/momentum/patch.ts tools/validate-levels.ts
 *
 * Varianten (Entwurf siehe Report):
 *   slope    Lande-Umlenkung: Fall-Energie → Tempo entlang des Gefälles, nie Verlust beim Aufsetzen
 *            (MOM_SLOPE_K = Anteil des Gewinns, Default 1 = Source-Clip, deterministisch)
 *   grace    Lande-Gnade: MOM_GRACE_TICKS Bodenticks ohne Friction nach einer Landung aus
 *            ≥ MOM_GRACE_AIR s Luft; Bodenschub darf |v_h| in der Zeit nicht über max(v_Landung, wish) heben
 *   kicker   Kanten-Launch: wer ohne Sprung von einer steigenden Fläche abhebt, behält deren
 *            Steig-Tempo (vy = k · v_h·Steigung, MOM_KICK_K)
 *   kickjump Sprung von steigender Fläche: vy = jumpImpulse + k · Steig-Tempo (MOM_KICKJ_K)
 *   surfw    Surf-Halten mit W: in der Luft über/an einer Surf-Flanke, nur W → wishdir in die Rampe
 */
import { Vector3 } from 'three';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';

export interface MomentumOptions {
  slope: boolean;
  slopeK: number;
  /** slope: Richtung des Anflugs behalten, nur Gewinn entlang der Flugrichtung (keine Seitenhang-Ablenkung). */
  slopeKeepDir: boolean;
  /** slope: Lande-Entscheidung deterministisch — zeigt clip(vIn) steiler als nonJumpVelocity nach oben, bleibt man in der Luft (Rampslide). */
  slopeSlide: boolean;
  /** slope: bergauf wie Source verlieren (nur Bergab-Gewinn) statt Tempo zu halten. */
  slopeUpSource: boolean;
  /** slope: Gewinn nur bis zu dieser Neigung (Grad), steilere Flächen wie Source. 90 = alle. */
  slopeMaxDeg: number;
  grace: boolean;
  graceTicks: number;
  graceAir: number;
  /** Bodenschub während der Gnade kappen (Ground-Strafe-Schutz). false nur für die Exploit-Messung. */
  graceClamp: boolean;
  kicker: boolean;
  kickK: number;
  kickJump: boolean;
  kickJumpK: number;
  surfW: boolean;
  /** surfw: erst ab so viel Abrutsch-Tempo (u/s entlang der Falllinie) in die Rampe drücken; 0 = immer. */
  surfWDive: number;
}

function envNum(name: string, d: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? d : Number(v);
}

const flags = new Set((process.env.MOM ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export const MOM: MomentumOptions = {
  slope: flags.has('slope'),
  slopeK: envNum('MOM_SLOPE_K', 1),
  slopeKeepDir: process.env.MOM_SLOPE_DIR === '1',
  slopeSlide: process.env.MOM_SLOPE_SLIDE === '1',
  slopeUpSource: process.env.MOM_SLOPE_UP === 'source',
  slopeMaxDeg: envNum('MOM_SLOPE_MAXDEG', 90),
  grace: flags.has('grace'),
  graceTicks: envNum('MOM_GRACE_TICKS', 8),
  graceAir: envNum('MOM_GRACE_AIR', 0.1),
  graceClamp: process.env.MOM_GRACE_CLAMP !== '0',
  kicker: flags.has('kicker'),
  kickK: envNum('MOM_KICK_K', 1),
  kickJump: flags.has('kickjump'),
  kickJumpK: envNum('MOM_KICKJ_K', 1),
  surfW: flags.has('surfw'),
  surfWDive: envNum('MOM_SURFW_DIVE', 0),
};

const OFF: MomentumOptions = { ...MOM, slope: false, grace: false, kicker: false, kickJump: false, surfW: false };

export function setMomentum(patch: Partial<MomentumOptions> | 'off'): void {
  Object.assign(MOM, patch === 'off' ? OFF : patch);
}

/** Zähler für Berichte (wie oft griff eine Variante). */
export const MOM_STATS = { slopeGain: 0, slopeSaved: 0, slopeLandings: 0, graceSkips: 0, graceClamps: 0, kicks: 0, kickJumps: 0, surfW: 0, slides: 0 };

/* eslint-disable @typescript-eslint/no-explicit-any */
type PM = any;
const P: PM = PlayerMovement.prototype;
const orig = {
  walkMove: P.walkMove,
  airMove: P.airMove,
  onLand: P.onLand,
  friction: P.friction,
  accelerate: P.accelerate,
  categorize: P.categorize,
  onLeaveGround: P.onLeaveGround,
  doJump: P.doJump,
  computeWish: P.computeWish,
};

const vIn = new WeakMap<object, Vector3>();
const prevN = new WeakMap<object, Vector3>();
/** Letzte Steigungs-Normale am Boden und Bodenweg seither (die AABB-Hull fährt ~32 u flach über jeden First). */
const slopeN = new WeakMap<object, Vector3>();
const slopeDist = new WeakMap<object, number>();
/** So weit (u Bodenweg) gilt die letzte Steigung noch: Hull-Breite + Rand. */
export const SLOPE_MEMORY = 40;

/** Normale für Launch-Berechnungen: aktuelle Boden-Normale, oder die Steigung kurz davor (First). */
function launchNormal(self: PM, n: Vector3 | undefined): Vector3 | undefined {
  if (n && n.y < 0.9999) return n;
  const m = slopeN.get(self);
  if (m && (slopeDist.get(self) ?? Infinity) <= SLOPE_MEMORY) return m;
  return n;
}
const graceOk = new WeakMap<object, boolean>();
function vec(m: WeakMap<object, Vector3>, o: object): Vector3 {
  let v = m.get(o);
  if (!v) {
    v = new Vector3();
    m.set(o, v);
  }
  return v;
}

/** Steig-Tempo der Fläche n bei Horizontal-Geschwindigkeit v: vy, mit dem man auf der Ebene bleibt. */
export function planeRise(n: Vector3, vx: number, vz: number): number {
  return n.y > 1e-3 ? -(n.x * vx + n.z * vz) / n.y : 0;
}

P.walkMove = function (this: PM, w: Vector3, ws: number): void {
  const s = this.s;
  const x0 = s.pos.x;
  const z0 = s.pos.z;
  orig.walkMove.call(this, w, ws);
  if (s.groundNormal.y < 0.9999) {
    vec(slopeN, this).copy(s.groundNormal);
    slopeDist.set(this, 0);
  } else {
    slopeDist.set(this, (slopeDist.get(this) ?? Infinity) + Math.hypot(s.pos.x - x0, s.pos.z - z0));
  }
};

P.airMove = function (this: PM, w: Vector3, ws: number): void {
  vec(vIn, this).copy(this.s.vel);
  orig.airMove.call(this, w, ws);
};

P.onLand = function (this: PM, preMoveVelY: number): void {
  if (MOM.slope) {
    const s = this.s;
    const n: Vector3 = s.groundNormal;
    const v = vec(vIn, this);
    MOM_STATS.slopeLandings++;
    const d = v.x * n.x + v.y * n.y + v.z * n.z;
    if (d < 0 && n.y < 0.9999 && n.y >= Math.cos((MOM.slopeMaxDeg * Math.PI) / 180) - 1e-9) {
      // Ebenen-Projektion der Anflug-Geschwindigkeit (ClipVelocity, overbounce 1).
      const px = v.x - n.x * d;
      const pz = v.z - n.z * d;
      let hp = Math.hypot(px, pz);
      const hIn = Math.hypot(v.x, v.z);
      const hNow = Math.hypot(s.vel.x, s.vel.z);
      // Richtung: Clip-Richtung (Source) oder Anflug-Richtung (keepDir: Gewinn nur entlang der Flugrichtung).
      let dx = px;
      let dz = pz;
      if (MOM.slopeKeepDir && hIn > 1e-3) {
        dx = v.x / hIn;
        dz = v.z / hIn;
        hp = px * dx + pz * dz;
        dx *= hp;
        dz *= hp;
      }
      // Nie weniger als im Anflug (bergauf: kein Clip-Verlust), bergab k × Clip-Gewinn.
      const target = hp > hIn ? hIn + MOM.slopeK * (hp - hIn) : MOM.slopeUpSource ? hNow : hIn;
      if (hp > 1e-3 && Math.abs(target - hNow) > 1e-6) {
        if (target > hNow) MOM_STATS.slopeGain += target - hNow;
        if (hNow < hIn) MOM_STATS.slopeSaved += Math.min(hIn, target) - hNow;
        s.vel.x = (dx / hp) * target;
        s.vel.z = (dz / hp) * target;
      }
    }
  }
  orig.onLand.call(this, preMoveVelY);
  graceOk.set(this, this.landAirTime >= MOM.graceAir - 1e-9);
  // Steigungs-Gedächtnis gilt nur für zusammenhängenden Bodenweg.
  slopeDist.set(this, Infinity);
};

function inGrace(self: PM, limit: number): boolean {
  return MOM.grace && self.frictionTicks < limit && graceOk.get(self) === true;
}

P.friction = function (this: PM): void {
  // friction() läuft vor frictionTicks++: 0 = erster Bodentick nach dem Landetick.
  if (inGrace(this, MOM.graceTicks)) {
    MOM_STATS.graceSkips++;
    return;
  }
  orig.friction.call(this);
};

P.accelerate = function (this: PM, wishdir: Vector3, wishspeed: number, accel: number): void {
  // accelerate() läuft nach frictionTicks++: Gnade = frictionTicks 1..N.
  if (!inGrace(this, MOM.graceTicks + 1) || !MOM.graceClamp) {
    orig.accelerate.call(this, wishdir, wishspeed, accel);
    return;
  }
  const v = this.s.vel;
  const h0 = Math.hypot(v.x, v.z);
  orig.accelerate.call(this, wishdir, wishspeed, accel);
  const h1 = Math.hypot(v.x, v.z);
  const lim = Math.max(h0, wishspeed);
  if (h1 > lim + 1e-9) {
    MOM_STATS.graceClamps++;
    v.x *= lim / h1;
    v.z *= lim / h1;
  }
};

P.categorize = function (this: PM, jumped: boolean, groundMove: boolean): void {
  const s = this.s;
  const wasGround = s.onGround;
  if (wasGround) vec(prevN, this).copy(s.groundNormal);
  orig.categorize.call(this, jumped, groundMove);
  if (!MOM.slope || !MOM.slopeSlide || wasGround || !s.onGround) return;
  // Landung erkannt: wäre die auf die Ebene geklippte Anflug-Geschwindigkeit ein Rampslide? Dann in der Luft bleiben.
  const n: Vector3 = s.groundNormal;
  const v = vec(vIn, this);
  const d = v.x * n.x + v.y * n.y + v.z * n.z;
  if (d >= 0) return;
  const py = v.y - n.y * d;
  if (py > this.cfg.nonJumpVelocity) {
    MOM_STATS.slides++;
    s.vel.set(v.x - n.x * d, py, v.z - n.z * d);
    s.onGround = false;
    s.groundNormal.set(0, 1, 0);
  }
};

P.onLeaveGround = function (this: PM): void {
  orig.onLeaveGround.call(this);
  if (!MOM.kicker) return;
  const s = this.s;
  const n = launchNormal(this, prevN.get(this));
  if (!n) return;
  const rise = planeRise(n, s.vel.x, s.vel.z);
  if (rise > 0 && MOM.kickK * rise > s.vel.y) {
    MOM_STATS.kicks++;
    s.vel.y = MOM.kickK * rise;
    // Launch statt Kante: kein Coyote (wie Source-Rampen-Launch).
    if (s.vel.y > this.groundLaunchVelocity()) this.coyoteOk = false;
  }
};

P.doJump = function (this: PM, coyote: boolean): void {
  const s = this.s;
  let rise = 0;
  if (MOM.kickJump) {
    const n = launchNormal(this, s.onGround ? s.groundNormal : coyote ? prevN.get(this) : undefined);
    if (n) rise = Math.max(0, planeRise(n, s.vel.x, s.vel.z));
  }
  orig.doJump.call(this, coyote);
  if (rise > 0) {
    MOM_STATS.kickJumps++;
    s.vel.y += MOM.kickJumpK * rise;
  }
};

P.computeWish = function (this: PM): void {
  orig.computeWish.call(this);
  if (!MOM.surfW) return;
  const s = this.s;
  if (s.onGround || this.inSide !== 0 || !(this.inForward > 0)) return;
  let n: Vector3 | null = null;
  if (s.surfing && this.lastSurfNormal.lengthSq() > 0) n = this.lastSurfNormal;
  else if (this.steepBelow) n = this.steepNormal;
  if (!n) return;
  const h = Math.hypot(n.x, n.z);
  if (h < 1e-6) return;
  if (MOM.surfWDive > 0) {
    // Falllinien-Tempo (aufwärts positiv): erst drücken, wenn man schneller als surfWDive abrutscht.
    const tx = -n.x * n.y;
    const ty = 1 - n.y * n.y;
    const tz = -n.z * n.y;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const u = (s.vel.x * tx + s.vel.y * ty + s.vel.z * tz) / tl;
    if (u > -MOM.surfWDive) return;
  }
  MOM_STATS.surfW++;
  this.wishdir.set(-n.x / h, 0, -n.z / h);
  this.wishspeed = this.cfg.runSpeed * Math.min(Math.abs(this.inForward), 1);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Config-Varianten prozessweit (vor jedem SpeedCurve-Cache): MOM_CFG='{"airSpeedCapLow":40}'.
if (process.env.MOM_CFG) {
  const patch = JSON.parse(process.env.MOM_CFG) as Record<string, number>;
  Object.assign(VELOCITY_DEFAULT as unknown as Record<string, number>, patch);
  console.error(`[momentum patch] VELOCITY_DEFAULT += ${JSON.stringify(patch)}`);
}

if (flags.size > 0 && process.env.MOM_QUIET !== '1') {
  console.error(`[momentum patch] aktiv: ${JSON.stringify(MOM)}`);
}
