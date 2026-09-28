/**
 * Movement-Sim (`npm run sim`): Bots vergleichen, Sprungweiten, Boden-Werte,
 * Level-Durchläufe. Ausgabe als Markdown auf stdout — direkt in
 * .docs/research/movement-tuning.md kopierbar.
 *
 *   npm run sim
 *   npm run sim -- --preset cs2
 *   npm run sim -- --sweep airSpeedCap=14,16.5,20,30
 *   npm run sim -- --level public/levels/sandbox.json
 *   npm run sim -- --section arcade      (nur der Arcade-Pass, Plan 007)
 */
import { MOVEMENT_PRESETS, withMovement, type MovementConfig, type MovementPresetId, type NumericMovementKey } from '../src/player/MovementConfig';
import { runRoute } from '../src/player/bots';
import { compileLevel } from '../src/world/level/compileLevel';
import { arcadeSection } from './sim/arcade';
import { readLevelFile } from './sim/levels';
import { BOT_LABELS, groundStats, hopRun, jumpDistance, standingHop, surfRun, type BotKind } from './sim/scenarios';

interface Args {
  preset: MovementPresetId;
  sweep: { key: NumericMovementKey; values: number[] } | null;
  level: string | null;
  /** Nur diesen Abschnitt (derzeit 'arcade'). */
  section: 'arcade' | null;
}

function isPreset(v: string): v is MovementPresetId {
  return v in MOVEMENT_PRESETS;
}

function isNumericKey(base: MovementConfig, k: string): k is NumericMovementKey {
  return k in base && typeof base[k as keyof MovementConfig] === 'number';
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { preset: 'velocity', sweep: null, level: null, section: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} braucht einen Wert`);
      return v;
    };
    if (a === '--preset') {
      const p = val();
      if (!isPreset(p)) throw new Error(`Unbekanntes Preset "${p}" (${Object.keys(MOVEMENT_PRESETS).join('|')})`);
      args.preset = p;
    } else if (a === '--sweep') {
      const spec = val();
      const [key, list] = spec.split('=');
      const base = MOVEMENT_PRESETS[args.preset];
      if (!key || !list || !isNumericKey(base, key)) {
        const keys = Object.keys(base).filter((k) => isNumericKey(base, k));
        throw new Error(`--sweep key=v1,v2 — key muss numerisch sein: ${keys.join(', ')}`);
      }
      const values = list.split(',').map(Number);
      if (values.some((v) => !Number.isFinite(v))) throw new Error(`--sweep: ungültige Zahl in "${list}"`);
      args.sweep = { key, values };
    } else if (a === '--level') {
      args.level = val();
    } else if (a === '--section') {
      const v = val();
      if (v !== 'arcade') throw new Error(`--section: nur "arcade" (war "${v}")`);
      args.section = v;
    } else {
      throw new Error(`Unbekanntes Argument ${a}`);
    }
  }
  return args;
}

function setNumeric(base: MovementConfig, key: NumericMovementKey, value: number): MovementConfig {
  const patch: Partial<Record<NumericMovementKey, number>> = {};
  patch[key] = value;
  return withMovement(base, patch);
}

const f0 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(0));
const f2 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2));
const f3 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(3));

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

const BOTS: readonly BotKind[] = ['perfect', 'sync85', 'sync70', 'aim2', 'aim3', 'rate150', 'naive'];
/** Menschenmodell-Vergleich (absolute Fehler) zwischen Presets. */
const HUMAN_BOTS: readonly BotKind[] = ['perfect', 'human', 'rate250', 'rate150', 'aim1', 'aim2', 'aim3', 'aim4', 'sync85', 'sync70', 'naive'];
const HOP_ROWS = Array.from({ length: 20 }, (_, i) => i + 1);
const TAKEOFF = [250, 320, 400, 500, 600, 800, 1000];
const HEIGHTS = [48, 32, 0, -64, -128, -256];

function configSection(cfg: MovementConfig, name: string): string {
  const keys: Array<keyof MovementConfig> = [
    'tickRate', 'gravity', 'jumpImpulse', 'runSpeed', 'sprintSpeed', 'duckSpeedScale', 'accelerate', 'airAccelerate',
    'airSpeedCap', 'airSpeedCapLow', 'airSpeedCapFadeFrom', 'airSpeedCapFadeTo', 'strafeAssist', 'friction', 'stopSpeed',
    'maxVelocity', 'stepSize', 'nonJumpVelocity', 'coyoteTime', 'jumpBufferTime', 'autoHop', 'autoHopSpeedShare',
    'autoHopGroundTime', 'autoHopLandShare', 'autoHopLandAirTime', 'duckTime',
  ];
  // Arcade-Pass (Plan 007): Hauptschalter und Rutsch-/Lenk-Werte als eigene Zeile.
  const arcade: Array<keyof MovementConfig> = [
    'landGraceTime', 'slopeLandGain', 'surfSeamFix', 'ledgeStep', 'ledgeMemory', 'slideMinSpeed', 'slideExitSpeed',
    'slideFriction', 'slideDecel', 'slideBoost', 'slideBoostCap', 'slideSteerRate', 'airControl', 'airControlHigh', 'airControlSurfGrace',
  ];
  return `## Konfiguration: ${name}\n\n` + table(['Wert', ...keys.map(String)], [['', ...keys.map((k) => String(cfg[k]))]]) +
    '\n\n' + table(['Arcade', ...arcade.map(String)], [['', ...arcade.map((k) => String(cfg[k]))]]);
}

function hopSection(cfg: MovementConfig): string {
  const runs = new Map(BOTS.map((b) => [b, hopRun(cfg, b)] as const));
  const rows = HOP_ROWS.map((h) => [String(h), ...BOTS.map((b) => f0(runs.get(b)?.landSpeeds[h - 1]))]);
  const out: string[] = [];
  out.push('## Flacher Boden: Speed (u/s) bei Landung nach Hop n\n');
  out.push('Start am Boden mit runSpeed Richtung -Z, Sprung gehalten (autoHop bzw. Flanke), Kurs halten. Bots mit Zufall: Mittel über 5 Seeds.\n');
  out.push('Strafe 0.85/0.7: Fehler relativ zum Gewinnfenster (HUD-Sync nachgestellt). Zielfehler n°: absoluter, zeitlich korrelierter Winkelfehler. konst. 150°/s: Blick dreht mit fester Rate.\n');
  out.push(table(['Hop', ...BOTS.map((b) => BOT_LABELS[b])], rows));
  out.push('\n### 10 s Bhop\n');
  out.push(table(
    ['Bot', 'Ø gemessener Sync', 'Luftlinie 10 s (u)', 'Weg 10 s (u)', 'Ø Speed (u/s)', 'Speed nach 10 s'],
    BOTS.map((b) => {
      const r = runs.get(b);
      return [BOT_LABELS[b], f2(r?.avgSync), f0(r?.dist10), f0(r?.path10), f0(r ? r.path10 / 10 : null), f0(r?.speed10)];
    }),
  ));
  return out.join('\n');
}

/** Gleiche Hand, zwei Presets: absolute Fehler wirken unabhängig vom Gewinnfenster ±cap/|v|. */
function humanSection(cfg: MovementConfig, name: string, other: MovementConfig, otherName: string): string {
  const cells = (c: MovementConfig, b: BotKind): string[] => {
    const r = hopRun(c, b);
    return [f0(r.landSpeeds[4]), f0(r.landSpeeds[9]), f0(r.landSpeeds[19]), f2(r.avgSync)];
  };
  return `## Menschenmodell: ${name} gegen ${otherName}\n\n` +
    'Speed bei Landung nach Hop 5/10/20 und gemessener Sync (Gewinn-Ticks/Strafe-Ticks). Absolute Fehler (Grad, Drehrate) sind der faire Vergleich zwischen Presets.\n\n' +
    table(
      ['Bot', `${name} H5`, 'H10', 'H20', 'Sync', `${otherName} H5`, 'H10', 'H20', 'Sync'],
      HUMAN_BOTS.map((b) => [BOT_LABELS[b], ...cells(cfg, b), ...cells(other, b)]),
    );
}

function jumpSection(cfg: MovementConfig): string {
  const out: string[] = [];
  const head = ['Absprung u/s', ...HEIGHTS.map((h) => `${h > 0 ? '+' : ''}${h}`)];
  for (const crouch of [false, true]) {
    out.push(`## Sprungweiten${crouch ? ' mit Crouch-Jump' : ''} (u, Origin, ohne Luft-Strafe)\n`);
    out.push('Horizontale Distanz vom Absprung bis die Füße die Zielhöhe kreuzen. Max. Lücke Kante-zu-Kante = Distanz + 32 (Hull-Breite).\n');
    const rows = TAKEOFF.map((v) => [
      String(v),
      ...HEIGHTS.map((h) => {
        const d = jumpDistance(cfg, v, h, crouch);
        return d === null ? '–' : `${d.toFixed(0)} (${(d + 2 * cfg.hull.halfWidth).toFixed(0)})`;
      }),
    ]);
    out.push(table(head, rows));
    out.push('');
  }
  return out.join('\n');
}

function groundSection(cfg: MovementConfig): string {
  const g = groundStats(cfg);
  const naive = (sprint: boolean, press: boolean): string[] => {
    const r = standingHop(cfg, sprint, press);
    return [
      `Naive aus dem Stand (W${sprint ? '+Shift' : ''}+Space ab t=0${press ? ', frisch gedrückt' : ' gehalten'}), 2 s`,
      `${f0(r.dist2)} u, Dauertempo ${f0(r.speed2)} u/s, 1. Sprung nach ${f3(r.firstJump)} s`,
    ];
  };
  return '## Boden & Sprung\n\n' + table(['Messung', 'Wert'], [
    naive(false, false),
    naive(true, false),
    naive(false, true),
    naive(true, true),
    [`0 → runSpeed (${cfg.runSpeed})`, `${f3(g.toRun)} s`],
    [`0 → sprintSpeed (${cfg.sprintSpeed})`, `${f3(g.toSprint)} s`],
    [`Stopp runSpeed → < 10 u/s`, `${f3(g.stopRunTo10)} s`],
    [`Stopp runSpeed → 0`, `${f3(g.stopRunTo0)} s (${f0(g.stopRunDist)} u Bremsweg)`],
    [`Stopp sprintSpeed → < 10 u/s`, `${f3(g.stopSprintTo10)} s`],
    ['Geduckt gehen', `${f0(g.duckSpeed)} u/s`],
    ['Sprunghöhe (Füße)', `${f2(g.jumpHeight)} u`],
    ['Crouch-Jump (Füße)', `${f2(g.crouchJumpFeet)} u`],
    ['Luftzeit flach', `${f3(g.airTime)} s`],
  ]);
}

function surfSection(cfg: MovementConfig): string {
  const rows = [false, true].map((hold) => {
    const r = surfRun(cfg, hold);
    return [hold ? 'A in die Rampe, Blick entlang' : 'ohne Eingabe', f0(r.speeds[0]), f0(r.speeds[1]), f0(r.speeds[2]), `${f0(r.drop)} u`, r.onRampAtEnd ? 'ja' : 'nein'];
  });
  return '## Surf (Flanke normal.y ≈ 0.54, Start 400 u/s in der Luft über der Flanke)\n\n' + table(
    ['Eingabe', 'nach 1 s', 'nach 2 s', 'nach 3 s', 'Höhe verloren', 'noch auf Rampe'],
    rows,
  );
}

function levelSection(cfg: MovementConfig, path: string): string {
  const level = compileLevel(readLevelFile(path));
  const out: string[] = [`## Level ${level.def.name} (${path})\n`];
  if (!level.def.route || level.def.route.length === 0) {
    out.push('Keine Route im Level — nichts zu fahren.');
    return out.join('\n');
  }
  for (const sync of [1.0, 0.8]) {
    const r = runRoute(level, cfg, { sync, seed: 11 });
    out.push(`### RouteFollower sync ${sync.toFixed(1)}: **${r.status}**${r.reason ? ` (${r.reason})` : ''} — ${f2(r.time)} s, ${r.reached}/${r.total} Knoten, max ${f0(r.maxSpeed)} u/s, Ziel-Trigger ${r.touchedFinish ? 'ja' : 'nein'}${level.def.parTime ? `, Par ${level.def.parTime} s` : ''}\n`);
    out.push(table(
      ['Knoten', 'Notiz', 'Zeit (s)', 'Speed', 'minSpeed', ''],
      r.nodes.map((n) => [String(n.index), n.note ?? '', f2(n.time), f0(n.speed), n.minSpeed === null ? '' : f0(n.minSpeed), n.belowMinSpeed ? 'ZU LANGSAM' : '']),
    ));
    if (r.status === 'failed') out.push(`\nGescheitert bei (${f0(r.endPos.x)}, ${f0(r.endPos.y)}, ${f0(r.endPos.z)}) vor Knoten ${r.reached}.`);
    out.push('');
  }
  return out.join('\n');
}

function sweepSection(base: MovementConfig, key: NumericMovementKey, values: readonly number[]): string {
  const rows = values.map((v) => {
    const cfg = setNumeric(base, key, v);
    const p = hopRun(cfg, 'perfect');
    const s85 = hopRun(cfg, 'sync85');
    const s70 = hopRun(cfg, 'sync70');
    const hu = hopRun(cfg, 'human');
    const a2 = hopRun(cfg, 'aim2');
    const a3 = hopRun(cfg, 'aim3');
    const r150 = hopRun(cfg, 'rate150');
    const nv = hopRun(cfg, 'naive', 10);
    const g = groundStats(cfg);
    const surf = surfRun(cfg, false);
    const flatGap400 = jumpDistance(cfg, 400, 0, false);
    return [
      String(v),
      f0(p.landSpeeds[4]), f0(p.landSpeeds[9]), f0(p.landSpeeds[19]),
      f0(s85.landSpeeds[9]), f0(s70.landSpeeds[9]), f0(a2.landSpeeds[9]), f0(a3.landSpeeds[9]), f0(r150.landSpeeds[9]), f0(hu.landSpeeds[9]), f0(nv.landSpeeds[9]),
      f3(g.toRun), f3(g.stopRunTo10), f2(g.jumpHeight), f3(g.airTime),
      flatGap400 === null ? '–' : f0(flatGap400 + 2 * cfg.hull.halfWidth),
      `${f0(surf.speeds[2])}${surf.onRampAtEnd ? '' : ' (ab)'}`,
    ];
  });
  return `## Sweep ${key}\n\n` + table(
    [key, 'Perf H5', 'Perf H10', 'Perf H20', '0.85 H10', '0.7 H10', '2° H10', '3° H10', '150°/s H10', '300°/s H10', 'Naive H10', '0→run s', 'Stopp s', 'Sprung u', 'Luft s', 'Lücke @400', 'Surf 3 s'],
    rows,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const base = MOVEMENT_PRESETS[args.preset];
  const parts: string[] = [`# VELOCITY Movement-Sim (Preset: ${args.preset})\n`];
  if (args.section === 'arcade') {
    parts.push(arcadeSection(base));
  } else if (args.sweep) {
    parts.push(sweepSection(base, args.sweep.key, args.sweep.values));
  } else {
    parts.push(configSection(base, args.preset));
    parts.push(hopSection(base));
    const otherId: MovementPresetId = args.preset === 'cs2' ? 'velocity' : 'cs2';
    parts.push(humanSection(base, args.preset, MOVEMENT_PRESETS[otherId], otherId));
    parts.push(groundSection(base));
    parts.push(surfSection(base));
    parts.push(jumpSection(base));
    // Arcade-Pass nur, wo er an ist (CS2 hat alle Schalter aus — die Tabelle wäre leer).
    if (base.landGraceTime > 0 || base.slideMinSpeed > 0 || base.ledgeStep > 0 || base.airControl > 0) parts.push(arcadeSection(base));
  }
  if (args.level) parts.push(levelSection(base, args.level));
  process.stdout.write(parts.join('\n\n') + '\n');
}

main();
