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
import { flatLevel } from '../tools/sim/levels';
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

/** Ein Hop ab dem Boden mit Tempo v0 Richtung −Z; A + Maus links (Rate °/s) ab `delay` s Luftzeit. */
function judgeHop(v0: number, rateDeg: number, variant: Variant, delay = 0, cfg: MovementConfig = CFG): { verdict: Verdict | null; gain: number } {
  const pm = new PlayerMovement(FLAT.world, cfg);
  pm.state.vel.set(0, 0, -v0);
  pm.teleport(new Vector3(0, 0.01, 30000), { keepVelocity: true });
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
    inp.yaw = yaw;
    inp.jumpHeld = t === 0;
    inp.jumpPressed = t === 0;
    inp.forward = variant === 'wOnly' || variant === 'wHeld' || t === 0 ? 1 : 0;
    inp.side = !acting ? 0 : variant === 'match' || variant === 'noMouse' || variant === 'wHeld' ? -1 : variant === 'against' ? 1 : 0;
    pm.copySnapshot(prev);
    pm.tick(inp);
    pm.copySnapshot(cur);
    if (judge.tick(DT, prev, cur, inp)) return { verdict: judge.last.verdict, gain: judge.last.gain };
  }
  return { verdict: null, gain: Number.NaN };
}

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

  it('Zielband: 40 °/s bis 0.8 × Zu-schnell-Grenze, gekappt bei 360', () => {
    const b = { lo: 0, hi: 0 };
    expect(turnBandAt(320, b)).toEqual({ lo: BAND_LO, hi: BAND_HI_MAX });
    expect(turnBandAt(1000, b).hi).toBeCloseTo(0.8 * tooFastRate(1000), 5);
    expect(turnBandAt(1000, b).hi).toBeGreaterThan(BAND_LO);
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
  const cases: Array<[string, (typeof HAND_MODELS)[keyof typeof HAND_MODELS], Verdict]> = [
    ['nur W', HAND_MODELS.nurW, 'wOnly'],
    ['gegen die Maus', HAND_MODELS.gegen, 'against'],
    ['ohne Maus', HAND_MODELS.keineMaus, 'noMouse'],
    ['zu spät', HAND_MODELS.spaet, 'late'],
    ['zu langsam', HAND_MODELS.langsam, 'tooSlow'],
  ];
  for (const [name, model, hit] of cases) {
    it(`${name}: ≥ 90 % der Fehl-Hops als ${hit}`, () => {
      const r = diagnose(FLAT, CFG, model, [hit], 6, 30);
      expect(r.bad).toBeGreaterThan(40);
      expect(r.accuracy).toBeGreaterThanOrEqual(0.9);
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
