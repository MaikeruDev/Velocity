import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  BAND_HI_MAX,
  BAND_LO,
  FAST_TABLE,
  GOOD_GAIN_TABLE,
  StrafeJudge,
  VERDICT_TEXT,
  goodGainAt,
  tooFastRate,
  turnBandAt,
} from '../src/engine/strafeJudge';
import { VERDICTS } from '../src/engine/trainingTypes';
import type { Verdict } from '../src/engine/trainingTypes';
import { VELOCITY_DEFAULT, withMovement } from '../src/player/MovementConfig';
import type { MovementConfig } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { NO_INPUT } from '../src/player/types';
import type { MutablePlayerInput } from '../src/player/types';
import { HAND_MODELS } from '../src/player/bots/BeginnerHand';
import { compileLevel } from '../src/world/level/compileLevel';
import { hasGlyph } from '../src/ui/glyphs';
import { box, flatLevel, makeLevel } from '../tools/sim/levels';
import { diagnose, strafeBotGood } from '../tools/levels/training/probes';

/**
 * StrafeJudge (Plan 007, TC1): Urteil pro Luftabschnitt. Die Schwellen-Tabellen stammen aus
 * tools/levels/training/turnwindow.ts gegen die finale Physik; hier: Form der Tabellen, jedes Fehlerbild
 * auf einem echten Hop, und die Treffsicherheit der Diagnose mit den Fehlerhänden (kleinere Stichprobe als
 * levels:check).
 */

const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const DEG = Math.PI / 180;
const FLAT = compileLevel(flatLevel(60000));

type Variant = 'match' | 'against' | 'noMouse' | 'wOnly' | 'nothing' | 'wHeld';

/**
 * Ein Hop ab dem Boden mit Tempo v0 Richtung −Z; A + Maus links (Rate °/s) ab `delay` s Luftzeit. `wrapAt` = ab
 * diesem Tick liegt cmd.yaw um 64π verschoben (wie InputState nach 32 Netto-Umdrehungen; die Physik sieht
 * denselben Blick). `level`/`z0` = eigene Welt und Start-z (Wand-Proben). Ohne Urteil: verdict null, `wall` sagt,
 * ob der Abschnitt eine Wand gestreift hat.
 */
function judgeHop(
  v0: number,
  rateDeg: number,
  variant: Variant,
  delay = 0,
  cfg: MovementConfig = CFG,
  wrapAt = -1,
  level = FLAT,
  z0 = 30000,
): { verdict: Verdict | null; gain: number; turnRate: number; wall: boolean } {
  const pm = new PlayerMovement(level.world, cfg);
  pm.state.vel.set(0, 0, -v0);
  pm.teleport(new Vector3(0, 0.01, z0), { keepVelocity: true });
  const judge = new StrafeJudge(cfg);
  const inp: MutablePlayerInput = { ...NO_INPUT };
  const prev = PlayerMovement.createSnapshot();
  const cur = PlayerMovement.createSnapshot();
  let yaw = 0;
  let air = 0;
  for (let t = 0; t < cfg.tickRate * 3; t++) {
    const inAir = t > 0 && !pm.state.onGround;
    const acting = inAir && air >= delay;
    if (inAir) air += DT;
    if (acting && variant !== 'noMouse' && variant !== 'nothing') yaw += rateDeg * DEG * DT;
    inp.yaw = wrapAt >= 0 && t >= wrapAt ? yaw + 64 * Math.PI : yaw;
    inp.jumpHeld = t === 0;
    inp.jumpPressed = t === 0;
    inp.forward = variant === 'wOnly' || variant === 'wHeld' || t === 0 ? 1 : 0;
    inp.side = !acting ? 0 : variant === 'match' || variant === 'noMouse' || variant === 'wHeld' ? -1 : variant === 'against' ? 1 : 0;
    pm.copySnapshot(prev);
    pm.tick(inp);
    pm.copySnapshot(cur);
    if (judge.tick(DT, prev, cur, inp)) return { verdict: judge.last.verdict, gain: judge.last.gain, turnRate: judge.last.turnRate, wall: judge.last.wall };
    if (t > 0 && cur.onGround && !prev.onGround) return { verdict: null, gain: judge.last.gain, turnRate: judge.last.turnRate, wall: judge.last.wall };
  }
  return { verdict: null, gain: Number.NaN, turnRate: Number.NaN, wall: false };
}

/** Flacher Boden mit einer Wand quer zur Fahrt bei z ∈ [−64, 0] (Oberkante 400). */
const WALLED = compileLevel(makeLevel([box([-4096, -64, -4096], [4096, 0, 4096]), box([-4096, 0, -64], [4096, 400, 0], 'wand')]));

describe('StrafeJudge — Schwellen', () => {
  it('Tabellen sind nach Tempo sortiert, Mindestgewinn und Zu-schnell-Grenze fallen mit dem Tempo', () => {
    for (const t of [GOOD_GAIN_TABLE, FAST_TABLE]) {
      for (let i = 1; i < t.length; i++) {
        expect(t[i][0]).toBeGreaterThan(t[i - 1][0]);
        expect(t[i][1]).toBeLessThanOrEqual(t[i - 1][1]);
      }
    }
    expect(goodGainAt(100)).toBe(GOOD_GAIN_TABLE[0][1]);
    expect(goodGainAt(5000)).toBe(GOOD_GAIN_TABLE[GOOD_GAIN_TABLE.length - 1][1]);
    expect(goodGainAt(360)).toBeLessThan(goodGainAt(320));
    expect(goodGainAt(360)).toBeGreaterThan(goodGainAt(400));
    expect(tooFastRate(600)).toBeCloseTo(570, 5);
  });

  it('Zielband: 60 °/s bis 0.8 × Zu-schnell-Grenze, gekappt bei 540', () => {
    const b = { lo: 0, hi: 0 };
    expect(BAND_LO).toBe(60);
    expect(BAND_HI_MAX).toBe(540);
    expect(turnBandAt(320, b)).toEqual({ lo: BAND_LO, hi: BAND_HI_MAX });
    expect(turnBandAt(600, b).hi).toBeCloseTo(0.8 * tooFastRate(600), 5);
    expect(turnBandAt(1000, b).hi).toBeCloseTo(0.8 * tooFastRate(1000), 5);
    expect(turnBandAt(1000, b).hi).toBeGreaterThan(BAND_LO);
  });

  it('Zielband und Urteil widersprechen sich nicht: schnell und gut gezogen (500 °/s bei 320/400 u/s) liegt im Band', () => {
    // Vorher Kappe 360: der Balken zeigte Gold ("daneben"), der Judge "GUT" mit +150 u/s (Review rv-tc3).
    const b = { lo: 0, hi: 0 };
    for (const v0 of [320, 400]) {
      expect(judgeHop(v0, 500, 'match').verdict).toBe('good');
      expect(500).toBeLessThanOrEqual(turnBandAt(v0, b).hi);
    }
    // Überdreht bleibt außerhalb: 600 u/s mit 540 °/s (turnwindow: −4.6 u/s bei 720 °/s, Band bis 456).
    expect(540).toBeGreaterThan(turnBandAt(600, b).hi);
  });

  it('jedes Urteil hat Texte im HUD-Font (Kurztext, Coach 2 × ≤ 40)', () => {
    for (const v of VERDICTS) {
      const t = VERDICT_TEXT[v];
      for (const ch of t.short + t.long) if (ch !== '\n') expect(hasGlyph(ch), `${v}: "${ch}"`).toBe(true);
      const lines = t.long === '' ? [] : t.long.split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('StrafeJudge — ein echter Hop je Fehlerbild', () => {
  it('A + Maus in dieselbe Richtung: gut (60 °/s bei 320, 150 °/s bei 600)', () => {
    expect(judgeHop(320, 60, 'match').verdict).toBe('good');
    expect(judgeHop(600, 150, 'match').verdict).toBe('good');
  });

  it('Fehlerbilder: gegen die Maus, ohne Maus, nur W, gar nichts, zu spät, zu langsam, zu schnell', () => {
    // Zu langsam: 12 °/s gibt +8.5 u/s (Schwelle 10.0); ab ~16 °/s ohne Verzug ist der Hop schon gut.
    expect(judgeHop(320, 90, 'against').verdict).toBe('against');
    expect(judgeHop(320, 90, 'noMouse').verdict).toBe('noMouse');
    expect(judgeHop(320, 90, 'wOnly').verdict).toBe('wOnly');
    expect(judgeHop(320, 90, 'nothing').verdict).toBe('noSide');
    expect(judgeHop(320, 25, 'match', 0.45).verdict).toBe('late');
    expect(judgeHop(320, 12, 'match').verdict).toBe('tooSlow');
    expect(judgeHop(800, 900, 'match').verdict).toBe('tooFast');
  });

  it('Technik vor Gewinn: nur W bzw. Taste gegen die Maus mit schneller Maus gewinnt Tempo — und ist trotzdem kein GUT', () => {
    // Der Blick (nur W) bzw. die Wunschrichtung (gegen) streicht durchs Gewinnfenster. Vorher hieß derselbe W-Hop je
    // nach Mausrate "W LOS" oder "GUT", und nur W + schnelle Maus bestand T4/T5 (Review rv-tc3).
    const w = judgeHop(320, 360, 'wOnly');
    expect(w.gain).toBeGreaterThan(3 * goodGainAt(320));
    expect(w.verdict).toBe('wOnly');
    const against = judgeHop(320, 540, 'against');
    expect(against.gain).toBeGreaterThan(3 * goodGainAt(320));
    expect(against.verdict).toBe('against');
    // Zu spät, aber mit genug Gewinn bleibt gut (Nachsicht wie bisher).
    expect(judgeHop(320, 90, 'match', 0.45).verdict).toBe('good');
  });

  it('Strafe-Assist aus: W zusätzlich zu A frisst den Gewinn → wHeld; mit Assist ist W egal', () => {
    const off = withMovement(CFG, { strafeAssist: false });
    // 40 °/s: mit Assist +19 u/s, ohne Assist und mit W 0 (gemessen).
    expect(judgeHop(320, 40, 'wHeld', 0, off).verdict).toBe('wHeld');
    expect(judgeHop(320, 40, 'wHeld').verdict).toBe('good');
  });

  it('Gewinn bis zum letzten Luft-Tick: flache Landung ändert ihn nicht', () => {
    const r = judgeHop(320, 90, 'match');
    expect(r.gain).toBeGreaterThan(goodGainAt(320));
    expect(r.gain).toBeLessThan(60);
  });

  it('Wand in der Luft: kein Urteil (auch nicht KNAPP) — frontal, schon im Absprung-Tick, Schleifen an der Bande', () => {
    // Frontal: 400 u/s auf die Wand zu, A + Maus 90 °/s — der Anprall kostet Tempo, das mit der Technik nichts zu tun hat.
    const front = judgeHop(400, 90, 'match', 0, CFG, -1, WALLED, 150);
    expect(front.wall).toBe(true);
    expect(front.verdict).toBeNull();
    // Wand 1 u vor der Hull: der Absprung-Tick selbst clippt (T4: 400 → 296 u/s im Sprung-Tick war 'weak').
    const takeoff = judgeHop(400, 90, 'match', 0, CFG, -1, WALLED, 17);
    expect(takeoff.wall).toBe(true);
    expect(takeoff.verdict).toBeNull();
    // Schleifen: Bande rechts (x ≥ 16), D gedrückt (Wunschrichtung in die Bande), Blick geradeaus — kein Positionsfehler,
    // aber v_h ändert sich quer zur Wunschrichtung.
    const side = compileLevel(makeLevel([box([-4096, -64, -4096], [4096, 0, 4096]), box([16, 0, -4096], [80, 400, 4096], 'bande')]));
    const pm = new PlayerMovement(side.world, CFG);
    pm.state.vel.set(0, 0, -400);
    pm.teleport(new Vector3(-0.5, 0.01, 3000), { keepVelocity: true });
    const judge = new StrafeJudge(CFG);
    const inp: MutablePlayerInput = { ...NO_INPUT };
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    let judged: boolean | null = null;
    for (let t = 0; t < CFG.tickRate * 2 && judged === null; t++) {
      inp.jumpHeld = t === 0;
      inp.jumpPressed = t === 0;
      inp.side = t > 0 && !pm.state.onGround ? 1 : 0;
      pm.copySnapshot(prev);
      pm.tick(inp);
      pm.copySnapshot(cur);
      const r = judge.tick(DT, prev, cur, inp);
      if (r || (t > 0 && cur.onGround)) judged = r;
    }
    expect(judge.last.wall).toBe(true);
    expect(judged).toBe(false);
  });

  it('Blick-Wicklung: ein Sprung um 64π in cmd.yaw (InputState nach 32 Umdrehungen) ändert das Urteil nicht', () => {
    const plain = judgeHop(320, 90, 'match');
    const wrapped = judgeHop(320, 90, 'match', 0, CFG, 30);
    expect(wrapped.verdict).toBe(plain.verdict);
    expect(wrapped.gain).toBeCloseTo(plain.gain, 6);
    expect(wrapped.turnRate).toBeCloseTo(plain.turnRate, 6);
  });

  it('nicht bewertet: Absprung unter 200 u/s, kurze Luft, Surf-Kontakt', () => {
    expect(judgeHop(150, 90, 'match').verdict).toBeNull();
    const judge = new StrafeJudge(CFG);
    const a = PlayerMovement.createSnapshot();
    const b = PlayerMovement.createSnapshot();
    // 0.2 s Luft mit 400 u/s → zu kurz.
    a.onGround = true;
    a.speed = 400;
    b.onGround = false;
    b.speed = 400;
    for (let i = 0; i < 0.2 * CFG.tickRate; i++) expect(judge.tick(DT, i === 0 ? a : b, b, NO_INPUT)).toBe(false);
    expect(judge.tick(DT, b, a, NO_INPUT)).toBe(false);
    // 0.6 s Luft, aber einmal an einer Surf-Flanke → nicht bewertet.
    for (let i = 0; i < 0.6 * CFG.tickRate; i++) {
      b.surfing = i === 20;
      judge.tick(DT, i === 0 ? a : b, b, NO_INPUT);
    }
    b.surfing = false;
    expect(judge.tick(DT, b, a, NO_INPUT)).toBe(false);
  });
});

describe('StrafeJudge — Diagnose-Treffsicherheit (Fehlerhände, 6 Seeds × 30 s)', () => {
  // strict = falsche Tasten/Maus: auch mit 'good' im Nenner ≥ 90 % (ein GUT lobte dort die falsche Technik).
  const cases: Array<[string, (typeof HAND_MODELS)[keyof typeof HAND_MODELS], Verdict, boolean]> = [
    ['nur W', HAND_MODELS.nurW, 'wOnly', true],
    ['nur W, schnelle Maus', HAND_MODELS.nurWSchnell, 'wOnly', true],
    ['gegen die Maus', HAND_MODELS.gegen, 'against', true],
    ['gegen die schnelle Maus', HAND_MODELS.gegenSchnell, 'against', true],
    ['ohne Maus', HAND_MODELS.keineMaus, 'noMouse', true],
    ['zu spät', HAND_MODELS.spaet, 'late', false],
    ['zu langsam', HAND_MODELS.langsam, 'tooSlow', false],
  ];
  for (const [name, model, hit, strict] of cases) {
    it(`${name}: ≥ 90 % der Fehl-Hops als ${hit}${strict ? ', auch mit good im Nenner' : ''}`, () => {
      const r = diagnose(FLAT, CFG, model, [hit], 6, 30);
      expect(r.bad).toBeGreaterThan(40);
      expect(r.accuracy).toBeGreaterThanOrEqual(0.9);
      if (strict) expect(r.accuracyAll).toBeGreaterThanOrEqual(0.9);
    });
  }

  it('StrafeBots 1° und 2° bei 300–600 u/s: ≥ 90 % gut', () => {
    for (const noise of [1, 2]) {
      const r = strafeBotGood(CFG, noise, 8, 12);
      expect(r.judged).toBeGreaterThan(20);
      expect(r.good / r.judged).toBeGreaterThanOrEqual(0.9);
    }
  });
});
