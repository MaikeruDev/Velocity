import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Vector3 } from 'three';
import { CS2_CLASSIC, VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import type { MovementConfig } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { lerpSnapshot } from '../src/player/interpolate';
import type { MovementEvent } from '../src/player/types';
import { compileLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import { clipBoxToBrush } from '../src/world/collision/BrushWorld';
import { makeTraceResult } from '../src/world/collision/types';
import { VERDICTS } from '../src/engine/trainingTypes';
import { InputState } from '../src/engine/InputState';
import { DEFAULT_KEYBINDS } from '../src/engine/settingsTypes';
import { VM_PARAM, VM_RIG, VM_STRING_POINTS, createViewModelFrame } from '../src/render/types';
import { box, flatLevel, makeLevel } from '../tools/sim/levels';
import { makeInput } from '../tools/sim/harness';

/**
 * Plan 007, Phase 0: neue Verträge sind da — Level ohne Lektion kompilieren wie vorher, Tore liegen
 * nicht in der Welt. Seit Phase 1 liest die Physik die Arcade-Felder (Cap 40, Rutschen).
 */

describe('MovementConfig (Plan 007)', () => {
  it('CS2: alle Arcade-Hauptschalter aus', () => {
    expect(CS2_CLASSIC.landGraceTime).toBe(0);
    expect(CS2_CLASSIC.slopeLandGain).toBe(0);
    expect(CS2_CLASSIC.surfSeamFix).toBe(false);
    expect(CS2_CLASSIC.ledgeStep).toBe(0);
    expect(CS2_CLASSIC.ledgeMemory).toBe(0);
    expect(CS2_CLASSIC.slideMinSpeed).toBe(0);
    expect(CS2_CLASSIC.airControl).toBe(0);
  });

  it('VELOCITY: Werte aus dem Plan, Anfänger-Cap 40 seit Phase 1', () => {
    const want: Partial<MovementConfig> = {
      landGraceTime: 0.0625,
      slopeLandGain: 1,
      surfSeamFix: true,
      ledgeStep: 5,
      ledgeMemory: 0.2,
      slideMinSpeed: 280,
      slideExitSpeed: 160,
      slideFriction: 0.3,
      slideDecel: 80,
      slideBoost: 50,
      slideBoostCap: 380,
      slideBoostMinGround: 0.25,
      slideBoostCooldown: 2,
      slideSteerRate: 1.4,
      slideSlopeGravity: 1,
      slideEyeTime: 0.06,
      airControl: 1.6,
      airControlHigh: 0.8,
      airControlFadeFrom: 350,
      airControlFadeTo: 700,
      airControlSurfGrace: 0.5,
      airSpeedCapLow: 40,
    };
    expect(VELOCITY_DEFAULT).toMatchObject(want);
  });
});

describe('Spieler-Snapshot und Events (Plan 007)', () => {
  const FLAT = compileLevel(flatLevel(4096));

  it('sliding: Sprint + C rutscht (Phase 1), wird kopiert und von der Interpolation diskret übernommen', () => {
    const pm = new PlayerMovement(FLAT.world, VELOCITY_DEFAULT);
    pm.teleport(new Vector3(0, 0, 0));
    const a = PlayerMovement.createSnapshot();
    const b = PlayerMovement.createSnapshot();
    expect(a.sliding).toBe(false);
    for (let i = 0; i < 200; i++) pm.tick(makeInput({ forward: 1, sprint: true, crouch: i > 100 }));
    pm.copySnapshot(a);
    expect(a.sliding).toBe(true);
    // Diskret: immer der neuere Snapshot, in beide Richtungen.
    const out = PlayerMovement.createSnapshot();
    b.sliding = false;
    lerpSnapshot(a, b, 0.25, out);
    expect(out.sliding).toBe(false);
    lerpSnapshot(b, a, 0.25, out);
    expect(out.sliding).toBe(true);
  });

  it("'jump'.clean = perfect (ohne Lande-Gnade), Absprung aus dem Stand nicht, Auto-Hop im Landetick schon", () => {
    const pm = new PlayerMovement(FLAT.world, VELOCITY_DEFAULT);
    pm.teleport(new Vector3(0, 0, 0));
    const jumps: Extract<MovementEvent, { type: 'jump' }>[] = [];
    const take = (ev: readonly MovementEvent[]): void => {
      for (const e of ev) if (e.type === 'jump') jumps.push({ ...e });
    };
    for (let i = 0; i < 20; i++) take(pm.tick(makeInput()));
    take(pm.tick(makeInput({ jumpPressed: true, jumpHeld: true })));
    for (let i = 0; i < 400; i++) take(pm.tick(makeInput({ jumpHeld: true })));
    expect(jumps.length).toBeGreaterThanOrEqual(3);
    expect(jumps[0].perfect).toBe(false);
    expect(jumps.some((j) => j.perfect)).toBe(true);
    for (const j of jumps) expect(j.clean).toBe(j.perfect);
  });
});

describe('Level-Verträge (Plan 007)', () => {
  it('echte Level: keine Tore, keine Zonen, Welt = kollidierende Brushes', () => {
    const dir = 'public/levels';
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const c = compileLevel(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as LevelFile);
      expect(c.gates, f).toEqual([]);
      expect(c.zones.size, f).toBe(0);
      expect(c.world.brushCount, f).toBe(c.brushes.filter((b) => b.collide).length);
    }
  });

  const lesson: LevelFile = {
    ...makeLevel([box([-1024, -64, -1024], [1024, 0, 1024], 'boden')], { id: 'lektion' }),
    training: {
      lesson: 1,
      short: 'T1',
      group: 'basics',
      zones: [{ id: 'ziel', min: [-64, 0, -900], max: [64, 72, -800] }],
      gates: [
        { id: 'tor1', min: [-256, 0, -310], max: [256, 200, -290], tint: '#ff4fd8' },
        { id: 'tor2', min: [-256, 0, -610], max: [256, 200, -590] },
      ],
      stages: [{ id: 's1', title: 'LOS', text: 'Lauf zum Ziel', task: { kind: 'reach', zone: 'ziel' }, opens: ['tor1'] }],
    },
  };

  it('Lektion: Tore kompiliert, aber nicht in der Welt; Zonen nach id', () => {
    const c = compileLevel(lesson);
    expect(c.gates.map((g) => g.id)).toEqual(['tor1', 'tor2']);
    expect(c.gates[0].brush.index).toBe(c.brushes.length);
    expect(c.gates[1].brush.index).toBe(c.brushes.length + 1);
    expect(c.gates[0].tint).toBe('#ff4fd8');
    expect(c.gates[1].tint).toBeNull();
    expect(c.gates[0].bounds.min.toArray()).toEqual([-256, 0, -310]);
    expect(c.world.brushCount).toBe(1);
    expect([...c.zones.keys()]).toEqual(['ziel']);
    expect(c.zones.get('ziel')?.max.toArray()).toEqual([64, 72, -800]);

    // Die Welt lässt durch; die GatedWorld (Phase 2) traced geschlossene Tore mit clipBoxToBrush.
    const mins = new Vector3(-16, 0, -16);
    const maxs = new Vector3(16, 72, 16);
    const start = new Vector3(0, 1, 0);
    const end = new Vector3(0, 1, -1000);
    expect(c.world.traceBox(start, end, mins, maxs).fraction).toBe(1);
    const tr = makeTraceResult();
    clipBoxToBrush(c.gates[0].brush, start, end, mins, maxs, tr);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.brushIndex).toBe(c.gates[0].brush.index);
    expect(tr.normal.z).toBeCloseTo(1, 6);
    expect(start.z + (end.z - start.z) * tr.fraction).toBeCloseTo(-290 + 16, 0);
  });

  it('doppelte Tor- oder Zonen-ids sind ein Fehler', () => {
    const t = lesson.training;
    if (!t) throw new Error('Lektion ohne training');
    const gates = t.gates ?? [];
    expect(() => compileLevel({ ...lesson, training: { ...t, gates: [...gates, { id: 'tor1', min: [0, 0, 0], max: [1, 1, 1] }] } })).toThrow(/Tor "tor1"/);
    const zones = t.zones ?? [];
    expect(() => compileLevel({ ...lesson, training: { ...t, zones: [...zones, ...zones] } })).toThrow(/Zone "ziel"/);
  });
});

describe('Training, Eingabe, Viewmodel (Plan 007)', () => {
  it('VERDICTS: die zehn Urteile, eindeutig', () => {
    expect([...VERDICTS].sort()).toEqual(['against', 'good', 'late', 'noMouse', 'noSide', 'tooFast', 'tooSlow', 'wHeld', 'wOnly', 'weak']);
  });

  it("Vorführungs-Taste: ein Druck = Aktion 'demo', kein gehaltener Knopf; ohne Belegung keine Spieltaste", () => {
    const s = new InputState(DEFAULT_KEYBINDS);
    expect(s.isGameCode('KeyH')).toBe(true);
    expect(s.keyDown('KeyH', false)).toBe(true);
    expect(s.keyDown('KeyH', true)).toBe(true);
    expect(s.consumeActions()).toEqual(['demo']);
    const inp = s.tickInput(0, 1);
    expect([inp.forward, inp.side, inp.jumpHeld, inp.crouch]).toEqual([0, 0, false, false]);
    s.keyUp('KeyH');
    const none = new InputState({ ...DEFAULT_KEYBINDS, demo: [] });
    expect(none.isGameCode('KeyH')).toBe(false);
    expect(none.keyDown('KeyH', false)).toBe(false);
    expect(none.consumeActions()).toEqual([]);
    const mouse = new InputState({ ...DEFAULT_KEYBINDS, demo: ['Mouse5'] });
    mouse.keyDown('Mouse5', false);
    expect(mouse.consumeActions()).toEqual(['demo']);
  });

  it('ViewModelFrame: neue Felder neutral (kein zweiter Körper, keine Schnur, kein Skin-Effekt)', () => {
    const f = createViewModelFrame();
    expect(f.subPos).toHaveLength(3);
    expect(f.subRot).toHaveLength(3);
    expect(f.subVisible).toBe(0);
    expect(f.subSpin).toBe(0);
    expect(f.stringPts).toHaveLength(VM_STRING_POINTS * 3);
    expect(VM_STRING_POINTS).toBe(9);
    expect(f.stringCount).toBe(0);
    expect(f.propParam).toHaveLength(4);
    expect(f.skinFx).toBe(0);
    for (const ch of Object.values(VM_PARAM)) for (const i of Object.values(ch)) expect(i).toBeLessThan(f.propParam.length);
    expect(VM_RIG.fingers).toHaveLength(4);
    for (const fg of VM_RIG.fingers) expect(fg.len).toHaveLength(3);
  });
});
