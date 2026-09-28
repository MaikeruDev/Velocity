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
 * Die Proben finden ihre Geometrie über Brush-Tags und Route-Flags (nie über
 * Notiztexte) — wer die Level umbaut und Tags umbenennt, bekommt einen Fehler
 * statt Stille.
 */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { makeBotInput, runRoute } from '../../src/player/bots';
import type { CompiledBrush } from '../../src/world/collision/types';
import type { CompiledLevel } from '../../src/world/level/compileLevel';
import type { RouteNode } from '../../src/world/level/LevelFormat';
import { OVERSHOOT } from './ballistics';
import { SpeedCurve, SurfRider, routeAxis, simulate, straightHop, type Controller } from './physics';

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
function passedNode(route: readonly RouteNode[], i: number, p: Vector3): boolean {
  const a = route[i - 1].pos;
  const b = route[i].pos;
  const sx = b[0] - a[0];
  const sz = b[2] - a[2];
  const l2 = sx * sx + sz * sz;
  if (l2 < 1) return false;
  return ((p.x - a[0]) * sx + (p.z - a[2]) * sz) / l2 >= 1;
}

function byTag(level: CompiledLevel, tag: string): CompiledBrush | null {
  return level.brushes.find((b) => b.tag === tag) ?? null;
}

/** Tag des Brushes, auf dem ein Route-Knoten steht (Boden bis 8 u darunter), sonst null. */
function groundTag(level: CompiledLevel, n: RouteNode): string | null {
  const p = new Vector3(...n.pos);
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 1, p.z), new Vector3(p.x, p.y - 8, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return null;
  return level.brushes[tr.brushIndex]?.tag ?? null;
}

function center(b: CompiledBrush): Vector3 {
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
 * Auffangfläche fällt, zählt nicht.
 */
function slalomNeedsSteering(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const turn = byTag(level, 'turn');
  const s1 = byTag(level, 'slalom1');
  const s5 = byTag(level, 'slalom5');
  const chute = byTag(level, 'chutea');
  if (!turn || !s1 || !s5 || !chute) {
    r.errors.push('Design: Slalom-Probe findet turn/slalom1/slalom5/chutea nicht');
    return;
  }
  const fwd = center(s5).sub(center(s1)).setY(0).normalize();
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
  const speeds = [0, 1, 2, 3, 4].map((k) => Math.round(vLo + ((vHi - vLo) * k) / 4));
  for (let o = -176; o <= 176; o += 16) {
    for (const v of speeds) {
      const start = c.clone().addScaledVector(fwd, 100).addScaledVector(side, o).setY(top);
      const res = straightHop(level, start, yaw, v, goal, cfg);
      runs++;
      if (res.ok) through.push(`${o}/${v}`);
    }
  }
  if (through.length) r.errors.push(`Design: Slalom geradeaus ohne Lenkung schaffbar (Versatz/Tempo: ${through.slice(0, 6).join(', ')})`);
  else r.info.push(`Design: Slalom braucht Lenkung — ${runs} Geradeaus-Läufe (Versatz ±176, ${speeds[0]}–${speeds[4]} u/s) scheitern alle`);
}

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
 * schneller sein als der Weg über die Auffangfläche.
 */
function chuteCatch(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const fin = level.triggers.find((t) => t.kind === 'finish');
  const from = route.findIndex((n) => groundTag(level, n) === 'slalom6');
  if (!fin || from < 0 || from + 1 >= route.length) {
    r.errors.push('Design: Rutschen-Probe findet slalom6-Knoten oder Ziel nicht');
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
  if (fails.length) r.errors.push(`Design: Surf-Rutsche fängt nicht jeden: ${fails.length}/${runs} Läufe (z. B. ${fails.slice(0, 4).join('; ')})`);
  else r.info.push(`Design: Surf-Rutsche fängt jeden — ${runs} Läufe ab der letzten Insel (${f0(cfg.sprintSpeed)}–1300 u/s, ±96, geradeaus ohne Surfen und W-Halter) im Ziel, langsamster W-Halter ${slow.toFixed(1)} s`);
}

/** W + Leertaste gehalten, Blick auf den nächsten Route-Knoten (wie novice.ts "W+Space"), Start mit Tempo v am Knoten. */
function wHolder(level: CompiledLevel, cfg: MovementConfig, from: number, v: number, lateral: number, goal: Box3): ReturnType<typeof simulate> {
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
  const ctl: Controller = {
    next: (s) => {
      while (node < route.length - 1) {
        const n = route[node].pos;
        if (Math.hypot(n[0] - s.pos.x, n[2] - s.pos.z) < 80 || passedNode(route, node, s.pos)) node++;
        else break;
      }
      const n = route[node].pos;
      out.yaw = Math.atan2(-(n[0] - s.pos.x), -(n[2] - s.pos.z));
      out.pitch = 0;
      out.forward = 1;
      out.side = 0;
      out.sprint = true;
      out.crouch = false;
      out.jumpHeld = true;
      out.jumpPressed = first;
      first = false;
      return out;
    },
  };
  return simulate(level, pm, ctl, { cfg, goal, timeout: 20 });
}

/**
 * Könner-Inseln (Level 1): die Abkürzung Kehren-Pad 1 → Inseln → Wende muss sich
 * lohnen. RouteFollower mit Zielfehler 1° über sechs Seeds, einmal die normale
 * Route, einmal über die Inseln (wie tools/critique/level-flow/veteran.ts, aber
 * mit dem Ende an der Wende). Soll: ≥ 5/6 durch, im Mittel ≥ 1 s schneller; der
 * perfekte Bot muss durchkommen.
 */
function expertIslands(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = level.def.route ?? [];
  const cuts = level.brushes.filter((b) => b.tag !== null && /^cut\d+$/.test(b.tag)).sort((a, b) => Number(a.tag?.slice(3)) - Number(b.tag?.slice(3)));
  const from = route.findIndex((n) => groundTag(level, n) === 'curve1');
  const to = route.findIndex((n) => groundTag(level, n) === 'turn');
  if (!cuts.length || from < 0 || to <= from) {
    r.errors.push('Design: Inseln-Probe findet cut-Inseln, Kehren-Pad 1 oder Wende nicht');
    return;
  }
  const minSpeed = route[from].minSpeed;
  const cutRoute: RouteNode[] = [
    ...route.slice(0, from + 1),
    ...cuts.map((b): RouteNode => ({ pos: [center(b).x, b.bounds.max.y, center(b).z], jump: true, ...(minSpeed !== undefined ? { minSpeed } : {}) })),
    ...route.slice(to),
  ];
  const cells: string[] = [];
  let ok = 0;
  let saved = 0;
  let pairs = 0;
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) {
    const a = runRoute(level, cfg, { aimNoiseDeg: 1, seed });
    const b = runRoute(level, cfg, { aimNoiseDeg: 1, seed, route: cutRoute });
    if (b.touchedFinish) ok++;
    if (a.touchedFinish && b.touchedFinish) {
      saved += a.time - b.time;
      pairs++;
    }
    cells.push(b.touchedFinish ? b.time.toFixed(1) : 'x');
  }
  const perfect = runRoute(level, cfg, { sync: 1, seed: 11, route: cutRoute });
  const perfectBase = runRoute(level, cfg, { sync: 1, seed: 11 });
  const avg = pairs ? saved / pairs : 0;
  const text = `Hand 1° über die Inseln ${ok}/${seeds.length} durch (${cells.join(' ')} s), Ersparnis Ø ${avg.toFixed(2)} s (${pairs} Paare); perfekter Bot ${perfect.touchedFinish ? `${(perfectBase.time - perfect.time).toFixed(2)} s schneller` : 'scheitert'}`;
  if (!perfect.touchedFinish) r.errors.push(`Design: Könner-Inseln: ${text}`);
  else if (ok < 5 || avg < 1) r.warnings.push(`Design: Könner-Inseln lohnen nicht (Soll ≥ 5/6, ≥ 1 s): ${text}`);
  else r.info.push(`Design: Könner-Inseln — ${text}`);
}

/** Seitliche Versätze der Auto-Hop-Raster (u, rechts positiv). */
const LATERALS: readonly number[] = [-96, -48, 0, 48, 96];

function band(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) out.push(Math.round(v));
  return out;
}

interface AutoHopSpec {
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

interface AutoHopResult {
  readonly runs: number;
  readonly fails: Array<{ readonly node: number; readonly v: number; readonly lateral: number; readonly text: string }>;
}

/**
 * Auto-Hop-Raster: wie ein Mensch, der die Leertaste hält (Auto-Hop ist Default)
 * und geradeaus hält, ohne zu strafen — die typische Art, an einer Kante zu
 * sterben: die Landung einer Hop-Phase liegt vor einer Stirnwand. Start auf dem
 * Boden am Knoten (seitlich versetzt), Tempo v Richtung Folgeknoten.
 */
function autoHopRaster(level: CompiledLevel, cfg: MovementConfig, spec: AutoHopSpec): AutoHopResult {
  const route = level.def.route ?? [];
  const axis = routeAxis(route);
  const fails: Array<{ node: number; v: number; lateral: number; text: string }> = [];
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
          fails.push({ node: i, v, lateral, text: `ab Knoten ${i} ${v} u/s Versatz ${lateral}: ${res.reason} bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)} (${line || '–'})` });
      }
    }
  }
  return { runs, fails };
}

/** Füße auf den Boden unter p setzen (Suche 48 u darüber bis 64 u darunter); null ohne begehbaren Boden. */
function dropToGround(level: CompiledLevel, p: Vector3): Vector3 | null {
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 48, p.z), new Vector3(p.x, p.y - 64, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1 || tr.normal.y < 0.7) return null;
  return tr.endPos.clone().setY(tr.endPos.y + 0.25);
}

/** Tag des Brushes unter den Füßen (für Linien-Protokolle), ohne Ring-Segmentnummer. */
function groundTagAt(level: CompiledLevel, p: Vector3): string {
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 1, p.z), new Vector3(p.x, p.y - 8, p.z), HULL_MINS, HULL_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return '';
  return (level.brushes[tr.brushIndex]?.tag ?? '').replace(/#\d+$/, '');
}

/** Tag der Surf-Rampe, die p am nächsten ist (für Linien-Protokolle). */
function flankName(level: CompiledLevel, p: Vector3): string {
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
}

/**
 * Die erste Surf-Berührung (S0) tötet niemanden, der nicht surft: ab dem CP2-Spawn
 * (E1) W gehalten, mit und ohne Leertaste, Blick fest in 5 Richtungen (±30° um
 * Nord) oder immer auf den nächsten Route-Knoten (wie novice.ts) — 12 s ohne Tod.
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
  for (const look of [-30, -15, 0, 15, 30, NaN]) {
    for (const hold of [false, true]) {
      const pm = new PlayerMovement(level.world, cfg);
      pm.teleport(cp.spawnPos);
      const out = makeBotInput();
      let node = from + 1;
      let first = true;
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
          out.sprint = true;
          out.crouch = false;
          out.jumpHeld = hold;
          out.jumpPressed = hold && first;
          first = false;
          return out;
        },
      };
      const res = simulate(level, pm, ctl, { cfg, goal: never, timeout: 12 });
      runs++;
      if (res.reason !== 'timeout') fails.push(`${Number.isNaN(look) ? 'Blick auf Knoten' : `Blick ${look}°`}${hold ? ' + Leertaste' : ''}: ${res.reason} nach ${res.time.toFixed(1)} s bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
    }
  }
  if (fails.length) r.errors.push(`Design: S0 fängt Nicht-Surfer nicht: ${fails.length}/${runs} W-Halter ab CP2 tot (${fails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design: S0 fängt Nicht-Surfer — ${runs} W-Halter ab CP2 (Blick ±30° / auf Knoten, mit und ohne Leertaste) 12 s ohne Tod`);
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

/** Finale aus dem CP4-Respawn (Grundtechnik, Blickfehler −1…+2°): Landung auf dem Ziel mit ≥ 10 % Weitenreserve. */
function finaleReserve(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
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
  const lz = launch.pos[2];
  // Ziel liegt in Fahrtrichtung (−z): nahe Kante = größtes z der Zielplattform.
  const lip = Math.abs(lz - pad.bounds.max.z);
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
    const landZ = res.end.z;
    if (!res.ok || Math.abs(res.end.y - pad.bounds.max.y) > 2) {
      r.errors.push(`Design: Finale aus dem CP${cp.order}-Respawn (Blick ${look}°) landet nicht auf dem Ziel`);
      return;
    }
    const reserve = Math.abs(lz - landZ) / lip - 1;
    worst = Math.min(worst, reserve);
    detail.push(`${look}°: ${f0(reserve * 100)} %`);
  }
  if (worst < 0.1) r.errors.push(`Design: Finale aus dem CP${cp.order}-Respawn hat nur ${f0(worst * 100)} % Weitenreserve (${detail.join(', ')}; Soll ≥ 10 %)`);
  else r.info.push(`Design: Finale aus dem Stand (CP${cp.order}) landet mit ${detail.join(', ')} Weitenreserve (Lücke ${f0(lip)} u)`);
}
