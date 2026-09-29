import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Coach, type HintId } from '../src/engine/Coach';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { makeBotInput, yawOf } from '../src/player/bots';
import type { MutablePlayerSnapshot } from '../src/player/types';
import { compileLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import { formatLevel } from '../tools/levels/build';
import { helixBoard } from '../tools/levels/designProbes';
import { BOARD_H, CROUCH_H, PREP_LESSONS, R_E2_IN, R_E2_OUT, R_LINE, R_OUT, TAKEOFF_FAR, TAKEOFF_NEAR, TRENCH_DEPTH, buildLevel4, level4Layout } from '../tools/levels/level4';
import {
  CROUCH_LOST_MAX,
  LANE_SLOW_GAIN,
  LANE_TRAP,
  MARK_SPEEDS,
  MARK_SPEEDS_FAR,
  bandeEscape,
  crouchEdges,
  dropIn,
  duckMarkJumps,
  innerLane,
  laneChoice,
  lanePath,
  novice,
  surfMedal,
  type BandeEscapeSpec,
} from '../tools/levels/probes/level4';
import { RESUME_BELOW, nodeInTrigger, resumeIndex, timedRun } from '../tools/levels/physics';
import { CROUCH_RESERVE, crouchSpeeds, noDuckReach } from '../tools/validate-levels';

/**
 * Level 4 "04 TURM" (Plan 007, Strang level4): schnelle Wächter für die Zusagen aus
 * .docs/research/levels/level4.md. Die volle Prüfung (alle Modelle, Raster, Anfänger) macht
 * `npm run levels:check -- level4`; hier nur, was beim nächsten Tuning still kippen würde.
 */

const CFG = VELOCITY_DEFAULT;
const TEXT = readFileSync('public/levels/level4.json', 'utf8');
const DEF = JSON.parse(TEXT) as LevelFile;
const LEVEL = compileLevel(DEF);
const LAY = level4Layout();
const ROUTE = DEF.route ?? [];
const CPS = LEVEL.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);

describe('Level 4 "04 TURM" — Datei und Regeln', () => {
  it('public/levels/level4.json ist der aktuelle Build (sonst: npm run levels:build -- level4)', () => {
    // Medaillen/Par misst build.ts (Spiel-Uhr, 49 Starts) — der Rest muss byte-gleich aus dem Builder kommen,
    // auch die gemessenen Surf-minSpeed und die Ziel-Lücke (ziehen mit jedem Movement-Tuning mit).
    expect(formatLevel({ ...buildLevel4(), parTime: DEF.parTime, medals: DEF.medals })).toBe(TEXT);
  }, 30_000);

  it('Kopf: Name, Untertitel, Tonart G, empfohlene Lektionen, Medaillen streng fallend, Par = Bronze aufgerundet', () => {
    expect(DEF.name).toBe('04 TURM');
    expect(DEF.subtitle).toBe('Tempo ist Höhe.');
    expect(DEF.music?.root).toBe('G');
    // K1/K2 verlangen den Crouch-Jump (T6), die Abfahrt Surfen (T7/T8).
    expect(DEF.prepLessons).toEqual(['t6', 't7', 't8']);
    expect(DEF.prepLessons).toEqual([...PREP_LESSONS]);
    const m = DEF.medals;
    expect(m).toBeDefined();
    if (!m) return;
    expect(m.bronze > m.silver && m.silver > m.gold && m.gold > m.velocity && m.velocity >= m.author).toBe(true);
    expect(DEF.parTime).toBe(Math.ceil(m.bronze));
  });

  it('keine Pads, keine Boosts: nur Start, 5 Checkpoints, Ziel und Kill-Zonen', () => {
    const kinds = new Set(DEF.triggers.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['checkpoint', 'finish', 'kill', 'start']);
    expect(CPS.map((c) => c.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('Crouch-Kanten: zwei Route-Knoten, Stufe genau CROUCH_H an der Planlinie, ≥ 2 u über der Reichweite ohne Ducken', () => {
    expect(ROUTE.filter((n) => n.crouch && n.jump)).toHaveLength(2);
    expect(CROUCH_H).toBeGreaterThanOrEqual(66);
    const mins = new Vector3(-2, 0, -2);
    const maxs = new Vector3(2, 2, 2);
    const floorAt = (theta: number): number => {
      const [x, z] = LAY.helix.xz(theta, R_LINE);
      const y = LAY.helix.yAt(theta, true);
      const tr = LEVEL.world.traceBox(new Vector3(x, y + 100, z), new Vector3(x, y - 100, z), mins, maxs);
      return tr.endPos.y;
    };
    for (const wall of LAY.crouchWalls) expect(floorAt(wall + 1) - floorAt(wall - 1)).toBeCloseTo(CROUCH_H, 3);
    // Reichweite ohne Ducken (Sprung + Auto-Hop-Landehöhe + Kanten-Assist) mit den Tempi des Validators.
    const vMax = Math.max(...ROUTE.filter((n) => n.crouch).map((n) => n.minSpeed ?? 0));
    const reach = noDuckReach(CFG, crouchSpeeds(CFG, vMax));
    expect(CROUCH_H - reach).toBeGreaterThanOrEqual(CROUCH_RESERVE);
  }, 30_000);

  it('gestapelt: jeder Checkpoint setzt auf seiner Etage wieder an (kein Schatten-Knoten der Umdrehung darunter)', () => {
    // Etagen liegen ≥ 384 u auseinander: der Wiedereinstieg liegt hinter dem vorigen und (Podeste) nahe der Spawn-Höhe.
    // CP4 (Krone) und CP5 gehen mit einem Surf-Knoten auf der Flanke weiter — auf dem Brett liegt kein Knoten mehr (dort
    // bremste der Bot per S, Review 29.09.).
    let last = 0;
    for (const cp of CPS) {
      const i = resumeIndex(ROUTE, cp);
      expect(i, `CP${cp.order}`).toBeGreaterThan(last);
      if (cp.order <= 3) expect(Math.abs(ROUTE[i].pos[1] - cp.spawnPos.y), `CP${cp.order}`).toBeLessThan(100);
      else {
        expect(ROUTE[i].surf, `CP${cp.order}`).toBe(true);
        expect(cp.spawnPos.y - ROUTE[i].pos[1], `CP${cp.order}`).toBeGreaterThan(0);
        expect(cp.spawnPos.y - ROUTE[i].pos[1], `CP${cp.order}`).toBeLessThan(500);
      }
      last = i;
    }
    expect(ROUTE.some((n) => n.note === 'Absprung')).toBe(false);
    // Der erste Knoten im Trigger ist einer dieser Etage (nodeInTrigger: y ab RESUME_BELOW unter der Unterkante).
    for (const cp of CPS.slice(0, 3)) {
      const first = ROUTE.findIndex((n) => nodeInTrigger(n.pos, cp));
      expect(ROUTE[first].pos[1], `CP${cp.order}`).toBeGreaterThanOrEqual(cp.bounds.min.y - RESUME_BELOW);
    }
    // Podest-Trigger nur 160 u hoch: die Etage darunter (≥ 512 u tiefer) liegt nie darin.
    for (const cp of CPS.slice(0, 3)) expect(cp.bounds.max.y - cp.bounds.min.y).toBeLessThanOrEqual(160);
  });

  it('E2 im kompilierten Level: Außenroute (r 1000) lückenlos, Innenlinie (r 752) mit den Gräben an ihren θ — gefahren ≥ 20 % kürzer', () => {
    const mins = new Vector3(-2, 0, -2);
    const maxs = new Vector3(2, 2, 2);
    const floorAt = (theta: number, r: number): number => {
      const [x, z] = LAY.helix.xz(theta, r);
      const y = LAY.helix.yAt(theta);
      const tr = LEVEL.world.traceBox(new Vector3(x, y + 100, z), new Vector3(x, y - 300, z), mins, maxs);
      return tr.fraction < 1 ? tr.endPos.y : Number.NEGATIVE_INFINITY;
    };
    const [e2a, e2b] = LAY.e2;
    let trenchHits = 0;
    for (let t = e2a + 1; t < e2b - 1; t += 1) {
      const lane = LAY.helix.yAt(t); // erster Abschnitt = Außenbahn (ohne Graben)
      expect(Math.abs(floorAt(t, R_E2_OUT) - lane), `außen θ ${t}`).toBeLessThan(3);
      const trench = LAY.trenches.find(([a, b]) => t > a + 1 && t < b - 1);
      if (!trench) {
        if (!LAY.trenches.some(([a, b]) => t > a - 1.5 && t < b + 1.5)) expect(Math.abs(floorAt(t, R_E2_IN) - lane), `innen θ ${t}`).toBeLessThan(3);
      } else if (t < (trench[0] + trench[1]) / 2) {
        // Vordere Grabenhälfte: Sohle mehr als die halbe Grabentiefe unter der Bahn (hinten steigt sie bündig zur Landekante).
        expect(floorAt(t, R_E2_IN), `Graben θ ${t}`).toBeLessThan(lane - 0.45 * TRENCH_DEPTH);
        trenchHits++;
      }
    }
    expect(trenchHits).toBeGreaterThanOrEqual(3 * 5);
    // Gefahren (W + Leertaste, 450 u/s) statt 1 − 752/1000: der Weg kommt aus dem kompilierten Level (Review 29.09.).
    const inner = lanePath(LEVEL, LAY, CFG, R_E2_IN);
    const outer = lanePath(LEVEL, LAY, CFG, R_E2_OUT);
    expect(Number.isFinite(inner) && Number.isFinite(outer)).toBe(true);
    expect(1 - inner / outer).toBeGreaterThanOrEqual(0.2);
  }, 30_000);

  it('Innenbahn: Warnstreifen (Bernstein) vor jedem Graben — die Linie liest sich nicht als freie Abkürzung', () => {
    const warn = LEVEL.brushes.filter((b) => b.mat === 'marking' && DEF.brushes[b.index]?.tag === 'trenchWarn');
    const c = new Vector3();
    for (const [ta] of LAY.trenches) {
      const here = warn.filter((b) => {
        b.bounds.getCenter(c);
        const th = LAY.helix.thetaOf(c.x, c.z, ta);
        return th > ta - 6 && th < ta && Math.hypot(c.x, c.z) < 864;
      });
      expect(here.length, `Graben θ ${ta}`).toBeGreaterThanOrEqual(3);
      for (const b of here) expect(b.tint).toBe('#ffb347');
    }
  });

  it('Absprungband auf beiden Terrassen: flach, parallel zur Wand, durchgehend bei TAKEOFF_NEAR, drei Streifen bei TAKEOFF_FAR', () => {
    const hw = CFG.hull.halfWidth;
    for (const wall of LAY.crouchWalls) {
      const terrace = LAY.helix.yAt(wall - 0.5);
      const [wx, wz] = LAY.helix.xz(wall, R_LINE);
      const ty = (LAY.helix.yawAt(wall) * Math.PI) / 180;
      const [tx, tz] = [-Math.sin(ty), -Math.cos(ty)];
      const before = (x: number, z: number): number => -((x - wx) * tx + (z - wz) * tz);
      for (const [tag, band, count] of [
        ['duckMark', TAKEOFF_NEAR, 1],
        ['duckMarkFar', TAKEOFF_FAR, 3],
      ] as const) {
        let lo = Infinity;
        let hi = -Infinity;
        let n = 0;
        for (const b of DEF.brushes) {
          if (b.tag !== tag || b.type !== 'hull') continue;
          if (!b.points.every(([x, y, z]) => Math.abs(y - terrace) < 8 && before(x, z) > 0 && before(x, z) < 400)) continue;
          n++;
          for (const [x, y, z] of b.points) {
            if (y < terrace - 1) continue; // Unterseite
            expect(y).toBeCloseTo(terrace, 3);
            lo = Math.min(lo, before(x, z) - hw);
            hi = Math.max(hi, before(x, z) - hw);
          }
        }
        expect(n, `${tag} θ ${wall}`).toBe(count);
        expect(lo, `${tag} θ ${wall}`).toBeCloseTo(band[0], 3);
        expect(hi, `${tag} θ ${wall}`).toBeCloseTo(band[1], 3);
      }
    }
  });

  it('Kill-Ring: außerhalb von Bande/Clip liegt jede Stelle 250 u unter der Bahn in einer Kill-Zone (Wendel und Steg)', () => {
    const kills = LEVEL.triggers.filter((t) => t.kind === 'kill');
    const p = new Vector3();
    const inKill = (): boolean => kills.some((k) => k.bounds.containsPoint(p));
    for (let t = 2; t <= 538; t += 4) {
      const [x, z] = LAY.helix.xz(t, R_OUT + 200);
      p.set(x, LAY.helix.yAt(t) - 250, z);
      expect(inKill(), `Wendel θ ${t}`).toBe(true);
    }
    const st = LAY.steg;
    for (let u = 20; u < st.len + st.krone; u += 60) {
      for (const side of [-1, 1]) {
        const [x, z] = st.frame.xz(u, side * (st.half + 200));
        p.set(x, st.floorAt(u) - 250, z);
        expect(inKill(), `Steg u ${u} ${side}`).toBe(true);
      }
    }
  });

  it('Grabensohlen ohne Trims (verwundene Dreiecke: sonst Zickzack quer durch die Grube)', () => {
    const trench = DEF.brushes.filter((b) => b.tag?.startsWith('trench'));
    expect(trench.length).toBeGreaterThan(0);
    expect(trench.every((b) => b.trim === false)).toBe(true);
  });

  it('Steg und Krone: unsichtbarer Clip statt Mauer, sichtbares Geländer daneben', () => {
    const clips = DEF.brushes.filter((b) => b.visible === false && /^(steg|krone)Board/.test(b.tag ?? ''));
    expect(clips.length).toBe(4);
    const rail = DEF.brushes.filter((b) => b.collide === false && (b.tag === 'rail' || b.tag === 'rail-post'));
    expect(rail.filter((b) => b.tag === 'rail-post').length).toBeGreaterThan(20);
    expect(rail.filter((b) => b.tag === 'rail').length).toBeGreaterThan(15);
  });
});

describe('Level 4 "04 TURM" — Physik-Wächter', () => {
  it('perfekter Bot: im Ziel in 22–30 s ohne Tod; 3°-Hand ohne Tod und ≥ 1.15 × langsamer', () => {
    const perfect = timedRun(LEVEL, { sync: 1 }, 1, CFG);
    const hand3 = timedRun(LEVEL, { aimNoiseDeg: 3 }, 1, CFG);
    expect(perfect.time).not.toBeNull();
    expect(hand3.time).not.toBeNull();
    expect(perfect.deaths + hand3.deaths).toBe(0);
    const t = perfect.time ?? 0;
    expect(t).toBeGreaterThanOrEqual(22);
    expect(t).toBeLessThanOrEqual(30);
    expect((hand3.time ?? 0) / t).toBeGreaterThanOrEqual(1.15);
  }, 30_000);

  it('Crouch-Kanten: ohne Ducken nie oben, geduckt ≥ 95 % in ≤ 4 s oben, teurer Anprall ab 550 u/s ≤ CROUCH_LOST_MAX, kein Tod', () => {
    const duck = crouchEdges(LEVEL, LAY, CFG, true);
    const plain = crouchEdges(LEVEL, LAY, CFG, false);
    const sum = (rs: typeof duck, f: (x: (typeof duck)[number]) => number): number => rs.reduce((a, x) => a + f(x), 0);
    expect(sum(plain, (x) => x.up)).toBe(0);
    expect(sum(duck, (x) => x.up)).toBeGreaterThanOrEqual(0.95 * sum(duck, (x) => x.runs));
    expect(sum(duck, (x) => x.deaths) + sum(plain, (x) => x.deaths)).toBe(0);
    for (const x of duck.filter((r) => r.speed >= 550)) expect(x.lost, `θ ${x.wall} @ ${x.speed}`).toBeLessThanOrEqual(CROUCH_LOST_MAX * x.runs);
  }, 60_000);

  it('Innenbahn: eine Wahl nach Tempo, keine Falle — Neuling innen schneller, Strafer verlieren dort höchstens LANE_TRAP; kein Tod, Rettung ≤ 2 s', () => {
    // Review 29.09.: mit 72-u-Gräben war die Innenlinie ab 450 u/s eine Falle (W + Leertaste bis +1.33 s gegen außen).
    const speeds = [320, 650, 800];
    const res = laneChoice(LEVEL, LAY, CFG, speeds, 8);
    expect(res[0].diff, 'innen bei 320 u/s').toBeLessThanOrEqual(-LANE_SLOW_GAIN);
    for (const c of res) expect(c.diff, `innen minus außen bei ${c.speed} u/s`).toBeLessThanOrEqual(LANE_TRAP);
    // Die Gräben liegen in der Linie (sonst misst der Vergleich nur die Steigung): der Neuling trifft sie.
    expect(res[0].trench).toBeGreaterThan(0);
    const lane = innerLane(LEVEL, LAY, CFG);
    expect(lane.deaths).toBe(0);
    expect(lane.rescueMax, lane.rescueWorst).toBeLessThanOrEqual(2);
    // Gegenprobe: die alten 72-u-Gräben muss der Wächter als Falle erkennen.
    const deep = { measure: false, trenchDepth: 72 } as const;
    const old = laneChoice(compileLevel(buildLevel4(deep)), level4Layout(deep), CFG, speeds, 8);
    expect(Math.max(...old.map((c) => c.diff))).toBeGreaterThan(LANE_TRAP);
  }, 60_000);

  it('Anfänger W + Leertaste + in der Luft ducken: ohne Tod bis zur Krone (CP4) in ≤ 45 s', () => {
    const res = novice(LEVEL, CFG, 'W+Space+Duck', 50);
    expect(res.checkpoints[3], res.stuck ?? '').toBeLessThanOrEqual(45);
    expect(res.deathsAt.slice(0, 4).reduce((a, b) => a + b, 0)).toBe(0);
  }, 30_000);

  it('Absprungband: wer darin springt, kommt ohne Tempoverlust hoch — durchgehend 250–950 u/s, Streifen ab 450 u/s', () => {
    // Review 29.09.: die alte Marke galt erst ab 450 u/s, die Probe begann dort — Langsame prallten im wandfernen Teil ab.
    expect(MARK_SPEEDS[0]).toBeLessThanOrEqual(250);
    const res = duckMarkJumps(LEVEL, LAY, CFG);
    expect(res.map((m) => `${m.wall}:${m.band}`)).toEqual(LAY.crouchWalls.flatMap((w) => [`${w}:near`, `${w}:far`]));
    for (const m of res) {
      expect(m.fails, `θ ${m.wall} ${m.band}`).toEqual([]);
      expect(m.runs).toBe(5 * 3 * (m.band === 'near' ? MARK_SPEEDS : MARK_SPEEDS_FAR).length);
      const band = m.band === 'near' ? TAKEOFF_NEAR : TAKEOFF_FAR;
      expect(m.from).toBeCloseTo(band[0], 3);
      expect(m.to).toBeCloseTo(band[1], 3);
    }
    // Gegenprobe: das durchgehende Band 120 u weiter von der Wand (≈ wandferne Hälfte der alten ↑C-Marke) muss bei
    // 250/320 u/s abprallende Sprünge finden.
    const moved = DEF.brushes.map((b) => {
      if (b.tag !== 'duckMark' || b.type !== 'hull') return b;
      const wall = LAY.crouchWalls.reduce((best, w) => {
        const d = (t: number): number => Math.hypot(LAY.helix.xz(t, R_LINE)[0] - b.points[0][0], LAY.helix.xz(t, R_LINE)[1] - b.points[0][2]);
        return d(w) < d(best) ? w : best;
      }, LAY.crouchWalls[0]);
      const ty = (LAY.helix.yawAt(wall) * Math.PI) / 180;
      return { ...b, points: b.points.map(([x, y, z]) => [x + Math.sin(ty) * 120, y, z + Math.cos(ty) * 120] as const) };
    });
    const far = duckMarkJumps(compileLevel({ ...DEF, brushes: moved }), LAY, CFG).filter((m) => m.band === 'near');
    expect(far.reduce((a, m) => a + m.fails.length, 0)).toBeGreaterThan(10);
  }, 60_000);

  it('Wendel-Bande (Stichprobe): Geradeaus-Hüpfer fallen nicht, sterben nicht, hängen nicht — auch schräg nach außen', () => {
    const res = helixBoard(LEVEL, LAY.helix, { thetas: [10, 530, 40], radii: [700, 1100], speeds: [600, 900], aims: [0, 25, 65] }, CFG);
    expect(res.runs).toBe(156);
    expect([...res.deaths, ...res.fell, ...res.hangs]).toEqual([]);
  }, 60_000);

  // Wer nach außen hüpft, auch geduckt und bergab (Review: die 80-u-Bande ließ Crouch-Hops und Hüpfer bergab hinaus).
  const ESCAPE_SAMPLE: BandeEscapeSpec = {
    thetas: [60, 200, 460, 500],
    radii: [1020, 1110],
    stegU: [450],
    alphas: [0, 30, 60],
    dirs: [1, -1],
    speeds: [250, 700],
    modes: ['hop', 'crouchAir'],
    seconds: 3,
  };

  it('Bande/Clip (Stichprobe): niemand kommt hinaus oder steht auf der Bande — ohne Clip schon (Gegenprobe)', () => {
    const res = bandeEscape(LEVEL, LAY, CFG, ESCAPE_SAMPLE);
    expect(res.runs).toBe(200);
    expect([...res.out, ...res.onTop]).toEqual([]);
    // Gegenprobe: nur die sichtbare 80-u-Bande, ohne Kill-Ring — die Stichprobe muss das finden.
    const bare = compileLevel(buildLevel4({ measure: false, clipH: BOARD_H, killRing: false }));
    const open = bandeEscape(bare, LAY, CFG, ESCAPE_SAMPLE);
    expect(open.out.length + open.onTop.length).toBeGreaterThan(10);
  }, 60_000);

  it('Drop-In vom Sprungbrett: Grundtechnik-Surfer kommen an CP5 — ruhig vom Spawn und mit Anlauf vom Steg (Kursfehler ±8°), je ≥ 95 %', () => {
    const { spawn, approach } = dropIn(LEVEL, LAY, CFG);
    expect(spawn.runs).toBe(80);
    expect(spawn.deaths).toBe(0);
    expect(spawn.ok).toBeGreaterThanOrEqual(0.95 * spawn.runs);
    expect(approach.runs).toBe(150);
    expect(approach.ok).toBeGreaterThanOrEqual(0.95 * approach.runs);
    // Gegenprobe: ein Brett weit im Norden (96–336 u) muss der Anlauf mit Kursfehler finden (gemessen 132/150).
    const north = { board: [96, 336] as const, measure: false } as const;
    const bad = dropIn(compileLevel(buildLevel4(north)), level4Layout(north), CFG).approach;
    expect(bad.ok).toBeLessThan(0.95 * bad.runs);
  }, 60_000);

  it('Medaillen-Wächter: perfekt strafen + einfach surfen ab CP4 unterbietet die Autor-Zeit um höchstens 10 % der Abfahrt', () => {
    // Review 29.09. (kritisch): build.ts misst Gold/VELOCITY/Autor mit dem RouteFollower, der die Abfahrt ~3 s langsamer
    // surft als der Grundtechnik-Surfer — Hand 3° + einfaches Surfen unterbot VELOCITY und Autor. Rot, bis der
    // RouteFollower so surft (src/player/bots) oder build.ts die Medaillen aus dem schnelleren von Bot und Hybrid misst.
    const author = DEF.medals?.author;
    expect(author).toBeDefined();
    const s = surfMedal(LEVEL, LAY, CFG, [24]);
    expect(s.hybrid).not.toBeNull();
    expect(Number.isFinite(s.riderSection)).toBe(true);
    expect(author ?? Infinity).toBeLessThanOrEqual((s.hybrid ?? 0) + 0.1 * s.riderSection);
  }, 30_000);

  it('Coach: W + Leertaste prallt an Kante 1 → Crouch-Hinweis; geduckt oben → gelernt (höhenbewusst in der Wendel)', () => {
    const run = (duck: boolean): { hints: HintId[]; learned: boolean; top: boolean } => {
      const pm = new PlayerMovement(LEVEL.world, CFG);
      const cp2 = CPS[1];
      pm.teleport(new Vector3(cp2.spawnPos.x, cp2.spawnPos.y + 1, cp2.spawnPos.z));
      const coach = new Coach(CFG);
      coach.setLevel(ROUTE);
      const hints: HintId[] = [];
      coach.onHint = (id) => hints.push(id);
      const prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
      const cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
      const inp = makeBotInput();
      const upper = LAY.helix.yAt(LAY.crouchWalls[0] + 1, true);
      let top = false;
      for (let k = 0; k < 14 * CFG.tickRate && !top; k++) {
        // Blick auf die Wendel 60 u voraus (wie ein Mensch, der der Kurve folgt).
        const theta = LAY.helix.thetaOf(pm.state.pos.x, pm.state.pos.z, 330);
        const [ax, az] = LAY.helix.xz(theta + 4, R_LINE);
        inp.yaw = yawOf(ax - pm.state.pos.x, az - pm.state.pos.z);
        inp.forward = 1;
        inp.sprint = true;
        inp.jumpHeld = true;
        inp.jumpPressed = k === 0;
        inp.crouch = duck && !pm.state.onGround;
        pm.copySnapshot(prev);
        pm.tick(inp);
        pm.copySnapshot(cur);
        coach.tick(1 / CFG.tickRate, prev, cur, inp);
        top = pm.state.onGround && pm.state.pos.y > upper - 4 && theta > LAY.crouchWalls[0];
      }
      return { hints, learned: coach.isLearned('crouch'), top };
    };
    const plain = run(false);
    expect(plain.top).toBe(false);
    expect(plain.hints).toContain('crouch');
    const duck = run(true);
    expect(duck.top).toBe(true);
    expect(duck.learned).toBe(true);
    expect(duck.hints).not.toContain('crouch');
  }, 30_000);
});
