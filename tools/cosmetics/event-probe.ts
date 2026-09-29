/**
 * Abnahme-Werkzeug (Plan 007): Trick-Takt der Gegenstände in echten Bot-Läufen. RouteFollower +
 * PlayerMovement + RunState (wie physics.timedRun) auf den Leveln (aus tools/levels gebaut), Events wie im
 * Spiel an die Trick-Maschinen aus PROP_FACTORIES, Frames mit 60 Hz.
 *   npx tsx tools/cosmetics/event-probe.ts [item …] [--levels level1,level3] [--seeds 15]
 *   ohne Filter → shots/v2/kosmetik/event-probe-core.json (alle Gegenstände, L1–L4),
 *   mit Filter  → shots/v2/kosmetik/event-probe-partial.json (die Kern-Datei bleibt vollständig).
 *
 * Gemessen je Gegenstand und Level × Spielertyp (sync 1.0 und 1.5°-Hand, je 3 Seeds):
 * - Trick-Anteil der Laufzeit OHNE Zustands-Tricks (Surf-Balance zählt nicht) — Ziel 25–45 % bezogen auf die
 *   Zeit außerhalb der Zustände ("Anteil an der Zeit ohne Surf-Zustände", Lead-Entscheidung Plan 007),
 * - Tricks pro Minute — Ziel 20–32, GEPRÜFT OHNE Ziel-Trick und je Minute OHNE Zustände ("frei/min", wie der
 *   Anteil: im Surf-Zustand startet kein Trick). Der Ziel-Trick kommt seit dem Review Phase 2 in jedem Lauf und
 *   polsterte kurze Läufe (L1 ~23 s: +2.6/min); daneben zur Information mit Ziel-Trick und je Laufzeit-Minute,
 * - Surf-Abdeckung: Anteil der Surf-Zeit ≥ 500 u/s, in der ein Surf-Zustand sichtbar läuft,
 * - sichtbare Aktion: Anteil der Laufzeit mit Trick ODER Zustand (surf-lastige Level, z. B. L3),
 * - Einlagen je Minute Zustandszeit (kleine Bewegungen IM Surf-Zustand, beenden ihn nicht — L3 ist reiner Surf),
 * - Abwechslung: größter Anteil eines einzelnen Tricks an den Starts (Review: Jo-Jo-Breakaway 57–60 %),
 * - Ziel-Reaktion (Phase-2-Review): Ziel-Trick im Ziel-Frame gestartet (auch aus Trick/Zustand), Handy: Auslöser
 *   vor dem Ergebnis (Game FINISH_MENU_DELAY 1.1 s) — nach dem Ziel rollt der Lauf 1.1 s weiter (zählt nicht
 *   in den Takt).
 * Exit 1 (Review Phase 2: vorher immer 0, eine Regression durch Level-Umbauten fiel niemandem auf), wenn ein
 * Plan-007-Gegenstand auf L1/L2 das Band verlässt (25–45 % frei, 20–32 frei/min ohne Ziel-Trick), irgendwo die
 * Surf-Abdeckung unter 80 % fällt (ab 3 s Surf ≥ 500), ein Trick mehr als 50 % der Starts ausmacht (ab 20 Starts)
 * oder die Ziel-Reaktion/das Foto fehlt. Dose/Karte/Messer (Plan 006, abgenommen) nur Warnung.
 * Referenz Dose/Karte/Messer (Plan 006): 22–42 %, 21–32/min. (Ursprung: tools/critique/v2/kosmetik/event-probe.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { compileLevel } from '../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../src/world/level/compileLevel';
import type { LevelFile } from '../../src/world/level/LevelFormat';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { RouteFollower } from '../../src/player/bots/RouteFollower';
import { RunState } from '../../src/engine/runState';
import type { GameEvent, RunEvent } from '../../src/engine/events';
import type { HeldItemId } from '../../src/engine/settingsTypes';
import { PROP_FACTORIES } from '../../src/ui/hand/ViewHand';
import type { PropControl } from '../../src/ui/hand/propTricks';
import { PhoneTricks } from '../../src/ui/hand/phoneTricks';
import { resumeIndex } from '../levels/physics';
import { buildLevel1 } from '../levels/level1';
import { buildLevel2 } from '../levels/level2';
import { buildLevel3 } from '../levels/level3';
import { buildLevel4 } from '../levels/level4';

interface Model {
  readonly name: string;
  readonly sync?: number;
  readonly aimNoiseDeg?: number;
}

const MODELS: readonly Model[] = [
  { name: 'sync1.0', sync: 1 },
  { name: 'Hand 1.5°', aimNoiseDeg: 1.5 },
];
const FRAME = 1 / 60;
const SURF_FROM = 500;
/** Game: Ergebnis-Menü so lange nach dem Ziel (Ausrollen). */
const FINISH_MENU_DELAY = 1.1;
const LEVELS: { readonly [id: string]: () => LevelFile } = { level1: buildLevel1, level2: buildLevel2, level3: buildLevel3, level4: buildLevel4 };

/** Grenzen (Plan 007 KI1/KI5/KI8, Review Phase 2). Plan-006-Gegenstände: nur Warnung. */
const PLAN006: readonly HeldItemId[] = ['can', 'card', 'knife'];
const BAND_LEVELS: readonly string[] = ['level1', 'level2'];
const SHARE_MIN = 25;
const SHARE_MAX = 45;
const RATE_MIN = 20;
const RATE_MAX = 32;
const SURF_COVER_MIN = 80;
/** Surf-Abdeckung erst ab so viel Surf ≥ 500 u/s (s) prüfen — darunter entscheiden einzelne Frames. */
const SURF_COVER_FROM = 3;
const TOP_MAX = 50;
/** Abwechslung erst ab so vielen Starts prüfen (L3: 5–15 Starts, dort zählt ein einzelner Trick doppelt). */
const TOP_FROM = 20;

interface Stats {
  busy: number;
  /** Zeit in Zustands-Tricks (Surf-Balance …) — dort ist kein Platz für Tricks. */
  state: number;
  starts: Record<string, number>;
  surfFast: number;
  surfShown: number;
  /** Einlagen im Zustand (PropControl.flourishes, Zähler). */
  flourishes: number;
  /** Ziele, in deren Frame ein Ziel-Trick startete; Ziel-Tricks nach Namen; Handy: Auslöser vor dem Ergebnis. */
  finishReact: number;
  finishTricks: Record<string, number>;
  photos: number;
  photoAt: number[];
}

interface Slot {
  readonly item: HeldItemId;
  readonly prop: PropControl;
  readonly s: Stats;
}

interface Global {
  time: number;
  surf: number;
  finishes: number;
  deaths: number;
}

const args = process.argv.slice(2);
/** Wert einer Option (--name=wert oder --name wert). */
function option(name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
}
const levelArg = args.find((a) => a.startsWith('--levels'));
const seedCount = Number(option('--seeds') ?? 3);
if (!(seedCount >= 1)) throw new Error('event-probe: --seeds braucht eine Zahl ≥ 1');
const SEEDS = Array.from({ length: Math.floor(seedCount) }, (_, i) => i + 1);
const levelIds = levelArg ? (option('--levels') ?? '').split(',').filter((x) => x.length > 0) : Object.keys(LEVELS);
for (const id of levelIds) if (!LEVELS[id]) throw new Error(`event-probe: unbekanntes Level ${id} (bekannt: ${Object.keys(LEVELS).join(', ')})`);
const requested = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && (args[i - 1] === '--levels' || args[i - 1] === '--seeds')));
const ITEMS = (Object.keys(PROP_FACTORIES) as HeldItemId[]).filter((i) => PROP_FACTORIES[i] !== undefined && (requested.length === 0 || requested.includes(i)));
const complete = requested.length === 0 && levelArg === undefined && seedCount === 3;

function makeSlots(): Slot[] {
  const out: Slot[] = [];
  for (const item of ITEMS) {
    const make = PROP_FACTORIES[item];
    if (make) out.push({ item, prop: make(), s: { busy: 0, state: 0, starts: {}, surfFast: 0, surfShown: 0, flourishes: 0, finishReact: 0, finishTricks: {}, photos: 0, photoAt: [] } });
  }
  return out;
}

function runOnce(level: CompiledLevel, m: Model, seed: number, slots: Slot[], g: Global): void {
  const cfg = VELOCITY_DEFAULT;
  const route = level.def.route ?? [];
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const runEvents: RunEvent[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const place = (p: Vector3): void => pm.teleport(new Vector3(p.x, p.y + 1, p.z));
  const follower = (from: number, start: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, { sync: m.sync, aimNoiseDeg: m.aimNoiseDeg, seed, killY: level.def.killY, world: level.world, start: { x: start.x, z: start.z }, stallTimeout: 12, timeout: 181 });
  place(level.spawnPos);
  let bot = follower(0, level.spawnPos);
  const dt = 1 / cfg.tickRate;
  let acc = 0;
  const inp = { speed: 0, onGround: true, surfing: false, surfSide: 0 };
  // Nach dem Ziel: Sekunden seit dem Ziel (−1 = läuft noch), Auslöser-Stand des Handys beim Ziel.
  let after = -1;
  const shutter0 = new Map<Slot, number>();
  const deliver = (e: GameEvent): void => {
    for (const sl of slots) {
      const before = sl.prop.trick;
      sl.prop.onEvent(e);
      const now = sl.prop.trick;
      if (after < 0 && now !== before && now !== 'none' && !sl.prop.inState) sl.s.starts[now] = (sl.s.starts[now] ?? 0) + 1;
    }
  };
  for (let t = 0; t < 185 * cfg.tickRate; t++) {
    const evs = pm.tick(bot.next(pm.state, pm.surfNormal));
    const s = pm.state;
    if (after < 0) {
      for (const e of evs) deliver(e);
      const out = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, runEvents);
      for (const e of runEvents) deliver(e);
      if (out === 'finish') {
        g.finishes++;
        for (const sl of slots) if (sl.prop instanceof PhoneTricks) shutter0.set(sl, sl.prop.shutterCount);
        // Ziel-Trick nicht in starts (eigene Spalte 'Ziel', unten wieder zu Tricks/min addiert): after vor dem Event.
        after = 0;
        deliver({ type: 'finish', time: run.time ?? 0, best: false, previousBest: null });
      } else if (out === 'fall' || out === 'kill') {
        g.deaths++;
        if (run.checkpoint === 0) run.reset(null);
        const sp = run.respawnPoint();
        place(sp.pos);
        deliver({ type: 'respawn', reason: 'fall' });
        const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
        bot = follower(from, sp.pos);
        continue;
      } else if (bot.status === 'failed') return;
    }
    acc += dt;
    while (acc >= FRAME) {
      acc -= FRAME;
      inp.speed = s.speed;
      inp.onGround = s.onGround;
      inp.surfing = s.surfing;
      if (after >= 0) {
        // Ausrollen nach dem Ziel (wie Game bis zum Ergebnis): nur die Ziel-Reaktion messen.
        const first = after === 0;
        for (const sl of slots) {
          sl.prop.update(FRAME, inp);
          if (first && sl.prop.trick !== 'none' && sl.prop.trickTime === 0) {
            sl.s.finishReact++;
            sl.s.finishTricks[sl.prop.trick] = (sl.s.finishTricks[sl.prop.trick] ?? 0) + 1;
          }
          const p = sl.prop;
          if (p instanceof PhoneTricks && p.shutterCount > (shutter0.get(sl) ?? 0)) {
            sl.s.photos++;
            sl.s.photoAt.push(Math.round(after * 1000) / 1000);
            shutter0.set(sl, Number.POSITIVE_INFINITY);
          }
        }
        after += FRAME;
        if (after > FINISH_MENU_DELAY + 1e-9) return;
        continue;
      }
      g.time += FRAME;
      if (s.surfing) g.surf += FRAME;
      for (const sl of slots) {
        const before = sl.prop.trick;
        const fl = sl.prop.flourishes;
        sl.prop.update(FRAME, inp);
        const now = sl.prop.trick;
        sl.s.flourishes += sl.prop.flourishes - fl;
        // Leerlauf-Tricks und Zustände starten im update (nicht über Events).
        if (now !== before && now !== 'none' && !sl.prop.inState) sl.s.starts[now] = (sl.s.starts[now] ?? 0) + 1;
        if (sl.prop.trick !== 'none' && !sl.prop.inState) sl.s.busy += FRAME;
        if (sl.prop.inState) sl.s.state += FRAME;
        if (s.surfing && s.speed >= SURF_FROM) {
          sl.s.surfFast += FRAME;
          if (sl.prop.inState) sl.s.surfShown += FRAME;
        }
      }
    }
  }
}

const pct = (a: number, b: number): number => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);
const perMin = (n: number, seconds: number): number => (seconds > 0 ? Math.round(((n * 60) / seconds) * 10) / 10 : 0);
const report: Record<string, unknown> = {};
const table: string[] = [];
/** Verstöße (Plan 007 → Exit 1) und Warnungen (Plan 006). */
const fails: string[] = [];
const warns: string[] = [];
for (const id of levelIds) {
  const level = compileLevel(LEVELS[id]());
  for (const m of MODELS) {
    const slots = makeSlots();
    const g: Global = { time: 0, surf: 0, finishes: 0, deaths: 0 };
    for (const seed of SEEDS) {
      for (const sl of slots) sl.prop.reset();
      runOnce(level, m, seed, slots, g);
    }
    const min = g.time / 60;
    const props: Record<string, unknown> = {};
    for (const sl of slots) {
      const n = Object.values(sl.s.starts).reduce((a, b) => a + b, 0);
      const top = Object.entries(sl.s.starts).sort((a, b) => b[1] - a[1])[0];
      const phone = sl.prop instanceof PhoneTricks;
      const free = g.time - sl.s.state;
      const row = {
        busyShare: pct(sl.s.busy, g.time),
        /** Anteil an der Zeit OHNE Zustände (vergleichbar mit Gegenständen ohne Surf-Zustand) — geprüft. */
        busyShareFree: pct(sl.s.busy, free),
        /** Starts ohne Ziel-Trick je Minute ohne Zustände — geprüft (Band 20–32). */
        tricksPerMinFree: perMin(n, free),
        /** Zur Information: je Laufzeit-Minute mit Ziel-Trick (Kalibrierung bis Review Phase 2) bzw. ohne. */
        tricksPerMin: Math.round(((n + sl.s.finishReact) / min) * 10) / 10,
        tricksPerMinRun: Math.round((n / min) * 10) / 10,
        surfShown: sl.s.surfFast > 0 ? pct(sl.s.surfShown, sl.s.surfFast) : null,
        /** Trick oder Zustand sichtbar (Anteil der Laufzeit). */
        actionShare: pct(sl.s.busy + sl.s.state, g.time),
        /** Einlagen je Minute Zustandszeit (Bewegung im Surf-Zustand). */
        flourishPerMin: perMin(sl.s.flourishes, sl.s.state),
        /** Größter Anteil eines Tricks an den Starts (Abwechslung). */
        topTrick: top ? { name: top[0], share: pct(top[1], n) } : null,
        finishReact: `${sl.s.finishReact}/${g.finishes}`,
        finishTricks: sl.s.finishTricks,
        ...(phone ? { photos: `${sl.s.photos}/${g.finishes}`, photoAt: sl.s.photoAt } : {}),
        starts: sl.s.starts,
      };
      props[sl.item] = row;
      table.push(
        `${id} · ${m.name} · ${sl.item}: ${row.busyShareFree} % frei (${row.busyShare} % der Laufzeit), ${row.tricksPerMinFree} frei/min ohne Ziel-Trick` +
          ` (Laufzeit ${row.tricksPerMinRun}/min, mit Ziel-Trick ${row.tricksPerMin})` +
          `${row.surfShown !== null ? `, Surf-Zustand ${row.surfShown} %` : ''}, Aktion ${row.actionShare} %, Einlagen ${row.flourishPerMin}/min Zustand` +
          `${row.topTrick ? `, häufigster ${row.topTrick.name} ${row.topTrick.share} % von ${n}` : ''}, Ziel ${row.finishReact}${phone ? `, Foto ${sl.s.photos}/${g.finishes} (max ${Math.max(0, ...sl.s.photoAt).toFixed(2)} s)` : ''}`,
      );
      // Grenzen: Plan 007 → Verstoß, Plan 006 → Warnung.
      const sink = PLAN006.includes(sl.item) ? warns : fails;
      const where = `${id} · ${m.name} · ${sl.item}`;
      if (BAND_LEVELS.includes(id)) {
        if (row.busyShareFree < SHARE_MIN || row.busyShareFree > SHARE_MAX) sink.push(`${where}: ${row.busyShareFree} % frei (Band ${SHARE_MIN}–${SHARE_MAX})`);
        if (row.tricksPerMinFree < RATE_MIN || row.tricksPerMinFree > RATE_MAX) sink.push(`${where}: ${row.tricksPerMinFree} frei/min ohne Ziel-Trick (Band ${RATE_MIN}–${RATE_MAX})`);
      }
      if (sl.s.surfFast >= SURF_COVER_FROM && row.surfShown !== null && row.surfShown < SURF_COVER_MIN) sink.push(`${where}: Surf-Zustand ${row.surfShown} % (≥ ${SURF_COVER_MIN})`);
      if (n >= TOP_FROM && row.topTrick && row.topTrick.share > TOP_MAX) sink.push(`${where}: ${row.topTrick.name} ${row.topTrick.share} % der Starts (≤ ${TOP_MAX})`);
      if (sl.s.finishReact < g.finishes) sink.push(`${where}: Ziel-Reaktion ${row.finishReact}`);
      if (phone && sl.s.photos < g.finishes) sink.push(`${where}: Foto ${sl.s.photos}/${g.finishes}`);
    }
    report[`${id} · ${m.name}`] = { runs: SEEDS.length, finishes: g.finishes, deaths: g.deaths, seconds: Math.round(g.time * 10) / 10, surfShare: pct(g.surf, g.time), props };
  }
}
mkdirSync('shots/v2/kosmetik', { recursive: true });
const file = complete ? 'shots/v2/kosmetik/event-probe-core.json' : 'shots/v2/kosmetik/event-probe-partial.json';
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(table.join('\n'));
console.log(`→ ${file}`);
if (warns.length > 0) console.log(`Warnungen (Plan 006, abgenommen — nur Hinweis):\n  ${warns.join('\n  ')}`);
if (fails.length > 0) {
  console.log(`VERSTÖSSE (Plan 007):\n  ${fails.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('Grenzen eingehalten (Plan 007).');
