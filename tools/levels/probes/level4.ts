/**
 * Design-Proben Level 4 "04 TURM" (Plan 007, Phase 2: Strang level4) — designProbes.ts ruft sie für id
 * 'level4'. Behauptungen aus .docs/research/levels/level4.md, die der Validator sonst nicht sieht:
 *
 * - Bande: Geradeaus-Hüpfer quer über die ganze Wendel — keiner fällt, stirbt oder hängt (Wall-Cling).
 * - Bande/Clip nach außen: wer absichtlich hinaus will (Hop, Crouch-Hop, Ducken gehalten; bergauf/bergab; 0–80° zur
 *   Wand), kommt weder über Wendel-Bande noch über Steg/Krone hinaus und steht nie darauf.
 * - Crouch-Kanten: gerader Crouch-Hüpfer (Leertaste gehalten, in der Luft geduckt) kommt hoch; ohne
 *   Ducken nie ("ohne Ducken 0" prüft der Validator zusätzlich für jede Crouch-Kante der Route). Wie oft dabei
 *   das Tempo verloren geht, meldet die Probe; wer im Absprungband springt, verliert keins (250–950 u/s).
 * - Innenbahn: gefahren ≥ 20 % kürzer, tötet nicht, aus jedem Graben ist man in ≤ 2 s wieder auf der Bahn, und sie ist
 *   eine Wahl nach Tempo, keine Falle: W + Leertaste innen bei 320 u/s ≥ 0.3 s schneller, bei keinem Tempo > 0.5 s langsamer.
 * - Anfänger: W + Leertaste + Ducken kommt ohne Tod bis zur Krone (CP4).
 * - Drop-In: Grundtechnik-Surfer vom Sprungbrett erreichen CP5 — ruhig vom Spawn und mit Anlauf vom Steg (Kursfehler).
 * - Finale aus dem CP5-Respawn mit ≥ 10 % Weitenreserve; Launch-Tempo und Skill-Spreizung.
 * - Medaillen: perfekt strafen + einfach surfen darf die Autor-Zeit um höchstens 10 % der Abfahrt unterbieten.
 *
 * Die Geometrie kommt aus level4Layout() (dieselben Zahlen wie der Builder); ein Abgleich mit dem
 * kompilierten Level meldet einen Fehler, falls JSON und Builder auseinanderlaufen.
 */
import { Box3, Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower, makeBotInput, runRoute, yawOf } from '../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput } from '../../../src/player/types';
import type { CompiledLevel, CompiledTrigger } from '../../../src/world/level/compileLevel';
import type { RouteNode } from '../../../src/world/level/LevelFormat';
import { finaleReserve, helixBoardProbe, type DesignReport } from '../designProbes';
import { CLIP_H, R_E2_IN, R_E2_OUT, R_LINE, R_OUT, R_SPLIT, level4Layout, type Level4Layout } from '../level4';
import {
  START_JITTERS,
  StartAim,
  SurfRider,
  jitterStart,
  resumeIndex,
  timedMedian,
  type MedalReference,
  type ReferenceRuns,
  type StartJitter,
  type StrafeModel,
  type TimedRun,
} from '../physics';

const DEG = Math.PI / 180;

export function level4Probes(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const lay = level4Layout();
  if (!layoutMatches(level, lay, r)) return;
  helixBoardProbe(level, lay.helix, { thetas: [10, 530, 20], radii: [700, 900, 1100], aims: [0, -25, 25, 45, 65] }, cfg, r, 'Wendel');
  bandeEscapeProbe(level, lay, cfg, r);
  crouchEdgesProbe(level, lay, cfg, r);
  innerLaneProbe(level, lay, cfg, r);
  novicesProbe(level, cfg, r);
  dropInProbe(level, lay, cfg, r);
  finaleReserve(level, cfg, r, 90);
  tempoProbe(level, cfg, r);
  surfMedalProbe(level, lay, cfg, r);
}

/** JSON und Builder-Geometrie müssen zusammenpassen (sonst messen die Proben ein anderes Level). */
function layoutMatches(level: CompiledLevel, lay: Level4Layout, r: DesignReport): boolean {
  const bad: string[] = [];
  const probe = new Vector3();
  const mins = new Vector3(-4, 0, -4);
  const maxs = new Vector3(4, 4, 4);
  for (const t of [20, 145, 240, 300, 347, 400, 437, 460, 500]) {
    const [x, z] = lay.helix.xz(t, 1100);
    const y = lay.helix.yAt(t);
    const tr = level.world.traceBox(probe.set(x, y + 40, z), new Vector3(x, y - 40, z), mins, maxs);
    if (tr.fraction >= 1 || Math.abs(tr.endPos.y - y) > 1) bad.push(`θ ${t}: Boden ${tr.fraction >= 1 ? 'fehlt' : tr.endPos.y.toFixed(1)} statt ${y.toFixed(1)}`);
  }
  if (bad.length) r.errors.push(`Design: level4-JSON passt nicht zu level4Layout() (${bad.slice(0, 3).join('; ')}) — erst npm run levels:build -- level4`);
  return bad.length === 0;
}

// ---------------------------------------------------------------------------
// Gemeinsame Bausteine

const hMin = new Vector3();
const hMax = new Vector3();
const box = new Box3();

function deadIn(level: CompiledLevel, kills: readonly CompiledTrigger[], pm: PlayerMovement): boolean {
  const s = pm.state;
  if (s.pos.y < level.def.killY) return true;
  hMin.copy(s.pos).add(pm.hullMins);
  hMax.copy(s.pos).add(pm.hullMaxs);
  box.set(hMin, hMax);
  return kills.some((k) => k.bounds.intersectsBox(box));
}

function inTrigger(t: CompiledTrigger, pm: PlayerMovement): boolean {
  hMin.copy(pm.state.pos).add(pm.hullMins);
  hMax.copy(pm.state.pos).add(pm.hullMaxs);
  box.set(hMin, hMax);
  return t.bounds.intersectsBox(box);
}

/** Blick tangential an der aktuellen Stelle der Wendel (folgt der Kurve wie ein Mensch). */
function tangentYaw(lay: Level4Layout, p: Vector3, near: number): { theta: number; yaw: number } {
  const theta = lay.helix.thetaOf(p.x, p.z, near);
  return { theta, yaw: lay.helix.yawAt(theta) * DEG };
}

function f0(n: number): string {
  return n.toFixed(0);
}

// ---------------------------------------------------------------------------
// Bande: Flucht nach außen

export type EscapeMode = 'hop' | 'crouchAir' | 'crouchHold';

export interface BandeEscapeSpec {
  /** Wendel: Startwinkel θ und Radien. */
  readonly thetas: readonly number[];
  readonly radii: readonly number[];
  /** Steg/Krone: Start-u (Frame des Stegs); v ±150 zur jeweiligen Seite. */
  readonly stegU: readonly number[];
  /** Winkel zur Wandnormale (0 = gerade nach außen), Grad. */
  readonly alphas: readonly number[];
  /** Anteil längs der Bahn: +1 bergauf, −1 bergab. */
  readonly dirs: readonly number[];
  readonly speeds: readonly number[];
  readonly modes: readonly EscapeMode[];
  readonly seconds: number;
}

export const BANDE_ESCAPE: BandeEscapeSpec = {
  thetas: [30, 60, 100, 145, 175, 215, 255, 300, 340, 355, 400, 440, 460, 490, 525],
  // 1110: Hull-Front 26 u vor der Bande — Crouch-Jump aus dem Stand direkt an der Wand (Review: θ 20, r 1110, 0 u/s hinaus).
  radii: [1020, 1110],
  stegU: [150, 450, 750, 1050, 1200],
  alphas: [0, 30, 60, 80],
  dirs: [1, -1],
  speeds: [0, 300, 600, 900],
  modes: ['hop', 'crouchAir', 'crouchHold'],
  seconds: 3,
};

export interface BandeEscapeResult {
  readonly runs: number;
  /** Über Bande/Clip hinaus: danach gestorben oder > 100 u unter der Bahn, auf der man hinausging. */
  readonly out: readonly string[];
  /** Auf Bande oder Clip gestanden. */
  readonly onTop: readonly string[];
  /** Größte Fußhöhe über der Bahn, während die Hull an der Bande lag (Front ≤ 4 u davor; u) — Abstand zur Clip-Oberkante. */
  readonly maxAtWall: number;
}

/**
 * Wer mit Absicht oder aus Versehen nach außen hüpft: Blick fest, W + Sprint + Leertaste, dazu nie / in der Luft /
 * immer geduckt, Anflug 0–80° zur Wandnormale mit Anteil bergauf oder bergab, 0–900 u/s — auf der Wendel und am
 * Steg/an der Krone. Soll: niemand kommt hinaus, niemand steht auf der Bande. (Review: die 80-u-Bande ließ 508/1995
 * Crouch-Hops bergauf und 1010/1995 Hüpfer bergab hinaus.)
 */
export function bandeEscape(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, spec: BandeEscapeSpec = BANDE_ESCAPE): BandeEscapeResult {
  const h = lay.helix;
  const st = lay.steg;
  const F = st.frame;
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const inp = makeBotInput();
  const out: string[] = [];
  const onTop: string[] = [];
  let runs = 0;
  let maxAtWall = 0;
  const [fx, fz] = [-Math.sin((F.yaw * Math.PI) / 180), -Math.cos((F.yaw * Math.PI) / 180)];
  const [rx, rz] = [Math.cos((F.yaw * Math.PI) / 180), -Math.sin((F.yaw * Math.PI) / 180)];
  // Wo ist p? Wendel (θ ≤ 540) oder Steg: Bahnhöhe dort, höchste Bahn im Umkreis ±2° (Crouch-Stufen), und wie weit
  // die Hull-Mitte hinter der Innenkante der Bande liegt (in der Bahn höchstens −16). θ wird Tick für Tick
  // nachgeführt: wer an der Bande entlanggleitet, kommt in 3 s bis 170° weit — `thetaOf` sucht den Zweig nahe `near`.
  const where = (p: Vector3, near: number): { theta: number; floor: number; floorHi: number; beyond: number } => {
    const th = h.thetaOf(p.x, p.z, near);
    if (th <= 540 && th >= 0) {
      // Erster Abschnitt = Außenbahn an der Bande (in E2 liefert `after` die Grabensohle der Innenbahn).
      const floor = h.yAt(th);
      const floorHi = Math.max(floor, h.yAt(th, true), h.yAt(Math.max(0, th - 2)), h.yAt(Math.min(540, th + 2)));
      return { theta: th, floor, floorHi, beyond: Math.hypot(p.x, p.z) - R_OUT };
    }
    const u = (p.x - F.x) * fx + (p.z - F.z) * fz;
    const v = (p.x - F.x) * rx + (p.z - F.z) * rz;
    if (th > 540 && u >= 0 && u <= st.len + st.krone) return { theta: th, floor: st.floorAt(u), floorHi: st.floorAt(Math.min(st.len + st.krone, u + 24)), beyond: Math.abs(v) - st.half };
    return { theta: th, floor: Number.NaN, floorHi: Number.NaN, beyond: Number.NaN };
  };
  const run = (name: string, start: Vector3, dx: number, dz: number, v0: number, mode: EscapeMode, near0: number): void => {
    runs++;
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(start);
    pm.state.vel.set(dx * v0, 0, dz * v0);
    const yaw = yawOf(dx, dz);
    let exitFloor = Number.NaN;
    let near = near0;
    for (let k = 0; k < spec.seconds * cfg.tickRate; k++) {
      inp.yaw = yaw;
      inp.pitch = 0;
      inp.forward = 1;
      inp.side = 0;
      inp.sprint = true;
      inp.jumpHeld = true;
      inp.jumpPressed = k === 0;
      inp.crouch = mode === 'crouchHold' || (mode === 'crouchAir' && !pm.state.onGround);
      pm.tick(inp);
      const s = pm.state;
      const w = where(s.pos, near);
      near = w.theta;
      // Hull-Front höchstens 4 u vor der Bande: wie hoch kommen die Füße dort (Abstand zur Clip-Oberkante)?
      if (w.beyond > -20 && w.beyond <= 24) maxAtWall = Math.max(maxAtWall, s.pos.y - w.floor);
      // Hull-Mitte ≥ 24 u hinter der Innenkante der Bande: über oder hinter ihr (in der Bahn höchstens −16).
      if (w.beyond > 24 && Number.isNaN(exitFloor)) exitFloor = w.floor;
      // Steht über der Bahn am Rand (die Hull überlappt die Bande): auf Bande oder Clip.
      if (s.onGround && w.beyond > -24 && s.pos.y > w.floorHi + 40) {
        onTop.push(`${name}: steht bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}`);
        return;
      }
      const dead = deadIn(level, kills, pm);
      if (!Number.isNaN(exitFloor) && (dead || (w.beyond > 48 && s.pos.y < exitFloor - 100) || Number.isNaN(w.floor))) {
        out.push(`${name}: ${dead ? 'tot' : 'draußen'} bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)} nach ${((k + 1) / cfg.tickRate).toFixed(2)} s`);
        return;
      }
      if (dead) return; // ohne Austritt (Anlauf ohne Bande): kein Befund dieser Probe
    }
  };
  for (const theta of spec.thetas) {
    const phi = ((h.o.phi0 + theta) * Math.PI) / 180;
    const [ox, oz] = [Math.cos(phi), -Math.sin(phi)]; // radial nach außen
    const [tx, tz] = [-Math.sin(phi), -Math.cos(phi)]; // Fahrtrichtung (bergauf)
    for (const r0 of spec.radii) {
      const [x, z] = h.xz(theta, r0);
      for (const alpha of spec.alphas) {
        const [ca, sa] = [Math.cos(alpha * DEG), Math.sin(alpha * DEG)];
        for (const dir of alpha === 0 ? [1] : spec.dirs) {
          for (const v0 of spec.speeds) {
            for (const mode of spec.modes) {
              run(`Wendel θ ${theta} r ${r0} ${alpha}° ${dir > 0 ? 'bergauf' : 'bergab'} ${v0} u/s ${mode}`, new Vector3(x, h.yAt(theta, true) + 2, z), ca * ox + dir * sa * tx, ca * oz + dir * sa * tz, v0, mode, theta);
            }
          }
        }
      }
    }
  }
  for (const u of spec.stegU) {
    for (const side of [-1, 1]) {
      const [x, z] = F.xz(u, side * 150);
      for (const alpha of spec.alphas) {
        const [ca, sa] = [Math.cos(alpha * DEG), Math.sin(alpha * DEG)];
        for (const dir of alpha === 0 ? [1] : spec.dirs) {
          // Quer zur Seite (v), längs: bergauf = Westen (+u).
          const dx = ca * side * rx + dir * sa * fx;
          const dz = ca * side * rz + dir * sa * fz;
          for (const v0 of spec.speeds) {
            for (const mode of spec.modes) {
              run(`Steg u ${u} ${side > 0 ? 'Nord' : 'Süd'} ${alpha}° ${dir > 0 ? 'bergauf' : 'bergab'} ${v0} u/s ${mode}`, new Vector3(x, st.floorAt(u) + 2, z), dx, dz, v0, mode, 560);
            }
          }
        }
      }
    }
  }
  return { runs, out, onTop, maxAtWall };
}

function bandeEscapeProbe(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, r: DesignReport): void {
  const res = bandeEscape(level, lay, cfg);
  const line = `Bande/Clip nach außen — ${res.runs} Läufe (hop/Crouch-Hop/Ducken gehalten, 0–80° zur Wand, bergauf/bergab, 0–900 u/s, Wendel + Steg/Krone): ${res.out.length} hinaus, ${res.onTop.length} auf der Bande; Füße an der Bande höchstens ${f0(res.maxAtWall)} u über der Bahn (Clip bis ${CLIP_H})`;
  if (res.out.length || res.onTop.length) r.errors.push(`Design: ${line} (${[...res.out, ...res.onTop].slice(0, 3).join('; ')})`);
  else r.info.push(`Design: ${line}`);
}

// ---------------------------------------------------------------------------
// Crouch-Kanten

export interface CrouchEdgeResult {
  readonly wall: number;
  readonly speed: number;
  readonly runs: number;
  /** Oben angekommen (Füße auf der oberen Fläche hinter der Kante) in ≤ 4 s. */
  readonly up: number;
  /** Mittlere Zeit bis oben (s) der erfolgreichen Läufe. */
  readonly time: number;
  /** Tempo-Dellen (< 60 % in einem Tick, auch solche, die das Kanten-Gedächtnis zurückgibt). */
  readonly bonks: number;
  /** Tempo verloren: oben mit < 60 % des Tempos vor der Kante angekommen oder gar nicht — der teure Anprall. */
  readonly lost: number;
  readonly deaths: number;
}

export const CROUCH_SPEEDS: readonly number[] = [250, 400, 550, 700, 900];
export const CROUCH_RADII: readonly number[] = [760, 896, 1040];
/** Phasen je Tempo und Radius, gleichmäßig über eine Hop-Länge (Flugzeit × Tempo) verteilt. */
export const CROUCH_PHASES = 8;

/**
 * Gerader Hüpfer ab der Rampe vor jeder Kante (45° + Phase davor, die Phasen verteilt über eine ganze Hop-Länge:
 * so kommt jede Absprungstelle vor der Wand vor), Tempo × Radius, W + Sprint + Leertaste gehalten, Blick
 * tangential; `duck` = in der Luft immer geduckt (Crouch-Hop), sonst nie. Zählt, wer in ≤ 4 s oben steht und wer
 * dabei sein Tempo verliert (Anprall nach dem Scheitel, das Gedächtnis gibt nichts zurück).
 */
export function crouchEdges(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, duck: boolean, seconds = 4): CrouchEdgeResult[] {
  const out: CrouchEdgeResult[] = [];
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const inp = makeBotInput();
  const hopTime = (2 * cfg.jumpImpulse) / cfg.gravity;
  for (const wall of lay.crouchWalls) {
    const upper = lay.helix.yAt(wall + 0.5, true);
    for (const v of CROUCH_SPEEDS) {
      let up = 0;
      let runs = 0;
      let tSum = 0;
      let bonks = 0;
      let lost = 0;
      let deaths = 0;
      for (const rad of CROUCH_RADII) {
        for (let phase = 0; phase < CROUCH_PHASES; phase++) {
          runs++;
          const pm = new PlayerMovement(level.world, cfg);
          const start = wall - 45 - lay.helix.dTheta((phase / CROUCH_PHASES) * hopTime * v, rad);
          const [x, z] = lay.helix.xz(start, rad);
          pm.teleport(new Vector3(x, lay.helix.yAt(start, true) + 2, z));
          let prev = v;
          let before = 0;
          let ok = false;
          for (let k = 0; k < seconds * cfg.tickRate; k++) {
            const { theta, yaw } = tangentYaw(lay, pm.state.pos, start);
            if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
            fillHop(inp, yaw, k === 0, duck && !pm.state.onGround);
            pm.tick(inp);
            const s = pm.state;
            if (prev > 150 && s.speed < 0.6 * prev) bonks++;
            prev = s.speed;
            // Tempo vor der Kante: das höchste auf dem letzten Stück davor (Hull-Front noch vor der Wand).
            if (lay.helix.arc(wall - theta, rad) > 16) before = Math.max(before, s.speed);
            if (deadIn(level, kills, pm)) {
              deaths++;
              break;
            }
            // Oben = Füße auf der Ebene hinter der Kante (die Hull-Mitte darf bei der Landung auf der Lippe noch davor liegen).
            if (s.onGround && s.pos.y >= upper - 4 && theta > wall - 2) {
              up++;
              tSum += (k + 1) / cfg.tickRate;
              ok = s.speed >= 0.6 * before;
              break;
            }
          }
          if (!ok) lost++;
        }
      }
      out.push({ wall, speed: v, runs, up, time: up ? tSum / up : Number.NaN, bonks, lost, deaths });
    }
  }
  return out;
}

function fillHop(inp: MutablePlayerInput, yaw: number, press: boolean, crouch: boolean): PlayerInput {
  inp.yaw = yaw;
  inp.pitch = 0;
  inp.forward = 1;
  inp.side = 0;
  inp.sprint = true;
  inp.jumpHeld = true;
  inp.jumpPressed = press;
  inp.crouch = crouch;
  return inp;
}

/**
 * Teurer Anprall (Tempo verloren) je Kante und Tempo ab 550 u/s höchstens so oft (Anteil der Phasen) — ein Wächter,
 * keine Qualitätsgrenze. Mit gehaltener Leertaste entscheidet die Landephase: oben ist man bei Wandkontakt ≈ 0–0.56 s
 * nach dem Absprung (frühen Kontakt gibt das Kanten-Gedächtnis zurück), ein Hop dauert 0.755 s — von einer flachen
 * Terrasse, die länger als ein Hop ist, prallen also ≥ 25 % ab, von der tieferen Rampe davor mehr. Gebaut (Terrassen
 * 25°): 25–38 %. Kürzere Terrassen treiben es hoch (15°: bis 12/24 = 50 %, 8°: 50 % bei 550–900 u/s), dann warnt die
 * Probe. Gegen die Lotterie hilft in der Geometrie nur Timing: das Absprungband (duckMarkJumps). Terrassen 25–50°
 * (Sweep 29.09.) bleiben bei 71–88/240. Der Hebel liegt in der Physik: das Kanten-Gedächtnis zählt nur Luftzeit, der
 * späte Anprall verbraucht es im Fallen + Neu-Hop (≥ 0.25 s); mit ledgeMemory 0.45 s statt 0.2 s nur 11/240, 0.6 s 3/240
 * (Design-Proben L1–L4 bei 0.45 s unverändert; level4.md "Crouch-Kanten") — Entscheidung beim Movement-Owner.
 */
export const CROUCH_LOST_MAX = 0.4;

function crouchEdgesProbe(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, r: DesignReport): void {
  const withDuck = crouchEdges(level, lay, cfg, true);
  const noDuck = crouchEdges(level, lay, cfg, false);
  const runs = withDuck.reduce((a, x) => a + x.runs, 0);
  const up = withDuck.reduce((a, x) => a + x.up, 0);
  const deaths = [...withDuck, ...noDuck].reduce((a, x) => a + x.deaths, 0);
  const cheat = noDuck.reduce((a, x) => a + x.up, 0);
  const detail = withDuck.map((x) => `K${lay.crouchWalls.indexOf(x.wall) + 1}@${x.speed} ${x.up}/${x.runs}${x.up ? ` ${x.time.toFixed(1)} s` : ''}`).join(', ');
  if (up < 0.95 * runs) r.errors.push(`Design: Crouch-Kanten — nur ${up}/${runs} Crouch-Hüpfer in ≤ 4 s oben (Soll ≥ 95 %; ${detail})`);
  else r.info.push(`Design: Crouch-Kanten — ${up}/${runs} Crouch-Hüpfer in ≤ 4 s oben (${detail})`);
  const lostLine = withDuck.map((x) => `K${lay.crouchWalls.indexOf(x.wall) + 1}@${x.speed} ${x.lost}/${x.runs}`).join(', ');
  const tooMany = withDuck.filter((x) => x.speed >= 550 && x.lost > CROUCH_LOST_MAX * x.runs);
  if (tooMany.length) r.warnings.push(`Design: Crouch-Kanten — teurer Anprall (oben mit < 60 % Tempo) zu oft, Soll ≤ ${f0(CROUCH_LOST_MAX * 100)} % ab 550 u/s: ${lostLine}`);
  else r.info.push(`Design: Crouch-Kanten — teurer Anprall (oben mit < 60 % Tempo, Phasen über einen ganzen Hop): ${lostLine}`);
  if (cheat > 0) r.errors.push(`Design: Crouch-Kanten ohne Ducken erreichbar — ${cheat} von ${noDuck.reduce((a, x) => a + x.runs, 0)} Hüpfern ohne Ducken oben`);
  else r.info.push(`Design: Crouch-Kanten ohne Ducken 0/${noDuck.reduce((a, x) => a + x.runs, 0)}`);
  if (deaths > 0) r.errors.push(`Design: Crouch-Kanten töten (${deaths} Tode)`);
  const marks = duckMarkJumps(level, lay, cfg);
  const part = (band: 'near' | 'far', speeds: readonly number[]): string => {
    const ms = marks.filter((x) => x.band === band);
    const runs = ms.reduce((a, x) => a + x.runs, 0);
    const clean = ms.reduce((a, x) => a + x.clean, 0);
    return `${clean}/${runs} bei ${speeds[0]}–${speeds[speeds.length - 1]} u/s (Hull-Front ${ms.map((x) => `K${lay.crouchWalls.indexOf(x.wall) + 1} ${f0(x.from)}–${f0(x.to)} u`).join(', ')})`;
  };
  const line = `Absprungband — Crouch-Jumps aus dem Band oben mit ≥ 90 % Tempo: durchgehend ${part('near', MARK_SPEEDS)}; Streifen ${part('far', MARK_SPEEDS_FAR)}`;
  const fails = marks.flatMap((x) => x.fails);
  if (fails.length) r.errors.push(`Design: ${line} (${fails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design: ${line}`);
}

// ---------------------------------------------------------------------------
// Absprungband auf den Terrassen

export interface DuckMarkResult {
  readonly wall: number;
  /** 'near' = durchgehendes Band (gilt immer), 'far' = Streifen davor (gilt mit Tempo). */
  readonly band: 'near' | 'far';
  /** Hull-Front-Abstand zur Wand (u, senkrecht zur Wand), den das Band abdeckt. */
  readonly from: number;
  readonly to: number;
  readonly runs: number;
  /** Oben mit ≥ 90 % des Anlauf-Tempos. */
  readonly clean: number;
  readonly fails: readonly string[];
}

/**
 * Tempi, für die das Band gilt. Nah: von der Wiederholung nach einem Anprall (~250 u/s) und Neulingen (~320) bis 950
 * — Review 29.09.: die Probe begann bei 450 und sah nicht, dass der wandferne Teil der alten Marke Langsame abprallen
 * ließ. Fern (Streifen): erst ab 450 u/s (400 u/s gemessen nur bis Hull-Front 168 u).
 */
export const MARK_SPEEDS: readonly number[] = [250, 320, 400, 450, 550, 700, 850, 950];
export const MARK_SPEEDS_FAR: readonly number[] = [450, 550, 700, 850, 950];

/**
 * Wer im Band springt, kommt hoch, ohne Tempo zu verlieren: Crouch-Jump von der Terrasse (Druck im Bodentick, in der
 * Luft geduckt, Blick tangential) mit der Hull-Mitte an 5 Stellen über die Tiefe des Bandes × 3 Radien über seine
 * Breite × Tempi. Das Band kommt aus dem kompilierten Level (Brushes 'duckMark' / 'duckMarkFar'), nicht aus dem Builder
 * — die Probe prüft, was gebaut ist. Abstand = senkrecht zur (radialen) Wand, wie das Band liegt.
 */
export function duckMarkJumps(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig): DuckMarkResult[] {
  const h = lay.helix;
  const inp = makeBotInput();
  const out: DuckMarkResult[] = [];
  const hw = cfg.hull.halfWidth;
  for (const wall of lay.crouchWalls) {
    const terrace = h.yAt(wall - 0.5);
    const upper = h.yAt(wall + 0.5, true);
    // Wand-Ebene: radial bei θ = wall; t = Fahrtrichtung dort (Normale der Wand).
    const [wx, wz] = h.xz(wall, R_LINE);
    const ty = (h.yawAt(wall) * Math.PI) / 180;
    const [tx, tz] = [-Math.sin(ty), -Math.cos(ty)];
    for (const [band, tag, speeds] of [['near', 'duckMark', MARK_SPEEDS], ['far', 'duckMarkFar', MARK_SPEEDS_FAR]] as const) {
      let near = Infinity;
      let far = -Infinity;
      let rMin = Infinity;
      let rMax = -Infinity;
      for (const b of level.def.brushes) {
        if (b.tag !== tag || b.type !== 'hull') continue;
        for (const [x, y, z] of b.points) {
          const d = -((x - wx) * tx + (z - wz) * tz);
          if (Math.abs(y - terrace) > 8 || d < 0 || d > 400) continue;
          near = Math.min(near, d);
          far = Math.max(far, d);
          rMin = Math.min(rMin, Math.hypot(x, z));
          rMax = Math.max(rMax, Math.hypot(x, z));
        }
      }
      if (!(far > near)) {
        out.push({ wall, band, from: Number.NaN, to: Number.NaN, runs: 1, clean: 0, fails: [`θ ${wall}: kein Band '${tag}' auf der Terrasse`] });
        continue;
      }
      const fails: string[] = [];
      let runs = 0;
      let clean = 0;
      for (let i = 0; i < 5; i++) {
        const centre = near + ((far - near) * i) / 4; // Hull-Mitte über dem Band
        for (const rad of [rMin + 0.2 * (rMax - rMin), (rMin + rMax) / 2, rMax - 0.2 * (rMax - rMin)]) {
          for (const v of speeds) {
            runs++;
            const pm = new PlayerMovement(level.world, cfg);
            const [x0, z0] = h.xz(wall, rad);
            pm.teleport(new Vector3(x0 - tx * centre, terrace + 1, z0 - tz * centre));
            let ok = false;
            for (let k = 0; k < 1.5 * cfg.tickRate; k++) {
              const { theta, yaw } = tangentYaw(lay, pm.state.pos, wall);
              if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
              fillHop(inp, yaw, k === 0, k > 0 && !pm.state.onGround);
              inp.jumpHeld = k === 0;
              pm.tick(inp);
              const s = pm.state;
              if (k > 2 && s.onGround) {
                ok = s.pos.y > upper - 4 && theta > wall - 2 && s.speed >= 0.9 * v;
                if (!ok) fails.push(`K θ ${wall} Front ${f0(centre - hw)} u r ${f0(rad)} ${v} u/s: ${s.pos.y > upper - 4 ? `oben mit ${f0(s.speed)} u/s` : 'abgeprallt'}`);
                break;
              }
            }
            if (ok) clean++;
          }
        }
      }
      out.push({ wall, band, from: near - hw, to: far - hw, runs, clean, fails });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Innenbahn

export interface InnerLaneResult {
  /** Innenlinie gegen Außenroute: 1 − Weg innen / Weg außen, gefahren (Median der W+Leertaste-Hüpfer je Linie). */
  readonly shorter: number;
  /** Gefahrener Weg (u) durch E2 je Linie (Median). */
  readonly pathIn: number;
  readonly pathOut: number;
  readonly runs: number;
  readonly deaths: number;
  readonly trenchLandings: number;
  /** Rettung aus dem Graben: größte / mittlere Zeit (s) bis zurück auf der Bahn dahinter. */
  readonly rescueMax: number;
  readonly rescueMean: number;
  readonly rescueWorst: string;
}

/**
 * Gefahrener Weg durch E2 (u, horizontal): W + Leertaste, Blick tangential, 450 u/s, ab θ e2+2 bis e2−2 — Median über
 * 4 Phasen. Aus dem kompilierten Level (Gräben, Hänge, Luftlenkung), nicht aus den Radien: der Test "≥ 20 % kürzer"
 * rechnete vorher nur 1 − 752/1000 (Review 29.09.).
 */
export function lanePath(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, rad: number): number {
  const h = lay.helix;
  const inp = makeBotInput();
  const lens: number[] = [];
  for (let ph = 0; ph < 4; ph++) {
    const pm = new PlayerMovement(level.world, cfg);
    const start = lay.e2[0] + 2 + ph * 1.5;
    const [x, z] = h.xz(start, rad);
    pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
    let len = 0;
    let ok = false;
    for (let k = 0; k < 12 * cfg.tickRate; k++) {
      const { theta, yaw } = tangentYaw(lay, pm.state.pos, start + 60);
      if (k === 0) pm.state.vel.set(-Math.sin(yaw) * 450, 0, -Math.cos(yaw) * 450);
      const [px, pz] = [pm.state.pos.x, pm.state.pos.z];
      pm.tick(fillHop(inp, yaw, k === 0, false));
      if (theta >= lay.e2[0] + 2) len += Math.hypot(pm.state.pos.x - px, pm.state.pos.z - pz);
      if (theta >= lay.e2[1] - 2) {
        ok = true;
        break;
      }
    }
    if (ok) lens.push(len);
  }
  lens.sort((a, b) => a - b);
  return lens.length ? lens[Math.floor((lens.length - 1) / 2)] : Number.NaN;
}

/**
 * (0) Weg: gefahren je Linie (lanePath, innen r 752 gegen die Außenroute r 1000).
 * (1) Geradeaus-Hüpfer auf der Innenlinie durch alle drei Gräben (320–900 u/s × 8 Phasen): niemand stirbt.
 * (2) Rettung: Start am Rücken jedes Grabens (Grabenboden, 3 Radien, Tempo 0–650), W + Leertaste, Blick
 *     tangential — Zeit, bis man hinter dem Graben wieder auf Bahnhöhe ist, am Boden oder im Hop darüber (Entwurf:
 *     0.75–1.8 s). "Am Boden" allein maß die Hop-Phase mit: aus dem Stand landete ein Hop 0.5° vor tb + 1 auf der Bahn,
 *     der nächste zählte erst 0.6 s später (1.45 → 2.05 s, 29.09.).
 */
export function innerLane(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig): InnerLaneResult {
  const h = lay.helix;
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const inp = makeBotInput();
  const pathIn = lanePath(level, lay, cfg, R_E2_IN);
  const pathOut = lanePath(level, lay, cfg, R_E2_OUT);
  const shorter = 1 - pathIn / pathOut;
  let runs = 0;
  let deaths = 0;
  let trenchLandings = 0;
  const goal = lay.trenches[lay.trenches.length - 1][1] + 4;
  const inTrench = (theta: number, pm: PlayerMovement): boolean =>
    pm.state.onGround && Math.hypot(pm.state.pos.x, pm.state.pos.z) < R_SPLIT && lay.trenches.some(([a, b]) => theta > a && theta < b) && pm.state.pos.y < h.yAt(theta) - 8;
  for (const v of [320, 450, 600, 750, 900]) {
    for (let ph = 0; ph < 8; ph++) {
      runs++;
      const pm = new PlayerMovement(level.world, cfg);
      const start = lay.e2[0] + 4 + ph * 1.5;
      const [x, z] = h.xz(start, R_E2_IN);
      pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
      let was = false;
      for (let k = 0; k < 12 * cfg.tickRate; k++) {
        const { theta, yaw } = tangentYaw(lay, pm.state.pos, start + 60);
        if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
        pm.tick(fillHop(inp, yaw, k === 0, false));
        const now = inTrench(theta, pm);
        if (now && !was) trenchLandings++;
        was = now;
        if (deadIn(level, kills, pm)) {
          deaths++;
          break;
        }
        if (theta > goal && pm.state.pos.y > h.yAt(goal) - 40) break;
      }
    }
  }
  let rescueMax = 0;
  let rescueSum = 0;
  let n = 0;
  let rescueWorst = '';
  for (const [ta, tb] of lay.trenches) {
    for (const rad of [700, R_E2_IN, 820]) {
      for (const v of [0, 250, 450, 650]) {
        const pm = new PlayerMovement(level.world, cfg);
        const t0 = ta + 1.5;
        const [x, z] = h.xz(t0, rad);
        pm.teleport(new Vector3(x, h.yAt(t0, true) + 2, z));
        let t = 6;
        for (let k = 0; k < 6 * cfg.tickRate; k++) {
          const { yaw } = tangentYaw(lay, pm.state.pos, t0);
          if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
          pm.tick(fillHop(inp, yaw, k === 0, false));
          const th = h.thetaOf(pm.state.pos.x, pm.state.pos.z, t0);
          if (deadIn(level, kills, pm)) {
            deaths++;
            break;
          }
          if (th > tb + 1 && pm.state.pos.y > h.yAt(th) - 6) {
            t = (k + 1) / cfg.tickRate;
            break;
          }
        }
        n++;
        rescueSum += t;
        if (t > rescueMax) {
          rescueMax = t;
          rescueWorst = `Graben θ ${f0(ta)}–${f0(tb)}, r ${rad}, ${v} u/s`;
        }
      }
    }
  }
  return { shorter, pathIn, pathOut, runs, deaths, trenchLandings, rescueMax, rescueMean: rescueSum / n, rescueWorst };
}

function innerLaneProbe(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, r: DesignReport): void {
  const res = innerLane(level, lay, cfg);
  const line = `Innenbahn ${f0(res.shorter * 100)} % kürzer (gefahren ${f0(res.pathIn)} gegen ${f0(res.pathOut)} u), ${res.runs} Geradeaus-Hüpfer (${(res.trenchLandings / res.runs).toFixed(2)} Grabenlandungen/Lauf), Rettung aus dem Graben Ø ${res.rescueMean.toFixed(2)} s / max ${res.rescueMax.toFixed(2)} s`;
  const bad: string[] = [];
  if (!(res.shorter >= 0.2)) bad.push(`nur ${f0(res.shorter * 100)} % kürzer (Soll ≥ 20 %)`);
  if (res.deaths > 0) bad.push(`${res.deaths} Tode`);
  if (res.rescueMax > 2) bad.push(`Rettung dauert bis ${res.rescueMax.toFixed(2)} s (${res.rescueWorst}; Soll ≤ 2 s)`);
  if (bad.length) r.errors.push(`Design: ${line} — ${bad.join(', ')}`);
  else r.info.push(`Design: ${line}`);
  const choice = laneChoice(level, lay, cfg);
  const cells = choice.map((c) => `${c.speed}: ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(2)} s (Graben ${c.trench}/${c.runs})`).join(', ');
  const cline = `Innenbahn als Wahl — W + Leertaste innen (r ${R_E2_IN}) minus außen (r ${LANE_OUTER}) bis P2, Median über ${LANE_PHASES} Phasen: ${cells}`;
  const warn: string[] = [];
  const slow = choice[0];
  if (!(slow.diff <= -LANE_SLOW_GAIN)) warn.push(`bei ${slow.speed} u/s innen nicht ≥ ${LANE_SLOW_GAIN} s schneller (keine Wahl)`);
  const trap = choice.filter((c) => !(c.diff <= LANE_TRAP));
  if (trap.length) warn.push(`innen bis ${Math.max(...trap.map((c) => c.diff)).toFixed(2)} s langsamer (Soll ≤ ${LANE_TRAP} s: sonst Falle)`);
  if (warn.length) r.warnings.push(`Design: ${cline} — ${warn.join(', ')}`);
  else r.info.push(`Design: ${cline}`);
}

/** Außenlinie des Linienvergleichs (Mitte der Außenbahn wie ein Mensch, nicht die Route r 1000). */
export const LANE_OUTER = 900;
export const LANE_SPEEDS: readonly number[] = [320, 450, 550, 650, 800, 950];
export const LANE_PHASES = 16;
/** Innen mindestens so viel schneller beim langsamsten Tempo (Neuling), höchstens so viel langsamer bei jedem Tempo (s). */
export const LANE_SLOW_GAIN = 0.3;
export const LANE_TRAP = 0.5;

export interface LaneChoice {
  readonly speed: number;
  /** Median(innen) − Median(außen), Spiel-Zeit bis P2 (s); negativ = innen schneller. */
  readonly diff: number;
  readonly runs: number;
  /** Läufe innen mit mindestens einer Grabenlandung. */
  readonly trench: number;
}

/**
 * Innenbahn als Wahl nach Tempo (Review 29.09.: mit 72-u-Gräben war sie ab 450 u/s eine Falle, +1.33 s): W + Leertaste,
 * Blick tangential, je Tempo `phases` Starts über eine Hop-Länge (22° bei r 752), Zeit bis P2 abzüglich des Vorsprungs der
 * Startphase — innen r 752 gegen außen r 900. Median je Linie; wie oft innen ein Graben getroffen wurde.
 */
export function laneChoice(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, speeds: readonly number[] = LANE_SPEEDS, phases = LANE_PHASES): LaneChoice[] {
  const h = lay.helix;
  const inp = makeBotInput();
  const [e2a, e2b] = lay.e2;
  const goalY = h.yAt(e2b) - 30;
  const run = (rad: number, v: number, ph: number): { t: number; trench: boolean } => {
    const pm = new PlayerMovement(level.world, cfg);
    const start = e2a + 1 + (ph * 22) / phases;
    const [x, z] = h.xz(start, rad);
    pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
    let trench = false;
    for (let k = 0; k < 15 * cfg.tickRate; k++) {
      const { theta, yaw } = tangentYaw(lay, pm.state.pos, start + k * 0.05);
      if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
      pm.tick(fillHop(inp, yaw, k === 0, false));
      const s = pm.state;
      if (s.onGround && Math.hypot(s.pos.x, s.pos.z) < R_SPLIT && lay.trenches.some(([a, b]) => theta > a && theta < b) && s.pos.y < h.yAt(theta) - 6) trench = true;
      if (theta >= e2b && s.pos.y > goalY) return { t: (k + 1) / cfg.tickRate - ((start - e2a) * DEG * rad) / v, trench };
    }
    return { t: Number.NaN, trench };
  };
  return speeds.map((v) => {
    const outer: number[] = [];
    const inner: number[] = [];
    let trench = 0;
    for (let ph = 0; ph < phases; ph++) {
      outer.push(run(LANE_OUTER, v, ph).t);
      const i = run(R_E2_IN, v, ph);
      inner.push(i.t);
      if (i.trench) trench++;
    }
    return { speed: v, diff: medianOf(inner) - medianOf(outer), runs: phases, trench };
  });
}

// ---------------------------------------------------------------------------
// Anfänger

type Novice = 'W' | 'W+Space' | 'W+Space+Duck';

export interface NoviceResult {
  readonly kind: Novice;
  /** Spiel-Uhr (ab Spawn) beim Erreichen jedes Checkpoints. */
  readonly checkpoints: readonly number[];
  readonly deaths: number;
  /** Tode vor dem genannten Checkpoint (Index = Checkpoint-Stand beim Tod). */
  readonly deathsAt: readonly number[];
  readonly stuck: string | null;
}

/** Knoten-Tracker mit Höhe: erreicht = horizontal < 96 u und Füße nicht tiefer als 48 u darunter, oder passiert. */
class NodeTracker {
  constructor(
    private readonly route: readonly RouteNode[],
    public i: number,
  ) {}

  update(p: Vector3): RouteNode {
    const route = this.route;
    for (;;) {
      const n = route[this.i];
      const nx = route[this.i + 1];
      if (!nx) return n;
      const dx = p.x - n.pos[0];
      const dz = p.z - n.pos[2];
      const near = Math.hypot(dx, dz) < 96 && p.y > n.pos[1] - 48;
      const prev = route[Math.max(0, this.i - 1)];
      const sx = n.pos[0] - prev.pos[0];
      const sz = n.pos[2] - prev.pos[2];
      const len = Math.hypot(sx, sz);
      const passed = len > 1 && (dx * sx + dz * sz) / len > 0 && Math.abs(dx * sz - dz * sx) / len < 300 && p.y > n.pos[1] - 48;
      if (near || passed) this.i++;
      else return n;
    }
  }
}

/**
 * Neuling mit Respawn am Checkpoint, Blick auf den nächsten Route-Knoten (höhenbewusst): nur W, W + Leertaste
 * gehalten, W + Leertaste + in der Luft geduckt. Wo stirbt er, wo staut er (40 s ohne Checkpoint)?
 */
export function novice(level: CompiledLevel, cfg: MovementConfig, kind: Novice, seconds: number): NoviceResult {
  const route = level.def.route ?? [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const ev: RunEvent[] = [];
  pm.teleport(new Vector3(level.spawnPos.x, level.spawnPos.y + 1, level.spawnPos.z));
  let tr = new NodeTracker(route, 0);
  const inp = makeBotInput();
  const dt = 1 / cfg.tickRate;
  const checkpoints: number[] = [];
  const deathsAt: number[] = [];
  let deaths = 0;
  let lastCp = 0;
  let stuck: string | null = null;
  let held = false;
  for (let k = 0; k < seconds * cfg.tickRate; k++) {
    const t = k * dt;
    const n = tr.update(pm.state.pos);
    inp.yaw = yawOf(n.pos[0] - pm.state.pos.x, n.pos[2] - pm.state.pos.z);
    inp.pitch = 0;
    inp.forward = 1;
    inp.side = 0;
    inp.sprint = true;
    inp.jumpHeld = kind !== 'W';
    inp.jumpPressed = inp.jumpHeld && !held;
    held = inp.jumpHeld;
    inp.crouch = kind === 'W+Space+Duck' && !pm.state.onGround;
    pm.tick(inp);
    const before = run.checkpoint;
    const out = run.tick(dt, pm.state.pos, pm.hullMins, pm.hullMaxs, pm.state.speed, pm.state.onGround, ev);
    if (run.checkpoint > before) {
      checkpoints[run.checkpoint - 1] = t;
      lastCp = t;
    }
    if (out === 'finish') break;
    if (out === 'fall' || out === 'kill') {
      deaths++;
      deathsAt[run.checkpoint] = (deathsAt[run.checkpoint] ?? 0) + 1;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      tr = new NodeTracker(route, run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0);
      held = false;
    }
    if (!stuck && t - lastCp > 40) {
      const p = pm.state.pos;
      stuck = `Stau nach CP${run.checkpoint} bei ${f0(p.x)},${f0(p.y)},${f0(p.z)} vor Knoten ${tr.i}${route[tr.i]?.note ? ` [${route[tr.i].note}]` : ''}`;
    }
  }
  return { kind, checkpoints, deaths, deathsAt: Array.from({ length: cps.length + 1 }, (_, i) => deathsAt[i] ?? 0), stuck };
}

function novicesProbe(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const lines: string[] = [];
  for (const kind of ['W', 'W+Space', 'W+Space+Duck'] as const) {
    const res = novice(level, cfg, kind, kind === 'W+Space+Duck' ? 60 : 40);
    const cp = res.checkpoints.map((t, i) => `CP${i + 1} ${t.toFixed(1)} s`).join(', ') || 'kein CP';
    lines.push(`${kind}: ${cp}, ${res.deaths} Tode${res.stuck ? ` (${res.stuck})` : ''}`);
    // Pflicht: W + Leertaste + Ducken bis zur Krone ohne Tod in ≤ 45 s; W / W + Leertaste bis CP2 ohne Tod in ≤ 25 s.
    const need = kind === 'W+Space+Duck' ? 4 : 2;
    const limit = kind === 'W+Space+Duck' ? 45 : 25;
    const t = res.checkpoints[need - 1];
    const early = res.deathsAt.slice(0, need).reduce((a, b) => a + b, 0);
    if (t === undefined || t > limit || early > 0)
      r.errors.push(`Design: Anfänger ${kind} kommt nicht ohne Tod in ≤ ${limit} s bis CP${need} (${cp}, Tode vor CP${need}: ${early}${res.stuck ? `; ${res.stuck}` : ''})`);
  }
  r.info.push(`Design: Anfänger — ${lines.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Drop-In an der Krone

export interface DropInResult {
  readonly runs: number;
  readonly ok: number;
  readonly deaths: number;
  readonly meanTime: number;
  readonly fails: readonly string[];
}

/** Brett (Brush 'absprung') und Krone quer: Mitte und halbe Breite in z (die Abfahrt läuft nach Westen). */
function boardSpan(level: CompiledLevel, tag: string): { readonly mid: number; readonly half: number; readonly west: number } | null {
  const b = level.brushes.find((x) => level.def.brushes[x.index]?.tag === tag);
  if (!b) return null;
  return { mid: (b.bounds.min.z + b.bounds.max.z) / 2, half: (b.bounds.max.z - b.bounds.min.z) / 2, west: b.bounds.min.x };
}

/** Versatz quer zur Brettmitte als Anteil der halben Brettbreite (ohne Hull): die ganze Brettbreite. */
export const DROP_LATERALS: readonly number[] = [-0.75, -0.375, 0, 0.375, 0.75];

/** Anlauf vom Steg (Review 29.09.): Start bei Steg-u 800, quer ±160, Tempo, Kursfehler (Grad, − = nach Norden). */
export const DROP_APPROACH = { u: 800, laterals: [-160, -80, 0, 80, 160], speeds: [400, 600, 800], courseErr: [-8, -3, 0, 3, 8], looks: [0, 2] } as const;

/**
 * Achse der Abfahrt: alle Rampen laufen mit dem Steg nach Westen (yaw des Steg-Frames). Nicht routeAxis: die
 * verbindet Knoten auf verschiedenen Tiefen (quer versetzt) — der "Blick 0°" des Surfers lag dann bis zu ~2°
 * neben der Rampe, und jede Route-Änderung verschob die Probe.
 */
export function descentAxis(lay: Level4Layout): () => number {
  const yaw = lay.steg.frame.yaw * DEG;
  return () => yaw;
}

/**
 * Grundtechnik-Surfer vom Sprungbrett — zwei Anläufe, der Surfer lenkt in der Luft nicht:
 * (1) ruhig am CP4-Spawn, quer über die Brettbreite versetzt, 0–800 u/s genau nach Westen, Blickfehler −2…+5°;
 * (2) wie ein Mensch vom Steg (DROP_APPROACH): W + Leertaste mit Kursfehler ±8°, ab dem Brettende Surfer mit Blick
 *     0°/2°. (2) fehlte bis zum Review: dort starben Surfer mit Kurs nach Norden am Fuß der Nordflanke (67/75).
 * Erreicht er den CP5-Trigger? Tode und Zeitlimits (Grat-Hänger) je Anlauf getrennt.
 */
export function dropIn(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig): { readonly spawn: DropInResult; readonly approach: DropInResult } {
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const cp4 = cps[3];
  const cp5 = cps[4];
  const board = boardSpan(level, 'absprung');
  const axis = descentAxis(lay);
  const none: DropInResult = { runs: 1, ok: 0, deaths: 0, meanTime: Number.NaN, fails: ['Brett, CP4 oder CP5 fehlt'] };
  if (!board || !cp4 || !cp5) return { spawn: none, approach: none };
  const brettEnde = board.west;
  const inp = makeBotInput();
  /** Ein Lauf: bis zum Brettende `pre` (null = gleich Surfer), dann Surfer; Ergebnis in `acc`. */
  const ride = (acc: { runs: number; ok: number; deaths: number; tSum: number; fails: string[] }, name: string, start: Vector3, vel: Vector3, look: number, pre: number | null): void => {
    acc.runs++;
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(start);
    pm.state.vel.copy(vel);
    const rider = new SurfRider(cfg, level.world, axis, look * DEG);
    let surf = pre === null;
    for (let k = 0; k < 12 * cfg.tickRate; k++) {
      if (!surf && pm.state.pos.x < brettEnde) surf = true;
      if (surf || pre === null) pm.tick(rider.next(pm.state, pm.surfNormal));
      else pm.tick(fillHop(inp, pre, k === 0, false));
      if (inTrigger(cp5, pm)) {
        acc.ok++;
        acc.tSum += (k + 1) / cfg.tickRate;
        return;
      }
      if (deadIn(level, kills, pm)) {
        acc.deaths++;
        acc.fails.push(`${name}: tot bei ${f0(pm.state.pos.x)},${f0(pm.state.pos.y)},${f0(pm.state.pos.z)}`);
        return;
      }
    }
    acc.fails.push(`${name}: Zeitlimit bei ${f0(pm.state.pos.x)},${f0(pm.state.pos.y)},${f0(pm.state.pos.z)}`);
  };
  const a1 = { runs: 0, ok: 0, deaths: 0, tSum: 0, fails: [] as string[] };
  const reach = board.half - 16;
  for (const look of [-2, 0, 2, 5]) {
    for (const v of [0, 300, 550, 800]) {
      for (const share of DROP_LATERALS) {
        const lateral = Math.round(share * reach);
        ride(a1, `Spawn Blick ${look}° ${v} u/s quer ${lateral}`, new Vector3(cp4.spawnPos.x, cp4.spawnPos.y + 1, board.mid - lateral), new Vector3(-v, 0, 0), look, null);
      }
    }
  }
  const a2 = { runs: 0, ok: 0, deaths: 0, tSum: 0, fails: [] as string[] };
  const st = lay.steg;
  for (const look of DROP_APPROACH.looks) {
    for (const v of DROP_APPROACH.speeds) {
      for (const lat of DROP_APPROACH.laterals) {
        for (const err of DROP_APPROACH.courseErr) {
          const [x, z] = st.frame.xz(DROP_APPROACH.u, lat);
          const yaw = (st.frame.yaw + err) * DEG;
          ride(a2, `Steg Blick ${look}° ${v} u/s quer ${lat} Kurs ${err > 0 ? '+' : ''}${err}°`, new Vector3(x, st.floorAt(DROP_APPROACH.u) + 2, z), new Vector3(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v), look, yaw);
        }
      }
    }
  }
  const done = (a: typeof a1): DropInResult => ({ runs: a.runs, ok: a.ok, deaths: a.deaths, meanTime: a.ok ? a.tSum / a.ok : Number.NaN, fails: a.fails });
  return { spawn: done(a1), approach: done(a2) };
}

/**
 * Trichter an der Kronen-Westkante: wer neben dem Brett anläuft (W + Sprint, Blick nach Westen, mit und ohne
 * Leertaste, aus dem Stand und mit 400 u/s), gleitet aufs Brett — keiner bleibt an der Wand stehen.
 * Liefert die Starts, die in 2.5 s nicht über das Kronen-Ende hinauskommen.
 */
export function funnel(level: CompiledLevel, cfg: MovementConfig): { readonly runs: number; readonly stuck: readonly string[] } {
  const board = boardSpan(level, 'absprung');
  const krone = boardSpan(level, 'krone');
  const cp4 = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 4);
  if (!board || !krone || !cp4) return { runs: 0, stuck: ['Brett, Krone oder CP4 fehlt'] };
  const inp = makeBotInput();
  const stuck: string[] = [];
  let runs = 0;
  // Mitte zwischen Brettrand und Kronenrand, beidseits.
  const zs = [(board.mid - board.half + krone.mid - krone.half) / 2, (board.mid + board.half + krone.mid + krone.half) / 2];
  for (const z of zs) {
    for (const v of [0, 400]) {
      for (const hop of [false, true]) {
        runs++;
        const pm = new PlayerMovement(level.world, cfg);
        pm.teleport(new Vector3(cp4.spawnPos.x, cp4.spawnPos.y + 1, z));
        pm.state.vel.set(-v, 0, 0);
        let ok = false;
        for (let k = 0; k < 2.5 * cfg.tickRate && !ok; k++) {
          fillHop(inp, 90 * DEG, k === 0 && hop, false);
          inp.jumpHeld = hop;
          pm.tick(inp);
          ok = pm.state.pos.x < krone.west - 24;
        }
        if (!ok) stuck.push(`z ${f0(z)}, ${v} u/s${hop ? ' + Leertaste' : ''}: steht bei ${f0(pm.state.pos.x)},${f0(pm.state.pos.y)},${f0(pm.state.pos.z)}`);
      }
    }
  }
  return { runs, stuck };
}

function dropInProbe(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, r: DesignReport): void {
  const f = funnel(level, cfg);
  if (f.stuck.length) r.errors.push(`Design: Trichter an der Krone — ${f.stuck.length}/${f.runs} Anläufe neben dem Brett bleiben stehen (${f.stuck.slice(0, 2).join('; ')})`);
  else r.info.push(`Design: Trichter an der Krone — ${f.runs}/${f.runs} Anläufe neben dem Brett gleiten aufs Brett`);
  const { spawn, approach } = dropIn(level, lay, cfg);
  const part = (x: DropInResult): string => `${x.ok}/${x.runs}${x.deaths ? `, ${x.deaths} Tode` : ''}${x.runs - x.ok - x.deaths ? `, ${x.runs - x.ok - x.deaths} Zeitlimit` : ''}`;
  const line = `Drop-In vom Sprungbrett — Grundtechnik-Surfer an CP5: ruhig am CP4-Spawn ${part(spawn)} (Ø ${spawn.meanTime.toFixed(1)} s), Anlauf vom Steg mit Kursfehler ±8° ${part(approach)}`;
  const fails = [...spawn.fails, ...approach.fails];
  if (spawn.ok < 0.95 * spawn.runs || approach.ok < 0.95 * approach.runs) r.errors.push(`Design: ${line}, Soll je ≥ 95 % (${fails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design: ${line}${fails.length ? ` (${fails.slice(0, 2).join('; ')})` : ''}`);
}

// ---------------------------------------------------------------------------
// Tempo: Launch und Skill-Spreizung

export interface TempoResult {
  /** Spiel-Uhr, Median über die Seeds 1–8. */
  readonly perfect: number | null;
  readonly hand3: number | null;
  /** Tempo des perfekten Bots am Launch-Knoten (u/s). */
  readonly launch: number;
}

export function tempo(level: CompiledLevel, cfg: MovementConfig): TempoResult {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const perfect = timedMedian(level, { sync: 1 }, seeds, cfg).median;
  const hand3 = timedMedian(level, { aimNoiseDeg: 3 }, seeds, cfg).median;
  const route = level.def.route ?? [];
  const li = route.findIndex((n) => n.note === 'Launch');
  const res = runRoute(level, cfg, { sync: 1, seed: 1 });
  const node = res.nodes.find((x) => x.index === li);
  return { perfect, hand3, launch: node ? node.speed : 0 };
}

/**
 * Plan 007 (Abnahme level4): sync 1.0 22–30 s (Spiel-Uhr), Hand 3° ≥ 1.15 × sync 1.0 (Skill zählt),
 * Launch ≥ 950 u/s (der Belohnungsflug). Warnungen — sie verschieben sich mit jedem Movement-Tuning.
 */
function tempoProbe(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const t = tempo(level, cfg);
  if (t.perfect === null || t.hand3 === null) {
    r.errors.push('Design: Tempo-Probe — perfekter Bot oder 3°-Hand kommt nicht ins Ziel');
    return;
  }
  const spread = t.hand3 / t.perfect;
  const line = `sync 1.0 ${t.perfect.toFixed(2)} s, Hand 3° ${t.hand3.toFixed(2)} s (× ${spread.toFixed(2)}), Launch ${f0(t.launch)} u/s`;
  const bad: string[] = [];
  if (t.perfect < 22 || t.perfect > 30) bad.push('sync 1.0 außerhalb 22–30 s');
  if (spread < 1.15) bad.push('Hand 3° < 1.15 × sync 1.0');
  if (t.launch < 950) bad.push('Launch < 950 u/s');
  if (bad.length) r.warnings.push(`Design: Tempo — ${line}: ${bad.join(', ')}`);
  else r.info.push(`Design: Tempo — ${line}`);
}

// ---------------------------------------------------------------------------
// Medaillen gegen Grundtechnik-Surfen (Review 29.09., Befund kritisch)

export interface SurfMedalRun {
  /** Spiel-Uhr: Medaillen-Bot (RouteFollower) allein, Hybrid (nach CP4 ab dem ersten Boden-/Flankenkontakt der Surfer). */
  readonly bot: number | null;
  readonly hybrid: number | null;
  /** Spiel-Uhr bei der Übergabe (nach CP4 der erste Boden- oder Flankenkontakt). */
  readonly handoff: number | null;
  /** Tempo des Surfers am Launch-Knoten (u/s). */
  readonly riderLaunch: number;
  readonly deaths: number;
}

export interface SurfMedalResult {
  readonly runs: readonly SurfMedalRun[];
  /** Mediane der Spiel-Uhr und der Abfahrt (Übergabe → Ziel). */
  readonly bot: number | null;
  readonly hybrid: number | null;
  readonly botSection: number;
  readonly riderSection: number;
  readonly riderLaunch: number;
}

/** Start-Jitter der Probe: die Diagonale des 7 × 7-Rasters (Build: alle 49). */
export const SURF_MEDAL_JITTERS: readonly number[] = [0, 8, 16, 24, 32, 40, 48];

function medianOf(xs: readonly number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : Number.NaN;
}

/**
 * Wie schnell wäre das Medaillen-Modell (perfekter Strafer, sync 1.0) mit einfacher Surf-Technik? Je Start-Jitter
 * zwei Läufe mit Spiel-Uhr (Tode inklusive): der RouteFollower allein — daraus baut build.ts Gold/VELOCITY/Autor — und
 * gegabelt nach CP4 ab dem ersten Kontakt mit Boden ODER Flanke der Grundtechnik-Surfer (A/D in die Rampe, Blick
 * entlang der Achse; in der Luft keine Eingabe). Nur Boden reichte nicht: in 3 von 7 Starts hüpft der Bot über die
 * Krone, ohne aufzusetzen — der Surfer übernahm nie. Schon beim Eintritt in CP4 übernehmen auch nicht: dann fliegt der
 * Surfer mit dem Lenkwinkel des Bots (bis 9° nach Norden) ungelenkt weiter und stirbt am Fuß der Nordflanke.
 * Hintergrund: der RouteFollower drückt beim Surfen entlang −n_h der Flanke; auf Rampen mit fallender Achse zeigt −n_h
 * etwas gegen die Fahrt (10°: ~9 % des Drucks bremsen). Er fuhr die Abfahrt ~3 s langsamer als der Surfer.
 */
/** Ergebnis eines Hybrid-Laufs (`hybridRace`). */
interface HybridRace {
  readonly time: number | null;
  /** Tick der Übergabe (nach CP4 der erste Boden- oder Flankenkontakt), −1 = nie. */
  readonly hand: number;
  readonly handTime: number | null;
  /** Tempo des Surfers am Launch-Knoten (u/s), 0 = nicht erreicht. */
  readonly launch: number;
  readonly deaths: number;
  readonly splits: readonly number[];
}

/**
 * Ein Lauf mit Spiel-Uhr (wie physics.timedRun, Tode inklusive): RouteFollower mit `model`; `handAt` = Tick der Übergabe
 * an den Grundtechnik-Surfer ('contact' = beim ersten Boden-/Flankenkontakt nach CP4 in DIESEM Lauf, null = nur Bot).
 * Deterministisch: 'contact' fährt bis zur Übergabe exakt wie der Bot allein.
 */
function hybridRace(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, model: StrafeModel, seed: number, jitter: StartJitter | null, handAt: number | 'contact' | null): HybridRace {
  const route = level.def.route ?? [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const launchX = route.find((n) => n.note === 'Launch')?.pos[0] ?? Number.NEGATIVE_INFINITY;
  const dt = 1 / cfg.tickRate;
  const start = jitterStart(level.spawnPos, level.spawnYaw, jitter?.lateral ?? 0);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(new Vector3(start.x, start.y + 1, start.z));
  const mk = (from: number, p: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, {
      sync: model.sync,
      aimNoiseDeg: model.aimNoiseDeg,
      seed,
      killY: level.def.killY,
      world: level.world,
      start: { x: p.x, z: p.z },
      stallTimeout: 12,
      timeout: 181,
    });
  let bot = mk(0, start);
  const aim = new StartAim(jitter?.yawDeg ?? 0);
  const rider = new SurfRider(cfg, level.world, descentAxis(lay), 0);
  const run = new RunState(level);
  run.reset(null);
  const ev: RunEvent[] = [];
  let hand = -1;
  let handTime: number | null = null;
  let launch = 0;
  let deaths = 0;
  const done = (time: number | null): HybridRace => ({ time, hand, handTime, launch, deaths, splits: run.splits() });
  for (let k = 0; k < 180 * cfg.tickRate; k++) {
    if (hand < 0 && run.checkpoint >= 4 && (pm.state.onGround || pm.state.surfing)) {
      hand = k;
      handTime = run.time;
    }
    const riding = handAt === 'contact' ? hand >= 0 : handAt !== null && k >= handAt;
    pm.tick(riding ? rider.next(pm.state, pm.surfNormal) : aim.apply(bot.next(pm.state, pm.surfNormal), pm.state.onGround));
    if (riding && launch === 0 && pm.state.pos.x < launchX) launch = pm.state.speed;
    const out = run.tick(dt, pm.state.pos, pm.hullMins, pm.hullMaxs, pm.state.speed, pm.state.onGround, ev);
    if (out === 'finish') return done(run.time);
    if (out === 'fall' || out === 'kill') {
      deaths++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      bot = mk(run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0, sp.pos);
      continue;
    }
    if (!riding && bot.status === 'failed') return done(null);
  }
  return done(null);
}

/**
 * Medaillen-Referenz L4 (build.ts, Freischalt-Leiter): jedes Medaillen-Modell klettert als RouteFollower und surft die
 * Abfahrt ab dem ersten Kontakt nach CP4 mit der Grundtechnik (`hybridRace`). Der RouteFollower allein surft die Abfahrt
 * ~2–3 s langsamer (drückt entlang −n_h, auf fallenden Rampen etwas gegen die Fahrt) — ohne Referenz unterbot "Hand 3° +
 * einfach surfen" Gold und VELOCITY. Gilt für alle Medaillen: auch Bronze/Silber-Hände surfen, was T7/T8 lehren.
 */
export function level4Reference(): MedalReference {
  const lay = level4Layout();
  return {
    name: 'L4-Hybrid (RouteFollower bis zur Krone, dann Grundtechnik-Surfer)',
    // L4 hat keine Gabel: route und safeRoute sind dieselbe Linie.
    runs(level, model, _line, jitter, seeds, cfg = VELOCITY_DEFAULT): ReferenceRuns | null {
      const toRun = (r: HybridRace): TimedRun => ({ time: r.time, deaths: r.deaths, reason: r.time === null ? 'hybrid' : null, splits: r.splits });
      const runs = jitter
        ? START_JITTERS.map((j, i) => toRun(hybridRace(level, lay, cfg, model, i + 1, j, 'contact')))
        : seeds.map((seed) => toRun(hybridRace(level, lay, cfg, model, seed, null, 'contact')));
      return { runs, detail: `${runs.filter((x) => x.time !== null).length}/${runs.length} im Ziel, Übergabe nach CP4`, overJitter: jitter };
    },
  };
}

/**
 * Wie schnell wäre das Medaillen-Modell (perfekter Strafer, sync 1.0) mit einfacher Surf-Technik? Je Start-Jitter
 * zwei Läufe mit Spiel-Uhr (Tode inklusive): der RouteFollower allein und gegabelt nach CP4 ab dem ersten Kontakt mit
 * Boden ODER Flanke der Grundtechnik-Surfer (A/D in die Rampe, Blick entlang der Achse; in der Luft keine Eingabe). Nur
 * Boden reichte nicht: in 3 von 7 Starts hüpft der Bot über die Krone, ohne aufzusetzen — der Surfer übernahm nie. Schon
 * beim Eintritt in CP4 übernehmen auch nicht: dann fliegt der Surfer mit dem Lenkwinkel des Bots (bis 9° nach Norden)
 * ungelenkt weiter und stirbt am Fuß der Nordflanke. Hintergrund: der RouteFollower drückt beim Surfen entlang −n_h der
 * Flanke; auf Rampen mit fallender Achse zeigt −n_h etwas gegen die Fahrt (10°: ~9 % des Drucks bremsen). Er fuhr die
 * Abfahrt ~3 s langsamer als der Surfer — seit Phase 3 misst build.ts Gold/VELOCITY/Autor deshalb aus dem schnelleren
 * von Bot und Hybrid (`level4Reference`).
 */
export function surfMedal(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, jitters: readonly number[] = SURF_MEDAL_JITTERS): SurfMedalResult {
  const race = (ji: number, handAt: number | null): HybridRace => hybridRace(level, lay, cfg, { sync: 1 }, ji + 1, START_JITTERS[ji], handAt);
  const runs: SurfMedalRun[] = jitters.map((ji) => {
    const a = race(ji, null);
    const b = a.hand >= 0 ? race(ji, a.hand) : null;
    return { bot: a.time, hybrid: b?.time ?? null, handoff: a.handTime, riderLaunch: b?.launch ?? 0, deaths: a.deaths + (b?.deaths ?? 0) };
  });
  const sec = (t: number | null, h: number | null): number => (t !== null && h !== null ? t - h : Number.NaN);
  const med = (xs: ReadonlyArray<number | null>): number | null => {
    const m = medianOf(xs.map((x) => x ?? Number.NaN));
    return Number.isFinite(m) ? m : null;
  };
  return {
    runs,
    bot: med(runs.map((x) => x.bot)),
    hybrid: med(runs.map((x) => x.hybrid)),
    botSection: medianOf(runs.map((x) => sec(x.bot, x.handoff))),
    riderSection: medianOf(runs.map((x) => sec(x.hybrid, x.handoff))),
    riderLaunch: medianOf(runs.map((x) => x.riderLaunch)),
  };
}

/**
 * Fährt ein perfekter Strafer mit einfachem Surfen mehr als 10 % der Abfahrt schneller als die Autor-Zeit, sind die
 * Medaillen zu lasch (Review: Hand 3° + Surfer unterbot VELOCITY und Autor) → Fehler. Seit Phase 3 misst build.ts die
 * Medaillen aus dem schnelleren von Bot und Hybrid (`level4Reference`); die Probe fängt einen veralteten Build.
 */
function surfMedalProbe(level: CompiledLevel, lay: Level4Layout, cfg: MovementConfig, r: DesignReport): void {
  const s = surfMedal(level, lay, cfg);
  const author = level.def.medals?.author;
  const f2 = (x: number | null): string => (x === null || !Number.isFinite(x) ? '–' : x.toFixed(2));
  const line =
    `Medaillen gegen Grundtechnik-Surfen (sync 1.0, ${s.runs.length} Start-Jitter, Spiel-Uhr): Medaillen-Bot ${f2(s.bot)} s, ` +
    `ab CP4 Surfer ${f2(s.hybrid)} s — Abfahrt Bot ${f2(s.botSection)} s gegen Surfer ${f2(s.riderSection)} s (× ${(s.botSection / s.riderSection).toFixed(2)}), ` +
    `Launch Surfer ${f0(s.riderLaunch)} u/s; Autor ${author ?? '–'} s`;
  if (s.hybrid === null || !Number.isFinite(s.riderSection)) r.errors.push(`Design: ${line} — Hybrid kommt nicht ins Ziel`);
  else if (author !== undefined && author > s.hybrid + 0.1 * s.riderSection)
    r.errors.push(
      `Design: ${line} — Autor liegt ${(author - s.hybrid).toFixed(2)} s über "perfekt strafen + einfach surfen" (Soll ≤ 10 % der Abfahrt = ${(0.1 * s.riderSection).toFixed(2)} s): ` +
        `Gold/VELOCITY/Autor zu lasch. Ursache RouteFollower.pushInto (src/player/bots) bzw. Medaillen-Modell (build.ts)`,
    );
  else r.info.push(`Design: ${line}`);
}
