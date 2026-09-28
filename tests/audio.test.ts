import { describe, expect, it } from 'vitest';
import { EnergyModel, layerForEnergy, targetEnergy } from '../src/audio/energy';
import { sfxBoost, stereoWidth, volumeGain } from '../src/audio/Mixer';
import { LandHold, blipIndex, blipPitchClass, shepardPartials, whooshProximity, windCurve } from '../src/audio/Sfx';
import { PENTATONIC } from '../src/audio/patterns';
import type { MusicDrive } from '../src/audio/types';

const d = (p: Partial<MusicDrive>): MusicDrive => ({
  speed: 0,
  onGround: false,
  hopChain: 0,
  strafeSync: 0,
  airTime: 0,
  surfing: false,
  active: true,
  ...p,
});

const db = (g: number): number => 20 * Math.log10(g);

describe('Energie-Formel B (Plan 003 A1)', () => {
  it('Wand-Hüpfen ohne Vortrieb bekommt keinen Chain-Bonus', () => {
    expect(targetEnergy(d({ speed: 24, hopChain: 11 }))).toBe(0);
    expect(layerForEnergy(targetEnergy(d({ speed: 24, hopChain: 11 })))).toBe(0);
  });

  it('Laufen = L1, Auto-Hop 320 mit Chain 10 = L2, Bhop 600 mit Chain und Sync = L4', () => {
    expect(layerForEnergy(targetEnergy(d({ speed: 250, onGround: true })))).toBe(1);
    expect(layerForEnergy(targetEnergy(d({ speed: 320, hopChain: 10 })))).toBe(2);
    expect(layerForEnergy(targetEnergy(d({ speed: 600, hopChain: 10, strafeSync: 0.8 })))).toBe(4);
  });

  it('Flow zählt: gleiche Speed, lange Chain → mehr Energie als ohne', () => {
    expect(targetEnergy(d({ speed: 450, hopChain: 10 }))).toBeGreaterThan(targetEnergy(d({ speed: 450, hopChain: 1 })) + 0.2);
  });

  it('Latch: ein kurzer Gipfel zwischen zwei Beats geht nicht verloren', () => {
    const m = new EnergyModel();
    m.settle(d({ speed: 400, hopChain: 3 }));
    m.takePeak();
    // 0.4 s Hoch, dann 0.6 s Einbruch — abgetastet wird erst danach.
    for (let i = 0; i < 50; i++) m.step(d({ speed: 800, hopChain: 12, strafeSync: 0.8 }), 1 / 128);
    const high = m.value;
    for (let i = 0; i < 77; i++) m.step(d({ speed: 150 }), 1 / 128);
    expect(m.value).toBeLessThan(high);
    expect(m.takePeak()).toBeCloseTo(high, 6);
    // Danach gilt wieder der aktuelle Wert.
    expect(m.takePeak()).toBeCloseTo(m.value, 6);
  });
});

describe('Chain-Blip als Shepard-Ton (A6)', () => {
  it('steigt endlos die Pentatonik hoch (keine Rückstufe)', () => {
    for (let c = 3; c <= 200; c++) expect(blipIndex(c)).toBe(blipIndex(c - 1) + 1);
    for (let s = 0; s < 20; s++) expect(PENTATONIC).toContain(blipPitchClass(s));
  });

  it('Gewichte summieren zu 1, spektraler Schwerpunkt springt über 100 Stufen nie um eine Oktave', () => {
    let prev = Number.NaN;
    let maxJump = 0;
    for (let s = 0; s < 100; s++) {
      const { hz, w } = shepardPartials(s);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      const c = hz.reduce((acc, f, i) => acc + w[i] * Math.log2(f), 0);
      // Glocke um 1.2 kHz: der Schwerpunkt bleibt in ihrer Nähe.
      expect(Math.abs(c - Math.log2(1200))).toBeLessThan(0.6);
      if (!Number.isNaN(prev)) maxJump = Math.max(maxJump, Math.abs(c - prev));
      prev = c;
    }
    expect(maxJump).toBeLessThan(0.5);
  });
});

describe('Wind und Whoosh (A2, A10)', () => {
  it('Wind setzt erst über Laufen ein und ist im Bhop-Bereich deutlich', () => {
    expect(windCurve(250)).toBe(0);
    expect(windCurve(600)).toBeGreaterThan(windCurve(450));
    expect(windCurve(600)).toBeGreaterThan(0.5);
  });

  it('Whoosh-Nähe: ohne Messwert oder weit weg nichts, ganz nah voll', () => {
    expect(whooshProximity(undefined)).toBe(0);
    expect(whooshProximity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(whooshProximity(200)).toBe(0);
    expect(whooshProximity(40)).toBe(1);
    expect(whooshProximity(64)).toBeGreaterThan(whooshProximity(120));
  });
});

describe('Mix-Kurven (A3, A7, A9)', () => {
  it('Lautstärke-Regler: 0 stumm, 1 voll, Default 0.8 ≈ −1.9 dB, monoton', () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(1)).toBe(1);
    expect(db(volumeGain(0.8))).toBeCloseTo(-1.94, 1);
    for (let x = 0.05; x <= 1; x += 0.05) expect(volumeGain(x)).toBeGreaterThan(volumeGain(x - 0.05));
  });

  it('Belohnungs-SFX wachsen mit der Energie mit (L4 ≈ +5 dB)', () => {
    expect(sfxBoost(0)).toBe(1);
    expect(db(sfxBoost(1))).toBeCloseTo(5.1, 1);
  });

  it('Breite ab L2 mindestens 1.15, Stand schmal', () => {
    expect(stereoWidth(0)).toBeLessThan(0.6);
    expect(stereoWidth(0.25)).toBeGreaterThanOrEqual(1.15);
    expect(stereoWidth(1)).toBeGreaterThan(stereoWidth(0.5));
  });
});

describe('Landung ohne Ankündigung (S2, fallen.md #54)', () => {
  it('wartet den Land-Frame ab und klingt, sobald ≥ 1 Tick Framezeit danach lief', () => {
    const h = new LandHold();
    h.hold(500);
    expect(h.frame(1 / 60)).toBe(-1); // Land-Frame selbst
    expect(h.frame(1 / 60)).toBe(500); // nächster Frame bei 60 Hz
    expect(h.pending).toBe(false);
  });

  it('bei 240 Hz erst nach zwei Frames (ein Tick = 7.8 ms)', () => {
    const h = new LandHold();
    h.hold(300);
    expect(h.frame(1 / 240)).toBe(-1);
    expect(h.frame(1 / 240)).toBe(-1);
    expect(h.frame(1 / 240)).toBe(300);
  });

  it('frisch gedrückter Sprung im Folgetick holt die Landung ab (dann nur leise)', () => {
    const h = new LandHold();
    h.hold(400);
    expect(h.frame(1 / 60)).toBe(-1);
    expect(h.take()).toBe(400);
    expect(h.frame(1 / 60)).toBe(-1);
  });
});
