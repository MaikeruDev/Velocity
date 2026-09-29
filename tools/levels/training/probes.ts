/**
 * Zusatzproben des Trainings (Plan 007, TC1-Abnahme):
 *  - diagnosisProbe: Treffsicherheit des StrafeJudge je eingebautem Fehlerbild (nur W, gegen die Maus,
 *    ohne Maus, zu spät, zu langsam; nur W und gegen auch mit schneller Maus 360 °/s) — Anteil der NICHT guten
 *    Hops mit "ihrem" Urteil, ≥ 90 % (Fehler). Zusätzlich mit 'good' im Nenner (wie oft der Judge das Fehlerbild
 *    überhaupt erkennt), ≥ 90 %: bei falschen TASTEN (strict: nur W, gegen, ohne Maus) ein Fehler — ein 'good' lobt
 *    dort die falsche Technik (vorher: nur W 360 °/s 26 % wOnly, 72 % GUT); bei Fehlern im GRAD (zu spät, zu
 *    langsam) eine Warnung — ein 'good' ist dort ein Hop, der die Schwelle trotz Verzug schafft (Nachsicht mit
 *    echtem Gewinn, Lead-Abnahme).
 *  - strafeBotProbe: StrafeBots mit 1–3° Zielfehler ≥ 90 % 'good' — 1°/2° bei 300–600 u/s (Fehler), 3° hart nur
 *    bei 300–450 u/s (Fehler); 3° bei 300–600 ist eine Warnung (fallen.md #134, Lead-Abnahme offen).
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

/**
 * Fehlerbild → Hand und die Urteile, die es richtig benennen (streng: nur das eigene). strict = falsche Tasten/Maus:
 * auch mit 'good' im Nenner ≥ 90 % (s. Kopf).
 */
export const DIAGNOSES: readonly { readonly name: string; readonly model: HandModel; readonly hits: readonly Verdict[]; readonly strict: boolean }[] = [
  { name: 'nur W', model: HAND_MODELS.nurW, hits: ['wOnly'], strict: true },
  { name: 'nur W, schnelle Maus (360 °/s)', model: HAND_MODELS.nurWSchnell, hits: ['wOnly'], strict: true },
  { name: 'gegen die Maus', model: HAND_MODELS.gegen, hits: ['against'], strict: true },
  { name: 'gegen die schnelle Maus (360 °/s)', model: HAND_MODELS.gegenSchnell, hits: ['against'], strict: true },
  { name: 'ohne Maus', model: HAND_MODELS.keineMaus, hits: ['noMouse'], strict: true },
  { name: 'zu spät (0.45 s)', model: HAND_MODELS.spaet, hits: ['late'], strict: false },
  { name: 'zu langsam (10 °/s)', model: HAND_MODELS.langsam, hits: ['tooSlow'], strict: false },
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
    const pct = Math.round(DIAG_MIN * 100);
    if (res.accuracy < DIAG_MIN || res.bad < 20) r.errors.push(`${line} — Soll ≥ ${pct} %`);
    else if (res.accuracyAll < DIAG_MIN && d.strict) r.errors.push(`${line} — mit 'good' unter ${pct} %: der Judge lobt falsche Tasten`);
    else if (res.accuracyAll < DIAG_MIN) r.warnings.push(`${line} — mit 'good' unter ${pct} %: ${res.counts.good ?? 0} Hops schaffen die Gut-Schwelle trotz des Fehlers (Nachsicht mit echtem Gewinn, Lead-Abnahme)`);
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
 * 1°/2°: Fehler unter 90 %. 3°: bei 300–450 u/s Fehler unter 90 % (dort hält das Kriterium: 96 %), bei 300–600 nur
 * Warnung — bei 450–600 u/s ist das Gewinnfenster (cap/|v| ≈ 3.2°) so breit wie der Zielfehler; jeder 5. Hop liegt
 * hinter 90° zur Flugrichtung und VERLIERT Tempo (−7 … −68 u/s). Diese Hops "gut" zu nennen, hieße lügen
 * (v2-Prototyp: 76 %). So bleibt der erreichbare Teil der Abnahme hart geprüft (Review rv-tc3).
 */
export function strafeBotProbe(cfg: MovementConfig, r: ProbeReport): StrafeBotResult[] {
  const out: StrafeBotResult[] = [];
  const pct = Math.round(BOT_GOOD_MIN * 100);
  for (const noise of [1, 2, 3]) {
    const res = strafeBotGood(cfg, noise);
    // Eigene, größere Stichprobe: das Band 300–450 durchfliegt der Bot in den ersten Sekunden (20 Seeds: nur 25 Hops).
    const lowBand = strafeBotGood(cfg, noise, 100, 6, 300, 450);
    const share = res.judged ? res.good / res.judged : 0;
    const shareLow = lowBand.judged ? lowBand.good / lowBand.judged : 0;
    const bad = Object.entries(res.counts)
      .filter(([k]) => k !== 'good')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const line = `StrafeBot ${noise}° (Absprung 300–600 u/s): ${Math.round(share * 100)} % gut (${res.good}/${res.judged}${bad ? `; ${bad}` : ''}), davon 300–450: ${Math.round(shareLow * 100)} % (${lowBand.good}/${lowBand.judged})`;
    if (share >= BOT_GOOD_MIN && res.judged >= 50) r.info.push(line);
    else if (noise < 3) r.errors.push(`${line} — Soll ≥ ${pct} %`);
    else if (shareLow < BOT_GOOD_MIN || lowBand.judged < 60) r.errors.push(`${line} — Soll 300–450 u/s ≥ ${pct} %`);
    else r.warnings.push(`${line} — 300–600: Soll ≥ ${pct} %; die Fehl-Hops verlieren Tempo (Zielfehler ≥ Gewinnfenster), 300–450 erfüllt (Lead-Abnahme offen)`);
    out.push(res);
  }
  return out;
}
