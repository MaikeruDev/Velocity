/**
 * Sim-Sektion "stick" (Plan 011 §1.2): Strafen mit dem Kamera-Stick, also mit
 * begrenzter Drehrate. `npm run sim -- --section stick`.
 *
 * Entscheidungskriterium (Plan): Default-Grundrate = kleinste Rate, bei der
 * StrafeBot sync 1 nach 20 Hops ≥ 90 % des Tempos ohne Ratenlimit erreicht
 * UND die Zeit bis 500 u/s ≤ 1.15× ist. Boost nur, wenn er bei gleicher
 * Feinzielbarkeit (Rate bei 30 % Auslenkung ≤ 25 °/s) mit kleinerer Grundrate
 * dasselbe schafft.
 */
import { Vector3 } from 'three';
import { DEFAULT_LOOK_CURVE, type LookCurveParams } from '../../src/engine/pad/stickCurve';
import type { MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { runRoute, StrafeBot, type Bot } from '../../src/player/bots';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import { readLevelFile } from './levels';
import { flatWorld } from './scenarios';
import { StickHand } from './StickHand';

const HOPS = 20;
const SEEDS = 5;
const RATES = [90, 120, 150, 180, 240, 300, 360, 450, 540, 630, 720, 900, 1080, Infinity];
const CURVES = [1, 1.6, 2.2, 2.4, 2.6, 3];
const BOOSTS = [0, 0.5, 1];
const NOISES = [0, 0.03, 0.06];
/** Raster für die Suche nach der kleinsten Rate (°/s). */
const GRID = Array.from({ length: 36 }, (_, i) => 180 + i * 30);
const SHARE_MIN = 0.9;
const T500_MAX = 1.15;
const FINE_AIM_MAX = 25;

interface Run {
  readonly landSpeeds: number[];
  /** Erste Zeit mit |v_h| ≥ 500 u/s (s), null = nie. */
  readonly t500: number | null;
}

function hopRun(cfg: MovementConfig, bot: Bot): Run {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -cfg.runSpeed);
  const landSpeeds: number[] = [];
  let t500: number | null = null;
  const maxTicks = Math.round(HOPS * 1.5 * cfg.tickRate);
  for (let t = 1; t <= maxTicks && landSpeeds.length < HOPS; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') landSpeeds.push(e.speed);
    if (t500 === null && pm.state.speed >= 500) t500 = t / cfg.tickRate;
  }
  return { landSpeeds, t500 };
}

function mean(runs: readonly Run[]): Run {
  const n = runs.length;
  const landSpeeds: number[] = [];
  for (let i = 0; i < HOPS; i++) landSpeeds.push(runs.reduce((s, r) => s + (r.landSpeeds[i] ?? Number.NaN), 0) / n);
  // Nie erreicht = Unendlich: das Mittel fällt dann sichtbar durch.
  const t500 = runs.reduce((s, r) => s + (r.t500 ?? Infinity), 0) / n;
  return { landSpeeds, t500: Number.isFinite(t500) ? t500 : null };
}

function stickRun(cfg: MovementConfig, curve: LookCurveParams, noise: number): Run {
  const seeds = noise > 0 ? SEEDS : 1;
  const runs: Run[] = [];
  for (let s = 1; s <= seeds; s++) runs.push(hopRun(cfg, new StickHand(cfg, { curve, noise, seed: s * 7919 })));
  return mean(runs);
}

function curveOf(rate: number, exponent: number, boost: number): LookCurveParams {
  return { ...DEFAULT_LOOK_CURVE, maxYawRate: rate, exponent, boost };
}

const f0 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(0));
const f2 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2));
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : '–');
const rateLabel = (r: number): string => (Number.isFinite(r) ? String(r) : '∞');

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

interface Ref {
  readonly h20: number;
  readonly t500: number;
}

function passes(r: Run, ref: Ref): boolean {
  const h20 = r.landSpeeds[HOPS - 1] ?? Number.NaN;
  return h20 / ref.h20 >= SHARE_MIN && r.t500 !== null && r.t500 / ref.t500 <= T500_MAX;
}

let l1: CompiledLevel | null = null;

/** L1 mit RouteFollower sync 1: Gesamtzeit und Slalom (Knoten "Slalom" → "Rutsche"). */
function l1Run(cfg: MovementConfig, rate: number): { time: number | null; slalom: number | null } {
  const level = (l1 ??= compileLevel(readLevelFile('public/levels/level1.json')));
  const r = runRoute(level, cfg, { sync: 1, seed: 11, maxTurnRate: Number.isFinite(rate) ? rate : undefined });
  const route = level.def.route ?? [];
  const from = route.findIndex((n) => n.note === 'Slalom');
  const to = route.findIndex((n) => n.note === 'Rutsche');
  const tFrom = r.nodes.find((n) => n.index === from)?.time;
  const tTo = r.nodes.find((n) => n.index === to)?.time;
  return {
    time: r.status === 'finished' ? r.time : null,
    slalom: tFrom !== undefined && tTo !== undefined ? tTo - tFrom : null,
  };
}

export function stickSection(cfg: MovementConfig): string {
  const out: string[] = ['## Controller: Strafen mit begrenzter Drehrate (Plan 011 §1.2)\n'];
  out.push('Flacher Boden, Start mit runSpeed am Boden, Sprung gehalten, Kurs −Z (Hysterese 10°). Referenz = StrafeBot sync 1 ohne Ratenlimit.');
  out.push(`Kriterium: H20 ≥ ${SHARE_MIN * 100} % der Referenz und Zeit bis 500 u/s ≤ ${T500_MAX}×.\n`);

  // A) StrafeBot mit hartem Ratenlimit (= Stick linear, ohne Rauschen).
  const refRun = hopRun(cfg, new StrafeBot(cfg, { sync: 1, heading: 0 }));
  const ref: Ref = { h20: refRun.landSpeeds[HOPS - 1] ?? Number.NaN, t500: refRun.t500 ?? Number.NaN };
  out.push('### A — StrafeBot sync 1 mit `maxTurnRate`\n');
  out.push(table(
    ['°/s', 'H5', 'H10', 'H20', 'H20 / ∞', 't→500 (s)', 't500 / ∞', 'Kriterium', 'L1 (s)', 'L1-Slalom (s)'],
    RATES.map((rate) => {
      const r = hopRun(cfg, new StrafeBot(cfg, { sync: 1, heading: 0, maxTurnRate: Number.isFinite(rate) ? rate : undefined }));
      const h20 = r.landSpeeds[HOPS - 1] ?? Number.NaN;
      const l = l1Run(cfg, rate);
      return [
        rateLabel(rate), f0(r.landSpeeds[4]), f0(r.landSpeeds[9]), f0(h20), pct(h20 / ref.h20),
        f2(r.t500), r.t500 === null ? '–' : `${f2(r.t500 / ref.t500)}×`, passes(r, ref) ? 'ja' : 'nein', f2(l.time), f2(l.slalom),
      ];
    }),
  ));

  // B) StickHand: kleinste Grundrate je Kurve × Boost × Rauschen.
  out.push('\n### B — StickHand: kleinste Grundrate, die das Kriterium erfüllt\n');
  out.push(`Raster ${GRID[0]}…${GRID[GRID.length - 1]} °/s in 30er-Schritten. Boost: +50 % nach ${DEFAULT_LOOK_CURVE.boostDelay} s am Rand, Rampe ${DEFAULT_LOOK_CURVE.boostRamp} s. ` +
    `Rauschen: AR(1) auf der Auslenkung, ${SEEDS} Seeds. "@30 %" = Rate bei 30 % Auslenkung mit dieser Grundrate (feinzielbar ≤ ${FINE_AIM_MAX} °/s).\n`);
  const minRows: string[][] = [];
  const found = new Map<string, number | null>();
  for (const exponent of CURVES) {
    for (const boost of BOOSTS) {
      const cells: string[] = [exponent === 1 ? 'linear' : `^${exponent}`, boost > 0 ? `+${boost * 100} %` : 'aus'];
      for (const noise of NOISES) {
        let hit: number | null = null;
        for (const rate of GRID) {
          if (passes(stickRun(cfg, curveOf(rate, exponent, boost), noise), ref)) {
            hit = rate;
            break;
          }
        }
        found.set(`${exponent}/${boost}/${noise}`, hit);
        cells.push(hit === null ? `> ${GRID[GRID.length - 1]}` : `${hit} (@30 %: ${f0(hit * Math.pow(0.3, exponent))})`);
      }
      minRows.push(cells);
    }
  }
  out.push(table(['Kurve', 'Boost', ...NOISES.map((n) => `Rauschen ${n * 100} %`)], minRows));

  // C) Detail bei den Default-Werten.
  const d = DEFAULT_LOOK_CURVE;
  out.push(`\n### C — StickHand bei Grundrate ${d.maxYawRate} °/s (Default), H20 / ∞ und t500 / ∞\n`);
  const detail: string[][] = [];
  for (const exponent of CURVES) {
    for (const boost of BOOSTS) {
      const cells: string[] = [exponent === 1 ? 'linear' : `^${exponent}`, boost > 0 ? `+${boost * 100} %` : 'aus', f0(d.maxYawRate * Math.pow(0.3, exponent))];
      for (const noise of NOISES) {
        const r = stickRun(cfg, curveOf(d.maxYawRate, exponent, boost), noise);
        const h20 = r.landSpeeds[HOPS - 1] ?? Number.NaN;
        cells.push(`${f0(h20)} (${pct(h20 / ref.h20)}) · ${r.t500 === null ? '–' : `${f2(r.t500 / ref.t500)}×`}`);
      }
      detail.push(cells);
    }
  }
  out.push(table(['Kurve', 'Boost', '°/s @30 %', ...NOISES.map((n) => `Rauschen ${n * 100} %`)], detail));
  out.push(`\nReferenz ∞: H20 ${f0(ref.h20)} u/s, t→500 ${f2(ref.t500)} s.`);
  return out.join('\n');
}
