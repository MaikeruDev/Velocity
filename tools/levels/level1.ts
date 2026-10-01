/**
 * 01 GRUNDKURS — "Lauf. Spring. Strafe."
 *
 * Lehrlevel: jede Station führt genau eine Fähigkeit ein und die nächste
 * baut darauf auf. Hinweg nach Norden (-Z) in die untergehende Sonne,
 * 180°-Kurve, Rückweg nach Süden bergab ins Ziel. Absicht, Speeds und
 * Draufsicht: .docs/research/level-design.md.
 *
 * Hop-Rhythmen kommen aus der Sim (physics.SpeedCurve). Hop-Reihe, Kehre und
 * Slalom liegen im Rhythmus des PERFEKTEN Strafers (Plan 007, l1l2): er landet
 * jedes Mal mitten auf der Plattform, Langsamere früher auf der (tiefen) Plattform;
 * alle Lücken bleiben mit Sprint von der Kante machbar. Drei Stellen misst der
 * Bau mit dem perfekten Bot selbst (Median über die 49 Start-Jitter), statt sie
 * aus der Ballistik zu schätzen: den Plateau-Absprung (Anfang und Tempo der
 * Hop-Reihe), die Landung auf H7 (Stand der Crouch-Wand) und das Tempo an CP3
 * (Slalom). Grund: auf einer nach Mitte-Band geplanten Reihe driftete er Hop für
 * Hop über die Plattformen, landete je nach Start-Phase in Gräben oder zu nah an
 * der Wand und zerfiel in zwei Zweige (≈ 22.7 / 27 s, M11); ein Slalom mit festem
 * Takt ließ ihn je nach Phase Inseln überspringen oder hart bremsen (±1 s).
 *
 * Kurz statt lang (Review l1l2): der perfekte Takt kostet Weg, und Weg kostet nur
 * die Langsamen — bei einem Hop je Plattform ist die Zeit ≈ Hops × Luftzeit, egal
 * wie schnell. Deshalb vier Reihen-Plattformen statt sechs und sechs Kehren-Pads
 * statt sieben (perfekter Bot 21.5 → 20.3 s, 3°-Hand 38.5 → 35.6 s, Neuling
 * W+Leertaste CP1 → H7 19.7 → 13.7 s; Median über 32 Seeds). Zweites Review: fünf
 * Slalom-Inseln statt sechs und die Könner-Balken im selben Takt (CUT_N) — perfekter
 * Bot 20.3 → 19.5 s, über die Balken 18.4 s. Drittes Review (Slalom für echte Hände
 * flüssig): vier Inseln (SL_N), ein Tor vor der Rutsche sperrt die Gerade der
 * Gegenspalte, flache Zungen an den Innenecken statt der 32°-Nase (außer an der
 * Phasen-Insel) — Hände 1°–3° 1.1–2.6 s schneller, Tempo-Einbrüche im Slalom
 * ~80 % weniger, perfekter Bot 19.5 → 18.8 s, über die Balken 17.7 s. Viertes Review: flache Lippe vor Insel 1
 * (kein Anprall an ihrer Stirn nach einem zu kurzen Hop von der Wende).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three';
import type { LevelFile } from '../../src/world/level/LevelFormat';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { RouteFollower } from '../../src/player/bots';
import { compileLevel } from '../../src/world/level/compileLevel';
import { airTime, riseWindow, speedFor, RESERVE, PHYS } from './ballistics';
import type { PlacedPlatform, V2, V3 } from './lib';
import { Frame, LevelBuilder, SurfRamp, aabbOf, arcPoint, chordDeg, dist2, orientedBox, r3, solveArcRadius, xzOf, yawTo } from './lib';
import { measureSurfSpeeds, SpeedCurve, START_JITTERS, StartAim, SURF_GRID, jitterStart } from './physics';

const COL = {
  magenta: '#ff4fd8',
  orange: '#ff8a3d',
  cyan: '#33f0ff',
  violet: '#8a5cff',
  gold: '#ffd166',
  pink: '#ff6fa8',
} as const;

/** Sprungweite bei v (Landung `drop` tiefer) — daraus entstehen alle Hop-Rhythmen. */
function hop(v: number, drop = 0): number {
  return v * airTime(drop);
}

/** Plan-Tempo nach k Hops ab v0: Mitte zwischen perfektem und 0.85-Sync-Strafer (minSpeed der Knoten). */
function plan(v0: number, k: number): number {
  return 0.5 * SpeedCurve.of(1).after(v0, k) + 0.5 * SpeedCurve.of(0.85).after(v0, k);
}

/** Tempo des perfekten Strafers nach k Hops ab v0 — der Rhythmus, auf dem Reihe und Kehre liegen. */
function perfect(v0: number, k: number): number {
  return SpeedCurve.of(1).after(v0, k);
}

/** Kantensprung mit Sprint: größte flache Lücke (Kante zu Kante) mit 10 % Reserve. */
const SPRINT_GAP = (PHYS.sprintSpeed * airTime(0)) / RESERVE + 2 * PHYS.hullHalf;
/**
 * Ziel-Lücke der Hop-Reihe: mit Luft unter SPRINT_GAP, damit Langsame
 * (3°-Hand, ~450 u/s) jede Lücke per Stop-and-Go von der Kante schaffen.
 * Schnellere Rhythmen machen die Plattformen tiefer statt die Lücken größer.
 */
const ROW_GAP = SPRINT_GAP - 16;

/**
 * Länge von Rampe und Treppe zum Plateau (128 u hoch, 11°). Aufstiegs-Raster (l1l2, perfekter Bot,
 * 49 Start-Jitter): 448–592 u (16–12°) zerfallen je nach Lauf-3-Tiefe in 2–7 Landefolgen — Landungen
 * an Rampenfuß und -kopf kosten je nach Tick-Phase 60–80 u/s —, 608–704 u in genau eine (Plateau-Absprung
 * 730 u/s). 656 liegt in der Mitte. Env ASCENT_RUN nur für Mess-Sweeps.
 */
const ASCENT_RUN = Number(process.env.ASCENT_RUN ?? 656);
/** Halbe Breite von Treppe und Rampe: so breit wie das Plateau — wer mit Auto-Hop seitlich driftet, fällt nicht vom Aufstieg. */
const ASCENT_W = Number(process.env.ASCENT_W ?? 256);
/** Lauf 3 (Landefläche vor dem Aufstieg): so tief, dass der perfekte Hop von Lauf 2 64 u vor dem Rampenfuß aufsetzt (bei 288 genau auf der Fuge). */
const RUN3_DEPTH = 352;
/** Plateau (CP1): der perfekte Bot landet ~150 u vor der Kante statt auf ihr (bei 384 hing die Hull über der Kante). */
const PLATEAU_DEPTH = 512;
/**
 * Plattformen der Hop-Reihe vor H7. Sechs im Takt des perfekten Strafers machten die Reihe 40 % länger als
 * im Mitte-Band-Plan (Review l1l2: Neuling W+Leertaste CP1 → H7 14.4 → 19.7 s); vier geben dem perfekten
 * Bot denselben sauberen Takt (Plateau/H7-Streuung 6/7 u) und jedem anderen 2 Plattformen weniger Weg.
 */
const ROW_N = 4;
/**
 * Kehren-Pads im Takt des perfekten Strafers. Sieben (Radius 1593 u) kosteten die 3°-Hand in CP2 → CP3
 * 11.1 s, sechs (Radius 1348 u, 30° je Hop) 8.7 s; der perfekte Bot bleibt in einem Zweig (4.66–4.77 s).
 * Tiefere Pads (Lücke 48 statt 120) oder Anteile 0.84–0.91 zerfielen dagegen hinter CP3 (±1–3 s).
 */
const ARC_N = 6;
/**
 * Slalom-Inseln im Takt des perfekten Strafers. Sechs kosteten jeden außer dem perfekten Bot 1.3–3 s (Review l1l2,
 * Hand 2° Slalom 8.5 s), fünf immer noch ~2 s: Weg kostet nur die Langsamen (fallen.md #121). Vier ließen früher einen
 * Geradeaus-Hüpfer der Gegenspalte über die letzte Insel hinweg in die tiefe Rutsche (dichte Lenkprobe 252/7020 ab
 * 1148 u/s) — das sperrt jetzt das Slalom-Tor vor der Rutsche, unabhängig von Tempo und Phase. Vier Inseln + Tor +
 * Zungen (Review l1l2, drittes, 24 Seeds, Spiel-Uhr): Hände 1°/1.5°/2°/3° 25.9/29.0/29.6/33.3 → 24.8/26.4/27.7/31.4 s,
 * sync 0.8/0.9 27.4/27.4 → 24.4/26.3 s, perfekter Bot 19.5 → 18.8 s (ein Zweig), Lenkprobe 0/7020.
 */
const SL_N = 4;
/**
 * Könner-Balken der Abkürzung im Takt des perfekten Strafers (Balkenmitten ≈ seine Hop-Weite ab Pad 1, ~950 u/s).
 * Vier Balken lagen im Takt von ~780 u/s: er bremste auf ihnen 952 → 681 u/s, kam mit 736 statt 1087 an CP3 an
 * und war am Ziel 1.7 s LANGSAMER als über die Kehre, in zwei Zweigen (Review l1l2). Drei: 1.1 s schneller, ein Zweig.
 */
const CUT_N = 3;
/**
 * Ende der Balken-Bahn so weit in der Wende (u ab ihrem Anfang). Es legt die Phase, mit der man über die Balken in
 * den Slalom kommt: bei 128 landete die Hand 1° früh auf Insel 1, rutschte Insel für Insel auf die Nasen und verlor
 * hinter CP3 2 s (Ersparnis am Ziel Ø −0.6 s). Raster 192…448 (perfekter Bot 49 Starts, Hände 24 Seeds): 256–320
 * ein Zweig ohne Tod, ab 352 Tode des perfekten Bots, ab 416 Zweige; 288 = Mitte (Ersparnis am Ziel Hand 1° Ø 0.6 s,
 * Hand 1.5° Ø 1.9 s).
 */
const CUT_END = 288;

/** Farbe der Start-Markierungen (palette.KIND_COLORS.start). */
const START_GLOW = '#46ff9e';

/** Tiefe der Auffangmulden unter Pflicht-Lücken im Erstkontakt: ein normaler Sprung (57 u) kommt heraus. */
const CATCH_DEPTH = 40;
/** Gräben unter der Hop-Reihe: tiefer als die Mulden (ein Fehlsprung soll spürbar sein), ein Sprung kommt heraus. */
const TRENCH_DEPTH = 48;
/** Tiefe der dunklen Lippe vor der Checkpoint-Fläche an der Crouch-Kante (u). */
const LIP = 48;
/**
 * Abstände der Hop-Reihe relativ zur Flugweite des perfekten Strafers beim Absprung-Tempo: er gewinnt
 * im Flug ~35 u/s, fliegt also etwas weiter als v₀·t — mit 1.02 landet er Hop für Hop gleich weit vor der
 * Plattformmitte, statt zu driften (1.00: +130 u bis H7, 1.04: −70 u).
 */
const ROW_PITCH = 1.02;
/** Route-Knoten der Hop-Reihe liegen so weit hinter der Plattformmitte (siehe dort). */
const ROW_NODE_AHEAD = 48;
/** H7 beginnt so weit vor seiner Plan-Landung: die gemessene Landung liegt mitten auf H7, nie an dessen Vorderkante. */
const H7_LEAD = 176;
/**
 * Crouch-Wand: die Hull-Front des perfekten Strafers erreicht sie (riseA + WALL_LEAD) s nach seinem Absprung
 * auf H7 — WALL_LEAD nach dem frühesten Moment, in dem die Füße über der Kante sind. Früh im Fenster, weil
 * langsamere Modelle früher auf H7 landen (weiter vor der Wand) und dort das späte Ende ihres Fensters
 * brauchen; der Plan-Knoten trägt so die 3°-Hand bis 1.2 × Plan (designProbes.crouchWindow).
 */
const WALL_LEAD = 0.06;
/** Kehre im Rhythmus des perfekten Strafers ab diesem Anteil seines H7-Tempos (Kurven-Strafen kostet Weite). */
const KEHRE_SHARE = 0.94;
/** Höhe der Crouch-Kante über H7 (u): ≥ 66 (Level-Regel Plan 007: ohne Ducken reicht es bis 63.5 u, dazu 2 u Reserve). */
const CROUCH_H = 66;
/** Oberkante von Plateau, Hop-Reihe und H7 (u). */
const ROW_TOP = 128;
/** Oberkante der Kante hinter der Crouch-Wand (CP2); die Kehre dahinter bleibt auf 192 (2 u Stufe, unsichtbar). */
const LEDGE_TOP = ROW_TOP + CROUCH_H;

/** Auf ein 16-u-Raster aufrunden (lesbare Maße, gleiche Kanten wie das Textur-Raster). */
function ceil16(n: number): number {
  return Math.ceil(n / 16) * 16;
}

/** Gemessene Landung des perfekten Bots (Median über die Start-Jitter): u in Laufrichtung, Tempo, Streuung von u. */
interface Landing {
  readonly u: number;
  readonly v: number;
  readonly spread: number;
}

/** Messwerte, aus denen der Bau die Reihe, die Crouch-Wand und den Slalom stellt; null = vorläufig (Messlauf). */
interface Probe {
  readonly takeoff: Landing | null;
  readonly h7: Landing | null;
  /** Perfekter Bot beim Eintritt in den CP3-Trigger (u, Tempo): Takt des Slaloms. */
  readonly cp3: Landing | null;
}

/**
 * Vier Bauten: (1) vorläufig → Landung des perfekten Bots auf dem Plateau (dort springt er ab),
 * (2) Hop-Reihe ab dieser Stelle und mit diesem Tempo, Wand noch weit → seine Landung auf H7,
 * (3) Wand danach → sein Tempo an CP3, (4) Slalom in diesem Takt. Keine Rückkopplung: jede Messung
 * hängt nur an dem, was davor liegt — die Wand ändert Plateau und H7 nicht, der Slalom nicht CP3.
 */
export function buildLevel1(): LevelFile {
  const takeoff = measureLanding(layout({ takeoff: null, h7: null, cp3: null }, false), 'plateau');
  const h7 = measureLanding(layout({ takeoff, h7: null, cp3: null }, false), 'hop7');
  const cp3 = measureLanding(layout({ takeoff, h7, cp3: null }, false), CP3_PROBE);
  const def = layout({ takeoff, h7, cp3 }, true);
  reportDrift(def);
  return def;
}

/** Ab dieser Verschiebung (u) einer Brush-Kante meldet der Bau die Drift gegen die eingecheckte level1.json. */
const DRIFT_WARN = 16;
/** Brushes, an denen die gemessene Planung hängt (Reihe, Crouch-Kante, Kehre, Abkürzung, Slalom, Ziel). */
const DRIFT_TAGS = /^(plateau|hop\d|ledgeLip|ledge|curve\d|turn|cut\d|slalom\d|finish)$/;

/**
 * Die Reihe misst sich beim Bau selbst — jedes Movement-Tuning verschiebt still Reihe, H7, Wand, Kehre,
 * Slalom und damit Medaillen, Ghosts und die Freischalt-Leiter (Review l1l2). Deshalb gegen die
 * eingecheckte public/levels/level1.json vergleichen und jede Kante, die sich um mehr als DRIFT_WARN
 * bewegt, laut melden (auch neue oder verschwundene Brushes).
 */
function reportDrift(def: LevelFile): void {
  let old: LevelFile;
  try {
    old = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/levels/level1.json', import.meta.url)), 'utf8')) as LevelFile;
  } catch {
    return; // Erster Bau oder anderer Arbeitsbaum: nichts zu vergleichen.
  }
  const boundsOf = (d: LevelFile): Map<string, Box3> => {
    const out = new Map<string, Box3>();
    for (const b of compileLevel(d).brushes) if (b.tag !== null && DRIFT_TAGS.test(b.tag) && !out.has(b.tag)) out.set(b.tag, b.bounds);
    return out;
  };
  const a = boundsOf(old);
  const b = boundsOf(def);
  const moved: string[] = [];
  for (const [tag, nb] of b) {
    const ob = a.get(tag);
    if (!ob) {
      moved.push(`${tag} neu`);
      continue;
    }
    const d = Math.max(...(['x', 'y', 'z'] as const).flatMap((k) => [Math.abs(nb.min[k] - ob.min[k]), Math.abs(nb.max[k] - ob.max[k])]));
    if (d > DRIFT_WARN) moved.push(`${tag} ${d.toFixed(0)} u`);
  }
  for (const tag of a.keys()) if (!b.has(tag)) moved.push(`${tag} entfällt`);
  if (moved.length)
    console.warn(
      `  level1: Geometrie weicht von public/levels/level1.json ab (> ${DRIFT_WARN} u): ${moved.join(', ')} — gewollt? Nach Movement-Tuning Doku (level-design.md), Medaillen und Freischalt-Leiter nachziehen; alte Ghosts verfallen`,
    );
  else console.log(`  level1: Geometrie wie public/levels/level1.json (alle Kanten ≤ ${DRIFT_WARN} u)`);
}

/** Pseudo-Tag für measureLanding: Eintritt in den Trigger von Checkpoint 3 statt Landung auf einem Brush. */
const CP3_PROBE = 'checkpoint:3';

/**
 * Erste Landung des perfekten Bots auf dem Brush `tag` (bzw. erster Tick im Trigger bei CP3_PROBE), je
 * Start-Jitter (wie physics.timedRun); Median von u und Tempo. CP3 nicht als Landung: der perfekte Bot
 * springt von Pad 6 teils über die Wende direkt auf Insel 1 — den Trigger kreuzt er immer (Streuung 8 u).
 */
function measureLanding(def: LevelFile, tag: string): Landing {
  const level = compileLevel(def);
  const cfg = VELOCITY_DEFAULT;
  const route = level.def.route ?? [];
  const mins = new Vector3(-PHYS.hullHalf, 0, -PHYS.hullHalf);
  const maxs = new Vector3(PHYS.hullHalf, PHYS.standHeight, PHYS.hullHalf);
  const trig = tag === CP3_PROBE ? level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 3) : undefined;
  if (tag === CP3_PROBE && !trig) throw new Error('level1: Messbau ohne Checkpoint 3');
  const hull = new Box3();
  const us: number[] = [];
  const vs: number[] = [];
  START_JITTERS.forEach((j, i) => {
    const pm = new PlayerMovement(level.world, cfg);
    const start = jitterStart(level.spawnPos, level.spawnYaw, j.lateral);
    pm.teleport(new Vector3(start.x, start.y + 1, start.z));
    const bot = new RouteFollower(route, cfg, { sync: 1, seed: i + 1, killY: level.def.killY, world: level.world, start: { x: start.x, z: start.z }, stallTimeout: 12, timeout: 60 });
    const aim = new StartAim(j.yawDeg);
    let was = true;
    for (let t = 0; t < 60 * cfg.tickRate && bot.status === 'running'; t++) {
      pm.tick(aim.apply(bot.next(pm.state, pm.surfNormal), pm.state.onGround));
      const s = pm.state;
      if (trig) {
        hull.min.copy(s.pos).add(pm.hullMins);
        hull.max.copy(s.pos).add(pm.hullMaxs);
        if (trig.bounds.intersectsBox(hull)) {
          us.push(-s.pos.z);
          vs.push(s.speed);
          break;
        }
        continue;
      }
      if (s.onGround && !was) {
        const p = s.pos;
        const tr = level.world.traceBox(new Vector3(p.x, p.y + 1, p.z), new Vector3(p.x, p.y - 8, p.z), mins, maxs);
        if (!tr.startSolid && tr.fraction < 1 && level.brushes[tr.brushIndex]?.tag === tag) {
          us.push(-p.z);
          vs.push(s.speed);
          break;
        }
      }
      was = s.onGround;
    }
  });
  if (us.length * 2 <= START_JITTERS.length) throw new Error(`level1: perfekter Bot landet in ${us.length}/${START_JITTERS.length} Läufen auf ${tag}`);
  const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  const spread = Math.max(...us) - Math.min(...us);
  // Mehrere Landefolgen = Chaos vor dieser Stelle; der Validator meldet die Folge (Zweige über den Start-Kasten).
  if (spread > 64) console.warn(`  level1: perfekter Bot landet auf ${tag} gestreut (${spread.toFixed(0)} u über ${us.length} Starts)`);
  return { u: med(us), v: med(vs), spread };
}

function layout(m: Probe, final: boolean): LevelFile {
  // Unter dem Ziel (tiefste begehbare Fläche, ~−1080) und den Kill-Zonen neben der Auffangfläche.
  const killY = -1700;
  const L = new LevelBuilder({
    id: 'level1',
    name: '01 GRUNDKURS',
    subtitle: 'Lauf. Spring. Strafe.',
    // Platzhalter: build.ts leitet Par aus der 3°-Hand ab (gemessen, nicht geschätzt).
    parTime: 50,
    killY,
    music: { root: 'A', bpm: 132 },
    environment: {
      skyTop: '#1b0736',
      skyHorizon: '#ff7a45',
      skyBottom: '#2b0b3f',
      fogColor: '#8a2d6e',
      fogNear: 1300,
      fogFar: 5200,
      // Tiefe Abendsonne im Norden: auf dem Hinweg fliegt man in den Sonnenuntergang.
      sunDir: [0.18, 0.22, -1],
      sunColor: '#ffb27a',
      ambientSky: '#6f58c9',
      ambientGround: '#3b1340',
      trimColor: COL.cyan,
      trimColorAlt: COL.magenta,
      voidY: -1900,
    },
  });

  const F = new Frame(0, 0, 0);

  // ── 0 START ─────────────────────────────────────────────────────────────
  const START_U: V2 = [-320, 160];
  L.platform(F, START_U, [-256, 256], 0, { mat: 'start', tag: 'start' });
  L.spawn(F.p(-224, 0, 0), 0);
  {
    const [a, b] = aabbOf(F, START_U, [-256, 256], [0, 160]);
    L.startZone(a, b);
  }
  L.node(F.p(-224, 0, 0), { minSpeed: 250, note: 'Start' });
  // Vier Leucht-Chevrons vor dem Spawn Richtung erste Lücke (statt Textur-Pfeilen,
  // die mittig je 256-u-Kachel lagen und am Spawn nur angeschnitten zu sehen waren).
  for (const u of [-120, -40, 40, 120]) L.chevron(F.p(u, 0, 0), F.yaw, { tint: START_GLOW, arm: 72, thick: 22, tag: 'startChevron' });

  // ── 1 LAUF: drei kleine Lücken, mit 250 u/s aus dem Laufen machbar ──────
  const RUN_W = [320, 320, 384] as const;
  const run = L.gapLine(F, START_U[1], [
    { gap: 96, depth: 256, width: RUN_W[0], top: 0, tag: 'run1' },
    { gap: 128, depth: 224, width: RUN_W[1], top: 0, tag: 'run2' },
    { gap: 144, depth: RUN3_DEPTH, width: RUN_W[2], top: 0, tag: 'run3' },
  ]);
  let edge = START_U[1];
  run.forEach((p, i) => {
    L.node(F.p(edge - 24, 0, 0), { jump: true, minSpeed: 250, note: `Lücke ${i + 1}` });
    L.node(p.center, { minSpeed: 250 });
    // Auffangmulde statt Kill-Zone: mit gehaltener Leertaste (Auto-Hop) springt
    // man dort ab, wo man zuletzt gelandet ist — über einer echten Lücke fiel
    // jede zweite bis dritte Hop-Phase hinein (Erstkontakt 26 % ohne Tod). Die
    // Mulde (40 u, ein Sprung kommt heraus, Rampe bis an die Landekante) macht
    // aus dem Fehler ~0.3 s statt Respawn. Breite = Landeplattform.
    L.catchDip(F, [edge, p.u0], [p.v - RUN_W[i] / 2, p.v + RUN_W[i] / 2], 0, CATCH_DEPTH, { tag: `catch-run${i + 1}` });
    edge = p.u1;
  });

  // ── 2 AUFSTIEG: Treppe (links) und Rampe (rechts) auf das Plateau ───────
  // Die Treppe ist nur Optik: darüber liegt ein unsichtbarer Clip mit derselben
  // Neigung wie die Rampe (Source "stair clip"). In der Luft gibt es keine Stufen —
  // im Hop war jede 16-u-Setzstufe eine Wand (Tempo 320 → 0 in einem Tick, danach
  // Mondhüpfen oder seitlich von der Rampe). So tragen beide Seiten den Hop-Flow.
  const U3 = run[2].u1;
  const UP = ASCENT_RUN;
  L.stairs(F, U3, [-ASCENT_W, 0], 0, 16, UP / 8, 8, { mat: 'metal', tag: 'stair', collide: false, trim: true });
  // EIN Clip über die volle Breite, die Rampe rechts ist Optik (Plan 007, l1l2): die Route läuft
  // mittig (x = 0), früher genau auf der Fuge zweier Keile — keine Kante unter der Linie.
  L.ramp(F, [U3, U3 + UP], [-ASCENT_W, ASCENT_W], 0, 128, { tag: 'stairClip', visible: false });
  L.ramp(F, [U3, U3 + UP], [0, ASCENT_W], 0, 128, { tag: 'ramp', collide: false, trim: true });
  const plateau = L.platform(F, [U3 + UP, U3 + UP + PLATEAU_DEPTH], [-256, 256], 128, { mat: 'checkpoint', thick: 192, tag: 'plateau' });
  // Mittig: Treppe (mit Clip) und Rampe sind gleichwertig — ein Knoten auf der
  // Rampenseite zog Läufer von der Treppe quer über die Rampe und seitlich hinunter.
  L.node(F.p(U3 - 40, 0, 0), { minSpeed: 250, note: 'Rampe' });
  L.node(F.p(U3 + UP + 48, 0, 128), { minSpeed: 250 });
  {
    const [a, b] = aabbOf(F, [U3 + UP, U3 + UP + 192], [-256, 256], [128, 288]);
    L.checkpoint(1, a, b, F.p(U3 + UP + 96, 0, 128), 0);
  }

  // ── 3 HOP-REIHE: ab dem gemessenen Plateau-Absprung im Rhythmus des perfekten Strafers.
  // Er landet dort, wo er auf dem Plateau aufsetzt, und springt sofort weiter (Bhop):
  // Mittelpunkte = seine Landepunkte (Messung + SpeedCurve, ROW_PITCH), Tiefe so, dass
  // jede Lücke ≤ ROW_GAP bleibt — bei schnellem Rhythmus werden die Plattformen tiefer,
  // nicht die Lücken größer (Stop-and-Go bleibt überall möglich). Wer langsamer ist,
  // landet früher auf der Plattform; unter jeder Lücke liegt ein Graben mit Ausstieg.
  // Früher lag die Reihe im Mitte-Band ab 450 u/s; der perfekte Strafer (Plateau ~600)
  // war schneller als geplant, rückte Hop für Hop über die Plattformen, landete je nach
  // Start-Phase in Gräben oder zu nah an der Wand — zwei Zweige, 22.7 und 27 s.
  const PU1 = plateau.u1;
  // Vorläufig (Messbau 1): Absprung an der Kante mit dem Tempo, das der Aufstieg ungefähr gibt.
  const TAKEOFF = m.takeoff?.u ?? PU1 - 20;
  const ROW_V0 = m.takeoff?.v ?? 700;
  if (m.takeoff && TAKEOFF > PU1 - 64) throw new Error(`level1: perfekter Bot springt ${(PU1 - TAKEOFF).toFixed(0)} u vor der Plateau-Kante ab (Hull über der Kante)`);
  const rowSpeed: number[] = [ROW_V0];
  const rowCenter: number[] = [];
  let at = TAKEOFF;
  for (let k = 0; k <= ROW_N; k++) {
    at += hop(perfect(ROW_V0, k)) * ROW_PITCH;
    rowCenter.push(at);
    rowSpeed.push(plan(ROW_V0, k + 1));
  }
  // Tiefen: mindestens 176 (H1 192: erste Landung nach dem Plateau-Absprung),
  // sonst so tief, dass die Lücke davor ≤ ROW_GAP bleibt.
  const ROW_DEPTH: number[] = [];
  for (let k = 0; k < ROW_N; k++) {
    const pitchIn = rowCenter[k] - (k === 0 ? PU1 - 96 : rowCenter[k - 1]);
    const prevHalf = k === 0 ? 96 : ROW_DEPTH[k - 1] / 2;
    ROW_DEPTH.push(Math.max(k === 0 ? 192 : 176, ceil16(2 * (pitchIn - prevHalf - ROW_GAP))));
  }
  const row: PlacedPlatform[] = ROW_DEPTH.map((d, k) =>
    L.platform(F, [rowCenter[k] - d / 2, rowCenter[k] + d / 2], [-128, 128], 128, { tag: `hop${k + 1}` }),
  );
  L.node(F.p(TAKEOFF, 0, 128), { jump: true, minSpeed: Math.round(ROW_V0), note: 'Hop-Reihe' });
  // Knoten ROW_NODE_AHEAD hinter der Plan-Mitte: der perfekte Bot landet 10–30 u vor ihr. Lag der
  // H6-Knoten auf seiner Landung, entschied der Erreich-Radius (12 u), ob er ihn schon abgehakt hatte —
  // dann zielte der Absprung auf den Crouch-Knoten, der Bot duckte schon im Anflug (Flug +60 u) und
  // landete zu nah an der Wand (7/49 Starts, Rampe 640 u).
  row.forEach((p, k) => L.node(F.p(rowCenter[k] + ROW_NODE_AHEAD, 0, 128), { jump: true, minSpeed: Math.round(rowSpeed[k + 1]) }));

  // ── 4 CROUCH-KANTE: 66 u — normaler Sprung (57, mit Kanten-Assist bis 63.5) reicht
  // nicht, Crouch (75) schon. H7 reicht bis an die Wand. Der Crouch-Hop steigt über die
  // Kante, wenn die Hull-Front die Wand im Fenster riseWindow(66) erreicht (0.23…0.53 s):
  // bei Tempo v also 0.23·v … 0.53·v davor. Für JEDES Tempo gibt es damit auf H7 eine
  // Absprungzone (designProbes: crouchWindow) — die 3°-Hand springt näher an der Wand,
  // der perfekte Strafer weiter davor, wer langsam ist, läuft an die Wand und springt
  // dort geduckt hoch. Zu früh oder zu spät: man prallt ab und landet wieder auf H7 —
  // kostet Tempo, nie das Leben.
  // Die Wand steht da, wo der perfekte Strafer sie aus seiner gemessenen H7-Landung
  // (dort springt er ab) früh im Fenster erreicht (WALL_LEAD). Der RouteFollower springt
  // nur, wenn seine Flugbahn-Vorhersage oben landet — die kennt den Kanten-Assist nicht:
  // landete er zu nah an der Wand, lief er an sie heran und sprang mit ~320 u/s (+4 s).
  const crouchV = rowSpeed[ROW_N + 1];
  const [riseA] = riseWindow(CROUCH_H, true);
  const h7c = rowCenter[ROW_N];
  // Messbau 2: Wand weit hinter jeder Landung (kein Absprung auf H7 wird gemessen, nur die Landung).
  const crouchAt = m.h7?.u ?? h7c;
  const vCrouch = m.h7?.v ?? perfect(ROW_V0, ROW_N + 1);
  const LE = m.h7 ? m.h7.u + PHYS.hullHalf + (riseA + WALL_LEAD) * m.h7.v : h7c + 1200;
  const h7: [number, number] = [Math.min(h7c - H7_LEAD, row[ROW_N - 1].u1 + ROW_GAP), LE];
  if (m.h7 && m.h7.u - PHYS.hullHalf < h7[0] + 32) throw new Error(`level1: H7-Landung ${m.h7.u.toFixed(0)} liegt an der Vorderkante von H7 (${h7[0].toFixed(0)})`);
  // Tag bleibt 'hop7' ("H7", die Crouch-Insel), obwohl davor nur ROW_N Plattformen liegen: designProbes
  // (crouchWindow) und sim/arcade.ts suchen die Insel unter diesem Namen.
  L.platform(F, h7, [-160, 160], 128, { mat: 'accent', tint: COL.orange, tag: 'hop7' });
  // Gräben statt Kill-Zone unter jeder Lücke der Hop-Reihe (Grundkurs): wer zu
  // kurz springt — typisch die ersten Strafe-Versuche, bei denen der falsche
  // Winkel bremst —, landet 48 u tiefer und springt über die Rampe vorn wieder
  // heraus (~0.5 s statt Respawn an CP1; 5°-Hand: 127 von 129 Toden hier).
  // Der saubere Hop merkt nichts davon.
  {
    const edges = [PU1, ...row.map((p) => p.u1)];
    const fronts = [...row.map((p) => p.u0), h7[0]];
    fronts.forEach((u1, k) => {
      const half = k < row.length ? 128 : 160;
      L.catchDip(F, [edges[k], u1], [-half, half], 128, TRENCH_DEPTH, { tag: `catch-row${k + 1}` });
    });
  }
  L.node(F.p(crouchAt, 0, 128), { jump: true, crouch: true, minSpeed: Math.round(crouchV), note: 'Crouch-Jump' });
  // Duck-Timing auf dem Boden (Polish-Runde 2): für Tasten-Neulinge war die Kante eine
  // Wand — das ↑C stand nur AN der Wand, also dort, wo es zu spät ist. Jetzt liegt die
  // Absprungzone auf H7: dasselbe Pixel-Glyph ↑C wie an der Wand, gefüllt, in
  // Trim-Farbe, 80–280 u vor der Wand (Fenster bei 320–450 u/s: 67–243 u; wer schneller
  // ist, springt am hinteren Ende). In Laufrichtung gestreckt wie eine Straßen-
  // markierung (25 u je Glyph-Zeile, 16 u je Spalte): aus dem Anlauf ist der Boden stark
  // verkürzt, ein unverzerrtes Glyph las sich dort als ein paar Striche.
  {
    const ROW = 25;
    const COLW = 16;
    const FAR = LE - 80 - DUCK_GLYPH.length * ROW; // Glyph-Zeile 0 liegt zur Wand hin
    const cols = DUCK_GLYPH[0].length;
    for (const [r0, r1, c0, c1] of glyphRects(DUCK_GLYPH)) {
      const u0 = FAR + (DUCK_GLYPH.length - r1) * ROW;
      const u1 = FAR + (DUCK_GLYPH.length - r0) * ROW;
      const v0 = (c0 - cols / 2) * COLW;
      const v1 = (c1 - cols / 2) * COLW;
      L.marking(F, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], 128, COL.cyan, 'duckMark');
    }
  }
  // Die Wand sagt "Duck-Sprung hier" (Piktogramm ↑C, Chevrons nach oben, in
  // Trim-Farbe) statt "Gefahr" (vorher Warnstreifen). Die Lippe ist 48 u tief und
  // dunkel: an der Kante bleibt eine einzige Leuchtlinie (der Trim), die gelben
  // Checkpoint-Markierungen beginnen dahinter (vorher stapelten sie sich mit dem
  // Trim zu einem unruhigen Band, Look-Kritik).
  L.platform(F, [LE, LE + LIP], [-224, 224], LEDGE_TOP, { mat: 'duck', tint: COL.cyan, thick: 128, tag: 'ledgeLip' });
  // Landepunkt des Crouch-Hops (perfekter Strafer, Flug 66 u hoch mit Duck-Lift) = Beginn der Kehre.
  const L0 = crouchAt + vCrouch * airTime(-CROUCH_H, true);
  L.node(F.p(L0, 0, LEDGE_TOP), { jump: true, minSpeed: Math.round(crouchV), note: 'Kante' });
  {
    const [a, b] = aabbOf(F, [LE + LIP, LE + 256], [-224, 224], [LEDGE_TOP, LEDGE_TOP + 160]);
    L.checkpoint(2, a, b, F.p(LE + 120, 0, LEDGE_TOP), 0);
  }

  // ── 5 KEHRE: Hop-Linie auf einem 180°-Bogen nach links ─────────────────
  // Sehnen = Sprungweiten des perfekten Strafers ab KEHRE_SHARE seines Kanten-Tempos
  // (Kurven-Strafen kostet Weite): er landet Pad für Pad an derselben Stelle, statt
  // wie früher (Sehnen des 0.85-Bands) immer weiter hinten und irgendwann daneben.
  // Langsamere landen vorn und laufen vor (Lücken nur ~120 u). Der Radius ergibt sich
  // so, dass der letzte Hop genau auf 180° landet.
  const KEHRE_V0 = KEHRE_SHARE * vCrouch;
  const KEHRE_GAP = 120;
  /** Breite der Kehren-Pads (quer zur Fahrt). */
  const KEHRE_W = 288;
  /** Das letzte Pad bleibt 256 breit: innen daneben enden die Könner-Balken. */
  const padW = (k: number): number => (k === chords.length - 1 ? 256 : KEHRE_W);
  const arcSpeed: number[] = [];
  for (let k = 0; k < ARC_N; k++) arcSpeed.push(perfect(KEHRE_V0, k));
  const chords = arcSpeed.map((v) => hop(v));
  const R = solveArcRadius(chords, 180);
  const S = F.p(L0, 0, 192);
  const C: V2 = [S[0] - R, S[2]];
  // Tiefe = Sehne − 120: die Kehre prüft das Kurven-Strafen, nicht die Lückenweite —
  // auch aus dem Stand (Respawn an CP2) reicht jeder Hop von der hinteren Padhälfte.
  const arcDepth = chords.map((c) => Math.max(208, c - KEHRE_GAP));
  const arc: PlacedPlatform[] = [];
  const arcPhi: number[] = [];
  let phi = 0;
  chords.forEach((c, k) => {
    phi += chordDeg(c, R);
    const [x, z] = arcPoint(C, R, phi);
    const last = k === chords.length - 1;
    arc.push(
      L.pad([x, 192, z], arcDepth[k], padW(k), last ? 180 : phi, {
        tag: `curve${k + 1}`,
        mat: k % 2 === 0 ? 'floor' : 'accent',
        tint: k % 2 === 0 ? undefined : COL.violet,
      }),
    );
    arcPhi.push(phi);
  });
  // Das letzte Pad liegt in Slalom-Richtung (lückenlos an der Wende), nicht auf dem Bogen:
  // zwischen Pad 6 und seiner Innenkante bleibt ein Keil, in den die Kurve zu eng
  // Fliegende fielen (1°-Hand, 1 von 16 Seeds). Innen an seiner vorderen Hälfte eine Leiste.
  const lastPad = arc[arc.length - 1];
  const IN_W = 96;
  L.platform(Frame.at(lastPad.center, 180), [-arcDepth[arcDepth.length - 1] / 2, 0], [-128 - IN_W, -128], 192, { tag: 'curveIn', mat: 'floor' });
  // Speed-Strecke nach der Kehre: Takt = gemessenes Tempo des perfekten Bots an CP3 (Messbau 3). Aus der
  // Kehren-Planung geschätzt (0.95 × Plan-Tempo) lag der Slalom je nach Kehre 5–10 % neben seinem echten
  // Tempo; er übersprang Inseln oder bremste hart vor der letzten (Zeit ±1–3 s über den Start-Kasten).
  const SLALOM_V = m.cp3?.v ?? perfect(KEHRE_V0, arcSpeed.length);
  arc.forEach((p, k) => L.node(p.center, { jump: true, minSpeed: Math.round(arcSpeed[k + 1] ?? SLALOM_V) }));
  // Kante (CP2) bis LEDGE_GAP vor das erste Kehren-Pad (mindestens 256 u): mit größeren
  // Sehnen rückt Pad 1 weiter weg, eine feste Länge ließ eine Lücke, vor der jeder langsame
  // Hop aus dem Stand landete.
  const LEDGE_GAP = 120;
  const pad1 = Frame.at(arc[0].center, arcPhi[0]);
  const pad1Rear = Math.min(...[-1, 1].map((sv) => -pad1.xz(-arcDepth[0] / 2, (sv * padW(0)) / 2)[1]));
  const LEDGE_END = Math.max(LE + 256, pad1Rear - LEDGE_GAP);
  L.platform(F, [LE + LIP, LEDGE_END], [-224, 224], LEDGE_TOP, { mat: 'checkpoint', thick: 128, tag: 'ledge' });

  // ── 6 WENDE (Checkpoint) und SPEED-STRECKE: Slalom, Terrassen bergab nach Süden ──
  const last = arc[arc.length - 1];
  const G = Frame.at(last.center, 180);
  const turnPitch = hop(SLALOM_V);
  // Zum Slalom hin verlängert: die erste Lücke nach dem Checkpoint ist klein.
  // Nach hinten lückenlos an das letzte Kehren-Pad: die Kehre prüft das
  // Kurven-Strafen, der Ausgang soll kein Todesband sein. Mit Lücke (215, auch
  // 120 u) fiel jeder langsame Hop, der vorn auf dem letzten Pad abging, vor die
  // Wende (Seed-Sweep der Bots, E2E-Review).
  const turnU0 = arcDepth[arcDepth.length - 1] / 2;
  const cp3 = L.platform(G, [turnU0, turnPitch + 256], [-192, 192], 192, { mat: 'checkpoint', tag: 'turn' });
  {
    const [a, b] = aabbOf(G, [cp3.u0, cp3.u1], [-192, 192], [192, 352]);
    L.checkpoint(3, a, b, G.p(cp3.u0 + 96, 0, 192), 180);
  }
  L.node(cp3.center, { jump: true, minSpeed: SLALOM_V, note: 'Slalom' });

  // Könner-Abkürzung: eine Innenbahn von Kehren-Pad 1 zur Wende (CP3). Spart Weg und
  // Hops, verlangt engeres Kurven-Strafen und Zielen (schmale Balken über dem Nichts).
  // Nicht in der Bot-Route (designProbes: expertIslands). Eine gerade Sehne bis zur Wende
  // verlangt an Pad 1 einen Knick von ~80° (unfliegbar); die Bahn ist deshalb eine Kurve
  // (kubische Bézier), die an Pad 1 in Laufrichtung beginnt und an der Wende in
  // Slalom-Richtung endet. CUT_N tiefe Balken in gleichem Abstand entlang der Bahn (Pad 1 →
  // Balken → Wende: CUT_N + 1 gleich lange Hops ≈ Sprungweite des perfekten Strafers ab Pad 1),
  // Lücken nur CUT_GAP: wer etwas langsamer ankommt, landet früher auf dem tiefen Balken statt
  // zu bremsen. Gemessen (Ziel-Zeit, perfekter Bot über 49 Starts, Hände 24 Seeds): perfekter Bot
  // 1.1 s schneller als über die Kehre, Hand 1° Ø 0.6 s, Hand 1.5° Ø 1.9 s; Abschnitt CP2 → CP3
  // Hand 1° Ø 1.35 s. Mit festen 176er-Lücken (Mitten 567 u) bremste der perfekte Bot vor jedem
  // zweiten Balken (Ersparnis Hand 1° 0.84 s).
  const CUT_W = 160;
  const CUT_GAP = 96;
  const cutA = arc[0].center;
  const cutB = cp3.on(cp3.u0 + CUT_END);
  const tA = [arc[1].center[0] - cutA[0], arc[1].center[2] - cutA[2]];
  const tB = G.xz(1, 0);
  const tBx = tB[0] - G.x;
  const tBz = tB[1] - G.z;
  const tAl = Math.hypot(tA[0], tA[1]);
  // Griff × Sehne: kürzer knickt die Bahn an Pad 1, länger schneidet sie die Pads 2 und 7.
  const handle = 0.1 * dist2(cutA, cutB);
  const P1: V2 = [cutA[0] + (tA[0] / tAl) * handle, cutA[2] + (tA[1] / tAl) * handle];
  const P2: V2 = [cutB[0] - tBx * handle, cutB[2] - tBz * handle];
  const bez = (t: number): V2 => {
    const s = 1 - t;
    const a = s * s * s;
    const b = 3 * s * s * t;
    const c = 3 * s * t * t;
    const d = t * t * t;
    return [a * cutA[0] + b * P1[0] + c * P2[0] + d * cutB[0], a * cutA[2] + b * P1[1] + c * P2[1] + d * cutB[2]];
  };
  // Bogenlänge tabellieren, dann gleichmäßig verteilen.
  const SAMPLES = 400;
  const acc: number[] = [0];
  for (let i = 1; i <= SAMPLES; i++) acc.push(acc[i - 1] + dist2(bez((i - 1) / SAMPLES), bez(i / SAMPLES)));
  const cutLen = acc[SAMPLES];
  const atLen = (len: number): number => {
    const i = Math.max(1, acc.findIndex((x) => x >= len));
    return (i - 1 + (len - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1])) / SAMPLES;
  };
  // Balkenmitten gleichmäßig zwischen Pad-1-Mitte und Wende-Knoten; Tiefe = Abstand − CUT_GAP,
  // in 16er-Schritten gekürzt, falls ein Balken einem Kehren-Pad näher als 32 u käme.
  const cutStep = cutLen / (CUT_N + 1);
  const cutPads: V2[] = [];
  for (let k = 0; k < CUT_N; k++) cutPads.push(bez(atLen((k + 1) * cutStep)));
  const kehreRects: Rect[] = [...arc.map((p, k) => rectOf(p.center, k === arc.length - 1 ? 180 : arcPhi[k], arcDepth[k], padW(k))), rectOf(cp3.center, G.yaw, cp3.u1 - cp3.u0, 384)];
  const cutDepths: number[] = [];
  cutPads.forEach((c, i) => {
    const prev = i === 0 ? xzOf(cutA) : cutPads[i - 1];
    const next = i === cutPads.length - 1 ? xzOf(cutB) : cutPads[i + 1];
    const yaw = yawTo(prev, next);
    const hitAt = (d: number): number => kehreRects.findIndex((r) => rectsOverlap(rectOf([c[0], 0, c[1]], yaw, d, CUT_W), r, 32));
    let depth = cutStep - CUT_GAP;
    while (depth > CUT_W && hitAt(depth) >= 0) depth -= 16;
    const hit = hitAt(depth);
    if (final && hit >= 0) throw new Error(`level1: Könner-Balken ${i + 1} überlappt ${hit < arc.length ? `Kehren-Pad ${hit + 1}` : 'die Wende'} (Griff/Tempo ändern)`);
    cutDepths.push(depth);
    L.pad([c[0], 192, c[1]], depth, CUT_W, yaw, { mat: 'accent', tint: COL.gold, tag: `cut${i + 1}` });
  });

  // Slalom: versetzte Langinseln in zwei Spalten (±160, 272 breit, 48 u
  // Spaltenabstand > Hull 32). Jede Insel beginnt, wo die vorige (andere
  // Spalte) endet, und ist so lang wie die Vorwärtsweite eines schrägen Hops
  // im Takt des perfekten Strafers ab seinem CP3-Tempo (wächst Hop für Hop wie
  // in der Reihe; mit festem Takt überholte er die Inseln) — die Vorwärtsweite
  // pro Hop ist frei, aber jeder Hop muss die Spalte wechseln: Lenken nur in der
  // Luft, A/D im Wechsel. Eine gerade Linie trifft nur jede zweite Insel.
  // Langsame laufen auf der Insel vor und springen schräg über die Ecke.
  const SL_W = 272;
  /** Spalten-Mitte: 48 u Spaltenabstand (> Hull 32 — eine Gerade über der Fuge trüge sonst auf beiden Spalten). */
  const SL_SHIFT = SL_W / 2 + 24;
  const SL_GAP = 48;
  /** Höhe der schrägen Nase vor jeder Insel (= Inseldicke). */
  const SL_NOSE_H = 64;
  /** Neigung der Nase (Grad, begehbar < 45.6°). */
  const SL_NOSE_DEG = 32;
  /**
   * Zunge vor der Innenecke (ab Insel 2, außer an der Phasen-Insel): flache Schräge (SL_TONGUE_DEG) von
   * SL_TONGUE_D unter der Oberkante bis an den Inselanfang, SL_TONGUE_W breit ab der Innenkante. Knapp zu
   * kurze Querhops treffen genau dort auf (Nasen-Treffer aller Hände: 88 % ≤ 40 u, alle ≤ 80 u neben der
   * Innenkante, 0–40 u unter der Oberkante) — an der 32°-Nase sprangen sie ab und verloren ~45 % Tempo
   * (Hände 1.5°–3° ~400 u/s je Slalom), auf der flachen Zunge landen sie (Hang-Landung: bergauf kein Verlust).
   * Gemessen (24 Seeds): Einbrüche je Lauf Hand 1.5°/2°/3° 473/476/413 → 103/86/138 u/s, an Zungen-Inseln 0.
   * Die Zunge verlängert die Landefläche auch für Geradeaus-Hüpfer — deshalb nie an der Phasen-Insel; Nachbarschaft
   * (W 64/96/128 × D 16/24/32 × 7/9/11°): 24/27 Varianten 0/7020 in der Lenkprobe, nur D 32 bei 7° (Zunge 261 u
   * lang) ließ 52–84 Läufe ab 1213 u/s durch. 5 Inseln mit Zungen überall: 86–660/7020 ab 1073 u/s (chaotisch).
   */
  const SL_TONGUE_W = 96;
  const SL_TONGUE_D = 24;
  const SL_TONGUE_DEG = 9;
  /** Spalte der Insel k (−1 / +1 in v). */
  const colOf = (k: number): 1 | -1 => (k % 2 === 0 ? -1 : 1);
  const lastCol = colOf(SL_N - 1);
  /**
   * Phasen-Insel: die erste Insel (ab Insel 2) in der Spalte der letzten Insel behält die volle 32°-Nase.
   * In dieser Spalte führt die Gerade legal in die Rutsche; Wende → Phasen-Insel → letzte Insel verlangt bei
   * EINEM Tempo zwei unvereinbare Weiten (die Wende legt fest, wo man auf der Phasen-Insel landet), und wer die
   * Nase trifft, springt mit ~55 % Tempo ab — die Gerade reißt. Die andere Spalte sperrt das Tor vor der Rutsche.
   * Die Nase kostet Hände ~40 % ihrer Einbrüche, fängt aber auch, wer von der Wende mittig über die Spaltenfuge
   * hüpft (der Anprall wirft ihn hoch, er kommt weiter). Viertes Review: Sperr-Finne in der Gegenspalte + Zunge an
   * der Phasen-Insel, oder 16/20/25°-Nase — Einbrüche Hand 1.5°/2° fast 0, aber ab CP3-Stand (nach jedem Respawn)
   * Tode Hand 2°/3° 2/1 → 4–13/6–9 von 96; verworfen.
   */
  let phaseIsland = 1;
  while (colOf(phaseIsland) !== lastCol) phaseIsland++;
  /** Vorwärtsweite des schrägen Hops Nr. k (perfekter Strafer ab CP3) = Abstand der Inselanfänge. */
  const slPitch = (k: number): number => Math.sqrt(hop(perfect(SLALOM_V, k)) ** 2 - (2 * SL_SHIFT) ** 2);
  const slLens: number[] = [];
  let su = cp3.u1 + SL_GAP;
  const slalom: PlacedPlatform[] = [];
  for (let k = 0; k < SL_N; k++) {
    const sv = colOf(k) * SL_SHIFT;
    const len = ceil16(slPitch(k) - SL_GAP);
    slLens.push(len);
    const style = { mat: k % 2 === 0 ? 'accent' : 'floor', tint: k % 2 === 0 ? COL.pink : undefined } as const;
    slalom.push(L.platform(G, [su, su + len], [sv - SL_W / 2, sv + SL_W / 2], 192, { ...style, tag: `slalom${k + 1}` }));
    // Nase vor jeder Insel (ab Insel 2): Schräge (begehbar) statt senkrechter Stirn.
    // Wer langsamer als geplant ist, springt mit Auto-Hop am Inselanfang ab und kam
    // bis 20 u zu kurz an: Stirnwand, vel → 0, Tod (Hand 2°: 3 von 8 Seeds). Mit der
    // Nase landet er auf der Schräge. Lenken bleibt Pflicht (die Spalten liegen 320 u
    // auseinander — designProbes: slalomNeedsSteering). 32° statt 40° (l1l2): auf den
    // längeren Inseln im Takt des perfekten Strafers landet ein Stand-Start an CP3 auf den
    // Nasen — mit 40° kippte das Tempo dort auf ~190 u/s (perfekter Bot CP3 → Ziel 16.7 s;
    // 25/28/30/32/33/35°: 14.4/12.7/12.7/12.7/17.6/18.6 s). Slalom-Probe und Jitter-Median
    // gleich. Achtung, chaotisch: ob einer der 8 Validator-Seeds vom Slalom fällt, wechselt
    // von Grad zu Grad (28–31° je 1–2 Warnungen); über 32 Seeds fallen je Modell 0–2 Läufe, wie vorher.
    if (k > 0) {
      const nose = SL_NOSE_H / Math.tan((SL_NOSE_DEG * Math.PI) / 180);
      const inner = sv - colOf(k) * (SL_W / 2);
      const outer = sv + colOf(k) * (SL_W / 2);
      const tongue = k !== phaseIsland ? SL_TONGUE_W : 0;
      const split = inner + colOf(k) * tongue;
      const span = (a: number, b: number): V2 => (a < b ? [a, b] : [b, a]);
      L.ramp(G, [su - nose, su], span(split, outer), 192 - SL_NOSE_H, 192, { ...style, tag: `slalom${k + 1}Nose`, thick: 0 });
      if (tongue > 0) {
        const tl = SL_TONGUE_D / Math.tan((SL_TONGUE_DEG * Math.PI) / 180);
        L.ramp(G, [su - tl, su], span(inner, split), 192 - SL_TONGUE_D, 192, { ...style, tag: `slalom${k + 1}Tongue`, thick: SL_NOSE_H - SL_TONGUE_D });
      }
    } else {
      // Insel 1: flache Lippe (SL_TONGUE_DEG) über die 48-u-Lücke zur Wende. Ein knapp zu kurzer Hop von der Wende
      // kam 1–2 u unter der Oberkante an die Stirn (533 → 11 u/s, Tod "nach turn"); auf der Lippe landet er.
      // Gemessen (96 Seeds, Hände 1.5°/2°/3°): Tode 5 → 3 (die "turn"-Tode entfallen), Einbrüche je Lauf
      // 91/121/153 → 73/120/138 u/s, Lenkprobe 0/7020, CP3-Stand-Starts unverändert. Eine 32°-Nase hier war
      // schlechter (Hand 1° Ø 0 → 63 u/s: sie trifft der steigende Hop von der Wende). 1 u Abstand zur Wende
      // (keine koplanare Stirn).
      const drop = (SL_GAP - 1) * Math.tan((SL_TONGUE_DEG * Math.PI) / 180);
      L.ramp(G, [su - SL_GAP + 1, su], [sv - SL_W / 2, sv + SL_W / 2], 192 - drop, 192, { ...style, tag: 'slalom1Lip', thick: SL_NOSE_H - drop });
    }
    su += slPitch(k);
  }
  slalom.forEach((p) => L.node(p.center, { jump: true, minSpeed: Math.round(SLALOM_V) }));
  const slEnd = slalom[slalom.length - 1];
  // Vorbeizieh-Pylonen (Polish-Runde 2): der Whoosh (Game.probeNear, ±160 u quer, nur
  // KOLLISIONS-Geometrie) war in Level 1 außer an der Rutsche stumm — alle Säulen standen
  // > 400 u neben der Linie. Je Insel ein Pylon außen, SL_PYLON_GAP neben der Inselkante
  // (116 u von der Inselmitte), mittig in der Länge — dort ist der Spieler der Inselmitte
  // am nächsten (der schräge Hop geht von Inselmitte zu Inselmitte). Als Finne 128 u lang:
  // ein 24 u dünner Pylon war bei ~870 u/s nur zwei Proben (30 ms) lang neben einem, ein
  // kaum hörbarer Blip; die Finne gibt ~0.15 s. Kollidierbar (sonst hört ihn die Probe
  // nicht), aber außerhalb jeder Bahn: wer dort ist, ist schon neben der Insel; die
  // Geradeaus-Probe (Versatz ±176) bleibt 36 u daneben. Vom Kill-Bereich bis über jeden
  // Sprung; Leuchtkopf als Deko.
  {
    const SL_PYLON_GAP = 28;
    const SL_PYLON_W = 24;
    const SL_PYLON_LEN = 128;
    slalom.forEach((p, k) => {
      const v = colOf(k) * (SL_SHIFT + SL_W / 2 + SL_PYLON_GAP + SL_PYLON_W / 2);
      const u = (p.u0 + p.u1) / 2;
      L.add(orientedBox(G, [u - SL_PYLON_LEN / 2, u + SL_PYLON_LEN / 2], [v - SL_PYLON_W / 2, v + SL_PYLON_W / 2], [-600, 440], { mat: 'dark', tag: 'slalomPylon' }));
      L.add(orientedBox(G, [u - SL_PYLON_LEN / 2 - 8, u + SL_PYLON_LEN / 2 + 8], [v - SL_PYLON_W, v + SL_PYLON_W], [440, 488], { mat: 'accent', tint: k % 2 ? COL.cyan : COL.pink, collide: false, tag: 'slalomPylonHead' }));
    });
  }

  // ── 7 FINALE: SURF-RUTSCHE, Kicker, Flug ins Ziel ───────────────────────
  // Der erste Surf des Spiels, verzeihend (früher fünf Terrassen: 5.8 s ohne
  // Risiko und ohne Entscheidung, L1 kam nie über 886 u/s; L2 verlangte Surfen,
  // das nirgends eingeführt war). Eine fallende Rampe (Querschnitt wie S1 in
  // Level 2) beginnt unter dem Ende der letzten Slalom-Insel — keine Stirnfläche im Weg —,
  // fällt 10°, endet mit einem kleinen Kicker und schickt einen über 1000 u/s ins
  // Ziel. Länge gemessen (tools/levels/sweepChute.ts, perfekter Bot): 1600 u hinter
  // der Insel → Launch 926 u/s; 1900 u → 1004 u/s. Ein 20°-Knick (Speed aus Höhe)
  // war langsamer: der Bot verliert an der konvexen Kante den Kontakt (758 u/s).
  // Wer nicht surfen kann (W gehalten, rutscht ab) oder neben der Rampe landet,
  // fällt 64 u auf eine durchgehende Auffangfläche ohne Kill-Zone (seitlich eine
  // Bande) und hüpft auf ihr bergab ins Ziel: langsamer, aber nie tot.
  const CHUTE_W = 768;
  /** Stücke der Rutsche: Länge (das erste zählt ab dem Ende der letzten Insel) und Achsgefälle. */
  const CHUTE_PIECES: ReadonlyArray<{ readonly length: number; readonly slopeDeg: number }> = process.env.CHUTE
    ? (JSON.parse(process.env.CHUTE) as Array<{ length: number; slopeDeg: number }>) // nur für Mess-Sweeps
    : [
        { length: 1900, slopeDeg: 10 },
        { length: 256, slopeDeg: 3 },
        { length: 256, slopeDeg: -8 },
      ];
  /**
   * Rampe beginnt so weit VOR dem Ende der letzten Insel (die Südkappe liegt unter ihr). Früher unter dem
   * Insel-Anfang: dann fing die Rampe auch, wer in der Spalten-Lücke VOR der letzten Insel fiel — mit fünf
   * Inseln kam so ein Geradeaus-Hüpfer ab 1183 u/s ohne Lenken bis in die Rutsche (dichte Lenkprobe 61/7020).
   * Wer die letzte Insel verfehlt, fällt jetzt wie bei jeder anderen (kill-slalom).
   */
  const CHUTE_UNDER = 64;
  /** First am Rampenbeginn: so tief unter der Insel, dass die Flanke die Insel (v ≥ 24) nicht schneidet. */
  const CHUTE_APEX = 192 - 40;
  /** Auffangfläche: so weit unter dem Rampenfuß, seitlich so weit über die Füße hinaus; danach mit 10° bis ins Ziel. */
  const CATCH_BELOW = 64;
  const CATCH_SIDE = 256;
  const CATCH_HALF = CHUTE_W / 2 + CATCH_SIDE;
  const CATCH_TAN = Math.tan((10 * Math.PI) / 180);
  /**
   * Route-Knoten an der Flanke auf der Seite der letzten Insel (bei ungerader Inselzahl −v):
   * CHUTE_LINE unter dem First am Einstieg, bis CHUTE_DIVE am Launch — die Ideallinie taucht
   * die Flanke hinunter und macht Höhe zu Tempo.
   */
  const CHUTE_LINE = Number(process.env.CHUTE_LINE ?? 240);
  const CHUTE_DIVE = Number(process.env.CHUTE_DIVE ?? 440);
  const chuteSide = lastCol;
  const chuteU0 = slEnd.u1 - CHUTE_UNDER;
  const pieces = CHUTE_PIECES.map((p, i) => (i === 0 ? { ...p, length: slEnd.u1 - chuteU0 + p.length } : p));
  const mainLen = pieces[0].length;
  const chute = L.surfChain({ start: G.xz(chuteU0), yaw: G.yaw, apex: CHUTE_APEX, width: CHUTE_W, tag: 'chute', pieces });
  // Slalom-Tor: eine Finne in der Spalte OHNE letzte Insel, direkt vor der Rutsche (von der Innenkante bis zur
  // Pylonen-Linie, vom Kill-Bereich bis über jeden Sprung). Mit vier Inseln erreichte ein Geradeaus-Hüpfer dieser
  // Spalte die tiefe Rutschen-Flanke über die letzte Insel hinweg (dichte Lenkprobe 252/7020 ab 1148 u/s) — das Tor
  // sperrt diese Gerade unabhängig von Tempo und Phase. Keine Lauflinie führt hierher: der letzte Querhop endet auf
  // der letzten Insel, 48 u neben dem Tor (Vorbeizieh-Whoosh). 16 u vor dem Rutschen-Anfang (keine koplanare Stirn,
  // wer abprallt, fällt vor der Rutsche).
  {
    const GATE_GAP = 16;
    const GATE_T = 24;
    const side = -lastCol;
    const v0 = side * (SL_SHIFT - SL_W / 2);
    const v1 = side * (SL_SHIFT + SL_W / 2 + 52);
    const gv: V2 = v0 < v1 ? [v0, v1] : [v1, v0];
    const gu: V2 = [chuteU0 - GATE_GAP - GATE_T, chuteU0 - GATE_GAP];
    L.add(orientedBox(G, gu, gv, [-600, 440], { mat: 'dark', tag: 'slalomGate' }));
    L.add(orientedBox(G, [gu[0] - 8, gu[1] + 8], [gv[0] - 8, gv[1] + 8], [440, 488], { mat: 'accent', tint: COL.cyan, collide: false, tag: 'slalomGateHead' }));
  }
  const kick = chute[chute.length - 1];
  const kickEndU = chuteU0 + chute.reduce((sum, r) => sum + r.o.length, 0);
  const foot = (r: SurfRamp, s: number): number => r.apexAt(s) - r.height;
  // Auffangfläche als Knickzug: CATCH_BELOW unter dem Fuß der fallenden Stücke,
  // unter Kicker und Lücke mit 10° weiter, bündig an die Zielkante. Knicke 16 u
  // hinter den Rampenstößen (sonst lägen die Stirnflächen von Fläche und Sockel koplanar).
  const CATCH_LEAD = 32; // vor der Rampe (sonst lägen ihre Rückseite und die des Sockels koplanar)
  const catchU0 = chuteU0 - CATCH_LEAD;
  const knots: Array<[number, number]> = [[catchU0, foot(chute[0], 0) - CATCH_BELOW + CATCH_LEAD * Math.tan((pieces[0].slopeDeg * Math.PI) / 180)]];
  {
    let u = chuteU0;
    for (const r of chute) {
      u += r.o.length;
      if (r.slopeDeg <= 0 || foot(r, r.o.length) - CATCH_BELOW > knots[knots.length - 1][1]) break;
      knots.push([u + 16, foot(r, r.o.length) - CATCH_BELOW - 16 * Math.tan((r.slopeDeg * Math.PI) / 180)]);
    }
  }
  const FIN_GAP = 256;
  const FIN_DEPTH = 2048;
  const finU0 = kickEndU + FIN_GAP;
  {
    const [lu, ly] = knots[knots.length - 1];
    knots.push([finU0, ly - (finU0 - lu) * CATCH_TAN]);
  }
  const catchTop = (u: number): number => {
    for (let k = 1; k < knots.length; k++) {
      const [u0, y0] = knots[k - 1];
      const [u1, y1] = knots[k];
      if (u <= u1 || k === knots.length - 1) return y0 + ((y1 - y0) * (u - u0)) / (u1 - u0);
    }
    return knots[0][1];
  };
  const finishTop = Math.round(knots[knots.length - 1][1]);
  // Bande an beiden Rändern bis ans Ende des Ziels: wer ohne Surf-Technik von der
  // 60°-Flanke rutscht, landet mit ~400 u/s nach außen und hüpft mit Auto-Hop
  // weiter nach außen — ohne Bande flog jeder dritte Geradeaus-Läufer seitlich
  // von der Auffangfläche. Oberkante leuchtet (Trim) und rahmt die Rutsche.
  // 192 statt 128 (Review l1l2): W+Leertaste-Halter mit Blick 15–30° neben der Route
  // (Luftlenkung dreht sie mit) oder gehaltenem C (Crouch-Hop +18 u) kamen nach dem
  // Flanken-Kontakt mit Auto-Hop bis 20 u über die 128er-Bande: 236/7000 tot, mit 192 0/6000.
  const RAIL_H = 192;
  const railV = (side: number): V2 => (side < 0 ? [-CATCH_HALF - 32, -CATCH_HALF] : [CATCH_HALF, CATCH_HALF + 32]);
  for (let k = 1; k < knots.length; k++) {
    const [u0, y0] = knots[k - 1];
    const [u1, y1] = knots[k];
    const last = k === knots.length - 1;
    const y1r = last ? finishTop : r3(y1);
    L.ramp(G, [u0, u1], [-CATCH_HALF, CATCH_HALF], r3(y0), y1r, { mat: 'metal', tag: 'chuteCatch' });
    for (const side of [-1, 1]) L.ramp(G, [u0, u1], railV(side), r3(y0) + RAIL_H, y1r + RAIL_H, { mat: 'accent', tint: COL.cyan, thick: RAIL_H + 64, tag: 'chuteRail' });
  }
  for (const side of [-1, 1]) L.platform(G, [finU0, finU0 + FIN_DEPTH + 64], railV(side), finishTop + RAIL_H, { mat: 'accent', tint: COL.cyan, thick: RAIL_H + 96, tag: 'finishRail' });
  // Sockel unter jedem Rampenstück: vom Fuß bis in die Auffangfläche — sonst läge
  // unter der Rampe ein 64 u hoher Schlitz, in den man geduckt kriechen könnte.
  let su0 = chuteU0;
  for (const r of chute) {
    const f0 = foot(r, 0);
    const f1 = foot(r, r.o.length);
    const floorLow = Math.min(catchTop(su0), catchTop(su0 + r.o.length));
    L.ramp(G, [su0, su0 + r.o.length], [-CHUTE_W / 2, CHUTE_W / 2], f0, f1, { mat: 'wall', trim: false, thick: Math.min(f0, f1) - floorLow + 16, tag: `${r.o.tag ?? ''}Base` });
    su0 += r.o.length;
  }
  const fin = L.platform(G, [finU0, finU0 + FIN_DEPTH], [-CATCH_HALF, CATCH_HALF], finishTop, { mat: 'finish', thick: 96, tag: 'finish' });
  // Prallwand am Ende: Überflieger bleiben im Ziel.
  L.platform(G, [fin.u1, fin.u1 + 64], [-CATCH_HALF, CATCH_HALF], finishTop + 480, { mat: 'wall', thick: 576, trim: false, tag: 'backstop' });
  {
    // Niedrig: der Lauf endet mit der Landung, nicht beim Überfliegen der Zielkante.
    // Mit den Banden (wer oben auf der Bande läuft, ist auch im Ziel: Füße auf 192 < 240).
    // 240 wie vor der höheren Bande — höher würde hohe Flüge früher stoppen (Medaillen).
    const FINISH_ZONE_H = 240;
    const [a, b] = aabbOf(G, [fin.u0, fin.u1], [-CATCH_HALF - 32, CATCH_HALF + 32], [finishTop, finishTop + FINISH_ZONE_H]);
    L.finishZone(a, b);
  }

  // Route: Surf-Knoten an der Flanke der letzten Insel (chuteSide); minSpeed wird unten gemessen.
  const surfNodes: number[] = [];
  const land0 = (slEnd.u0 + slEnd.u1) / 2 + 0.8 * hop(SLALOM_V) - chuteU0;
  const chuteLen = kickEndU - chuteU0;
  /** Knoten bei Kettenposition g (ab Rampenbeginn), Tiefe linear von CHUTE_LINE (Einstieg) bis CHUTE_DIVE (Launch). */
  const surfNode = (g: number, note?: string): void => {
    let off = 0;
    let k = 0;
    while (k < chute.length - 1 && g > off + chute[k].o.length) off += chute[k++].o.length;
    const depth = CHUTE_LINE + ((CHUTE_DIVE - CHUTE_LINE) * Math.max(0, g - land0)) / (chuteLen - 8 - land0);
    surfNodes.push(L.route.length);
    L.node(chute[k].riderPos(g - off, chuteSide, depth), { surf: true, note });
  };
  surfNode(land0, 'Rutsche');
  for (const g of [land0 + 480, land0 + 960]) if (g < mainLen - 160) surfNode(g);
  surfNode(mainLen - 64);
  surfNode(mainLen + 128);
  surfNode(chuteLen - 8, 'Launch');
  // Messbauten brauchen das Surf-Band nicht (sie enden vor der Crouch-Kante).
  const measured = final ? measureSurfSpeeds(L.build(), [{ surfer: 0 }, { surfer: 2 }], { grid: SURF_GRID }) : surfNodes.map(() => 500);
  surfNodes.forEach((i, k) => {
    const v = final ? measured[i] : measured[k];
    if (!Number.isFinite(v)) throw new Error(`level1: Surf-Knoten ${i} wird im Surf-Raster nicht erreicht`);
    L.route[i] = { ...L.route[i], minSpeed: Math.round(0.9 * v) };
  });
  const launch = L.route[surfNodes[surfNodes.length - 1]];
  // Ziel-Knoten geradeaus hinter dem Launch (gleiches v wie der Launch-Knoten) und weit
  // hinten: der Bot beendet seine Route beim Passieren des Knotens — auch im Flug hoch
  // über dem (niedrigen) Ziel-Trigger; so landet er vorher.
  L.node(fin.on(fin.u0 + 1700, chuteSide * (CHUTE_DIVE / Math.tan((60 * Math.PI) / 180) + 16)), { minSpeed: 250, note: 'Ziel' });

  // ── KILL-ZONEN: ~300–450 u unter jedem Abschnitt statt 1000 u Void ─────
  // Hinweg (Start … Kante, x um 0) und Rückweg (Kehre-Ende … Ziel, x um −2R)
  // liegen seitlich getrennt; die Kehre selbst bekommt eine eigene Zone.
  const zOf = (uu: number): number => F.xz(uu)[1];
  L.killZone([-900, -800, zOf(U3)], [900, -400, zOf(START_U[0] - 400)], 'kill-start');
  L.killZone([-900, -700, zOf(LEDGE_END)], [900, -280, zOf(U3)], 'kill-row');
  {
    const xs = arc.map((p) => p.center[0]);
    const zs = arc.map((p) => p.center[2]);
    const zMin = Math.min(...zs, zOf(LEDGE_END)) - 600;
    L.killZone([Math.min(...xs) - 600, -650, zMin], [900, -250, zOf(LEDGE_END)], 'kill-curve');
    // Rückweg auf 192 bis zum Beginn der Rutsche (dahinter fängt die Auffangfläche).
    const backX = last.center[0];
    const zBack = G.xz(catchU0)[1];
    L.killZone([backX - 700, -650, Math.min(zMin, zBack)], [backX + 700, -250, Math.max(zMin, zBack)], 'kill-slalom');
  }
  // Neben der Auffangfläche (wer seitlich herunterfällt): gestuft in 512er-Stücken,
  // jede Zone 300 u unter der Fläche ihres Stücks.
  {
    const SEG = 512;
    const uEnd = fin.u1 + 64;
    for (let ua = catchU0, k = 1; ua < uEnd; ua += SEG, k++) {
      const ub = Math.min(uEnd, ua + SEG);
      const low = Math.min(catchTop(Math.min(ub, finU0)), finishTop);
      for (const side of [-1, 1]) {
        const v: V2 = side < 0 ? [-CATCH_HALF - 900, -CATCH_HALF - 64] : [CATCH_HALF + 64, CATCH_HALF + 900];
        const [a, b] = aabbOf(G, [ua, ub], v, [killY, low - 300]);
        L.killZone(a, b, `kill-chute-${side < 0 ? 'l' : 'r'}${k}`);
      }
    }
  }

  // ── DEKO ────────────────────────────────────────────────────────────────
  // Tore über der Strecke: fliegen vorbei und machen Tempo lesbar.
  L.arch(F, START_U[1] - 40, [-256, 256], 0, 320, COL.magenta);
  L.arch(F, (row[1].u1 + row[2].u0) / 2, [-160, 160], 128, 288, COL.cyan);
  L.arch(F, (row[ROW_N - 2].u1 + row[ROW_N - 1].u0) / 2, [-192, 192], 128, 320, COL.magenta);
  // Tore über der Rutsche (Pfosten außerhalb der Auffangfläche, Balken hoch über dem Grat)
  // und ein Ziel-Tor weit hinten, das die Landung rahmt statt im Flug zu liegen. Gezählt ab
  // dem Ende der letzten Slalom-Insel: darüber springt man noch ab (sonst Balken im Flug).
  [320, 1120].map((s) => s + slEnd.u1 - chuteU0).forEach((s, k) => {
    const r = chute[0];
    L.arch(G, chuteU0 + s, [-CATCH_HALF - 32, CATCH_HALF + 32], catchTop(chuteU0 + s), r.apexAt(s) - catchTop(chuteU0 + s) + 360, k % 2 ? COL.cyan : COL.magenta, 48, 'chuteArch');
  });
  L.arch(G, fin.u0 + 1600, [-CATCH_HALF - 32, CATCH_HALF + 32], finishTop, 560, COL.gold, 56, 'finishArch');

  // Pylonen entlang Hop-Reihe und Rückweg (unten verankert, oben Leuchtkopf),
  // weit genug draußen, dass sie die nächste Plattform nie verdecken.
  for (let k = 0; k < 5; k++) {
    const uu = PU1 + 150 + k * 420;
    L.pylon(F.xz(uu, -600), -700, 960 + (k % 2) * 160, k % 2 ? COL.cyan : COL.magenta, 16);
    L.pylon(F.xz(uu + 210, 600), -700, 1040 - (k % 2) * 160, k % 2 ? COL.magenta : COL.cyan, 16);
  }
  for (let k = 0; k < 6; k++) {
    const uu = cp3.u1 + 200 + k * 560;
    L.pylon(G.xz(uu, CATCH_HALF + 360), -1600, 1500 + (k % 2) * 200, k % 2 ? COL.orange : COL.cyan, 16);
  }

  // Lautsprecher-Stacks neben Start und Ziel, auf eigenen Sockeln.
  for (const side of [-1, 1]) {
    const fs = Frame.at(F.xz(-120, side * 400), side < 0 ? -30 : 30);
    L.decoBox([fs.x - 80, -400, fs.z - 80], [fs.x + 80, 0, fs.z + 80], { mat: 'dark' });
    L.speakerStack(fs, 3, 112);
    const ff = Frame.at(G.xz(fin.u0 + 512, side * (CATCH_HALF + 160)), 180 + side * 25);
    L.decoBox([ff.x - 80, finishTop - 400, ff.z - 80], [ff.x + 80, finishTop, ff.z + 80], { mat: 'dark' });
    L.speakerStack(ff, 4, 112, finishTop);
  }

  // Ferne Türme: Silhouetten im Nebel, geben der Leere Maßstab.
  const towers: Array<[number, number, number, number, string]> = [
    [2600, -1200, 220, 2600, COL.magenta],
    [3200, -3600, 300, 3400, COL.cyan],
    [1800, -7000, 260, 3000, COL.orange],
    // Weiter nördlich als früher (-8600): die größere Kehre (Plan 007) reicht bis z ≈ -8500.
    [-1100, -9600, 340, 3800, COL.magenta],
    [-4400, -6800, 240, 2800, COL.cyan],
    [-5000, -3000, 280, 3200, COL.orange],
    [-4600, 400, 220, 2400, COL.magenta],
    [1600, 2400, 200, 2200, COL.cyan],
  ];
  // Aus dem Void-Grid (voidY -1900) herauswachsend, nicht darüber schwebend.
  for (const [x, z, w, h, crown] of towers) L.tower([x, z], w, -2000, h + 600, { crown });

  // Kurven-Mitte: Monolith als Blickanker für die Kehre — aus der Sichtachse der
  // Könner-Bahn gerückt: mindestens MONO_CLEAR von jeder Insel, vom nächsten weg.
  {
    const MONO_CLEAR = 520;
    const mono: [number, number] = [C[0], C[1]];
    for (let it = 0; it < 8; it++) {
      const near = cutPads.reduce((b, p) => (dist2(p, mono) < dist2(b, mono) ? p : b), cutPads[0]);
      const d = dist2(near, mono);
      if (d >= MONO_CLEAR) break;
      mono[0] += ((mono[0] - near[0]) / Math.max(1, d)) * (MONO_CLEAR - d + 8);
      mono[1] += ((mono[1] - near[1]) / Math.max(1, d)) * (MONO_CLEAR - d + 8);
    }
    L.tower(mono, 160, -900, 1400, { crown: COL.gold });
  }

  const gaps = [row[0].u0 - PU1, ...row.slice(1).map((p, k) => p.u0 - row[k].u1), h7[0] - row[ROW_N - 1].u1];
  if (final && !(L0 > LE + PHYS.hullHalf && L0 < LEDGE_END - PHYS.hullHalf)) throw new Error(`level1: Crouch-Landepunkt ${L0.toFixed(0)} liegt nicht auf der Kante`);
  if (Math.max(...gaps) > SPRINT_GAP) throw new Error(`level1: Hop-Reihe hat eine Lücke > ${SPRINT_GAP.toFixed(0)} u (Sprint von der Kante)`);
  if (!final || !m.takeoff || !m.h7) return L.build();
  reportDesign({
    takeoff: m.takeoff,
    h7: m.h7,
    wall: LE - m.h7.u,
    rowSpeed,
    gaps,
    rowNeed: row.slice(0, ROW_N - 1).map((p, k) => speedFor(row[k + 1].u0 - (p.u0 + p.u1) / 2 - 16, 0, false, RESERVE)),
    arcRadius: R,
    arcSpeed,
    cut: { step: cutStep, n: CUT_N, depth: Math.min(...cutDepths), perfectHop: hop(perfect(m.h7.v, 2)) },
    slalomV: SLALOM_V,
    chuteLen: kickEndU - chuteU0,
    chuteDrop: CHUTE_APEX - Math.min(...chute.map((r) => r.apexAt(r.o.length))),
    launchMin: launch.minSpeed ?? 0,
    finishTop,
    slalomLen: slLens,
    rowDepth: ROW_DEPTH,
  });

  return L.build();
}

interface DesignNumbers {
  readonly takeoff: Landing;
  readonly h7: Landing;
  readonly wall: number;
  readonly rowSpeed: readonly number[];
  readonly gaps: readonly number[];
  readonly rowNeed: readonly number[];
  readonly arcRadius: number;
  readonly arcSpeed: readonly number[];
  readonly cut: { readonly step: number; readonly n: number; readonly depth: number; readonly perfectHop: number };
  readonly slalomV: number;
  readonly chuteLen: number;
  readonly chuteDrop: number;
  readonly launchMin: number;
  readonly finishTop: number;
  readonly slalomLen: readonly number[];
  readonly rowDepth: readonly number[];
}

/** Planungszahlen beim Bauen ausgeben — Gegenprobe für die Doku. */
function reportDesign(d: DesignNumbers): void {
  const f = (n: number): string => n.toFixed(0);
  console.log('  level1 Planung:');
  console.log(
    `    Gemessen (perfekter Bot, Median über ${START_JITTERS.length} Starts): Plateau-Absprung ${f(d.takeoff.v)} u/s (Streuung ${f(d.takeoff.spread)} u), H7-Landung ${f(d.h7.v)} u/s (Streuung ${f(d.h7.spread)} u) ${f(d.wall)} u vor der Wand`,
  );
  console.log(`    Hop-Reihe: Plan-Tempo ${d.rowSpeed.map(f).join(' → ')} u/s; Lücken ${d.gaps.map(f).join(' / ')} u; Tiefen ${d.rowDepth.map(f).join(' / ')} u`);
  console.log(`    Hop-Reihe braucht ab Plattformmitte (mit Reserve): ${d.rowNeed.map(f).join(' / ')} u/s`);
  console.log(`    Kehre: Radius ${f(d.arcRadius)} u, Plan-Tempo ${d.arcSpeed.map(f).join(' / ')}; Slalom ab ${f(d.slalomV)} u/s (CP3 gemessen, Inseln ${d.slalomLen.map(f).join(' / ')} u)`);
  console.log(`    Abkürzung: ${d.cut.n} Balken ≥ ${f(d.cut.depth)} u tief, Mitten ${f(d.cut.step)} u auseinander (Hop des perfekten Strafers ab Pad 1 ≈ ${f(d.cut.perfectHop)} u)`);
  console.log(
    `    Rutsche: ${f(d.chuteLen)} u, ${f(d.chuteDrop)} u Gefälle bis zum Kicker; Launch (unteres Band) ${f(d.launchMin)} u/s; Ziel auf y=${f(d.finishTop)}`,
  );
}

/**
 * ↑C als Pixel-Glyph (wie DUCK_ARROW/DUCK_C an der Wand, render/textures.ts), eine
 * Leerspalte dazwischen. Zeile 0 = "oben" = zur Wand.
 */
const DUCK_ARROW_ROWS = ['..#..', '.###.', '#####', '.###.', '.###.', '.###.', '.###.', '.###.'];
const DUCK_C_ROWS = ['.###.', '##.##', '##...', '##...', '##...', '##...', '##.##', '.###.'];
const DUCK_GLYPH: readonly string[] = DUCK_ARROW_ROWS.map((a, i) => `${a}.${DUCK_C_ROWS[i]}`);

/**
 * Glyph in achsparallele Rechtecke zerlegen: [Zeile von, Zeile bis (exkl.), Spalte von,
 * Spalte bis (exkl.)]. Waagerechte Läufe, gleiche Läufe in Folgezeilen zusammengefasst —
 * keine Überlappung (Markierungen müssen Parallelogramme sein und dürfen nicht doppelt leuchten).
 */
function glyphRects(rows: readonly string[]): Array<readonly [number, number, number, number]> {
  const runs = (row: string): Array<readonly [number, number]> => {
    const out: Array<readonly [number, number]> = [];
    for (let c = 0; c < row.length; ) {
      if (row[c] !== '#') {
        c++;
        continue;
      }
      const c0 = c;
      while (c < row.length && row[c] === '#') c++;
      out.push([c0, c]);
    }
    return out;
  };
  const open = new Map<string, [number, number, number, number]>();
  const done: Array<readonly [number, number, number, number]> = [];
  rows.forEach((row, r) => {
    const cur = new Set<string>();
    for (const [c0, c1] of runs(row)) {
      const key = `${c0}:${c1}`;
      cur.add(key);
      const o = open.get(key);
      if (o) o[1] = r + 1;
      else open.set(key, [r, r + 1, c0, c1]);
    }
    for (const [key, o] of [...open]) {
      if (!cur.has(key)) {
        done.push(o);
        open.delete(key);
      }
    }
  });
  for (const o of open.values()) done.push(o);
  return done;
}

/** Gedrehtes Rechteck im Grundriss: Mitte, Richtung (yaw, Grad) und halbe Maße längs/quer. */
interface Rect {
  readonly c: V2;
  readonly f: V2;
  readonly r: V2;
  readonly hu: number;
  readonly hv: number;
}

function rectOf(c: V3, yaw: number, depth: number, width: number): Rect {
  const f = Frame.at(c, yaw);
  const o = f.xz(0, 0);
  const u = f.xz(1, 0);
  const v = f.xz(0, 1);
  return { c: o, f: [u[0] - o[0], u[1] - o[1]], r: [v[0] - o[0], v[1] - o[1]], hu: depth / 2, hv: width / 2 };
}

/** Überlappen sich zwei Rechtecke (Trennachsen-Test), mit `margin` Abstand? */
function rectsOverlap(a: Rect, b: Rect, margin: number): boolean {
  const dx = b.c[0] - a.c[0];
  const dz = b.c[1] - a.c[1];
  for (const ax of [a.f, a.r, b.f, b.r]) {
    const radius = (q: Rect): number => q.hu * Math.abs(q.f[0] * ax[0] + q.f[1] * ax[1]) + q.hv * Math.abs(q.r[0] * ax[0] + q.r[1] * ax[1]);
    if (Math.abs(dx * ax[0] + dz * ax[1]) > radius(a) + radius(b) + margin) return false;
  }
  return true;
}
