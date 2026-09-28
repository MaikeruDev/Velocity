/**
 * Zusatzproben des Trainings (Plan 007, TC1-Abnahme):
 *  - diagnosisProbe: Treffsicherheit des StrafeJudge je eingebautem Fehlerbild (nur W, gegen die Maus,
 *    ohne Maus, zu spät, zu langsam) — Anteil der NICHT guten Hops mit "ihrem" Urteil, ≥ 90 % (Fehler).
 *    Zusätzlich mit 'good' im Nenner (wie oft der Judge das Fehlerbild überhaupt erkennt), ≥ 90 % (Warnung):
 *    ein 'good' für eine Fehlerhand ist Nachsicht, keine falsche Ursache — aber der Spieler hört kein Wort.
 *  - strafeBotProbe: StrafeBots mit 1–3° Zielfehler bei 300–600 u/s Absprungtempo ≥ 90 % 'good'.
 * Beide nutzen den echten Judge (src/engine/strafeJudge.ts) auf echter PlayerMovement.
 */
import { StrafeJudge } from '../../../src/engine/strafeJudge';
import { BeginnerHand, HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { HandModel } from '../../../src/player/bots/BeginnerHand';
import { StrafeBot } from '../../../src/player/bots';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import type { Verdict } from '../../../src/engine/trainingTypes';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../../src/world/level/compileLevel';
import { flatLevel } from '../../sim/levels';

export interface ProbeReport {
  readonly errors: string[];
  readonly warnings: string[];
  readonly info: string[];
}

/** Fehlerbild → Hand und die Urteile, die es richtig benennen (streng: nur das eigene). */
export const DIAGNOSES: readonly { readonly name: string; readonly model: HandModel; readonly hits: readonly Verdict[] }[] = [
  { name: 'nur W', model: HAND_MODELS.nurW, hits: ['wOnly'] },
  { name: 'gegen die Maus', model: HAND_MODELS.gegen, hits: ['against'] },
  { name: 'ohne Maus', model: HAND_MODELS.keineMaus, hits: ['noMouse'] },
  { name: 'zu spät (0.45 s)', model: HAND_MODELS.spaet, hits: ['late'] },
  { name: 'zu langsam (10 °/s)', model: HAND_MODELS.langsam, hits: ['tooSlow'] },
];

export const DIAG_MIN = 0.9;

export interface DiagnosisResult {
  readonly name: string;
  /** Treffer / nicht gute Hops. */
  readonly accuracy: number;
  /** Treffer / alle bewerteten Hops ('good' für eine Fehlerhand zählt als verfehlt). */
  readonly accuracyAll: number;
  readonly bad: number;
  readonly counts: Readonly<Record<string, number>>;
}

/** Fehlerhand im Zickzack zur Mitte, `seeds` × `seconds`, Urteile gezählt. */
export function diagnose(level: CompiledLevel, cfg: MovementConfig, model: HandModel, hits: readonly Verdict[], seeds = 20, seconds = 60): DiagnosisResult & { readonly name: string } {
  const counts: Record<string, number> = {};
  for (let seed = 1; seed <= seeds; seed++) {
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(level.spawnPos);
    const judge = new StrafeJudge(cfg);
    const hand = new BeginnerHand(cfg, { ...model, pattern: 'zigzag' }, { seed, goal: { x: level.spawnPos.x, z: level.spawnPos.z } });
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    pm.copySnapshot(cur);
    for (let i = 0; i < seconds * cfg.tickRate; i++) {
      const cmd = hand.next(pm.state);
      pm.copySnapshot(prev);
      pm.tick(cmd);
      pm.copySnapshot(cur);
      if (judge.tick(1 / cfg.tickRate, prev, cur, cmd)) counts[judge.last.verdict] = (counts[judge.last.verdict] ?? 0) + 1;
    }
  }
  const bad = Object.entries(counts)
    .filter(([k]) => k !== 'good')
    .reduce((a, [, v]) => a + v, 0);
  const hit = hits.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const all = bad + (counts.good ?? 0);
  return { name: model.name, accuracy: bad ? hit / bad : 0, accuracyAll: all ? hit / all : 0, bad, counts };
}

export function diagnosisProbe(level: CompiledLevel, cfg: MovementConfig, r: ProbeReport): DiagnosisResult[] {
  const out: DiagnosisResult[] = [];
  for (const d of DIAGNOSES) {
    const res = diagnose(level, cfg, d.model, d.hits);
    const counts = Object.entries(res.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const all = res.bad + (res.counts.good ?? 0);
    const line = `Diagnose ${d.name}: ${Math.round(res.accuracy * 100)} % der ${res.bad} Fehl-Hops als ${d.hits.join('/')}, mit 'good' im Nenner ${Math.round(res.accuracyAll * 100)} % von ${all} (${counts})`;
    if (res.accuracy < DIAG_MIN || res.bad < 20) r.errors.push(`${line} — Soll ≥ ${Math.round(DIAG_MIN * 100)} %`);
    else if (res.accuracyAll < DIAG_MIN) r.warnings.push(`${line} — mit 'good' unter ${Math.round(DIAG_MIN * 100)} %`);
    else r.info.push(line);
    out.push({ ...res, name: d.name });
  }
  return out;
}

export const BOT_GOOD_MIN = 0.9;

export interface StrafeBotResult {
  readonly noise: number;
  readonly good: number;
  readonly judged: number;
  readonly counts: Readonly<Record<string, number>>;
}

/** StrafeBot (Zielfehler `noise`°, Zickzack, frischer Druck je Landung) auf flachem Boden; Hops mit Absprung 300–600. */
export function strafeBotGood(cfg: MovementConfig, noise: number, seeds = 20, seconds = 12, lo = 300, hi = 600): StrafeBotResult {
  const level = compileLevel(flatLevel(60000));
  const counts: Record<string, number> = {};
  let good = 0;
  let judged = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(level.spawnPos);
    const judge = new StrafeJudge(cfg);
    const bot = new StrafeBot(cfg, { aimNoiseDeg: noise, seed, mode: 'zigzag' });
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    pm.copySnapshot(cur);
    for (let i = 0; i < seconds * cfg.tickRate; i++) {
      const cmd = bot.next(pm.state);
      pm.copySnapshot(prev);
      pm.tick(cmd);
      pm.copySnapshot(cur);
      if (!judge.tick(1 / cfg.tickRate, prev, cur, cmd)) continue;
      const rep = judge.last;
      if (rep.takeoffSpeed < lo || rep.takeoffSpeed > hi) continue;
      judged++;
      counts[rep.verdict] = (counts[rep.verdict] ?? 0) + 1;
      if (rep.verdict === 'good') good++;
    }
  }
  return { noise, good, judged, counts };
}

/**
 * 1°/2°: Fehler unter 90 %. 3°: nur Warnung — bei 450–600 u/s ist das Gewinnfenster (cap/|v| ≈ 3.2°)
 * so breit wie der Zielfehler; jeder 5. Hop liegt hinter 90° zur Flugrichtung und VERLIERT Tempo
 * (−7 … −68 u/s). Diese Hops "gut" zu nennen, hieße lügen (v2-Prototyp: 76 %).
 */
export function strafeBotProbe(cfg: MovementConfig, r: ProbeReport): StrafeBotResult[] {
  const out: StrafeBotResult[] = [];
  for (const noise of [1, 2, 3]) {
    const res = strafeBotGood(cfg, noise);
    const lowBand = strafeBotGood(cfg, noise, 20, 12, 300, 450);
    const share = res.judged ? res.good / res.judged : 0;
    const shareLow = lowBand.judged ? lowBand.good / lowBand.judged : 0;
    const bad = Object.entries(res.counts)
      .filter(([k]) => k !== 'good')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const line = `StrafeBot ${noise}° (Absprung 300–600 u/s): ${Math.round(share * 100)} % gut (${res.good}/${res.judged}${bad ? `; ${bad}` : ''}), davon 300–450: ${Math.round(shareLow * 100)} %`;
    if (share >= BOT_GOOD_MIN && res.judged >= 50) r.info.push(line);
    else if (noise >= 3) r.warnings.push(`${line} — Soll ≥ ${Math.round(BOT_GOOD_MIN * 100)} %; die Fehl-Hops verlieren Tempo (Zielfehler ≥ Gewinnfenster)`);
    else r.errors.push(`${line} — Soll ≥ ${Math.round(BOT_GOOD_MIN * 100)} %`);
    out.push(res);
  }
  return out;
}
