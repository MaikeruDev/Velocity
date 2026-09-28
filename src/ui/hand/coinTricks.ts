import type { GameEvent } from '../../engine/events';
import { VM_PARAM, VM_RIG } from '../../render/types';
import { arc, backOut, bell, clamp, fin, smooth } from './anim';
import { fingerPoint, thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES } from './rot';
import { viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Münze (Plan 007, KI5): Kopf oder Zahl zeigt deinen Split. Ruht auf dem gekrümmten Zeigefinger
 * am Daumen (Pose coin: lockere Faust, Daumen eingezogen).
 *
 * - Stand: knuckleRoll (über die Knöchel Zeige → kleiner Finger, jeder Schritt eine halbe Wende um
 *   die Fingerachse, unter der Hand zurück; die Hand dreht dafür den Handrücken zur Kamera),
 * - Lauf: flip (Daumen-Flip, Scheitel 5), Flow: flip / roll (schneller Knöchel-Lauf),
 * - Overdrive: highFlip (Scheitel 9, Fang als Klatsch auf dem Handrücken) / vanish (Poof wie die Karte),
 * - Surf ≥ 500: Zustand edgeSpin — tanzt auf der Kante über der Faust, Ende = Klatsch,
 * - Checkpoint: call — Flip, die Landung zeigt KOPF, wenn split < 0 oder ohne Referenz, sonst ZAHL;
 *   Ziel: Kopf bei neuer Bestzeit, sonst Zahl. Läuft gerade ein Trick, kommt der call danach (≤ 1.5 s).
 * Würfe drehen immer um eine gerade Zahl halber Drehungen: vorn liegt am Ende wieder die Vorderseite,
 * das Motiv vorn wählt der Kanal side — umgeschaltet, während die Münze hochkant steht (unsichtbar).
 */

export const COIN_TRICKS = ['none', 'knuckleRoll', 'roll', 'flip', 'highFlip', 'vanish', 'call', 'edgeSpin'] as const;
export type CoinTrick = Exclude<(typeof COIN_TRICKS)[number], 'none'>;
const COIN_NAMES: readonly string[] = COIN_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const COIN_TIER_TRICKS: readonly (readonly CoinTrick[])[] = [[], ['flip'], ['flip', 'roll'], ['highFlip', 'vanish']];

export const HEADS = 0;
export const TAILS = 1;

/** Abklingzeiten: kalibriert mit event-probe (vorher 49–73 % Trick-Anteil, bis 36.7 Tricks/min). */
const COOLDOWN: { readonly [K in CoinTrick]: number } = { knuckleRoll: 0.6, roll: 0.8, flip: 0.6, highFlip: 1.2, vanish: 1.4, call: 1.0, edgeSpin: 0.5 };
const WALK_T = 2.0;
const WALK_PITCH = 0.9;
const WALK_YAW = 0.3;
const ROLL_T = 0.8;
const FLIP_WIND = 0.08;
const FLIP_AIR = 0.42;
const FLIP_T = 0.64;
const HIGH_AIR = 0.7;
const HIGH_SLAP = 0.2;
const HIGH_BACK = 0.2;
const HIGH_T = FLIP_WIND + HIGH_AIR + HIGH_SLAP + HIGH_BACK;
/** Der call ist kürzer als ein Flip (kommt an jedem Checkpoint): niedriger Wurf, kurz zeigen. */
const CALL_AIR = 0.36;
const CALL_SHOW = 0.32;
const CALL_T = FLIP_WIND + CALL_AIR + CALL_SHOW + 0.06;
const V_SWIPE = 0.16;
const V_GONE = 0.4;
const V_BACK = 0.95;
const V_POP = 1.1;
const V_TOTAL = 1.42;
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const PENDING = 1.5;
const SPIN_RATE = 17;

const P = VM_PARAM.coin;
const J = POSE_JOINTS[POSE.coin];

type M = V3;

function sub(a: M, b: M): M {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(a: M): M {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function fp(f: number, seg: number, x: number, y: number, z: number): M {
  const o: [number, number, number] = [0, 0, 0];
  fingerPoint(J, f, seg, x, y, z, o);
  return o;
}

/** Auf dem Rücken des Grundglieds von Finger f (Ladezeit, Pose coin). */
function knuckle(f: number): { pos: M; nrm: M; axis: M } {
  const r = VM_RIG.fingers[f];
  const mid = r.len[0] * 0.55;
  const c = fp(f, 0, 0, mid, 0);
  const top = fp(f, 0, 0, mid, r.r * 0.95 + 0.25);
  return { pos: top, nrm: norm(sub(top, c)), axis: norm(sub(fp(f, 0, 0, r.len[0], 0), fp(f, 0, 0, 0, 0))) };
}

const KN_LIFT_UP = 1.7;
const KN_LIFT_CAM = 0.8;
const KNUCKLES = [0, 1, 2, 3].map((f) => {
  const k = knuckle(f);
  return { ...k, pos: viewPoint(k.pos, 0, KN_LIFT_UP, KN_LIFT_CAM) };
});
/**
 * Auf den Knöcheln STEHEND, Vorderseite zur Kamera (leicht nach hinten gekippt): die Knöchel-Flächen
 * zeigen aus dieser Sicht nach oben-hinten (gemessen: Normale (−0.15, 0.58, −0.81) in Bildachsen) —
 * flach aufgelegt sähe man die Münze nur als Strich. Gewendet wird um die Bild-Hochachse (Drehtür).
 */
const KN_ROT: M = viewRot([[0, -0.4]]);
/** Ruhe: auf dem gekrümmten Zeigefinger am Daumen, flach, Vorderseite schräg zur Kamera. */
export const COIN_REST_POS: V3 = ((): V3 => {
  const t: [number, number, number] = [0, 0, 0];
  thumbPoint(J, 2, 0, VM_RIG.thumb.len[2], 0, t);
  const i = fp(0, 1, 0, 1.1, 0);
  return viewPoint([(t[0] + i[0]) / 2, (t[1] + i[1]) / 2, (t[2] + i[2]) / 2], -0.3, 1.3, 1.4);
})();
const REST_TILT = 0.95;
export const COIN_REST_ROT: V3 = viewRot([[0, -REST_TILT]]);
/** Auf der Kante über der Faust (Surf), Vorderseite zur Kamera. */
const EDGE_ROT: V3 = viewRot([]);
const EDGE_POS: V3 = viewPoint(COIN_REST_POS, 0.4, 2.2, 0.4);
/** Handrücken-Mitte (Klatsch beim highFlip). */
const SLAP_POS: V3 = ((): V3 => {
  const a = KNUCKLES[1].pos;
  const b = KNUCKLES[2].pos;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
})();

export class CoinTricks extends PropTricks<CoinTrick> {
  /** Motiv vorn (HEADS/TAILS) — bleibt bis zum nächsten Wurf. */
  side = HEADS;
  private target = HEADS;
  private pendingSide = -1;
  private pendingUntil = 0;
  private pick = 0;
  private idleCount = 0;
  private flips = 0;
  private halfTurns = 4;
  private surfOut = -1;
  /** Letzter Frame: schnell gesurft (der call wartet dann aufs Surf-Ende, der Surf-Zustand hat Vorrang). */
  private surfFast = false;
  /** Letzter Frame: am Boden, nicht surfend (dort darf der call sofort starten). */
  private grounded = true;

  override get trickNames(): readonly string[] {
    return COIN_NAMES;
  }

  protected override isState(id: CoinTrick): boolean {
    return id === 'edgeSpin';
  }

  protected resetRun(): void {
    this.side = HEADS;
    this.target = HEADS;
    this.pendingSide = -1;
    this.writeRest(this.out);
  }

  protected override start(id: CoinTrick): void {
    super.start(id);
    this.surfOut = -1;
    if (id === 'flip') this.halfTurns = 4;
    else if (id === 'highFlip') this.halfTurns = 8;
    else if (id === 'call') this.halfTurns = 4;
    if (id === 'flip' || id === 'highFlip') {
      // Normale Würfe: mal Kopf, mal Zahl (fest verteilt, kein Zufall im Test).
      this.target = this.flips++ % 3 === 1 ? 1 - this.side : this.side;
    }
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.coin;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = COIN_REST_POS[0];
    o.pos[1] = COIN_REST_POS[1];
    o.pos[2] = COIN_REST_POS[2];
    o.rot[0] = COIN_REST_ROT[0];
    o.rot[1] = COIN_REST_ROT[1];
    o.rot[2] = COIN_REST_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    o.param[P.side] = this.side;
  }

  protected cooldownOf(id: CoinTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (this.takePending()) return;
    if (tier === 0) return;
    const list = COIN_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('highFlip');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten hier auf die Abklingzeit (sonst L1 bei sync 1.0: 12 von 38 Tricks, 48 % Trick-Anteil).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('vanish');
    else if (tier === 2) this.start('flip');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'flip' : 'knuckleRoll');
    return 2.8 + 1.8 * this.rand();
  }

  /** Kopf/Zahl merken — auch wenn gerade ein Trick läuft (dann kommt der call direkt danach). */
  override onEvent(e: GameEvent): void {
    if (e.type === 'checkpoint') this.call(e.split === null || e.split < 0 ? HEADS : TAILS);
    else if (e.type === 'finish') this.call(e.best ? HEADS : TAILS);
    else super.onEvent(e);
  }

  private call(side: number): void {
    if (this.motionFx <= 0) return;
    this.target = side;
    // In der Luft wartet er bis zur Landung oder zum nächsten Sprung: sonst blockiert er einen Surf,
    // der gleich beginnt (Checkpoint vor der Rampe — event-probe: Surf-Zustand nur 74–76 %).
    if (this.free && this.grounded) this.start('call');
    else {
      this.pendingSide = side;
      this.pendingUntil = this.now + PENDING;
    }
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('edgeSpin');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) {
      this.start('edgeSpin');
      return;
    }
    if (inp.onGround && !inp.surfing) this.takePending();
  }

  protected override onLand(): void {
    this.takePending();
  }

  /** Wartenden call starten (sofern nicht verfallen). true = gestartet. */
  private takePending(): boolean {
    if (this.pendingSide < 0) return false;
    const s = this.pendingSide;
    this.pendingSide = -1;
    if (this.now > this.pendingUntil) return false;
    this.target = s;
    this.start('call');
    return true;
  }

  override update(dt: number, inp: PropFrameInput): void {
    this.surfFast = inp.surfing && fin(inp.speed) >= SURF_FROM;
    this.grounded = inp.onGround && !inp.surfing;
    super.update(dt, inp);
    // Ein call, der auf Surf-Ende oder Landung wartet, verfällt nicht, solange das dauert.
    if (this.pendingSide >= 0 && (this.inState || !this.grounded)) this.pendingUntil = this.now + PENDING;
  }

  protected evaluate(id: CoinTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'knuckleRoll') return this.walk(t, WALK_T, o);
    if (id === 'roll') return this.walk(t, ROLL_T, o);
    if (id === 'flip' || id === 'call') return this.flip(id, t, o);
    if (id === 'highFlip') return this.highFlip(t, o);
    if (id === 'vanish') return this.vanish(t, o);
    return this.edgeSpin(t, inp, o);
  }

  /** Knöchel-Lauf: zum Zeigefinger, drei Wenden bis zum kleinen Finger, unter der Hand zurück. */
  private walk(t: number, T: number, o: PropOut): boolean {
    const u = t / T;
    if (u >= 1) return true;
    // Handrücken zur Kamera gedreht: sonst verschwindet die Münze auf Ring- und Kleinfinger-Knöchel
    // hinter der Faust (Kontaktblatt; mit 0.25 rad war sie ab der Mitte des Laufs unsichtbar).
    const env = smooth(u / 0.12) * (1 - smooth((u - 0.85) / 0.15));
    o.hpitch = WALK_PITCH * env;
    o.hyaw = WALK_YAW * env;
    o.hroll = 0.15 * env;
    const k0 = KNUCKLES[0].pos;
    if (u < 0.12) {
      // Hoch auf den Zeigefinger-Knöchel.
      this.lerpPos(o, COIN_REST_POS, k0, smooth(u / 0.12), 0.8 * arc(u / 0.12));
      this.lerpRot(o, smooth(u / 0.12));
      return false;
    }
    if (u < 0.72) {
      // Drei Wenden (je eine halbe Drehung um die Fingerachse), Münze wandert über die Knöchel.
      const w = (u - 0.12) / 0.6;
      const step = Math.min(2, Math.floor(w * 3));
      const s = smooth(w * 3 - step);
      const a = KNUCKLES[step].pos;
      const b = KNUCKLES[step + 1].pos;
      this.lerpPos(o, a, b, s, 0.9 * arc(s));
      o.rot[0] = KN_ROT[0];
      o.rot[1] = KN_ROT[1];
      o.rot[2] = KN_ROT[2];
      this.rotateView(o, 0, 1, 0, -Math.PI * (step + s));
      if (this.mark(step, 0.12 * T + ((step + 0.5) / 3) * 0.6 * T, t)) this.kick(o, 0.04, -0.08);
      return false;
    }
    // Unter der Hand zurück (Daumen holt sie) — hinter den Fingern verdeckt, dann wieder obenauf.
    const r = (u - 0.72) / 0.28;
    const k3 = KNUCKLES[3].pos;
    const A = VIEW_AXES;
    const s = smooth(r);
    const dip = Math.sin(Math.PI * s);
    for (let k = 0; k < 3; k++) o.pos[k] = k3[k] + (COIN_REST_POS[k] - k3[k]) * s - A.cam[k] * 3.2 * dip - A.up[k] * 1.5 * dip;
    this.lerpRot(o, 1 - s);
    // Nach drei Wenden zeigt die Rückseite: halbe Drehung zurück, während sie verdeckt ist.
    this.rotateView(o, 0, 1, 0, -Math.PI * 3 * (1 - s));
    if (this.mark(3, T * 0.97, t)) this.kick(o, 0.06, -0.15);
    return false;
  }

  /** Daumen-Flip (auch der call): Scheitel über dem Daumen, gerade Zahl halber Drehungen, Fang in der Ruhe. */
  private flip(id: CoinTrick, t: number, o: PropOut): boolean {
    const call = id === 'call';
    if (t < FLIP_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.15, 0);
      o.pose = POSE.coin;
      this.offsetView(o, 0, -0.4 * Math.sin(Math.PI * (t / FLIP_WIND)), 0);
      return false;
    }
    if (this.mark(1, FLIP_WIND, t)) this.kick(o, -0.35, 0);
    const air = call ? CALL_AIR : FLIP_AIR;
    const s = (t - FLIP_WIND) / air;
    if (s < 1) {
      this.toss(o, s, call ? 4.5 : 5, 0.5);
      o.pose = s < 0.25 ? POSE.thumbsUp : POSE.coin;
      o.poseTau = 0.04;
      return false;
    }
    if (this.mark(2, FLIP_WIND + air, t)) {
      this.kick(o, 0.25, -0.6);
      this.spinKick(-0.8);
    }
    this.side = this.target;
    o.param[P.side] = this.side;
    if (call) {
      // Zeigen: Münze kippt kurz zur Kamera — Kopf oder Zahl liest sich.
      const c = t - FLIP_WIND - air;
      const show = bell(clamp(c / CALL_SHOW, 0, 1));
      this.offsetView(o, 0, 0.9 * show, 0.8 * show);
      this.rotateView(o, 1, 0, 0, 0.8 * show);
      o.hpitch = 0.12 * show;
      return t >= CALL_T;
    }
    return t >= FLIP_T;
  }

  /** Wurfbahn ab der Ruhe: Scheitel `peak`, halbe Drehungen um die Bild-Querachse, Seite am Hochkant-Punkt. */
  private toss(o: PropOut, s: number, peak: number, drift: number): void {
    const turns = this.halfTurns;
    this.offsetView(o, drift * Math.sin(Math.PI * s), peak * arc(s), 0.6 * Math.sin(Math.PI * s));
    this.rotateView(o, 1, 0, 0, -Math.PI * turns * s);
    // Zum ersten Mal hochkant zur Kamera (Normale ⟂ Blick, Ruhe ist um REST_TILT gekippt): nur die Kante
    // ist sichtbar — dort das Motiv wechseln, dann springt kein Bild.
    if (s >= (Math.PI / 2 - REST_TILT) / (Math.PI * turns)) this.side = this.target;
    o.param[P.side] = this.side;
  }

  /** Hoher Wurf, Fang als Klatsch auf dem Handrücken, kurz liegen lassen, zurück in die Ruhe. */
  private highFlip(t: number, o: PropOut): boolean {
    if (t < FLIP_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.22, 0);
      this.offsetView(o, 0, -0.6 * Math.sin(Math.PI * (t / FLIP_WIND)), 0);
      return false;
    }
    if (this.mark(1, FLIP_WIND, t)) this.kick(o, -0.6, 0);
    const s = (t - FLIP_WIND) / HIGH_AIR;
    if (s < 1) {
      // Wurf zur Kamera hin und über den Handrücken: Landepunkt = Mitte der Knöchel.
      this.toss(o, s, 9, 0.8);
      const e = smooth((s - 0.55) / 0.45);
      for (let k = 0; k < 3; k++) o.pos[k] += (SLAP_POS[k] - COIN_REST_POS[k]) * e;
      this.blendTo(o, KN_ROT, e);
      o.pose = s < 0.3 ? POSE.thumbsUp : POSE.coin;
      o.hpitch = 0.2 * e;
      return false;
    }
    const c = t - FLIP_WIND - HIGH_AIR;
    if (this.mark(2, FLIP_WIND + HIGH_AIR, t)) {
      this.kick(o, 0.45, -1.1);
      this.spinKick(-1.4);
    }
    this.side = this.target;
    o.param[P.side] = this.side;
    // Klatsch: liegt auf dem Handrücken, dann zurück.
    const back = smooth((c - HIGH_SLAP) / HIGH_BACK);
    const env = 1 - back;
    o.hpitch = 0.2 * env;
    this.lerpPos(o, SLAP_POS, COIN_REST_POS, back, 0.6 * arc(back));
    this.lerpRot(o, 1 - back);
    return t >= HIGH_T;
  }

  /** Zaubertrick wie die Karte: Wisch, Auflösen mit Poof, leere Hand, Wiedererscheinen mit Schwung. */
  private vanish(t: number, o: PropOut): boolean {
    if (t >= V_TOTAL) return true;
    const swipe1 = bell(t / (V_GONE + 0.1));
    const swipe2 = bell((t - V_BACK + 0.05) / (V_POP - V_BACK + 0.25));
    o.hroll = 0.4 * swipe1 - 0.35 * swipe2;
    o.hy = -0.02 * (swipe1 + swipe2);
    if (t < V_SWIPE) return false;
    if (t < V_GONE) {
      const u = (t - V_SWIPE) / (V_GONE - V_SWIPE);
      o.visible = 1 - smooth(u);
      o.pose = POSE.flat;
      o.poseTau = 0.05;
      if (this.mark(0, V_SWIPE + 0.05, t)) this.kick(o, -0.2, 0.4);
      this.poofAt(o, (t - V_SWIPE) / 0.45);
      return false;
    }
    if (t < V_POP) {
      o.visible = 0;
      o.pose = t < V_BACK ? POSE.open : POSE.flat;
      o.poseTau = 0.07;
      // Unsichtbar weich auf Startgröße/-drehung des Wiedererscheinens: die Zeitleiste bleibt stetig.
      const g = smooth((t - V_GONE) / (V_POP - V_GONE));
      o.scale = 1 - 0.95 * g;
      o.spin = -Math.PI * 2 * g;
      this.poofAt(o, (t - V_SWIPE) / 0.45);
      return false;
    }
    const u = (t - V_POP) / (V_TOTAL - V_POP);
    if (this.mark(1, V_POP, t)) this.kick(o, 0.3, -0.8);
    o.visible = smooth((t - V_POP) / 0.05);
    o.scale = Math.max(0.05, backOut(smooth(u * 1.6), 2.4));
    o.spin = -Math.PI * 2 * (1 - smooth(u * 1.3));
    this.poofAt(o, (t - V_POP) / 0.4);
    return false;
  }

  /** Surf: tanzt auf der Kante über der Faust, neigt sich mit der Rampe; Ende = Klatsch zurück. */
  private edgeSpin(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.25);
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - out);
    for (let k = 0; k < 3; k++) o.pos[k] = COIN_REST_POS[k] + (EDGE_POS[k] - COIN_REST_POS[k]) * e;
    this.blendRot(o, COIN_REST_ROT, EDGE_ROT, e);
    // Dreht auf der Kante (Eigenachse = Bild-oben), taumelt leicht, neigt sich mit der Rampe.
    o.spin = SPIN_RATE * t * e;
    this.rotateView(o, 0, 0, 1, (0.12 * Math.sin(t * 7) - 0.3 * this.surfLean) * e);
    if (this.mark(0, 0.25, t)) this.kick(o, 0.05, -0.1);
    if (this.surfOut >= 0 && this.mark(1, this.surfOut + 0.3, t)) this.kick(o, 0.2, -0.5);
    return this.surfOut >= 0 && t >= this.surfOut + 0.3;
  }

  private lerpPos(o: PropOut, a: M, b: M, s: number, lift: number): void {
    const A = VIEW_AXES;
    for (let k = 0; k < 3; k++) o.pos[k] = a[k] + (b[k] - a[k]) * s + A.up[k] * lift + A.cam[k] * lift * 0.5;
  }

  /** Lage zwischen Ruhe (0) und flach auf den Knöcheln (1). */
  private lerpRot(o: PropOut, s: number): void {
    this.blendRot(o, COIN_REST_ROT, KN_ROT, s);
  }

  /** Euler-Mischung (kleine Winkeldifferenzen zwischen nahen Lagen — reicht für Übergänge). */
  private blendRot(o: PropOut, a: M, b: M, s: number): void {
    for (let k = 0; k < 3; k++) {
      let d = b[k] - a[k];
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      o.rot[k] = a[k] + d * s;
    }
  }

  /** Aktuelle Lage (o.rot) Richtung b mischen. */
  private blendTo(o: PropOut, b: M, s: number): void {
    for (let k = 0; k < 3; k++) {
      let d = b[k] - o.rot[k];
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      o.rot[k] += d * s;
    }
  }

  private poofAt(o: PropOut, u: number): void {
    if (u < 0 || u >= 1) return;
    o.poof = u;
    o.poofPos[0] = o.pos[0];
    o.poofPos[1] = o.pos[1];
    o.poofPos[2] = o.pos[2];
  }
}
