/**
 * T3 AIR-STRAFE — die Kernlektion (Plan 007; Prototyp lessonArena, v2-Entwurf §3).
 *
 * Arena 4800 × 4800, Spawn in der Mitte. Der Rand ist eine Schüssel: 256 breite, begehbare Rampe
 * (20.6°, 96 hoch) vor der Bande — wer beim Kreisen driftet, rollt hoch und wird gebremst, statt frontal
 * abzuprallen (Bande-Fassung 3200²: Bonk −166 u/s, Anfänger 10/20). Stufen: 5 gute Hops links, 5 rechts,
 * 6 im Wechsel (verzeihend). Das Ausgangstor im Süden öffnet nach dem Wechsel, dahinter das Portal.
 * Bonus/Meister: gute Hops mit frühem A/D (≥ 80/85 % der Luftzeit) — die Taste gleich nach dem Absprung.
 */
import { HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { backStrafe, hand, naive, p2 } from './drivers';
import type { HandPlan } from './drivers';
import { ENV_BASICS, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';
import { diagnosisProbe, strafeBotProbe } from './probes';

const HALF = 2400;
const RIM = 256;
const RIM_H = 96;
/** Surf-Band hinter dem Rand: 60°-Flanke, auf der niemand steht — wer hineinfliegt, rutscht zurück in die Arena. */
const BAND = 96;
const BAND_TOP = RIM_H + Math.round(BAND * Math.tan(Math.PI / 3));
const WALL_TOP = 400;
const DOOR = 384;
const ALCOVE = 640;

export function buildT3(): LevelFile {
  const B = new LessonBuilder({ id: 't3', name: 'AIR-STRAFE', subtitle: 'Kurven in der Luft = Tempo.', lesson: 3, group: 'basics', killY: -600, environment: ENV_BASICS, turnBand: true });
  const L = B.L;
  const O = HALF + RIM;
  const W = O + BAND;
  // Bodenplatte bis unter die Bande und dicker als die Randkeile: keine Fläche fällt mit einem Keil zusammen.
  L.box([-W - 64, -128, -W - 64], [W + 64, 0, W + 64], { mat: 'floor', tag: 'arena' });
  // Schüssel-Rand: begehbare Rampe (20.6°, 96 hoch), dahinter ein 60°-Surf-Band bis zur Bande —
  // an der Bande steht man nie (erste Messung: Hand klebte 100 s an der Westbande, −160 u/s je Hop).
  // Die Rampen laufen über die Ecken durch (Walm): auch dort geht es überall zurück in die Arena.
  const sides: Array<[string, number, number, number]> = [
    ['n', 0, -HALF, 0],
    ['s', 0, HALF, 180],
    ['w', -HALF, 0, 90],
    ['o', HALF, 0, -90],
  ];
  for (const [tag, x, z, yaw] of sides) {
    const f = Frame.at([x, z], yaw);
    // Nord/Süd laufen über die ganze Breite (auch die Ecken), Ost/West nur dazwischen und 8 u dicker:
    // keine zusammenfallenden Stirn- oder Unterflächen (Z-Fighting).
    const ew = tag === 'w' || tag === 'o';
    const thick = ew ? 72 : 64;
    const span: [number, number] = ew ? [-HALF, HALF] : [-W, W];
    L.ramp(f, [0, RIM], span, 0, RIM_H, { tag: `rand-${tag}`, thick });
    if (tag === 's') {
      // Vor der Tür kein Surf-Band: ebener Absatz auf Randhöhe bis ins Tor.
      L.ramp(f, [RIM, RIM + BAND], [-W, -DOOR / 2], RIM_H, BAND_TOP, { mat: 'surf', tag: 'band-s1', thick });
      L.ramp(f, [RIM, RIM + BAND], [DOOR / 2, W], RIM_H, BAND_TOP, { mat: 'surf', tag: 'band-s2', thick });
    } else L.ramp(f, [RIM, RIM + BAND], span, RIM_H, BAND_TOP, { mat: 'surf', tag: `band-${tag}`, thick });
  }
  const t = 64;
  L.box([-W - t, 0, -W - t], [W + t, WALL_TOP, -W], { mat: 'wall', tag: 'bande-n' });
  L.box([-W - t, 0, -W], [-W, WALL_TOP, W], { mat: 'wall', tag: 'bande-w' });
  L.box([W, 0, -W], [W + t, WALL_TOP, W], { mat: 'wall', tag: 'bande-o' });
  L.box([-W - t, 0, W], [-DOOR / 2, WALL_TOP, W + t], { mat: 'wall', tag: 'bande-s1' });
  L.box([DOOR / 2, 0, W], [W + t, WALL_TOP, W + t], { mat: 'wall', tag: 'bande-s2' });
  // Absatz vor der Tür (zwischen den Surf-Bändern) und Nische dahinter auf Randhöhe, Portal am Ende.
  L.box([-DOOR / 2, RIM_H - 64, O], [DOOR / 2, RIM_H, W + ALCOVE], { mat: 'floor', tag: 'nische' });
  L.box([-DOOR / 2 - t, 0, W + t], [-DOOR / 2, WALL_TOP, W + ALCOVE + t], { mat: 'wall', tag: 'nische-w' });
  L.box([DOOR / 2, 0, W + t], [DOOR / 2 + t, WALL_TOP, W + ALCOVE + t], { mat: 'wall', tag: 'nische-o' });
  L.box([-DOOR / 2, 0, W + ALCOVE], [DOOR / 2, WALL_TOP, W + ALCOVE + t], { mat: 'wall', tag: 'nische-s' });
  B.gate('ausgang', [-DOOR / 2, RIM_H, W], [DOOR / 2, WALL_TOP, W + 24], TC.amber);
  B.portalZ(0, W + ALCOVE - 160, RIM_H, 256, TC.lime);
  // Mitte: Leuchtkreis als Orientierung (Spawn), Chevrons zum Ausgang.
  // Raute (Markierungen müssen Parallelogramme sein).
  L.marking(Frame.at([0, 0], 0), [[96, 0], [0, 96], [-96, 0], [0, -96]], 0, TC.cyan, 'mitte');
  for (let k = 0; k < 3; k++) L.chevron([0, 0, HALF - 700 + k * 180], 180, { tint: TC.amber, arm: 72 });
  L.spawn([0, 0, 0], 0);

  const circleL = { kind: 'hand', rateDeg: 120, pattern: 'circle', side: 'left', seconds: 12 } as const;
  const circleR = { kind: 'hand', rateDeg: 120, pattern: 'circle', side: 'right', seconds: 12 } as const;
  const zig = { kind: 'hand', rateDeg: 120, pattern: 'zigzag', side: 'left', seconds: 16 } as const;
  B.stage({
    id: 'links',
    title: 'LINKSKURVE',
    // W + Leertaste zuerst: der Judge wertet Absprünge unter 200 u/s nicht — wer nur "in der Luft A" las, hüpfte mit
    // 40 u/s 20 s ohne Rückmeldung (Review training-ui). "FLÜSSIG" statt "LANGSAM": unter 35 °/s urteilt er tooSlow.
    text: 'W + LEERTASTE: ANLAUFEN, DANN IN DER\nLUFT A HALTEN, MAUS NACH LINKS ZIEHEN',
    task: { kind: 'goodHops', count: 5, side: 'left' },
    spawn: { pos: [0, 0, 0], yaw: 0 },
    demo: circleL,
    tips: [
      { on: 'air', text: 'JETZT: A HALTEN\nMAUS FLÜSSIG NACH LINKS' },
      // Der Drehbalken über W (HUD "MAUS") war nirgends erklärt (Review training-ui).
      { on: 'stuck', after: 12, text: 'DER BALKEN ÜBER W ZEIGT DEIN MAUS-TEMPO:\nIM FLUG IM GRÜNEN BAND HALTEN' },
    ],
  });
  B.stage({
    id: 'rechts',
    title: 'RECHTSKURVE',
    text: 'IN DER LUFT: D HALTEN\nUND DIE MAUS NACH RECHTS ZIEHEN',
    task: { kind: 'goodHops', count: 5, side: 'right' },
    demo: circleR,
    tips: [{ on: 'air', text: 'JETZT ANDERSHERUM:\nD HALTEN, MAUS NACH RECHTS' }],
  });
  B.stage({
    id: 'wechsel',
    title: 'WECHSELN',
    text: 'JEDER SPRUNG ANDERE SEITE:\nA + LINKS, DANN D + RECHTS',
    task: { kind: 'goodHops', count: 6, side: 'alternate' },
    opens: ['ausgang'],
    demo: zig,
  });
  B.stage({
    id: 'frueh',
    title: 'FRÜH DRÜCKEN',
    text: 'TASTE GLEICH NACH DEM ABSPRUNG:\n5 GUTE HOPS, A/D FAST DIE GANZE LUFT',
    task: { kind: 'goodHops', count: 5, side: 'any', minSideShare: 0.8 },
    rank: 'bonus',
    demo: zig,
  });
  B.stage({
    id: 'profi',
    title: 'PROFI-WECHSEL',
    text: '8 GUTE HOPS IM WECHSEL\nTASTE GLEICH NACH DEM ABSPRUNG',
    task: { kind: 'goodHops', count: 8, side: 'alternate', minSideShare: 0.85 },
    rank: 'master',
    demo: zig,
  });
  return B.build();
}

const CENTER = p2(0, 0);
/** Hände: Stufe 0 Kreis links, 1 Kreis rechts, danach Wechsel mit Drift-Korrektur zur Mitte. */
const plan = (si: number): HandPlan => (si === 0 ? { pattern: 'circle', side: 'left', goal: null } : si === 1 ? { pattern: 'circle', side: 'right', goal: null } : { pattern: 'zigzag', goal: CENTER });

export const T3_CHECK: LessonCheck = {
  rows: [
    { model: 'ordentlicher Anfänger', from: 'links', to: 'wechsel', make: hand(HAND_MODELS.anfaenger, plan), expect: { min: 18 }, level: 'error', verdicts: true },
    { model: 'geübter Anfänger', from: 'links', to: 'wechsel', make: hand(HAND_MODELS.geuebt, plan), expect: { min: 19 }, level: 'warning' },
    { model: 'zaghaft 30 °/s', from: 'links', to: 'wechsel', make: hand(HAND_MODELS.zaghaft, plan), expect: { min: 0 }, level: 'info', verdicts: true },
    { model: 'Fehler: nur W + Maus', from: 'links', make: hand(HAND_MODELS.nurW, plan), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: gegen die Maus', from: 'links', make: hand(HAND_MODELS.gegen, plan), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: ohne Maus', from: 'links', make: hand(HAND_MODELS.keineMaus, plan), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: W + Leertaste', from: 'links', make: naive(p2(0, -HALF + 400)), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: nur W + Maus (Wechsel)', from: 'wechsel', make: hand(HAND_MODELS.nurW, plan), expect: { max: 0 }, level: 'error', seconds: 60 },
    // Dieselben Fehler mit schneller Maus: der Blick streicht durchs Gewinnfenster, Gewinn ohne A/D-Technik.
    { model: 'Fehler: nur W + schnelle Maus 360 °/s', from: 'links', make: hand(HAND_MODELS.nurWSchnell, plan), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: gegen die schnelle Maus 360 °/s', from: 'links', make: hand(HAND_MODELS.gegenSchnell, plan), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    // Rückwärts-Strafer (A + Maus rechts, ohne W in der Luft): gewinnt Tempo rückwärts — FALSCHE SEITE, zählt nie.
    { model: 'Fehler: Rückwärts-Strafer A + Maus rechts 90 °/s', from: 'links', make: backStrafe(90), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    // Richtige Technik mit schneller Maus: darf nicht scheitern (Band bis 540 °/s, Judge 'good').
    { model: 'Anfänger mit schneller Maus 240 °/s', from: 'links', to: 'wechsel', make: hand({ ...HAND_MODELS.anfaenger, name: 'Anfänger 240', rateDeg: 240 }, plan), expect: { min: 18 }, level: 'warning', verdicts: true },
    { model: 'geübter Anfänger (Bonus)', from: 'frueh', make: hand(HAND_MODELS.geuebt, plan), expect: { min: 10 }, level: 'warning' },
    { model: 'ordentlicher Anfänger (Bonus)', from: 'frueh', make: hand(HAND_MODELS.anfaenger, plan), expect: { max: 20 }, level: 'info' },
    { model: 'geübter Anfänger (Meister)', from: 'profi', make: hand(HAND_MODELS.geuebt, plan), expect: { max: 20 }, level: 'info' },
  ],
  extra: (level, cfg) => {
    const r = { errors: [] as string[], warnings: [] as string[], info: [] as string[] };
    diagnosisProbe(level, cfg, r);
    strafeBotProbe(cfg, r);
    return r;
  },
};
