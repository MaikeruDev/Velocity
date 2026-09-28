/**
 * 01 GRUNDKURS — "Lauf. Spring. Strafe."
 *
 * Lehrlevel: jede Station führt genau eine Fähigkeit ein und die nächste
 * baut darauf auf. Hinweg nach Norden (-Z) in die untergehende Sonne,
 * 180°-Kurve, Rückweg nach Süden bergab ins Ziel. Absicht, Speeds und
 * Draufsicht: .docs/research/level-design.md.
 *
 * Hop-Rhythmen kommen aus der Sim (physics.SpeedCurve): Plattformabstände =
 * Sprungweite beim Tempo, das ein guter Strafer an dieser Stelle hat (Mischung
 * aus perfektem und 0.85-Sync-Bot). Wer langsamer ist, landet früher auf der
 * (tiefen) Plattform; alle Lücken bleiben mit Sprint von der Kante machbar.
 */
import type { LevelFile } from '../../src/world/level/LevelFormat';
import { airTime, riseWindow, speedFor, RESERVE, PHYS } from './ballistics';
import type { PlacedPlatform, V2, V3 } from './lib';
import { Frame, LevelBuilder, SurfRamp, aabbOf, arcPoint, chordDeg, dist2, orientedBox, r3, solveArcRadius, xzOf, yawTo } from './lib';
import { measureSurfSpeeds, SpeedCurve, SURF_GRID } from './physics';

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

/** Plan-Tempo nach k Hops ab v0: Mitte zwischen perfektem und 0.85-Sync-Strafer. */
function plan(v0: number, k: number): number {
  return 0.5 * SpeedCurve.of(1).after(v0, k) + 0.5 * SpeedCurve.of(0.85).after(v0, k);
}

/** Unteres Band (Sync 0.85): Präzisionsziele müssen für Langsamere erreichbar sein — zu schnell kann man bremsen, zu kurz nicht. */
function planLow(v0: number, k: number): number {
  return SpeedCurve.of(0.85).after(v0, k);
}

/** Kantensprung mit Sprint: größte flache Lücke (Kante zu Kante) mit 10 % Reserve. */
const SPRINT_GAP = (PHYS.sprintSpeed * airTime(0)) / RESERVE + 2 * PHYS.hullHalf;
/**
 * Ziel-Lücke der Hop-Reihe: mit Luft unter SPRINT_GAP, damit Langsame
 * (3°-Hand, ~450 u/s) jede Lücke per Stop-and-Go von der Kante schaffen.
 * Schnellere Rhythmen machen die Plattformen tiefer statt die Lücken größer.
 */
const ROW_GAP = SPRINT_GAP - 16;

/** Länge von Rampe und Treppe zum Plateau (128 u hoch). Env ASCENT_RUN nur für Mess-Sweeps. */
const ASCENT_RUN = Number(process.env.ASCENT_RUN ?? 448);
/** Halbe Breite von Treppe und Rampe: so breit wie das Plateau — wer mit Auto-Hop seitlich driftet, fällt nicht vom Aufstieg. */
const ASCENT_W = Number(process.env.ASCENT_W ?? 256);

/** Farbe der Start-Markierungen (palette.KIND_COLORS.start). */
const START_GLOW = '#46ff9e';

/** Tiefe der Auffangmulden unter Pflicht-Lücken im Erstkontakt: ein normaler Sprung (57 u) kommt heraus. */
const CATCH_DEPTH = 40;
/** Gräben unter der Hop-Reihe: tiefer als die Mulden (ein Fehlsprung soll spürbar sein), ein Sprung kommt heraus. */
const TRENCH_DEPTH = 48;
/** Tiefe der dunklen Lippe vor der Checkpoint-Fläche an der Crouch-Kante (u). */
const LIP = 48;
/** Plan-Tempo der Hop-Reihe am Plateau-Absprung (u/s). */
const ROW_V0 = 450;
/**
 * Abstände der Hop-Reihe relativ zur Flugweite beim Plan-Tempo. Der perfekte
 * RouteFollower sprang mit voller Weite immer ~20 u zu kurz (er springt dort ab, wo
 * er landet, und landet auf dem Grabenhang vor der nächsten Plattform — flacher
 * Flug, 0.72 statt 0.74 s). Der Rückstand wuchs bis H6 auf ~230 u, der Crouch-Hop
 * ging dann zu früh ab: jeder Lauf stand bei 320 u/s an der Kante (Mess-Sweep
 * 1.0/0.97/0.94/0.91). Mit 0.94 landet er mittig; H7 bekommt 1.04 (der Crouch-Hop
 * braucht den Abstand zur Wand, siehe CROUCH-KANTE). Bots danach: sync 1.0 an der
 * Kante 816 statt 320 u/s, Hand 1° 5/6 statt 3/6, Hand 3° 8/8 statt 7/8 im Ziel.
 */
const ROW_PITCH = 0.94;
const H7_PITCH = 1.04;

/** Auf ein 16-u-Raster aufrunden (lesbare Maße, gleiche Kanten wie das Textur-Raster). */
function ceil16(n: number): number {
  return Math.ceil(n / 16) * 16;
}

export function buildLevel1(): LevelFile {
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
    { gap: 144, depth: 288, width: RUN_W[2], top: 0, tag: 'run3' },
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
  L.ramp(F, [U3, U3 + UP], [-ASCENT_W, 0], 0, 128, { tag: 'stairClip', visible: false });
  L.ramp(F, [U3, U3 + UP], [0, ASCENT_W], 0, 128, { tag: 'ramp' });
  const plateau = L.platform(F, [U3 + UP, U3 + UP + 384], [-256, 256], 128, { mat: 'checkpoint', thick: 192, tag: 'plateau' });
  // Mittig: Treppe (mit Clip) und Rampe sind gleichwertig — ein Knoten auf der
  // Rampenseite zog Läufer von der Treppe quer über die Rampe und seitlich hinunter.
  L.node(F.p(U3 - 40, 0, 0), { minSpeed: 250, note: 'Rampe' });
  L.node(F.p(U3 + UP + 48, 0, 128), { minSpeed: 250 });
  {
    const [a, b] = aabbOf(F, [U3 + UP, U3 + UP + 192], [-256, 256], [128, 288]);
    L.checkpoint(1, a, b, F.p(U3 + UP + 96, 0, 128), 0);
  }

  // ── 3 HOP-REIHE: Absprung von der Plateau-Kante, dann im Kettenrhythmus.
  // Mittelpunkte = Landepunkte des Plan-Tempos (Mitte aus perfektem und
  // 0.85-Strafer); Tiefe so, dass jede Lücke ≤ ROW_GAP bleibt — bei schnellem
  // Rhythmus werden die Plattformen tiefer, nicht die Lücken größer
  // (Stop-and-Go bleibt überall möglich, Überflieger landen trotzdem).
  // Plan ab ROW_V0 statt Sprint: über die 16°-Rampe kommt man mit dem Tempo aus
  // dem Anlauf oben an (Strafer 480–630 u/s) — ein Plan ab 320 setzte es zurück,
  // wer schneller war, flog über H1 in die Lücke. Wer langsamer ist, landet
  // früher; unter jeder Lücke liegt ein Graben mit Ausstieg (s. u.).
  const PU1 = plateau.u1;
  const V0 = PHYS.sprintSpeed;
  const TAKEOFF = PU1 - 20;
  /** H7 beginnt so weit vor dem Plan-Landepunkt (Rest bis zur Wand: siehe CROUCH-KANTE). */
  const H7_LEAD = 48;
  const rowSpeed: number[] = [ROW_V0];
  const rowCenter: number[] = [];
  let at = TAKEOFF;
  for (let k = 0; k < 7; k++) {
    // H7 (k = 6): Rhythmus des langsameren Bands — dort beginnt die Crouch-Kante.
    at += k === 6 ? hop(planLow(ROW_V0, 6)) * H7_PITCH : hop(rowSpeed[k]) * ROW_PITCH;
    rowCenter.push(at);
    rowSpeed.push(plan(ROW_V0, k + 1));
  }
  // Tiefen: mindestens 176 (H1 192: erste Landung nach dem Sprint-Absprung),
  // sonst so tief, dass die Lücke davor und — vor H7 — danach ≤ ROW_GAP bleibt.
  const ROW_DEPTH: number[] = [];
  for (let k = 0; k < 6; k++) {
    const pitchIn = rowCenter[k] - (k === 0 ? TAKEOFF : rowCenter[k - 1]);
    const prevHalf = k === 0 ? 0 : ROW_DEPTH[k - 1] / 2;
    let d = Math.max(k === 0 ? 192 : 176, ceil16(2 * (pitchIn - prevHalf - ROW_GAP)));
    if (k === 5) d = Math.max(d, ceil16(2 * (rowCenter[6] - rowCenter[5] - H7_LEAD - ROW_GAP)));
    ROW_DEPTH.push(d);
  }
  const row: PlacedPlatform[] = ROW_DEPTH.map((d, k) =>
    L.platform(F, [rowCenter[k] - d / 2, rowCenter[k] + d / 2], [-128, 128], 128, { tag: `hop${k + 1}` }),
  );
  L.node(F.p(TAKEOFF, 0, 128), { jump: true, minSpeed: ROW_V0, note: 'Hop-Reihe' });
  row.forEach((p, k) => L.node(p.center, { jump: true, minSpeed: rowSpeed[k + 1] }));

  // ── 4 CROUCH-KANTE: 64 u — normaler Sprung (57) reicht nicht, Crouch (75) schon.
  // H7 reicht bis an die Wand. Der Crouch-Hop steigt über die Kante, wenn die
  // Hull-Front die Wand im Fenster riseWindow(64) erreicht (0.21…0.54 s): bei
  // Tempo v also 0.21·v … 0.54·v davor. Für JEDES Tempo gibt es damit auf H7
  // eine Absprungzone (designProbes: crouchWindow) — die 3°-Hand springt näher
  // an der Wand, der perfekte Strafer weiter davor, wer langsam ist, läuft an
  // die Wand und springt dort geduckt hoch. Zu früh oder zu spät: man prallt
  // ab und landet wieder auf H7 — kostet Tempo, nie das Leben (früher lag hier
  // eine Grube, aus der ohne Bhop-Tempo kein Weg zurück auf die Kante führte).
  // Der Plan-Absprung (Knoten) liegt in der Mitte des Fensters beim Plan-Tempo.
  const crouchV = rowSpeed[7];
  const [riseA, riseB] = riseWindow(64, true);
  const h7c = rowCenter[6];
  const LE = h7c + PHYS.hullHalf + 0.5 * (riseA + riseB) * crouchV; // Wand der Kante
  const h7: [number, number] = [h7c - H7_LEAD, LE];
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
  L.node(F.p(h7c, 0, 128), { jump: true, crouch: true, minSpeed: crouchV, note: 'Crouch-Jump' });
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
  L.platform(F, [LE, LE + LIP], [-224, 224], 192, { mat: 'duck', tint: COL.cyan, thick: 128, tag: 'ledgeLip' });
  // Endet vor dem ersten Kehren-Pad (dessen gedrehte Ecke sonst koplanar überlappt).
  const LEDGE_END = LE + 256;
  L.platform(F, [LE + LIP, LEDGE_END], [-224, 224], 192, { mat: 'checkpoint', thick: 128, tag: 'ledge' });
  // Landepunkt des Crouch-Hops (Flug 64 u hoch mit Duck-Lift) = Beginn der Kehre.
  const L0 = h7c + crouchV * airTime(-64, true);
  L.node(F.p(L0, 0, 192), { jump: true, minSpeed: crouchV, note: 'Kante' });
  {
    const [a, b] = aabbOf(F, [LE + LIP, LE + 256], [-224, 224], [192, 352]);
    L.checkpoint(2, a, b, F.p(LE + 120, 0, 192), 0);
  }

  // ── 5 KEHRE: Hop-Linie auf einem 180°-Bogen nach links ─────────────────
  // Sehnen = Sprungweiten des unteren Bands (Sync 0.85): der perfekte Strafer
  // ist höchstens ~1.2× so schnell und landet weiter hinten auf dem tiefen
  // Pad; Langsamere landen vorn und laufen vor (Lücken nur ~120 u). Der Radius
  // ergibt sich so, dass der letzte Hop genau auf 180° landet.
  const arcSpeed: number[] = [];
  for (let k = 0; k < 7; k++) arcSpeed.push(planLow(V0, 8 + k));
  const chords = arcSpeed.map((v) => hop(v));
  const R = solveArcRadius(chords, 180);
  const S = F.p(L0, 0, 192);
  const C: V2 = [S[0] - R, S[2]];
  // Tiefe = Sehne − 120: die Kehre prüft das Kurven-Strafen, nicht die Lückenweite —
  // auch aus dem Stand (Respawn an CP2) reicht jeder Hop von der hinteren Padhälfte.
  const arcDepth = chords.map((c) => Math.max(208, c - 120));
  const arc: PlacedPlatform[] = [];
  const arcPhi: number[] = [];
  let phi = 0;
  chords.forEach((c, k) => {
    phi += chordDeg(c, R);
    const [x, z] = arcPoint(C, R, phi);
    const last = k === chords.length - 1;
    arc.push(
      L.pad([x, 192, z], arcDepth[k], 256, last ? 180 : phi, {
        tag: `curve${k + 1}`,
        mat: k % 2 === 0 ? 'floor' : 'accent',
        tint: k % 2 === 0 ? undefined : COL.violet,
      }),
    );
    arcPhi.push(phi);
  });
  // Speed-Strecke nach der Kehre: das untere Band läuft weiter.
  const SLALOM_V = planLow(V0, 8 + arcSpeed.length);
  arc.forEach((p, k) => L.node(p.center, { jump: true, minSpeed: arcSpeed[k + 1] ?? SLALOM_V }));

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

  // Könner-Abkürzung: eine Innenbahn aus Inseln von Kehren-Pad 1 zur Wende (CP3).
  // Spart Hops und Weg, verlangt Tempo und engeres Kurven-Strafen (~30° statt ~22°
  // je Hop). Nicht in der Bot-Route (designProbes: expertIslands). Früher drei
  // 112er-Inseln auf der geraden Sehne bis Pad 6, geplant für 685 u/s: die 1°-Hand
  // kam in 3 von 6 Läufen nicht durch und sparte 0.2 s. Eine gerade Sehne bis zur
  // Wende verlangt an Pad 1 einen Knick von ~80° (unfliegbar); die Bahn ist deshalb
  // eine Kurve (kubische Bézier), die an Pad 1 in Laufrichtung beginnt und an der
  // Wende in Slalom-Richtung endet. 160er-Inseln, Sprünge für CUT_V mit Reserve.
  const CUT_SIZE = 160;
  const CUT_V = 620;
  const cutA = arc[0].center;
  const cutB = cp3.on(cp3.u0 + 128);
  const tA = [arc[1].center[0] - cutA[0], arc[1].center[2] - cutA[2]];
  const tB = G.xz(1, 0);
  const tBx = tB[0] - G.x;
  const tBz = tB[1] - G.z;
  const tAl = Math.hypot(tA[0], tA[1]);
  // Griff 0.2 × Sehne: kürzer knickt die Bahn an Pad 1, länger schneidet sie die Pads 2 und 7
  // (Sweep 0.1–0.4 und Sehnen bis Pad 5/6/7: .docs/research/level-design.md).
  const handle = 0.2 * dist2(cutA, cutB);
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
  // Sprung von Inselmitte bis zur nächsten Kante (Hull darf überstehen), mit Reserve.
  const cutStepMax = CUT_SIZE / 2 + PHYS.hullHalf + hop(CUT_V) / RESERVE;
  const cutN = Math.ceil(cutLen / cutStepMax) - 1;
  const cutStep = cutLen / (cutN + 1);
  const cutPads: V2[] = [];
  for (let k = 1; k <= cutN; k++) cutPads.push(bez(atLen(k * cutStep)));
  cutPads.forEach((c, i) => {
    const prev = i === 0 ? xzOf(cutA) : cutPads[i - 1];
    const next = i === cutPads.length - 1 ? xzOf(cutB) : cutPads[i + 1];
    L.pad([c[0], 192, c[1]], CUT_SIZE, CUT_SIZE, yawTo(prev, next), { mat: 'accent', tint: COL.gold, tag: `cut${i + 1}` });
  });

  // Slalom: versetzte Langinseln in zwei Spalten (±112, 176 breit, 48 u
  // Spaltenabstand > Hull 32). Jede Insel beginnt, wo die vorige (andere
  // Spalte) endet, und ist so lang wie die Vorwärtsweite eines schrägen Hops
  // beim Plan-Tempo — die Vorwärtsweite pro Hop ist frei, aber jeder Hop muss
  // die Spalte wechseln: Lenken nur in der Luft, A/D im Wechsel. Eine gerade
  // Linie trifft nur jede zweite Insel. Langsame laufen auf der Insel vor und
  // springen schräg über die Ecke (Stop-and-Go).
  const SL_SHIFT = 112;
  const SL_W = 176;
  const SL_GAP = 48;
  /** Höhe der schrägen Nase vor jeder Insel (= Inseldicke). */
  const SL_NOSE_H = 64;
  const SL_LEN = ceil16(Math.sqrt(hop(SLALOM_V) ** 2 - (2 * SL_SHIFT) ** 2) - SL_GAP);
  let su = cp3.u1 + SL_GAP;
  const slalom: PlacedPlatform[] = [];
  for (let k = 0; k < 6; k++) {
    const sv = k % 2 === 0 ? -SL_SHIFT : SL_SHIFT;
    slalom.push(
      L.platform(G, [su, su + SL_LEN], [sv - SL_W / 2, sv + SL_W / 2], 192, {
        tag: `slalom${k + 1}`,
        mat: k % 2 === 0 ? 'accent' : 'floor',
        tint: k % 2 === 0 ? COL.pink : undefined,
      }),
    );
    // Nase vor jeder Insel (ab Insel 2): 40°-Schräge (begehbar) statt senkrechter Stirn.
    // Wer langsamer als geplant ist, springt mit Auto-Hop am Inselanfang ab und kam
    // bis 20 u zu kurz an: Stirnwand, vel → 0, Tod (Hand 2°: 3 von 8 Seeds). Mit der
    // Nase landet er auf der Schräge. Lenken bleibt Pflicht (die Spalten liegen 224 u
    // auseinander — designProbes: slalomNeedsSteering).
    if (k > 0) {
      const nose = SL_NOSE_H / Math.tan((40 * Math.PI) / 180);
      L.ramp(G, [su - nose, su], [sv - SL_W / 2, sv + SL_W / 2], 192 - SL_NOSE_H, 192, {
        tag: `slalom${k + 1}Nose`,
        mat: k % 2 === 0 ? 'accent' : 'floor',
        tint: k % 2 === 0 ? COL.pink : undefined,
        thick: 0,
      });
    }
    su += SL_LEN + SL_GAP;
  }
  slalom.forEach((p) => L.node(p.center, { jump: true, minSpeed: SLALOM_V }));
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
      const side = k % 2 === 0 ? -1 : 1;
      const v = side * (SL_SHIFT + SL_W / 2 + SL_PYLON_GAP + SL_PYLON_W / 2);
      const u = (p.u0 + p.u1) / 2;
      L.add(orientedBox(G, [u - SL_PYLON_LEN / 2, u + SL_PYLON_LEN / 2], [v - SL_PYLON_W / 2, v + SL_PYLON_W / 2], [-600, 440], { mat: 'dark', tag: 'slalomPylon' }));
      L.add(orientedBox(G, [u - SL_PYLON_LEN / 2 - 8, u + SL_PYLON_LEN / 2 + 8], [v - SL_PYLON_W, v + SL_PYLON_W], [440, 488], { mat: 'accent', tint: k % 2 ? COL.cyan : COL.pink, collide: false, tag: 'slalomPylonHead' }));
    });
  }

  // ── 7 FINALE: SURF-RUTSCHE, Kicker, Flug ins Ziel ───────────────────────
  // Der erste Surf des Spiels, verzeihend (früher fünf Terrassen: 5.8 s ohne
  // Risiko und ohne Entscheidung, L1 kam nie über 886 u/s; L2 verlangte Surfen,
  // das nirgends eingeführt war). Eine fallende Rampe (Querschnitt wie S1 in
  // Level 2) beginnt unter der letzten Slalom-Insel — keine Stirnfläche im Weg —,
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
  /** Rampe beginnt so weit hinter dem Anfang der letzten Insel (dort ist die Hull noch auf der Insel). */
  const CHUTE_UNDER = 64;
  /** First am Rampenbeginn: so tief unter der Insel, dass die Flanke die Insel (v ≥ 24) nicht schneidet. */
  const CHUTE_APEX = 192 - 40;
  /** Auffangfläche: so weit unter dem Rampenfuß, seitlich so weit über die Füße hinaus; danach mit 10° bis ins Ziel. */
  const CATCH_BELOW = 64;
  const CATCH_SIDE = 256;
  const CATCH_HALF = CHUTE_W / 2 + CATCH_SIDE;
  const CATCH_TAN = Math.tan((10 * Math.PI) / 180);
  /**
   * Route-Knoten an der +v-Flanke (Seite der letzten Insel): CHUTE_LINE unter dem
   * First am Einstieg, bis CHUTE_DIVE am Launch — die Ideallinie taucht die Flanke
   * hinunter und macht Höhe zu Tempo.
   */
  const CHUTE_LINE = Number(process.env.CHUTE_LINE ?? 240);
  const CHUTE_DIVE = Number(process.env.CHUTE_DIVE ?? 440);
  const chuteU0 = slEnd.u0 + CHUTE_UNDER;
  const pieces = CHUTE_PIECES.map((p, i) => (i === 0 ? { ...p, length: slEnd.u1 - chuteU0 + p.length } : p));
  const mainLen = pieces[0].length;
  const chute = L.surfChain({ start: G.xz(chuteU0), yaw: G.yaw, apex: CHUTE_APEX, width: CHUTE_W, tag: 'chute', pieces });
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
  const RAIL_H = 128;
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
    // Mit den Banden (wer oben auf der Bande läuft, ist auch im Ziel).
    const [a, b] = aabbOf(G, [fin.u0, fin.u1], [-CATCH_HALF - 32, CATCH_HALF + 32], [finishTop, finishTop + RAIL_H + 112]);
    L.finishZone(a, b);
  }

  // Route: Surf-Knoten an der +v-Flanke; minSpeed wird unten gemessen.
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
    L.node(chute[k].riderPos(g - off, 1, depth), { surf: true, note });
  };
  surfNode(land0, 'Rutsche');
  for (const g of [land0 + 480, land0 + 960]) if (g < mainLen - 160) surfNode(g);
  surfNode(mainLen - 64);
  surfNode(mainLen + 128);
  surfNode(chuteLen - 8, 'Launch');
  const measured = measureSurfSpeeds(L.build(), [{ surfer: 0 }, { surfer: 2 }], { grid: SURF_GRID });
  for (const i of surfNodes) {
    const v = measured[i];
    if (!Number.isFinite(v)) throw new Error(`level1: Surf-Knoten ${i} wird im Surf-Raster nicht erreicht`);
    L.route[i] = { ...L.route[i], minSpeed: Math.round(0.9 * v) };
  }
  const launch = L.route[surfNodes[surfNodes.length - 1]];
  // Ziel-Knoten geradeaus hinter dem Launch (gleiches v wie der Launch-Knoten) und weit
  // hinten: der Bot beendet seine Route beim Passieren des Knotens — auch im Flug hoch
  // über dem (niedrigen) Ziel-Trigger; so landet er vorher.
  L.node(fin.on(fin.u0 + 1700, CHUTE_DIVE / Math.tan((60 * Math.PI) / 180) + 16), { minSpeed: 250, note: 'Ziel' });

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
  L.arch(F, (row[4].u1 + row[5].u0) / 2, [-192, 192], 128, 320, COL.magenta);
  // Tore über der Rutsche (Pfosten außerhalb der Auffangfläche, Balken hoch über dem Grat)
  // und ein Ziel-Tor weit hinten, das die Landung rahmt statt im Flug zu liegen.
  [480, 1280].forEach((s, k) => {
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
    [-1100, -8600, 340, 3800, COL.magenta],
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

  const gaps = [row[0].u0 - PU1, ...row.slice(1).map((p, k) => p.u0 - row[k].u1), h7[0] - row[5].u1];
  if (!(L0 > LE + PHYS.hullHalf && L0 < LEDGE_END - PHYS.hullHalf)) throw new Error(`level1: Crouch-Landepunkt ${L0.toFixed(0)} liegt nicht auf der Kante`);
  if (Math.max(...gaps) > SPRINT_GAP) throw new Error(`level1: Hop-Reihe hat eine Lücke > ${SPRINT_GAP.toFixed(0)} u (Sprint von der Kante)`);
  reportDesign({
    rowSpeed,
    gaps,
    rowNeed: row.slice(0, 5).map((p, k) => speedFor(row[k + 1].u0 - (p.u0 + p.u1) / 2 - 16, 0, false, RESERVE)),
    arcRadius: R,
    arcSpeed,
    cut: { step: cutStep, n: cutN, need: speedFor(cutStep - CUT_SIZE / 2 - PHYS.hullHalf, 0, false, RESERVE) },
    slalomV: SLALOM_V,
    chuteLen: kickEndU - chuteU0,
    chuteDrop: CHUTE_APEX - Math.min(...chute.map((r) => r.apexAt(r.o.length))),
    launchMin: launch.minSpeed ?? 0,
    finishTop,
    slalomLen: SL_LEN,
    rowDepth: ROW_DEPTH,
  });

  return L.build();
}

interface DesignNumbers {
  readonly rowSpeed: readonly number[];
  readonly gaps: readonly number[];
  readonly rowNeed: readonly number[];
  readonly arcRadius: number;
  readonly arcSpeed: readonly number[];
  readonly cut: { readonly step: number; readonly n: number; readonly need: number };
  readonly slalomV: number;
  readonly chuteLen: number;
  readonly chuteDrop: number;
  readonly launchMin: number;
  readonly finishTop: number;
  readonly slalomLen: number;
  readonly rowDepth: readonly number[];
}

/** Planungszahlen beim Bauen ausgeben — Gegenprobe für die Doku. */
function reportDesign(d: DesignNumbers): void {
  const f = (n: number): string => n.toFixed(0);
  console.log('  level1 Planung:');
  console.log(`    Hop-Reihe: Plan-Tempo ${d.rowSpeed.map(f).join(' → ')} u/s; Lücken ${d.gaps.map(f).join(' / ')} u; Tiefen ${d.rowDepth.map(f).join(' / ')} u`);
  console.log(`    Hop-Reihe braucht ab Plattformmitte (mit Reserve): ${d.rowNeed.map(f).join(' / ')} u/s`);
  console.log(`    Kehre: Radius ${f(d.arcRadius)} u, Plan-Tempo ${d.arcSpeed.map(f).join(' / ')}; Slalom ${f(d.slalomV)} u/s (Inseln ${f(d.slalomLen)} u)`);
  console.log(`    Abkürzung: ${d.cut.n} Inseln, Sprünge à ${f(d.cut.step)} u, braucht ${f(d.cut.need)} u/s`);
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
