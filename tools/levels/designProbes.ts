/**
 * Level-spezifische Design-Proben mit echter Physik: Behauptungen aus
 * .docs/research/level-design.md, die der Validator sonst nicht sieht.
 *
 * - level1: Erstkontakt ohne Tod; jeder Fehlsprung im Grundkurs hat einen
 *   Ausstieg; Slalom braucht Lenkung (keine gerade Linie kommt durch);
 *   Crouch-Hop klappt von jeder Stelle der Absprung-Insel H7; die Surf-Rutsche
 *   fängt jeden, der nicht surft.
 * - level2: Ausfahrt ohne Todesstreifen zwischen den Tempo-Stufen; die erste
 *   Surf-Rampe (S0) tötet niemanden, der nicht surft, und von ihrer Auffangfläche
 *   führt ein begehbarer Rückweg aufs Vorfeld;
 *   Finale aus dem CP4-Respawn mit ≥ 10 % Landereserve.
 *
 * - level3/level4: tools/levels/probes/level3.ts, level4.ts (Plan 007, Phase 2).
 *
 * Die Proben finden ihre Geometrie über Brush-Tags und Route-Flags (nie über
 * Notiztexte) — wer die Level umbaut und Tags umbenennt, bekommt einen Fehler
 * statt Stille. Die allgemeinen Bausteine (Auto-Hop-Raster, W-Halter,
 * Finale-Reserve, Wendel-Bande) sind exportiert: die Proben neuer Level bauen
 * darauf auf, statt sie zu kopieren.
 */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { RouteFollower, makeBotInput } from '../../src/player/bots';
import type { CompiledBrush } from '../../src/world/collision/types';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import type { RouteNode } from '../../src/world/level/LevelFormat';
import { OVERSHOOT } from './ballistics';
import { forwardOf, type V2 } from './lib';
import { SpeedCurve, SurfRider, describeBranches, jitterMedian, routeAxis, simulate, straightHop, timedRun, type Controller, type StrafeModel } from './physics';
import { level3Probes } from './probes/level3';
import { level4Probes } from './probes/level4';
import { level2RingBoard } from './level2';

export interface DesignReport {
  readonly errors: string[];
  readonly warnings: string[];
  readonly info: string[];
}

export function designProbes(level: CompiledLevel, cfg: MovementConfig = VELOCITY_DEFAULT): DesignReport {
  const r: DesignReport = { errors: [], warnings: [], info: [] };
  switch (level.def.id) {
    case 'level1':
      firstContactProbe(level, cfg, r);
      grundkursExits(level, r);
      slalomNeedsSteering(level, cfg, r);
      slalomFlow(level, cfg, r);
      crouchWindow(level, cfg, r);
      chuteCatch(level, cfg, r);
      expertIslands(level, cfg, r);
      break;
    case 'level2':
      firstContactProbe(level, cfg, r);
      exitTiers(level, cfg, r);
      s0Catch(level, cfg, r);
      s0BackWay(level, cfg, r);
      finaleReserve(level, cfg, r);
      ringBoardEscape(level, cfg, r);
      break;
    case 'level3':
      level3Probes(level, cfg, r);
      break;
    case 'level4':
      level4Probes(level, cfg, r);
      break;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Erstkontakt (beide Level)

/** Ergebnis der Erstkontakt-Probe (auch für Mess-Skripte außerhalb des Validators). */
export interface FirstContactResult {
  readonly runs: number;
  readonly deaths: ReadonlyArray<{ readonly text: string }>;
  readonly timeouts: number;
  /** Zeit bis zum Ziel (s): Median und Maximum aller erfolgreichen Läufe. */
  readonly median: number;
  readonly max: number;
  /** Größte Zeitspanne (s) zwischen Läufen gleicher Hand (Versatz, Shift): Obergrenze für den Preis der Fehlphasen. */
  readonly spread: number;
  /** Größter Zeitverlust (s) je Landung in einer Auffangmulde (Tag "catch…"), gegen den schnellsten Lauf gleicher Hand. */
  readonly costPerCatch: number;
  /** Läufe mit mindestens einer Muldenlandung. */
  readonly caught: number;
}

/**
 * Der typische erste Versuch eines Neulings: W gehalten, Leertaste ab x s
 * gehalten (Auto-Hop), Blick immer auf den nächsten Route-Knoten, mit und ohne
 * Shift, seitlich versetzt. Ziel ist der erste Checkpoint (Level 1: Plateau,
 * Level 2: Ring). Mit Auto-Hop springt man dort ab, wo man zuletzt gelandet
 * ist — jede Lücke auf dem Weg braucht darunter eine Auffangmulde (fallen.md
 * #43/#46). Leertaste vor 0.2 s gehört nicht dazu: dort friert der alte
 * Auto-Hop das Tempo ein (Movement-Strang, Smart-Auto-Hop).
 */
export function firstContact(level: CompiledLevel, cfg: MovementConfig = VELOCITY_DEFAULT): FirstContactResult | null {
  const route = level.def.route ?? [];
  const goal = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order)[0];
  if (!goal || route.length < 2) return null;
  const yaw0 = (level.spawnYaw * Math.PI) / 180;
  const rx = Math.cos(yaw0);
  const rz = -Math.sin(yaw0);
  const dt = 1 / cfg.tickRate;
  const deaths: Array<{ text: string }> = [];
  const groups = new Map<string, Array<{ t: number; catches: number }>>();
  const times: number[] = [];
  let runs = 0;
  let timeouts = 0;
  for (const lateral of LATERALS) {
    for (const sprint of [true, false]) {
      for (let k = 0; k <= 26; k++) {
        const hold = 0.2 + 0.05 * k;
        const pm = new PlayerMovement(level.world, cfg);
        const sp = level.spawnPos;
        pm.teleport(new Vector3(sp.x + rx * lateral, sp.y + 1, sp.z + rz * lateral));
        const out = makeBotInput();
        let node = 1;
        let tick = 0;
        let catches = 0;
        let wasGround = true;
        const ctl: Controller = {
          next: (s) => {
            // Wie ein Mensch, der auf die nächste Plattform schaut.
            while (node < route.length - 1) {
              const n = route[node].pos;
              if (Math.hypot(n[0] - s.pos.x, n[2] - s.pos.z) < 80 || passedNode(route, node, s.pos)) node++;
              else break;
            }
            if (s.onGround && !wasGround && groundTagAt(level, s.pos).startsWith('catch')) catches++;
            wasGround = s.onGround;
            const n = route[node].pos;
            const t = tick * dt;
            tick++;
            out.yaw = Math.atan2(-(n[0] - s.pos.x), -(n[2] - s.pos.z));
            out.pitch = 0;
            out.forward = 1;
            out.side = 0;
            out.sprint = sprint;
            out.crouch = false;
            out.jumpHeld = t >= hold;
            out.jumpPressed = Math.abs(t - hold) < dt / 2;
            return out;
          },
        };
        const res = simulate(level, pm, ctl, { cfg, goal: goal.bounds, timeout: 20 });
        runs++;
        if (res.ok) {
          times.push(res.time);
          const key = `${lateral}|${sprint}`;
          const g = groups.get(key) ?? [];
          g.push({ t: res.time, catches });
          groups.set(key, g);
        } else if (res.reason === 'timeout') timeouts++;
        else deaths.push({ text: `Versatz ${lateral}, ${sprint ? 'Shift' : 'ohne Shift'}, Leertaste ab ${hold.toFixed(2)} s: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}` });
      }
    }
  }
  let spread = 0;
  let costPerCatch = 0;
  let caught = 0;
  for (const g of groups.values()) {
    const best = Math.min(...g.map((x) => x.t));
    spread = Math.max(spread, Math.max(...g.map((x) => x.t)) - best);
    for (const x of g) {
      if (x.catches === 0) continue;
      caught++;
      costPerCatch = Math.max(costPerCatch, (x.t - best) / x.catches);
    }
  }
  times.sort((a, b) => a - b);
  return {
    runs,
    deaths,
    timeouts,
    median: times.length ? times[Math.floor((times.length - 1) / 2)] : Number.NaN,
    max: times.length ? times[times.length - 1] : Number.NaN,
    spread,
    costPerCatch,
    caught,
  };
}

function firstContactProbe(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const res = firstContact(level, cfg);
  if (!res) {
    r.errors.push('Design: Erstkontakt-Probe findet Route oder ersten Checkpoint nicht');
    return;
  }
  const f2 = (n: number): string => n.toFixed(2);
  if (res.deaths.length || res.timeouts)
    r.errors.push(
      `Design: Erstkontakt tödlich: ${res.deaths.length} Tode, ${res.timeouts} ohne Ankunft von ${res.runs} Läufen (z. B. ${res.deaths.slice(0, 3).map((d) => d.text).join('; ')})`,
    );
  else
    r.info.push(
      `Design: Erstkontakt ohne Tod — ${res.runs} Läufe (W, Leertaste ab 0.2–1.5 s gehalten, ±96, mit/ohne Shift) bis CP1 in ${f2(res.median)}–${f2(res.max)} s; ` +
        `${res.caught} Läufe über eine Auffangmulde, Verlust je Mulde ≤ ${f2(res.costPerCatch)} s`,
    );
}

/** So tief darf eine Auffangfläche höchstens unter der Landekante liegen: ein Sprung (57 u) kommt heraus. */
const EXIT_DEPTH = 50;

/**
 * Grundkurs (Level 1 bis zur Crouch-Kante): jeder Fehlsprung hat einen Ausstieg
 * ohne Respawn. Unter jeder Lücke zwischen zwei Sprungknoten liegt begehbarer
 * Boden höchstens EXIT_DEPTH unter der tieferen Kante — auf der Knotenlinie und
 * ±64 u daneben. Statisch (Traces), die Physik prüft die Erstkontakt-Probe und
 * `trench.ts`-artige Läufe; diese Regel fängt den Umbau, der eine Mulde vergisst.
 */
function grundkursExits(level: CompiledLevel, r: DesignReport): void {
  const route = level.def.route ?? [];
  const end = route.findIndex((n) => n.crouch === true);
  if (end < 1) {
    r.errors.push('Design: Grundkurs-Probe findet den Crouch-Knoten nicht');
    return;
  }
  const missing: string[] = [];
  let gaps = 0;
  for (let i = 0; i < end; i++) {
    const A = route[i];
    const B = route[i + 1];
    if (!A.jump) continue;
    const dx = B.pos[0] - A.pos[0];
    const dz = B.pos[2] - A.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 1) continue;
    const lo = Math.min(A.pos[1], B.pos[1]);
    const hi = Math.max(A.pos[1], B.pos[1]);
    let inGap = false;
    for (let s = 0; s <= d; s += 8) {
      for (const lat of [-64, 0, 64]) {
        const x = A.pos[0] + (dx * s) / d - (dz / d) * lat;
        const z = A.pos[2] + (dz * s) / d + (dx / d) * lat;
        const top = level.world.traceBox(new Vector3(x, hi + 8, z), new Vector3(x, lo - 6, z), PROBE_MINS, PROBE_MAXS);
        if (!top.startSolid && top.fraction < 1 && top.normal.y >= 0.7) continue; // Boden auf Kantenhöhe: keine Lücke
        if (lat === 0) inGap = true;
        const tr = level.world.traceBox(new Vector3(x, hi + 8, z), new Vector3(x, lo - EXIT_DEPTH, z), PROBE_MINS, PROBE_MAXS);
        if (tr.startSolid || tr.fraction >= 1 || tr.normal.y < 0.7) missing.push(`Route ${i}→${i + 1} bei ${f0(x)},${f0(z)}`);
      }
    }
    if (inGap) gaps++;
  }
  if (missing.length) r.errors.push(`Design: Grundkurs-Fehlsprung ohne Ausstieg (kein Boden ≤ ${EXIT_DEPTH} u unter der Kante): ${missing.length} Stellen, z. B. ${missing.slice(0, 3).join('; ')}`);
  else r.info.push(`Design: Grundkurs — unter allen ${gaps} Lücken bis zur Crouch-Kante liegt Boden ≤ ${EXIT_DEPTH} u tief (Ausstieg ohne Respawn)`);
}

const PROBE_MINS = new Vector3(-4, 0, -4);
const PROBE_MAXS = new Vector3(4, 4, 4);

/** Hat p den Knoten i schon passiert (Projektion auf das Segment i−1 → i ≥ 1)? */
export function passedNode(route: readonly RouteNode[], i: number, p: Vector3): boolean {
  const a = route[i - 1].pos;
  const b = route[i].pos;
  const sx = b[0] - a[0];
  const sz = b[2] - a[2];
  const l2 = sx * sx + sz * sz;
  if (l2 < 1) return false;
  return ((p.x - a[0]) * sx + (p.z - a[2]) * sz) / l2 >= 1;
}

export function byTag(level: CompiledLevel, tag: string): CompiledBrush | null {
  return level.brushes.find((b) => b.tag === tag) ?? null;
}

/** L1-Slalom-Inseln (Tags slalom1 … slalomN, ohne Nasen/Pylonen), aufsteigend — die Zahl legt level1.ts fest. */
export function slalomIslands(level: CompiledLevel): CompiledBrush[] {
  const num = (b: CompiledBrush): number => Number(/^slalom(\d+)$/.exec(b.tag ?? '')?.[1] ?? Number.NaN);
  return level.brushes.filter((b) => Number.isFinite(num(b))).sort((a, b) => num(a) - num(b));
}

/** Tag des Brushes, auf dem ein Route-Knoten steht (Boden bis 8 u darunter), sonst null. */
export function groundTag(level: CompiledLevel, n: RouteNode): string | null {
  const p = new Vector3(...n.pos);
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 1, p.z), new Vector3(p.x, p.y - 8, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return null;
  return level.brushes[tr.brushIndex]?.tag ?? null;
}

export function center(b: CompiledBrush): Vector3 {
  return b.bounds.getCenter(new Vector3());
}

const f0 = (n: number): string => n.toFixed(0);
/** Hull-Halbbreite: Landung auf einer Kante zählt, solange die Hull überlappt. */
const PHYS_HULL = VELOCITY_DEFAULT.hull.halfWidth;
const HULL_MINS = new Vector3(-PHYS_HULL, 0, -PHYS_HULL);
const HULL_MAXS = new Vector3(PHYS_HULL, VELOCITY_DEFAULT.hull.standHeight, PHYS_HULL);

// ---------------------------------------------------------------------------
// level1

/**
 * Kein Geradeaus-Hüpfer (fester Blick, nur Auto-Hop) darf vom Wende-Pad bis zur
 * Surf-Rutsche kommen — im Band von der 3°-Hand bis OVERSHOOT × Plan-Tempo des
 * Slalom-Knotens (wer schneller ist, darf Inseln auslassen: Speed belohnt).
 * Ziel ist die Flanke oberhalb des Fußes: wer neben den Inseln auf die
 * Auffangfläche fällt, zählt nicht. Dicht (SLALOM_STEP u/s × 8 u, ~7000 Läufe, ~1.3 s):
 * fünf Tempi × 16 u sahen bei fünf Inseln 0/115, dicht waren es 61/7020 (Bänder ab
 * 1183 u/s, fallen.md #117) — ob ein Geradeaus-Hüpfer durchkommt, hängt an seiner Phase.
 */
function slalomNeedsSteering(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const turn = byTag(level, 'turn');
  const islands = slalomIslands(level);
  const s1 = islands[0];
  // Achse aus Insel 1 und der letzten Insel derselben Spalte (ungerade Nummer) — unabhängig von der Inselzahl.
  const sSame = islands.length >= 3 ? islands[2 * Math.floor((islands.length - 1) / 2)] : undefined;
  const chute = byTag(level, 'chutea');
  if (!turn || !s1 || !sSame || !chute) {
    r.errors.push('Design: Slalom-Probe findet turn, ≥ 3 Slalom-Inseln (slalomN) oder chutea nicht');
    return;
  }
  const fwd = center(sSame).sub(center(s1)).setY(0).normalize();
  const side = new Vector3(-fwd.z, 0, fwd.x);
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  const c = center(turn);
  const top = turn.bounds.max.y;
  // Obere zwei Drittel der Rutsche (der Fuß liegt 64 u über der Auffangfläche, eine Hull dort reicht nicht hinein).
  const goal = chute.bounds.clone();
  goal.min.y = goal.max.y - (2 * (goal.max.y - goal.min.y)) / 3;
  const through: string[] = [];
  let runs = 0;
  const node = (level.def.route ?? []).find((n) => groundTag(level, n) === 'turn');
  const vHi = OVERSHOOT * (node?.minSpeed ?? cfg.sprintSpeed);
  const vLo = SpeedCurve.hand(3, cfg).top * 0.8;
  const speeds = band(vLo, vHi, SLALOM_STEP);
  for (let o = -176; o <= 176; o += 8) {
    for (const v of speeds) {
      const start = c.clone().addScaledVector(fwd, 100).addScaledVector(side, o).setY(top);
      const res = straightHop(level, start, yaw, v, goal, cfg);
      runs++;
      if (res.ok) through.push(`${o}/${v}`);
    }
  }
  if (through.length) r.errors.push(`Design: Slalom geradeaus ohne Lenkung schaffbar: ${through.length}/${runs} (Versatz/Tempo: ${through.slice(0, 6).join(', ')})`);
  else r.info.push(`Design: Slalom braucht Lenkung — ${runs} Geradeaus-Läufe (Versatz ±176 in 8 u, ${speeds[0]}–${speeds[speeds.length - 1]} u/s in ${SLALOM_STEP}er-Schritten) scheitern alle`);
}

/** Tempo-Schritt der Slalom-Lenkprobe (u/s). */
const SLALOM_STEP = 5;

/**
 * Slalom flüssig für echte Hände (drittes Review l1l2): Hand 1.5°/2°/3° (RouteFollower mit Zielfehler) ab dem
 * CP3-Spawn mit dem Tempo, mit dem Hände an der Wende ankommen (600/700/800 u/s, Median Hand 3°/2°/1° 603/688/806),
 * bis zur Rutsche. Gezählt werden harte Einbrüche (in einem Tick > 10 % und > 40 u/s: Anprall an Nase, Stirn,
 * Pylon, Tor) und Tode. Mit fünf Inseln und 32°-Nasen überall verloren diese Hände ~400 u/s je Slalom, fast alles
 * an den Nasen knapp zu kurzer Querhops — der Slalom war für sie ein Zeitfresser. Soll: Einbruch im Mittel
 * ≤ SLALOM_FLOW_MAX je Lauf, Tode ≤ 1 je 24 Läufe; sonst Warnung (die Lenkprobe prüft die Gegenrichtung).
 */
function slalomFlow(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const from = route.findIndex((n) => groundTag(level, n) === 'turn');
  const cp = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 3);
  const islands = slalomIslands(level);
  const chute = byTag(level, 'chutea');
  const turn = byTag(level, 'turn');
  if (from < 0 || !cp || islands.length < 3 || !chute || !turn) {
    r.errors.push('Design: Slalom-Fluss-Probe findet Wende (turn), CP3, Slalom-Inseln oder chutea nicht');
    return;
  }
  const fwd = center(islands[2]).sub(center(islands[0])).setY(0).normalize();
  const sub = route.slice(from);
  // Gezählt wird erst hinter der Wende (Slalom); der Start liegt 24 u über dem Spawn, damit der Bot wie im Lauf
  // aus einem Hop weiterhüpft — vom Boden aus liefe er erst zum Wende-Knoten und verlöre Tempo an die Reibung.
  const tc = center(turn);
  const along = (x: number, z: number): number => (x - tc.x) * fwd.x + (z - tc.z) * fwd.z;
  const turnEnd = Math.max(...[turn.bounds.min.x, turn.bounds.max.x].flatMap((x) => [turn.bounds.min.z, turn.bounds.max.z].map((z) => along(x, z))));
  let runs = 0;
  let deaths = 0;
  let loss = 0;
  let worst = 0;
  const times: number[] = [];
  for (const aim of SLALOM_FLOW_HANDS) {
    for (const v0 of SLALOM_FLOW_SPEEDS) {
      for (let seed = 1; seed <= SLALOM_FLOW_SEEDS; seed++) {
        const pm = new PlayerMovement(level.world, cfg);
        pm.teleport(cp.spawnPos.clone().setY(cp.spawnPos.y + 24));
        pm.state.vel.set(fwd.x * v0, 0, fwd.z * v0);
        const bot = new RouteFollower(sub, cfg, { aimNoiseDeg: aim, seed, killY: level.def.killY, world: level.world, start: { x: cp.spawnPos.x, z: cp.spawnPos.z }, stallTimeout: 6, timeout: 14 });
        let prev = v0;
        let lost = 0;
        const ctl: Controller = {
          next: (s, n) => {
            const past = along(s.pos.x, s.pos.z) > turnEnd;
            if (past && prev - s.speed > Math.max(40, 0.1 * prev)) lost += prev - s.speed;
            prev = s.speed;
            return bot.next(s, n);
          },
        };
        const res = simulate(level, pm, ctl, { cfg, goal: chute.bounds, timeout: 14, botStatus: () => bot.status });
        runs++;
        loss += lost;
        worst = Math.max(worst, lost);
        if (res.ok) times.push(res.time);
        else if (res.reason === 'kill' || res.reason === 'fell') deaths++;
      }
    }
  }
  times.sort((a, b) => a - b);
  const mean = loss / Math.max(1, runs);
  const text = `Hand ${SLALOM_FLOW_HANDS.join('/')}° ab der Wende (${SLALOM_FLOW_SPEEDS.join('/')} u/s, ${runs} Läufe): Einbruch Ø ${f0(mean)} u/s je Lauf (höchstens ${f0(worst)}), ${deaths} Tode, bis zur Rutsche Median ${times.length ? times[Math.floor((times.length - 1) / 2)].toFixed(2) : '–'} s`;
  if (mean > SLALOM_FLOW_MAX || deaths * 24 > runs) r.warnings.push(`Design: Slalom nicht flüssig für echte Hände (Soll Ø ≤ ${SLALOM_FLOW_MAX} u/s, ≤ 1 Tod je 24 Läufe): ${text}`);
  else r.info.push(`Design: Slalom flüssig — ${text}`);
}

const SLALOM_FLOW_HANDS: readonly number[] = [1.5, 2, 3];
const SLALOM_FLOW_SPEEDS: readonly number[] = [600, 700, 800];
const SLALOM_FLOW_SEEDS = 8;
/** Höchster mittlerer Einbruch je Slalom-Lauf (u/s). */
const SLALOM_FLOW_MAX = 150;

/**
 * Crouch-Kante: H7 reicht bis an die Wand. Für jedes Tempo vom Sprint-Anlauf
 * bis OVERSHOOT × Plan muss es auf H7 eine Absprungzone von ≥ 48 u geben, von
 * der der Crouch-Hop (W gehalten) auf der Kante landet; der Plan-Knoten liegt
 * für das Band 3°-Hand … OVERSHOOT × Plan in der Zone. Jeder Fehlversuch endet
 * wieder auf H7 — nie im Tod.
 */
function crouchWindow(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const h7 = byTag(level, 'hop7');
  const ledge = byTag(level, 'ledge');
  const node = (level.def.route ?? []).find((n) => n.crouch === true);
  if (!h7 || !ledge || !node) {
    r.errors.push('Design: Crouch-Probe findet hop7/ledge/Crouch-Knoten nicht');
    return;
  }
  const x = (h7.bounds.min.x + h7.bounds.max.x) / 2;
  const top = h7.bounds.max.y;
  const vPlan = node.minSpeed ?? cfg.sprintSpeed;
  // Die 3°-Hand nach der Hop-Reihe (Sprint-Absprung + 7 Hops) — untere Kante des Pflicht-Bands.
  const vHand = SpeedCurve.hand(3, cfg).after(cfg.sprintSpeed, 7);
  const vTop = OVERSHOOT * vPlan;
  const onLedge = new Box3(new Vector3(ledge.bounds.min.x, ledge.bounds.max.y - 2, ledge.bounds.min.z), ledge.bounds.max.clone().setY(ledge.bounds.max.y + 4));
  const speeds: number[] = [];
  for (let v = cfg.sprintSpeed; v < vTop; v += 40) speeds.push(v);
  speeds.push(vHand, vPlan, vTop);
  const narrow: string[] = [];
  const deaths: string[] = [];
  const nodeMiss: string[] = [];
  let runs = 0;
  for (const v of speeds) {
    let best = 0;
    let streak = 0;
    // Nach Norden (-z): von max.z (Inselanfang) bis zur Wand (min.z), Hull ganz auf H7.
    for (let z = h7.bounds.max.z - PHYS_HULL; z >= h7.bounds.min.z + PHYS_HULL + 0.5; z -= 8) {
      const ok = crouchHop(level, cfg, new Vector3(x, top, z), v, onLedge, top, deaths);
      runs++;
      streak = ok ? streak + 8 : 0;
      best = Math.max(best, streak);
    }
    if (best < 48) narrow.push(`${f0(v)} u/s: ${best} u`);
    if (v >= vHand - 1 && !crouchHop(level, cfg, new Vector3(...node.pos), v, onLedge, top, deaths)) nodeMiss.push(f0(v));
  }
  if (narrow.length) r.errors.push(`Design: Crouch-Kante ohne Absprungzone ≥ 48 u bei ${narrow.join(', ')}`);
  if (nodeMiss.length) r.errors.push(`Design: Crouch-Hop vom Plan-Knoten scheitert bei ${nodeMiss.join(', ')} u/s (Band ${f0(vHand)}–${f0(vTop)})`);
  if (deaths.length) r.errors.push(`Design: Fehlversuch am Crouch-Hop endet nicht auf H7 (${deaths.slice(0, 4).join(', ')})`);
  if (!narrow.length && !nodeMiss.length && !deaths.length)
    r.info.push(`Design: Crouch-Kante hat bei ${f0(cfg.sprintSpeed)}–${f0(vTop)} u/s überall eine Absprungzone ≥ 48 u, Plan-Knoten trägt ${f0(vHand)}–${f0(vTop)}; Fehlversuche landen auf H7 (${runs} Läufe)`);
}

/** Ein Crouch-Hop (W gehalten, geduckt) von `start` mit Tempo v nach Norden. Fehlschlag muss wieder auf H7 enden. */
function crouchHop(level: CompiledLevel, cfg: MovementConfig, start: Vector3, v: number, goal: Box3, h7Top: number, deaths: string[]): boolean {
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(start);
  pm.state.vel.set(0, 0, -v);
  const out = makeBotInput();
  let first = true;
  const ctl: Controller = {
    next: () => {
      out.yaw = 0;
      out.forward = 1;
      out.side = 0;
      out.jumpPressed = first;
      out.jumpHeld = first;
      out.crouch = true;
      first = false;
      return out;
    },
  };
  const res = simulate(level, pm, ctl, { cfg, goal, timeout: 1.5 });
  if (!res.ok && !(pm.state.onGround && Math.abs(pm.state.pos.y - h7Top) < 1)) deaths.push(`${f0(v)} u/s ab z ${f0(start.z)} → ${res.reason} bei ${f0(res.end.y)}`);
  return res.ok;
}

/**
 * Surf-Rutsche (Level-1-Finale) fängt jeden: ab der letzten Slalom-Insel mit
 * Auto-Hop geradeaus Richtung Rutsche, ohne zu surfen (rutscht ab) bzw. W
 * gehalten und Blick auf den nächsten Knoten (der typische erste Surf-Versuch:
 * W an der Rampe gibt keinen Schub), bei jedem Tempo vom Sprint bis 1300 u/s
 * und seitlich ±96 — jeder Lauf muss im Ziel ankommen (Auffangfläche unter und
 * neben der Rampe, keine Kill-Zone). Dazu die Zeit: der saubere Surf muss
 * schneller sein als der Weg über die Auffangfläche. Zusätzlich W + Leertaste-Halter,
 * deren Blick in 2 s bis ±30° neben die Route schwenkt (Luftlenkung dreht sie mit), mit
 * C nie/immer/am Boden/ab 1 s — kein Tod (2875 Läufe, Review l1l2).
 */
function chuteCatch(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const fin = level.triggers.find((t) => t.kind === 'finish');
  const lastIsland = slalomIslands(level).at(-1)?.tag ?? null;
  const from = lastIsland === null ? -1 : route.findIndex((n) => groundTag(level, n) === lastIsland);
  if (!fin || from < 0 || from + 1 >= route.length) {
    r.errors.push('Design: Rutschen-Probe findet den Knoten der letzten Slalom-Insel oder das Ziel nicht');
    return;
  }
  const speeds = band(cfg.sprintSpeed, 1300, 40);
  const straight = autoHopRaster(level, cfg, { from: [from], speeds, laterals: LATERALS, goal: fin.bounds, surf: false, timeout: 14 });
  // W-Halter: Blick immer auf den nächsten Knoten, W + Leertaste gehalten.
  const fails = [...straight.fails.map((x) => x.text)];
  let runs = straight.runs;
  let slow = 0;
  for (const lateral of LATERALS) {
    for (const v of speeds) {
      const res = wHolder(level, cfg, from, v, lateral, fin.bounds);
      runs++;
      if (!res.ok) fails.push(`W-Halter ab Knoten ${from} ${v} u/s Versatz ${lateral}: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
      else slow = Math.max(slow, res.time);
    }
  }
  // Review l1l2: Luftlenkung dreht W-Halter mit, deren Blick neben der Route liegt, und C gibt den
  // Crouch-Hop (+18 u) — beides trug über die 128er-Bande (236/7000 tot), die Probe sah es nicht
  // (Blick immer auf dem Knoten, nie C). Blick schwenkt in 2 s auf den Versatz; nur Tode zählen hier
  // (wer mit W allein in eine Ecke läuft, steht — das deckt der Knoten-Blick oben ab).
  let swept = 0;
  const sweptFails: string[] = [];
  for (const lateral of LATERALS) {
    for (const v of speeds) {
      for (const sweepDeg of CHUTE_SWEEPS) {
        for (const crouch of CROUCH_MODES) {
          if (sweepDeg === 0 && crouch === 'never') continue; // = W-Halter oben
          const res = wHolder(level, cfg, from, v, lateral, fin.bounds, { sweepDeg, crouch });
          swept++;
          if (!res.ok && res.reason !== 'timeout') sweptFails.push(`Blick ${sweepDeg}°, C ${crouch}, ${v} u/s, Versatz ${lateral}: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
        }
      }
    }
  }
  if (fails.length) r.errors.push(`Design: Surf-Rutsche fängt nicht jeden: ${fails.length}/${runs} Läufe (z. B. ${fails.slice(0, 4).join('; ')})`);
  else r.info.push(`Design: Surf-Rutsche fängt jeden — ${runs} Läufe ab der letzten Insel (${f0(cfg.sprintSpeed)}–1300 u/s, ±96, geradeaus ohne Surfen und W-Halter) im Ziel, langsamster W-Halter ${slow.toFixed(1)} s`);
  if (sweptFails.length) r.errors.push(`Design: Surf-Rutsche — W-Halter mit Blickversatz/C sterben: ${sweptFails.length}/${swept} (z. B. ${sweptFails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design: Surf-Rutsche — ${swept} W + Leertaste-Halter mit Blickversatz ${CHUTE_SWEEPS.filter((s) => s !== 0).join('/')}° und C (${CROUCH_MODES.join('/')}) ohne Tod`);
}

/** Blickversatz der W-Halter an der Rutsche (Grad, in 2 s eingeschwenkt): Luftlenkung dreht die Flugbahn mit. */
const CHUTE_SWEEPS: readonly number[] = [0, -30, -20, -15, 15, 30];
/** C gedrückt: nie, immer (Crouch-Hops), nur am Boden (Rutschen), ab 1 s (nach dem ersten Flug). */
export type CrouchMode = 'never' | 'always' | 'ground' | 'late';
const CROUCH_MODES: readonly CrouchMode[] = ['never', 'always', 'ground', 'late'];

/** Varianten des W-Halters: Blick in 2 s um `sweepDeg` neben den Knoten schwenken, C nach `crouch`. */
export interface WHolderOptions {
  readonly sweepDeg?: number;
  readonly crouch?: CrouchMode;
}

/** W + Leertaste gehalten, Blick auf den nächsten Route-Knoten (wie novice.ts "W+Space"), Start mit Tempo v am Knoten. */
export function wHolder(level: CompiledLevel, cfg: MovementConfig, from: number, v: number, lateral: number, goal: Box3, opts: WHolderOptions = {}): ReturnType<typeof simulate> {
  const route = level.def.route ?? [];
  const A = route[from];
  const B = route[from + 1];
  const dir = new Vector3(B.pos[0] - A.pos[0], 0, B.pos[2] - A.pos[2]).normalize();
  const start = dropToGround(level, new Vector3(A.pos[0] - dir.z * lateral, A.pos[1], A.pos[2] + dir.x * lateral));
  const pm = new PlayerMovement(level.world, cfg);
  if (!start) return simulate(level, pm, { next: () => makeBotInput() }, { cfg, goal, timeout: 0 });
  pm.teleport(start);
  pm.state.vel.set(dir.x * v, 0, dir.z * v);
  const out = makeBotInput();
  let node = from + 1;
  let first = true;
  let t = 0;
  const sweep = ((opts.sweepDeg ?? 0) * Math.PI) / 180;
  const crouch = opts.crouch ?? 'never';
  const dt = 1 / cfg.tickRate;
  const ctl: Controller = {
    next: (s) => {
      while (node < route.length - 1) {
        const n = route[node].pos;
        if (Math.hypot(n[0] - s.pos.x, n[2] - s.pos.z) < 80 || passedNode(route, node, s.pos)) node++;
        else break;
      }
      const n = route[node].pos;
      out.yaw = Math.atan2(-(n[0] - s.pos.x), -(n[2] - s.pos.z)) + Math.min(1, t / 2) * sweep;
      out.pitch = 0;
      out.forward = 1;
      out.side = 0;
      out.sprint = true;
      out.crouch = crouch === 'always' || (crouch === 'ground' && s.onGround) || (crouch === 'late' && t > 1);
      out.jumpHeld = true;
      out.jumpPressed = first;
      first = false;
      t += dt;
      return out;
    },
  };
  return simulate(level, pm, ctl, { cfg, goal, timeout: 20 });
}

/**
 * Könner-Inseln (Level 1): die Abkürzung Kehren-Pad 1 → Inseln → Wende muss sich
 * lohnen. Zwei Kennzahlen:
 * - Hand 1° (RouteFollower mit Zielfehler 1°) über zwölf Seeds, einmal die normale Route,
 *   einmal über die Inseln: Spiel-Uhr CP2 → CP3, der Abschnitt der Abkürzung (die Wende ist
 *   CP3). Soll: ≥ 5/6 durch, im Mittel ≥ 1 s schneller. Die Zielzeit einer Hand streut hinter
 *   CP3 je nach Einflug ±5 s (24 Seeds) — über zwölf Seeds wäre ihr Vorzeichen Zufall.
 * - Perfekter Bot über die 49 Start-Jitter (wie Gold/Autor in build.ts): ZIELZEIT-Median über
 *   die Inseln ≤ Median der Normalroute, und kein Zweig. Seine Zeit ist über den Start-Kasten
 *   robust; eine Abkürzung, die ihn erst hinter CP3 Zeit kostet (falscher Takt in den Slalom),
 *   zeigt nur die Zielzeit (Review l1l2: CP2 → CP3 +0.26 s, am Ziel −1.7 s mit zwei Zweigen).
 */
function expertIslands(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const cuts = level.brushes.filter((b) => b.tag !== null && /^cut\d+$/.test(b.tag)).sort((a, b) => Number(a.tag?.slice(3)) - Number(b.tag?.slice(3)));
  const from = route.findIndex((n) => groundTag(level, n) === 'curve1');
  const to = route.findIndex((n) => groundTag(level, n) === 'turn');
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').length;
  if (!cuts.length || from < 0 || to <= from || cps < 3) {
    r.errors.push('Design: Inseln-Probe findet cut-Inseln, Kehren-Pad 1, Wende oder CP3 nicht');
    return;
  }
  const minSpeed = route[from].minSpeed;
  const cutRoute: RouteNode[] = [
    ...route.slice(0, from + 1),
    ...cuts.map((b): RouteNode => ({ pos: [center(b).x, b.bounds.max.y, center(b).z], jump: true, ...(minSpeed !== undefined ? { minSpeed } : {}) })),
    ...route.slice(to),
  ];
  const cutLevel = compileLevel({ ...level.def, route: cutRoute });
  /** Spiel-Uhr CP2 → CP3; null ohne Ziel (dann fehlt die Wertung ganz). */
  const section = (lv: CompiledLevel, model: StrafeModel, seed: number): number | null => {
    const run = timedRun(lv, model, seed, cfg);
    return run.time === null || run.splits.length < 3 ? null : run.splits[2] - run.splits[1];
  };
  const cells: string[] = [];
  let ok = 0;
  let saved = 0;
  let pairs = 0;
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
  for (const seed of seeds) {
    const a = section(level, { aimNoiseDeg: 1 }, seed);
    const b = section(cutLevel, { aimNoiseDeg: 1 }, seed);
    if (b !== null) ok++;
    if (a !== null && b !== null) {
      saved += a - b;
      pairs++;
    }
    cells.push(b !== null ? b.toFixed(1) : 'x');
  }
  const avg = pairs ? saved / pairs : 0;
  // Perfekter Bot: Zielzeit über den Start-Kasten, Normalroute gegen Inseln.
  const base = jitterMedian(level, { sync: 1 }, cfg);
  const over = jitterMedian(cutLevel, { sync: 1 }, cfg);
  const gain = base.median !== null && over.median !== null ? base.median - over.median : null;
  const perfectText =
    gain === null
      ? `perfekter Bot scheitert (${over.runs.filter((x) => x.time === null).length}/${over.runs.length} Starts ohne Ziel)`
      : `perfekter Bot am Ziel ${Math.abs(gain).toFixed(2)} s ${gain >= 0 ? 'schneller' : 'LANGSAMER'} (Median über ${over.runs.length} Starts ${over.median?.toFixed(2)} gegen ${base.median?.toFixed(2)} s${over.branches ? `, ZWEIGE ${describeBranches(over.branches)}` : ', ein Zweig'})`;
  const text = `Hand 1° über die Inseln ${ok}/${seeds.length} durch (CP2 → CP3 ${cells.join(' ')} s), Ersparnis Ø ${avg.toFixed(2)} s (${pairs} Paare); ${perfectText}`;
  if (gain === null) r.errors.push(`Design: Könner-Inseln: ${text}`);
  else if (ok * 6 < seeds.length * 5 || avg < 1 || gain < 0 || over.branches !== null)
    r.warnings.push(`Design: Könner-Inseln lohnen nicht (Soll ≥ 5/6 durch, Hand 1° CP2 → CP3 ≥ 1 s, perfekter Bot am Ziel ≥ 0 s in einem Zweig): ${text}`);
  else r.info.push(`Design: Könner-Inseln — ${text}`);
}

/** Seitliche Versätze der Auto-Hop-Raster (u, rechts positiv). */
export const LATERALS: readonly number[] = [-96, -48, 0, 48, 96];

export function band(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) out.push(Math.round(v));
  return out;
}

export interface AutoHopSpec {
  /** Route-Indizes der Startknoten; Richtung jeweils zum Folgeknoten. */
  readonly from: readonly number[];
  readonly speeds: readonly number[];
  readonly laterals: readonly number[];
  readonly goal: Box3;
  /** Nach dem ersten Surf-Kontakt übernimmt der Grundtechnik-Surfer (Blick entlang der Achse). */
  readonly surf: boolean;
  readonly timeout: number;
  /** Optional: Linie eines Laufs protokollieren (Knoten, Tempo, Versatz → Boden-/Rampenfolge). */
  readonly onLine?: (node: number, v: number, lateral: number, line: string) => void;
}

export interface AutoHopFail {
  readonly node: number;
  readonly v: number;
  readonly lateral: number;
  readonly text: string;
  /** Grund aus simulate ('timeout', 'kill', 'fall', …) und Endlage — trennt Tod, Hänger und Stau in einer Grube. */
  readonly reason: string;
  readonly end: Vector3;
}

export interface AutoHopResult {
  readonly runs: number;
  readonly fails: AutoHopFail[];
}

/**
 * Auto-Hop-Raster: wie ein Mensch, der die Leertaste hält (Auto-Hop ist Default)
 * und geradeaus hält, ohne zu strafen — die typische Art, an einer Kante zu
 * sterben: die Landung einer Hop-Phase liegt vor einer Stirnwand. Start auf dem
 * Boden am Knoten (seitlich versetzt), Tempo v Richtung Folgeknoten.
 */
export function autoHopRaster(level: CompiledLevel, cfg: MovementConfig, spec: AutoHopSpec): AutoHopResult {
  const route = level.def.route ?? [];
  const axis = routeAxis(route);
  const fails: AutoHopFail[] = [];
  let runs = 0;
  for (const i of spec.from) {
    const A = route[i];
    const B = route[i + 1];
    const dir = new Vector3(B.pos[0] - A.pos[0], 0, B.pos[2] - A.pos[2]).normalize();
    const yaw = Math.atan2(-dir.x, -dir.z);
    for (const lateral of spec.laterals) {
      const start = dropToGround(level, new Vector3(A.pos[0] - dir.z * lateral, A.pos[1], A.pos[2] + dir.x * lateral));
      if (!start) continue;
      for (const v of spec.speeds) {
        const pm = new PlayerMovement(level.world, cfg);
        pm.teleport(start);
        pm.state.vel.set(dir.x * v, 0, dir.z * v);
        const rider = new SurfRider(cfg, level.world, axis, 0);
        const out = makeBotInput();
        let first = true;
        let surfed = false;
        let line = '';
        let lastGround = '';
        const ctl: Controller = {
          next: (s, n) => {
            if (spec.surf && (surfed || n.lengthSq() > 0)) {
              if (!surfed) line += `${line ? '→' : ''}${flankName(level, s.pos)}`;
              surfed = true;
              return rider.next(s, n);
            }
            if (s.onGround) {
              const g = groundTagAt(level, s.pos);
              if (g && g !== lastGround) {
                lastGround = g;
                line += `${line ? '→' : ''}${g}`;
              }
            }
            out.yaw = yaw;
            out.pitch = 0;
            out.forward = 0;
            out.side = 0;
            out.sprint = false;
            out.crouch = false;
            out.jumpHeld = true;
            out.jumpPressed = first;
            first = false;
            return out;
          },
        };
        const res = simulate(level, pm, ctl, { cfg, goal: spec.goal, timeout: spec.timeout });
        runs++;
        spec.onLine?.(i, v, lateral, line);
        if (!res.ok)
          fails.push({ node: i, v, lateral, reason: res.reason, end: res.end, text: `ab Knoten ${i} ${v} u/s Versatz ${lateral}: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)} (${line || '–'})` });
      }
    }
  }
  return { runs, fails };
}

/** Füße auf den Boden unter p setzen (Suche 48 u darüber bis 64 u darunter); null ohne begehbaren Boden. */
export function dropToGround(level: CompiledLevel, p: Vector3): Vector3 | null {
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 48, p.z), new Vector3(p.x, p.y - 64, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1 || tr.normal.y < 0.7) return null;
  return tr.endPos.clone().setY(tr.endPos.y + 0.25);
}

/** Tag des Brushes unter den Füßen (für Linien-Protokolle), ohne Ring-Segmentnummer. */
export function groundTagAt(level: CompiledLevel, p: Vector3): string {
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 1, p.z), new Vector3(p.x, p.y - 8, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return '';
  return (level.brushes[tr.brushIndex]?.tag ?? '').replace(/#\d+$/, '');
}

/** Tag der Surf-Rampe, die p am nächsten ist (für Linien-Protokolle). */
export function flankName(level: CompiledLevel, p: Vector3): string {
  let best = '';
  let bestD = Infinity;
  for (const b of level.brushes) {
    if (!b.collide || !b.tag || !b.faces.some((fc) => fc.surf)) continue;
    const d = b.bounds.distanceToPoint(p);
    if (d < bestD) {
      bestD = d;
      best = b.tag;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// level2

/**
 * Ausfahrt ohne Todesstreifen, mit Auto-Hop: ab dem letzten Ring-Knoten und
 * ab T0 (Absprung vor E1) geradeaus, Leertaste gehalten, kein Strafen, vom
 * Sprint bis 1500 u/s und seitlich ±96 u — nach dem ersten Surf-Kontakt fährt
 * der Grundtechnik-Surfer. Jeder Lauf muss CP3 erreichen: wer eine Stufe
 * verfehlt, landet auf der darunterliegenden, nie vor einer Stirnwand.
 * Früher startete die Probe nur an T0 mit einem Absprungpunkt; mit Auto-Hop
 * springt man auf der Ausfahrt je nach Tempo bis zu 120 u früher ab (fallen.md #43).
 */
function exitTiers(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  // T0 = letzter Absprung vor dem ersten Knoten auf E1 (exit1).
  const t0i = route.findIndex((n) => groundTag(level, n) === 'exit1') - 1;
  const goal = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 3);
  if (t0i < 1 || !goal) {
    r.errors.push('Design: Ausfahrt-Probe findet Knoten vor E1 oder CP3 nicht');
    return;
  }
  // Linien bei Versatz 0 ab T0: Tempo, ab dem eine Linie zuerst vorkommt.
  const lines = new Map<string, number>();
  const res = autoHopRaster(level, cfg, {
    from: [t0i - 1, t0i],
    speeds: band(cfg.sprintSpeed, 1500, 20),
    laterals: LATERALS,
    goal: goal.bounds,
    surf: true,
    timeout: 14,
    onLine: (node, v, lateral, line) => {
      if (node === t0i && lateral === 0 && line && !lines.has(line)) lines.set(line, v);
    },
  });
  if (res.fails.length)
    r.errors.push(`Design: Ausfahrt hat Todesstreifen mit Auto-Hop: ${res.fails.length}/${res.runs} Läufe (z. B. ${res.fails.slice(0, 4).map((x) => x.text).join('; ')})`);
  else r.info.push(`Design: Ausfahrt ohne Todesstreifen mit Auto-Hop (${res.runs} Läufe ab Ring und T0, ${f0(cfg.sprintSpeed)}–1500 u/s, seitlich ±96)`);
  r.info.push(`Design: Ausfahrt-Linien ab T0 (geradeaus, Auto-Hop): ${[...lines].map(([k, v]) => `${k} ab ${v}`).join(', ')} u/s`);
  // Rand bis an die Vorfeldkante (Review l1l2): erst ein dichteres Raster fand die Hänger an der
  // Finnen-Stirn (62 bei −160…−148). Wer so weit außen fährt, darf in der S0-Grube landen (sie fängt
  // Nicht-Surfer, ein Rückweg führt hinaus) — aber nicht sterben; Hänger in der Luft meldet sie laut.
  // Tempo in EXIT_EDGE_STEP (zweites Review): in 20er-Schritten traf das Raster den Todesstreifen bei
  // 875–886 u/s (Versatz 150–160, S2 1024 breit) nur an seinen überlebenden Rändern.
  const edge = autoHopRaster(level, cfg, { from: [t0i - 1, t0i], speeds: band(cfg.sprintSpeed, 1500, EXIT_EDGE_STEP), laterals: EXIT_EDGE, goal: goal.bounds, surf: true, timeout: 14 });
  const deaths = edge.fails.filter((x) => x.reason !== 'timeout');
  const stuck = edge.fails.filter((x) => x.reason === 'timeout');
  // Grube = Grundriss der S0-Auffangflächen (auch unter dem S1-Anfang), bis 300 u über ihrer Oberkante.
  const pit = new Box3();
  for (const b of level.brushes) if (b.tag === 's0Catch') pit.union(b.bounds);
  pit.max.y += 300;
  const inPit = stuck.filter((x) => pit.containsPoint(x.end));
  const hangs = stuck.filter((x) => !pit.containsPoint(x.end));
  const where = (xs: readonly AutoHopFail[]): string => [...new Set(xs.map((x) => `${f0(x.end.x)},${f0(x.end.y)},${f0(x.end.z)}`))].slice(0, 3).join('; ');
  if (deaths.length) r.errors.push(`Design: Ausfahrt-Rand (Versatz ${EXIT_EDGE.join('/')}) tödlich: ${deaths.length}/${edge.runs} Läufe (z. B. ${deaths.slice(0, 3).map((x) => x.text).join('; ')})`);
  // Hänger außerhalb der Grube sind ein Softlock: keine Eingabe kommt heraus, nur F. In der Kerbe S0-Flanke/E1-Westwand
  // (x ≈ 1200) hingen 24/5676, bis das Sims (level2 buildS0Notch) den Knick zum Stand machte — seitdem 0, also Fehler.
  if (hangs.length) r.errors.push(`Design: Ausfahrt-Rand — ${hangs.length}/${edge.runs} Läufe (${EXIT_EDGE_STEP} u/s) bleiben außerhalb der S0-Grube stecken (bei ${where(hangs)}; Knick Flanke + Wand, fallen.md #98/#156)`);
  if (!deaths.length) r.info.push(`Design: Ausfahrt-Rand ohne Tod — ${edge.runs} Läufe (Versatz bis ±${EXIT_EDGE[EXIT_EDGE.length - 1]}, ${EXIT_EDGE_STEP} u/s), ${edge.runs - edge.fails.length} bis CP3, ${inPit.length} in der S0-Grube, ${hangs.length} Hänger`);
}

/** Versätze des Ausfahrt-Rands (u): zwischen dem Kernraster (±96) und der Vorfeldkante (±160). */
const EXIT_EDGE: readonly number[] = [-160, -152, -144, -128, -112, 112, 128, 144, 152, 160];
/** Tempo-Schritt des Rand-Rasters (u/s): chaotische Streifen sind wenige u/s breit (fallen.md #117). */
const EXIT_EDGE_STEP = 2.5;

/**
 * Die erste Surf-Berührung (S0) tötet niemanden, der nicht surft: ab dem CP2-Spawn
 * (E1) W gehalten, mit und ohne Leertaste und Shift, C nie/immer/spät, Blick fest in
 * 1°-Schritten über ±90° oder immer auf den nächsten Route-Knoten (wie novice.ts) — 12 s
 * ohne Tod (2184 Läufe, ~7 s).
 * Vorher (S1 direkt hinter E1, ohne Auffangfläche) starb so ein Lauf nach ~3 s.
 */
function s0Catch(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const cp = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
  const floor = byTag(level, 's0Catch');
  const from = route.findIndex((n) => groundTag(level, n) === 'exit1');
  if (!cp || !floor || from < 0) {
    r.errors.push('Design: S0-Probe findet CP2, E1-Knoten oder die Auffangfläche (s0Catch) nicht');
    return;
  }
  const never = new Box3(new Vector3(1e9, 1e9, 1e9), new Vector3(1e9 + 1, 1e9 + 1, 1e9 + 1));
  const fails: string[] = [];
  let runs = 0;
  // Blick fest in 1°-Schritten über ±90° (Review l1l2: sechs Richtungen sahen weder die Tode bei −14…−18°
  // noch die bei 53–90°) oder auf den nächsten Knoten; mit/ohne Leertaste, mit/ohne Shift, C nie /
  // immer / ab 0.6 s (Rutschen nach dem Anlauf).
  const looks = [Number.NaN, ...Array.from({ length: 181 }, (_, i) => i - 90)];
  const dt = 1 / cfg.tickRate;
  for (const look of looks) {
    for (const hold of [false, true]) {
      for (const sprint of [true, false]) {
        for (const crouch of ['never', 'always', 'late'] as const) {
          const pm = new PlayerMovement(level.world, cfg);
          pm.teleport(cp.spawnPos);
          const out = makeBotInput();
          let node = from + 1;
          let first = true;
          let t = 0;
          const ctl: Controller = {
            next: (st) => {
              if (Number.isNaN(look)) {
                while (node < route.length - 1 && (Math.hypot(route[node].pos[0] - st.pos.x, route[node].pos[2] - st.pos.z) < 80 || passedNode(route, node, st.pos))) node++;
                const n = route[node].pos;
                out.yaw = Math.atan2(-(n[0] - st.pos.x), -(n[2] - st.pos.z));
              } else out.yaw = (-look * Math.PI) / 180;
              out.pitch = 0;
              out.forward = 1;
              out.side = 0;
              out.sprint = sprint;
              out.crouch = crouch === 'always' || (crouch === 'late' && t > 0.6);
              out.jumpHeld = hold;
              out.jumpPressed = hold && first;
              first = false;
              t += dt;
              return out;
            },
          };
          const res = simulate(level, pm, ctl, { cfg, goal: never, timeout: 12 });
          runs++;
          if (res.reason !== 'timeout')
            fails.push(`${Number.isNaN(look) ? 'Blick auf Knoten' : `Blick ${look}°`}${hold ? ' + Leertaste' : ''}${sprint ? '' : ' ohne Shift'}, C ${crouch}: ${res.reason} nach ${res.time.toFixed(1)} s bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
        }
      }
    }
  }
  if (fails.length) r.errors.push(`Design: S0 fängt Nicht-Surfer nicht: ${fails.length}/${runs} W-Halter ab CP2 tot (${fails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design: S0 fängt Nicht-Surfer — ${runs} W-Halter ab CP2 (Blick −90…+90° in 1°-Schritten / auf Knoten, mit/ohne Leertaste und Shift, C nie/immer/ab 0.6 s) 12 s ohne Tod`);
}

/**
 * Rückweg von der S0-Auffangfläche aufs Vorfeld ist begehbar: Start auf dem
 * Boden der Grube 200 u südlich des Durchgangs, W (mit und ohne Leertaste) erst
 * nach Nord bis auf Höhe des Durchgangs, dann nach Ost hinein, dann Süd die Rampe
 * hinauf — Ziel: Füße auf dem oberen Absatz (s0BackTop).
 */
function s0BackWay(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const foot = byTag(level, 's0BackFoot');
  const topB = byTag(level, 's0BackTop');
  const floors = level.brushes.filter((b) => b.tag === 's0Catch');
  if (!foot || !topB || floors.length === 0) {
    r.errors.push('Design: Rückweg-Probe findet s0BackFoot, s0BackTop oder s0Catch nicht');
    return;
  }
  // Oststreifen der Fläche: der, dessen Westkante am nächsten an der Fuß-Plattform liegt.
  const east = floors.reduce((a, b) => (Math.abs(b.bounds.max.x - foot.bounds.min.x) < Math.abs(a.bounds.max.x - foot.bounds.min.x) ? b : a));
  const fc = center(foot);
  const gapZ = fc.z;
  const start = dropToGround(level, new Vector3((east.bounds.min.x + east.bounds.max.x) / 2, foot.bounds.max.y + 40, gapZ + 200));
  if (!start) {
    r.errors.push('Design: Rückweg-Probe findet keinen Boden auf der S0-Fläche');
    return;
  }
  const goal = new Box3(topB.bounds.min.clone().setY(topB.bounds.max.y - 1), topB.bounds.max.clone().setY(topB.bounds.max.y + 2));
  const fails: string[] = [];
  let slow = 0;
  for (const hold of [false, true]) {
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(start);
    const out = makeBotInput();
    let phase = 0;
    const ctl: Controller = {
      next: (st) => {
        // 0: nach Norden bis auf Höhe des Durchgangs, 1: nach Osten auf die Fuß-Plattform, 2: nach Süden hinauf.
        if (phase === 0 && st.pos.z <= gapZ) phase = 1;
        if (phase === 1 && st.pos.x >= fc.x) phase = 2;
        out.yaw = phase === 0 ? 0 : phase === 1 ? -Math.PI / 2 : Math.PI;
        out.pitch = 0;
        out.forward = 1;
        out.side = 0;
        out.sprint = true;
        out.jumpHeld = hold;
        out.jumpPressed = false;
        return out;
      },
    };
    const res = simulate(level, pm, ctl, { cfg, goal, timeout: 15 });
    if (!res.ok) fails.push(`${hold ? 'W + Leertaste' : 'W'}: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
    else slow = Math.max(slow, res.time);
  }
  if (fails.length) r.errors.push(`Design: Rückweg von der S0-Fläche nicht begehbar (${fails.join('; ')})`);
  else r.info.push(`Design: Rückweg von der S0-Fläche aufs Vorfeld begehbar (W / W + Leertaste, ≤ ${slow.toFixed(1)} s)`);
}

/**
 * L2-Ringbande gegen Flucht nach außen (Plan 007 Phase 3, Fehlerklasse aus L4: seit dem Kanten-Assist kommt ein
 * Crouch-Hop über eine 80-u-Bande — ohne Clip 10/3864 Läufe hinaus, 1 auf der Bande stehend). Start mit der
 * Hull-Front 4/24 u vor der Bande an jedem 2. Bandenstück, Blick fest, W + Sprint + Leertaste, nie / in der Luft /
 * immer geduckt, 0–80° zur Wandnormalen in beide Richtungen, 300–900 u/s, 3 s. Wer durch eine offene Stelle
 * (Ausfahrt, Anflug) hinausfliegt, zählt nicht — die ist gewollt. Soll: 0 über die Bande, 0 auf der Bande.
 */
function ringBoardEscape(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const rb = level2RingBoard();
  const o = rb.outer;
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const inp = makeBotInput();
  const hMin = new Vector3();
  const hMax = new Vector3();
  const hb = new Box3();
  const out: string[] = [];
  const onTop: string[] = [];
  let runs = 0;
  let maxFeet = 0;
  const openAt = (phi: number, pad: number): boolean => rb.open.some(([a, b]) => phi >= a - pad && phi < b + pad);
  // Winkel des nächsten Ringpunkts (Konvention von Ring.point; grob genügt, die offenen Sektoren sind breit).
  const phiOf = (x: number, z: number, rr: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let q = 0; q < 360; q += 1) {
      const [qx, qz] = o.point(q, rr);
      const d = (qx - x) ** 2 + (qz - z) ** 2;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  };
  const dPhi = 360 / o.o.segments;
  for (let phi = dPhi / 2; phi < 360; phi += 2 * dPhi) {
    if (openAt(phi, 6)) continue;
    for (const front of [4, 24]) {
      const r0 = o.rOut - 16 - front;
      const [x, z] = o.point(phi, r0);
      const [x2, z2] = o.point(phi, r0 + 10);
      const [ox, oz] = [(x2 - x) / 10, (z2 - z) / 10];
      const [xa, za] = o.point(phi + 0.1, r0);
      const tl = Math.hypot(xa - x, za - z);
      const [tx, tz] = [(xa - x) / tl, (za - z) / tl];
      const y = o.surfaceY(x, z) + 2;
      for (const alpha of [0, 30, 60, 80]) {
        const [ca, sa] = [Math.cos((alpha * Math.PI) / 180), Math.sin((alpha * Math.PI) / 180)];
        for (const dir of alpha === 0 ? [1] : [1, -1]) {
          const dx = ca * ox + dir * sa * tx;
          const dz = ca * oz + dir * sa * tz;
          const yaw = Math.atan2(-dx, -dz);
          for (const v0 of [300, 600, 900]) {
            for (const mode of ['hop', 'crouchAir', 'crouchHold'] as const) {
              runs++;
              const pm = new PlayerMovement(level.world, cfg);
              pm.teleport(new Vector3(x, y, z));
              pm.state.vel.set(dx * v0, 0, dz * v0);
              let exited = false;
              let viaGap = false;
              const name = `φ ${phi.toFixed(1)} Front ${front} ${alpha}° ${v0} u/s ${mode}`;
              for (let k = 0; k < 3 * cfg.tickRate; k++) {
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
                const rr = Math.hypot(s.pos.x - rb.center[0], s.pos.z - rb.center[1]);
                if (rr > o.rOut - 20 && rr < o.rOut + rb.boardT + 16) maxFeet = Math.max(maxFeet, s.pos.y - o.hOut);
                // Auf der Bande = der Boden unter den Füßen IST Bande oder Clip (am Rand liegt auch die Anlaufbahn).
                if (s.onGround && rr > o.rOut - 16 && s.pos.y > o.hOut + 60 && /^ring(Board|Clip)$/.test(groundTagAt(level, s.pos))) {
                  onTop.push(`${name}: steht bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}`);
                  break;
                }
                if (!exited && rr > o.rOut + rb.boardT + 16) {
                  exited = true;
                  viaGap = openAt(phiOf(s.pos.x, s.pos.z, rr), 2);
                }
                hMin.copy(s.pos).add(pm.hullMins);
                hMax.copy(s.pos).add(pm.hullMaxs);
                hb.set(hMin, hMax);
                const dead = s.pos.y < level.def.killY || kills.some((t) => t.bounds.intersectsBox(hb));
                if (exited && !viaGap && (dead || (k === 3 * cfg.tickRate - 1 && !s.onGround && s.pos.y < o.hOut - 300))) {
                  out.push(`${name}: ${dead ? 'tot' : 'fällt'} bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}`);
                  break;
                }
                if (dead) break;
              }
            }
          }
        }
      }
    }
  }
  const line = `Ringbande nach außen — ${runs} Läufe (Hop/Crouch-Hop/Ducken gehalten, 0–80°, 300–900 u/s): ${out.length} über die Bande, ${onTop.length} auf der Bande; Füße am Außenrand höchstens ${f0(maxFeet)} u über der Außenkante (Bande ${rb.boardH}, Clip bis ${rb.clipH}; dort liegt auch die Anlaufbahn)`;
  if (out.length || onTop.length) r.errors.push(`Design: ${line} (${[...out, ...onTop].slice(0, 3).join('; ')})`);
  else r.info.push(`Design: ${line}`);
}

/**
 * Finale aus dem Respawn am letzten Checkpoint (Grundtechnik, Blickfehler −1…+2°): Landung auf dem Ziel
 * mit ≥ 10 % Weitenreserve. `yawDeg` = Flugrichtung des Launchs (L2: 0 = Norden; L3/L4 die Richtung ihres
 * Kickers). Weiten werden entlang dieser Richtung gemessen; die nahe Kante der Zielplattform (Tag 'finish')
 * muss quer dazu liegen (finishAfterLaunch baut sie so), sonst meldet die Probe einen Fehler statt einer Zahl.
 */
export function finaleReserve(level: CompiledLevel, cfg: MovementConfig, r: DesignReport, yawDeg = 0): void {
  const route = level.def.route ?? [];
  // Launch = letzter Surf-Knoten (Abflug ins Ziel).
  const launch = [...route].reverse().find((n) => n.surf === true);
  const cp = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => b.order - a.order)[0];
  const fin = level.triggers.find((t) => t.kind === 'finish');
  const pad = byTag(level, 'finish');
  if (!launch || !cp || !fin || !pad) {
    r.errors.push('Design: Finale-Probe findet Launch-Knoten, letzten Checkpoint oder Ziel nicht');
    return;
  }
  const [fx, fz] = forwardOf(yawDeg);
  const along = (x: number, z: number): number => (x - launch.pos[0]) * fx + (z - launch.pos[2]) * fz;
  // Nahe Kante aus den echten Ecken der Plattform-Oberseite, nicht aus der AABB: bei schräger Flugrichtung
  // läge eine AABB-Ecke näher als die Kante — Lücke zu klein, Reserve zu groß, die Probe grün statt rot.
  const corners = new Map<string, number>();
  for (const f of pad.faces) if (f.normal.y > 0.99) for (const v of f.vertices) corners.set(`${v.x.toFixed(3)},${v.z.toFixed(3)}`, along(v.x, v.z));
  const tops = [...corners.values()].sort((a, b) => a - b);
  // Die Weite gilt nur, wenn die nahe Kante quer zur Flugrichtung liegt (finishAfterLaunch baut sie so).
  if (tops.length < 2 || tops[1] - tops[0] > 1) {
    r.errors.push(`Design: Finale-Probe braucht eine Zielkante quer zur Flugrichtung ${yawDeg}° — die Plattform 'finish' steht schräg dazu (Ecken ${tops.slice(0, 2).map(f0).join(' / ')} u)`);
    return;
  }
  const lip = tops[0];
  const axis = routeAxis(route);
  let worst = Infinity;
  const detail: string[] = [];
  for (const look of [-1, 0, 2]) {
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(cp.spawnPos);
    const rider = new SurfRider(cfg, level.world, axis, (look * Math.PI) / 180);
    // Erste Berührung der Zieloberseite = Landung (Füße auf Höhe der Oberseite).
    const onPad = new Box3(pad.bounds.min.clone().setY(pad.bounds.max.y - 1), pad.bounds.max.clone().setY(pad.bounds.max.y + 2));
    const res = simulate(level, pm, rider, { cfg, goal: onPad, timeout: 20 });
    if (!res.ok || Math.abs(res.end.y - pad.bounds.max.y) > 2) {
      r.errors.push(`Design: Finale aus dem CP${cp.order}-Respawn (Blick ${look}°) landet nicht auf dem Ziel`);
      return;
    }
    const reserve = along(res.end.x, res.end.z) / lip - 1;
    worst = Math.min(worst, reserve);
    detail.push(`${look}°: ${f0(reserve * 100)} %`);
  }
  if (worst < 0.1) r.errors.push(`Design: Finale aus dem CP${cp.order}-Respawn hat nur ${f0(worst * 100)} % Weitenreserve (${detail.join(', ')}; Soll ≥ 10 %)`);
  else r.info.push(`Design: Finale aus dem Stand (CP${cp.order}) landet mit ${detail.join(', ')} Weitenreserve (Lücke ${f0(lip)} u)`);
}

// ---------------------------------------------------------------------------
// Wendel (Plan 007: L4, gestapelte Lektionen)

/** Was die Wendel-Proben brauchen — lib.Helix erfüllt es. θ in Grad, yaw in Grad. */
export interface HelixLike {
  xz(theta: number, r: number): V2;
  yAt(theta: number, after?: boolean): number;
  yawAt(theta: number): number;
}

export interface HelixBoardSpec {
  /** θ von, bis (exklusiv), Schritt (Grad). */
  readonly thetas: readonly [number, number, number];
  readonly radii: readonly number[];
  readonly speeds?: readonly number[];
  /** Fester Blick relativ zur Fahrtrichtung (Grad): 0 und ±25 drücken in Kern und Bande. */
  readonly aims?: readonly number[];
  readonly seconds?: number;
}

export interface HelixBoardResult {
  readonly runs: number;
  readonly deaths: readonly string[];
  /** Läufe, die > 150 u unter ihrem Start aufsetzten oder am Ende noch darunter fallen (von der Wendel geflogen). */
  readonly fell: readonly string[];
  /** Läufe mit Luft-Hänger > 0.25 s (in der Luft, |vy| < 12, Tempo < 40: Wall-Cling in einer Ecke). */
  readonly hangs: readonly string[];
  readonly worstDrop: number;
}

/**
 * Bande einer Wendel: Geradeaus-Hüpfer (Blick fest, W + Leertaste gehalten, kein Lenken) quer über die
 * Bahn — die Bande muss jeden halten, keiner darf in einer Ecke hängen. Entwurf L4 (Probe B): θ 10–530 ×
 * 3 Radien × 320/600/900 u/s × Blick 0/±25°, 3 s — 0 Tode, 0 Landungen > 150 u tiefer, 0 Hänger.
 */
export function helixBoard(level: CompiledLevel, helix: HelixLike, spec: HelixBoardSpec, cfg: MovementConfig = VELOCITY_DEFAULT): HelixBoardResult {
  const [t0, t1, step] = spec.thetas;
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const hangTicks = Math.round(0.25 * cfg.tickRate);
  const lo = new Vector3();
  const hi = new Vector3();
  const deaths: string[] = [];
  const fell: string[] = [];
  const hangs: string[] = [];
  let worstDrop = 0;
  let runs = 0;
  for (let theta = t0; theta < t1; theta += step) {
    for (const r of spec.radii) {
      for (const v of spec.speeds ?? [320, 600, 900]) {
        for (const aim of spec.aims ?? [0, -25, 25]) {
          const pm = new PlayerMovement(level.world, cfg);
          const [x, z] = helix.xz(theta, r);
          const y0 = helix.yAt(theta, true);
          pm.teleport(new Vector3(x, y0 + 80, z));
          const yaw0 = (helix.yawAt(theta) * Math.PI) / 180;
          const yaw = yaw0 + (aim * Math.PI) / 180;
          pm.state.vel.set(-Math.sin(yaw0) * v, 0, -Math.cos(yaw0) * v);
          const inp = makeBotInput();
          const name = `θ ${theta} r ${r} ${v} u/s Blick ${aim}°`;
          let minY = Infinity;
          let hang = 0;
          let maxHang = 0;
          for (let k = 0; k < (spec.seconds ?? 3) * cfg.tickRate; k++) {
            inp.yaw = yaw;
            inp.forward = 1;
            inp.sprint = true;
            inp.jumpHeld = true;
            inp.jumpPressed = k === 0;
            pm.tick(inp);
            const s = pm.state;
            if (s.onGround) minY = Math.min(minY, s.pos.y);
            hang = !s.onGround && Math.abs(s.vel.y) < 12 && s.speed < 40 ? hang + 1 : 0;
            maxHang = Math.max(maxHang, hang);
            lo.copy(s.pos).add(pm.hullMins);
            hi.copy(s.pos).add(pm.hullMaxs);
            if (s.pos.y < level.def.killY || kills.some((t) => t.bounds.min.x < hi.x && t.bounds.max.x > lo.x && t.bounds.min.y < hi.y && t.bounds.max.y > lo.y && t.bounds.min.z < hi.z && t.bounds.max.z > lo.z)) {
              deaths.push(`${name}: tot bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}`);
              break;
            }
          }
          runs++;
          if (maxHang > hangTicks) hangs.push(`${name}: ${(maxHang / cfg.tickRate).toFixed(2)} s`);
          // Tiefer gelandet — oder am Ende noch im Fall unter der Bahn (von der Wendel geflogen, Tod kommt erst später).
          const end = pm.state;
          const drop = Math.max(Number.isFinite(minY) ? y0 - minY : 0, end.onGround ? 0 : y0 - end.pos.y);
          if (drop > 150) fell.push(`${name}: ${f0(drop)} u tiefer${end.onGround ? '' : ' (fällt noch)'}`);
          worstDrop = Math.max(worstDrop, drop);
        }
      }
    }
  }
  return { runs, deaths, fell, hangs, worstDrop };
}

/** helixBoard als Design-Probe: Tode, Abstürze oder Hänger sind Fehler. */
export function helixBoardProbe(level: CompiledLevel, helix: HelixLike, spec: HelixBoardSpec, cfg: MovementConfig, r: DesignReport, name = 'Wendel'): void {
  const res = helixBoard(level, helix, spec, cfg);
  const bad = [...res.deaths, ...res.fell, ...res.hangs];
  if (bad.length)
    r.errors.push(
      `Design: ${name}-Bande hält nicht: ${res.deaths.length} Tode, ${res.fell.length} Abstürze > 150 u, ${res.hangs.length} Hänger > 0.25 s von ${res.runs} Geradeaus-Hüpfern (z. B. ${bad.slice(0, 3).join('; ')})`,
    );
  else r.info.push(`Design: ${name}-Bande hält — ${res.runs} Geradeaus-Hüpfer ohne Tod, Absturz oder Hänger (größter Höhenverlust ${f0(res.worstDrop)} u)`);
}
