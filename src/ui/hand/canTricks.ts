import { POSE } from './poses';
import { arc, bell, clamp, smooth } from './anim';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';

/**
 * Energy-Drink-Dose (Plan 006): seitlich im Griff wie in den Referenzen, Deckel oben am Daumen.
 *
 * - Einmal pro Leben "crack": Lasche aufziehen (im ersten ruhigen Moment, spätestens nach
 *   12 s am Boden). Offen bleibt offen bis Respawn/Neustart.
 * - Schluck (nur offen): Dose zum Mund kippen — nur in Ruhe (Stand/Gehen) oder bei einer
 *   ruhigen Landung. Bei Tempo nie (Nutzerwunsch).
 * - Tempo-Tricks an Sprüngen: Flip → hoher Flip/Twirl → Doppel-Flip/Wurf hinter die Hand.
 */

export const CAN_TRICKS = ['none', 'tilt', 'crack', 'sip', 'flip', 'highFlip', 'twirl', 'doubleFlip', 'behindThrow'] as const;
export type CanTrick = Exclude<(typeof CAN_TRICKS)[number], 'none'>;

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const CAN_TIER_TRICKS: readonly (readonly CanTrick[])[] = [[], ['flip'], ['highFlip', 'twirl', 'flip'], ['doubleFlip', 'behindThrow', 'highFlip', 'twirl']];

/** Griff im Handgelenk-Raum: Mitte der Dose, Achse quer zur Hand (Deckel Richtung Daumen). */
export const CAN_HOLD_POS = [1.6, 7.2, -5.6] as const;
export const CAN_HOLD_ROT = [0, 0, Math.PI / 2] as const;

interface Toss {
  readonly windup: number;
  readonly air: number;
  /** Scheitel über dem Griff (Einheiten, im Bild nach oben). */
  readonly peak: number;
  /** Drehung um die Bild-Tiefenachse (rad, Vielfaches von 2π → Fang wieder im Griff). */
  readonly rot: number;
  /** Umdrehungen um die eigene Achse. */
  readonly twirl: number;
  /** Seitlicher Bogen (rechts) und Tiefe (zur Kamera, negativ = hinter die Hand). */
  readonly drift: number;
  readonly depth: number;
  readonly total: number;
  /** Wurfimpuls an die Hand (Bildhöhen/s nach oben). */
  readonly throwKick: number;
}

const TAU = Math.PI * 2;
const TOSS: { readonly [K in CanTrick]?: Toss } = {
  flip: { windup: 0.09, air: 0.44, peak: 4.5, rot: TAU, twirl: 0, drift: 0, depth: 0, total: 0.7, throwKick: 0.45 },
  highFlip: { windup: 0.11, air: 0.66, peak: 7.5, rot: TAU, twirl: 0, drift: -2, depth: 0, total: 0.95, throwKick: 0.65 },
  twirl: { windup: 0.07, air: 0.58, peak: 4, rot: 0, twirl: 3, drift: 0, depth: 0, total: 0.8, throwKick: 0.4 },
  doubleFlip: { windup: 0.11, air: 0.72, peak: 8.5, rot: 2 * TAU, twirl: 1, drift: 0, depth: 1.5, total: 1.0, throwKick: 0.75 },
  behindThrow: { windup: 0.13, air: 0.9, peak: 9.5, rot: 2 * TAU, twirl: 2, drift: 5, depth: -8, total: 1.2, throwKick: 0.85 },
};

const COOLDOWN = { tilt: 0.3, crack: 0.6, sip: 0.8, flip: 1.3, highFlip: 0.95, twirl: 0.95, doubleFlip: 0.7, behindThrow: 0.7 } as const;

const WIND_ANGLE = 0.25;
const DIP_KICK = 0.22;
const CATCH_KICK = 0.42;
const CATCH_SQUASH = 1.3;
const CATCH_SPIN_CARRY = 0.08;

const TILT_TIME = 1.0;
const CRACK_TIME = 1.15;
const CRACK_CALM_AFTER = 1.2;
const CRACK_LATEST = 12;
const SIP_TIME = 1.8;
const SIP_EVERY = 5.5;

export class CanTricks extends PropTricks<CanTrick> {
  /** Dose in diesem Leben geöffnet. */
  opened = false;
  /** Crack-Ereignis seit dem letzten Abholen (Zisch-Sound, Tools). */
  cracked = false;
  private groundTime = 0;
  private sipNext = 0;
  private pick2 = 0;
  private pick3 = 0;
  private idleCount = 0;

  protected resetRun(): void {
    this.opened = false;
    this.cracked = false;
    this.groundTime = 0;
    this.sipNext = 0;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.grip;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = CAN_HOLD_POS[0];
    o.pos[1] = CAN_HOLD_POS[1];
    o.pos[2] = CAN_HOLD_POS[2];
    o.rot[0] = CAN_HOLD_ROT[0];
    o.rot[1] = CAN_HOLD_ROT[1];
    o.rot[2] = CAN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.canTab = 0;
    o.canOpen = this.opened;
    o.poof = -1;
  }

  protected cooldownOf(id: CanTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    if (tier === 1) this.start('flip');
    else if (tier === 2) this.start(good ? (this.pick2++ % 2 === 0 ? 'highFlip' : 'twirl') : CAN_TIER_TRICKS[2][this.pick2++ % 3]);
    else this.start(good ? (this.pick3++ % 2 === 0 ? 'doubleFlip' : 'behindThrow') : CAN_TIER_TRICKS[3][this.pick3++ % 4]);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('behindThrow');
    else if (tier === 2) this.start('highFlip');
  }

  protected onIdle(): number {
    if (this.opened && this.now >= this.sipNext) {
      this.start('sip');
      this.sipNext = this.now + SIP_EVERY;
    } else this.start(this.idleCount++ % 2 === 0 ? 'tilt' : 'twirl');
    return 2.6 + 1.8 * this.rand();
  }

  protected override onLand(k: number, queued: boolean, speed: number): void {
    // Ruhige Landung (kein Bhop, langsam, nicht zu hart): ab und zu ein Schluck.
    if (!queued && speed < 250 && k < 0.9 && this.opened && this.now >= this.sipNext && this.rand() < 0.5) {
      this.start('sip');
      this.sipNext = this.now + SIP_EVERY;
    }
  }

  protected override onFinish(): void {
    if (this.opened) this.start('sip');
    else this.start('behindThrow');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (this.opened) return;
    const calm = inp.onGround && !inp.surfing && speed < 300;
    if (calm && this.groundTime >= CRACK_CALM_AFTER) this.start('crack');
    else if (inp.onGround && this.groundTime >= CRACK_LATEST) this.start('crack');
  }

  override update(dt: number, inp: PropFrameInput): void {
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    // Ruhezeit für den Crack: am Boden zählen, im Tempo-Flow nur langsam.
    if (inp.onGround && !inp.surfing) this.groundTime += inp.speed < 300 ? d : d * 0.1;
    super.update(dt, inp);
  }

  protected evaluate(id: CanTrick, t: number, _dt: number, _inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'tilt') {
      const u = t / TILT_TIME;
      if (u >= 1) return true;
      this.rotateView(o, 0, 0, 1, 0.32 * bell(u));
      this.offsetView(o, 0, 1.2 * bell(u), 0);
      return false;
    }
    if (id === 'crack') return this.crack(t, o);
    if (id === 'sip') return this.sip(t, o);
    const toss = TOSS[id];
    if (!toss) return true;
    const tr = t - toss.windup;
    const dir = toss.rot > 0 ? 1 : toss.rot < 0 ? -1 : 0;
    if (tr < 0) {
      // Ausholen: Dose kippt gegen die Drehrichtung, Hand taucht ab.
      if (this.mark(0, 0, t)) this.kick(o, DIP_KICK, 0);
      const u = smooth(t / toss.windup);
      this.rotateView(o, 0, 0, 1, -dir * WIND_ANGLE * u);
      this.offsetView(o, 0, -1.2 * Math.sin(Math.PI * (t / toss.windup)), 0);
      return false;
    }
    if (this.mark(1, toss.windup, t)) this.kick(o, -toss.throwKick, 0);
    if (tr < toss.air) {
      const s = tr / toss.air;
      this.offsetView(o, toss.drift * Math.sin(Math.PI * s), toss.peak * arc(s), toss.depth * Math.sin(Math.PI * s));
      const w0 = -dir * WIND_ANGLE;
      // Uhrzeigersinn im Bild (negativ um die Kamera-Achse) — wie ein Flip nach vorn.
      this.rotateView(o, 0, 0, 1, -(w0 + (toss.rot - w0) * s));
      o.spin = TAU * toss.twirl * s;
      // Hand öffnet sich nach dem Wurf und schließt kurz vor dem Fang (Vorfreude).
      o.pose = s < 0.75 ? POSE.open : POSE.grip;
      o.poseTau = s < 0.75 ? 0.06 : 0.035;
      return false;
    }
    if (this.mark(2, toss.windup + toss.air, t)) {
      this.kick(o, CATCH_KICK, -CATCH_SQUASH);
      this.spinKick(-(toss.rot / toss.air) * CATCH_SPIN_CARRY);
    }
    return t >= toss.total;
  }

  /** Lasche aufziehen: Hand hebt die Dose leicht und kippt den Deckel ins Bild, Daumen hakt ein. */
  private crack(t: number, o: PropOut): boolean {
    if (t >= CRACK_TIME) return true;
    const lift = smooth(t / 0.22) * (1 - smooth((t - 0.8) / 0.35));
    o.hy = -0.03 * lift;
    o.hpitch = 0.35 * lift;
    o.hroll = 0.12 * lift;
    o.pose = t > 0.12 && t < 0.85 ? POSE.crack : POSE.grip;
    o.poseTau = 0.05;
    if (t < 0.28) o.canTab = 0;
    else if (t < 0.46) o.canTab = smooth((t - 0.28) / 0.18);
    else o.canTab = 1 - 0.8 * smooth((t - 0.46) / 0.25);
    if (this.mark(0, 0.46, t) || (t >= 0.46 && !this.opened)) {
      // "Pssht": geöffnet (bleibt bis Respawn), kleiner Ruck.
      if (!this.opened) this.cracked = true;
      this.opened = true;
      this.kick(o, 0.25, -0.6);
    }
    o.canOpen = this.opened;
    return false;
  }

  /** Schluck: Dose zum Mund (links oben, zur Kamera), Deckel kippt zu uns, drei kleine Schlucke. */
  private sip(t: number, o: PropOut): boolean {
    if (t >= SIP_TIME) return true;
    const up = smooth(t / 0.45) * (1 - smooth((t - 1.25) / 0.5));
    o.hx = -0.15 * up;
    o.hy = -0.16 * up;
    o.hz = 6 * up;
    o.hpitch = 1.05 * up;
    o.hroll = 0.55 * up;
    o.hyaw = 0.25 * up;
    // Schlucke: kleines Nachkippen im Takt.
    const g = t > 0.5 && t < 1.2 ? Math.max(0, Math.sin(((t - 0.5) / 0.7) * Math.PI * 3)) : 0;
    o.hpitch += 0.12 * g * up;
    return false;
  }
}
