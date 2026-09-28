/**
 * Bausteine der Lektions-Maps T1–T8 (Plan 007, TC4): Umgebung, Lektions-Builder (Stufen, Zonen, Tore,
 * Portal) und der Validierungsvertrag, den tools/levels/training/check.ts je Lektion abarbeitet.
 *
 * Regeln aller Lektionen (Plan 007 §3 Trainingsmodus): kein Tod (keine Kill-Zonen, geschlossene
 * Räume mit Banden ≥ 128 u — Crouch-Jump reicht bis ~81), kein Timer, mindestens ein Tor, am Ende ein
 * Portal (finish-Trigger hinter dem Ausgangstor). Maße in u, Spawn-Blick −Z (yaw 0).
 */
import type { Vector3 } from 'three';
import type { TrainingSession } from '../../../src/engine/Training';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../../../src/player/types';
import type { CollisionWorld } from '../../../src/world/collision/types';
import type { CompiledLevel } from '../../../src/world/level/compileLevel';
import type { GateDef, LevelFile, StageDef, TrainingDef, TrainingGroup, TrainingZoneDef } from '../../../src/world/level/LevelFormat';
import { Frame, LevelBuilder, r3 } from '../lib';
import type { V3 } from '../lib';

/** Farben der Lektionen (Trims, Markierungen, Tore). */
export const TC = {
  cyan: '#33f0ff',
  magenta: '#ff3fd0',
  amber: '#ffb347',
  lime: '#9dff5c',
  violet: '#9a6bff',
  white: '#e8f4ff',
} as const;

/** Grundlagen T1–T4: nächtliche Trainingshalle, Cyan. */
export const ENV_BASICS: LevelFile['environment'] = {
  skyTop: '#060a24',
  skyHorizon: '#1d3f7a',
  skyBottom: '#070b1f',
  fogColor: '#16305e',
  fogNear: 1800,
  fogFar: 9000,
  sunDir: [0.35, 0.55, -0.75],
  sunColor: '#d6ecff',
  ambientSky: '#4a6ad0',
  ambientGround: '#141a3a',
  trimColor: TC.cyan,
  trimColorAlt: TC.magenta,
  voidY: -1400,
};

/** Fortgeschritten T5–T8: violette Dämmerung, Magenta. */
export const ENV_ADVANCED: LevelFile['environment'] = {
  skyTop: '#12061f',
  skyHorizon: '#6a2a8a',
  skyBottom: '#10061c',
  fogColor: '#3a1655',
  fogNear: 1800,
  fogFar: 10000,
  sunDir: [-0.3, 0.5, -0.8],
  sunColor: '#ffd0f0',
  ambientSky: '#6a4ac0',
  ambientGround: '#1d0f2e',
  trimColor: TC.magenta,
  trimColorAlt: TC.cyan,
  voidY: -2600,
};

export interface LessonMeta {
  readonly id: string;
  /** Anzeigename ohne Kürzel, z. B. "AIR-STRAFE" (HUD-Karte: "T3 · AIR-STRAFE"). */
  readonly name: string;
  readonly subtitle: string;
  readonly lesson: number;
  readonly group: TrainingGroup;
  readonly killY: number;
  readonly environment: LevelFile['environment'];
  readonly turnBand?: boolean;
}

const rv = (v: V3): V3 => [r3(v[0]), r3(v[1]), r3(v[2])];

/** Quersteg der Surf-Lektionen (z-Bereich südlich der Rampe): Plattformen enden an [0], die Nische beginnt an [1]. */
export const STEG_Z: readonly [number, number] = [1920, 2200];

/** LevelBuilder plus Trainings-Teil (Zonen, Tore, Stufen). */
export class LessonBuilder {
  readonly L: LevelBuilder;
  private readonly zones: TrainingZoneDef[] = [];
  private readonly gates: GateDef[] = [];
  private readonly stages: StageDef[] = [];

  constructor(readonly meta: LessonMeta) {
    this.L = new LevelBuilder({ id: meta.id, name: meta.name, subtitle: meta.subtitle, killY: meta.killY, environment: meta.environment, music: { bpm: 132 } });
  }

  zone(id: string, min: V3, max: V3): void {
    this.zones.push({ id, min: rv(min), max: rv(max) });
  }

  /** Tor (kollidiert bis offen); Optik baut der Renderer aus CompiledLevel.gates. */
  gate(id: string, min: V3, max: V3, tint?: string): void {
    this.gates.push({ id, min: rv(min), max: rv(max), ...(tint ? { tint } : {}) });
  }

  stage(s: StageDef): void {
    this.stages.push(s);
  }

  /** Geschlossener Raum: vier Banden um [x0,x1]×[z0,z1], Oberkante y1. */
  walls(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, t = 64, tag = 'bande'): void {
    this.L.box([x0 - t, y0, z0 - t], [x1 + t, y1, z0], { mat: 'wall', tag: `${tag}-n` });
    this.L.box([x0 - t, y0, z1], [x1 + t, y1, z1 + t], { mat: 'wall', tag: `${tag}-s` });
    this.L.box([x0 - t, y0, z0], [x0, y1, z1], { mat: 'wall', tag: `${tag}-w` });
    this.L.box([x1, y0, z0], [x1 + t, y1, z1], { mat: 'wall', tag: `${tag}-o` });
  }

  /** Portal: finish-Trigger (Ergebnis) und Leucht-Bogen, Blick durch den Bogen in Richtung −Z. */
  portalZ(x: number, z: number, floorY: number, width: number, tint: string): void {
    this.L.finishZone([x - width / 2, floorY, z - 64], [x + width / 2, floorY + 200, z + 64]);
    this.L.decoBox([x - width / 2 - 32, floorY, z - 16], [x - width / 2, floorY + 224, z + 16], { mat: 'dark' });
    this.L.decoBox([x + width / 2, floorY, z - 16], [x + width / 2 + 32, floorY + 224, z + 16], { mat: 'dark' });
    this.L.decoBox([x - width / 2 - 32, floorY + 224, z - 16], [x + width / 2 + 32, floorY + 256, z + 16], { mat: 'light', tint });
  }

  /** Portal quer zu X (Nische nach Osten/Westen): finish-Trigger über die Breite entlang z, Leucht-Bogen. */
  portalX(x: number, z: number, floorY: number, width: number, tint: string): void {
    this.L.finishZone([x - 64, floorY, z - width / 2], [x + 64, floorY + 200, z + width / 2]);
    this.L.decoBox([x - 16, floorY, z - width / 2 - 32], [x + 16, floorY + 224, z - width / 2], { mat: 'dark' });
    this.L.decoBox([x - 16, floorY, z + width / 2], [x + 16, floorY + 224, z + width / 2 + 32], { mat: 'dark' });
    this.L.decoBox([x - 16, floorY + 224, z - width / 2 - 32], [x + 16, floorY + 256, z + width / 2 + 32], { mat: 'light', tint });
  }

  /**
   * Südende einer Surf-Lektion (T7/T8): Startplattform(en) östlich (und westlich) des Firsts von z = 0 bis zum
   * Quersteg, begehbare Rampe vom Auffangboden zurück hinauf, Quersteg, und dahinter (Süden) die Portal-Nische
   * hinter dem Tor 'ausgang'. Die Südbande hat dort ihre Öffnung. Gibt die Route-Knoten Portal → Quersteg
   * zurück (die Route berührt so das Ziel, bevor sie zur Plattform läuft).
   */
  surfSouth(o: {
    readonly platY: number;
    readonly platX: readonly [number, number];
    readonly west: boolean;
    readonly pitAt: (s: number) => number;
    readonly half: number;
    readonly low: number;
    readonly wallTop: number;
  }): { readonly portal: V3; readonly steg: V3 } {
    const L = this.L;
    const f = Frame.at([0, 0], 0);
    const [x0, x1] = o.platX;
    const t = 64;
    const niche = 192;
    L.box([x0, o.platY - 64, 0], [x1, o.platY, STEG_Z[0]], { mat: 'start', tag: 'start-ost' });
    if (o.west) L.box([-x1, o.platY - 64, 0], [-x0, o.platY, STEG_Z[0]], { mat: 'start', tag: 'start-west' });
    // Rückweg: ≈ 20° vom Auffangboden (z 500) hinauf bis an den Quersteg.
    L.ramp(f, [-STEG_Z[0], -500], [x1 + 32, x1 + 352], o.platY, o.pitAt(-500) + 8, { tag: 'rueckweg' });
    // Quersteg über die ganze Breite von Plattform(en) und Nische: die Nische hängt immer daran.
    L.box([o.west ? -x1 : -niche, o.platY - 64, STEG_Z[0]], [x1 + 352, o.platY, STEG_Z[1]], { tag: 'quersteg' });
    // Südbande mit Öffnung, Nische dahinter (Seitenwände hinter der Bande: keine koplanaren Flächen).
    L.box([-o.half - t, o.low, STEG_Z[1]], [-niche, o.wallTop, STEG_Z[1] + t], { mat: 'wall', tag: 'bande-s1' });
    L.box([niche, o.low, STEG_Z[1]], [o.half + t, o.wallTop, STEG_Z[1] + t], { mat: 'wall', tag: 'bande-s2' });
    const back = STEG_Z[1] + 420;
    L.box([-niche, o.platY - 64, STEG_Z[1]], [niche, o.platY, back], { tag: 'nische' });
    L.box([-niche - t, o.platY - 64, STEG_Z[1] + t], [-niche, o.wallTop, back + t], { mat: 'wall', tag: 'nische-w' });
    L.box([niche, o.platY - 64, STEG_Z[1] + t], [niche + t, o.wallTop, back + t], { mat: 'wall', tag: 'nische-o' });
    L.box([-niche, o.platY - 64, back], [niche, o.wallTop, back + t], { mat: 'wall', tag: 'nische-s' });
    this.gate('ausgang', [-niche, o.platY, STEG_Z[1]], [niche, o.wallTop, STEG_Z[1] + 24], TC.amber);
    this.portalZ(0, STEG_Z[1] + 300, o.platY, 256, TC.lime);
    return { portal: [0, o.platY, STEG_Z[1] + 300], steg: [x0 + 32, o.platY, (STEG_Z[0] + STEG_Z[1]) / 2] };
  }

  build(): LevelFile {
    const m = this.meta;
    const training: TrainingDef = {
      lesson: m.lesson,
      short: `T${m.lesson}`,
      group: m.group,
      ...(this.zones.length ? { zones: this.zones } : {}),
      ...(this.gates.length ? { gates: this.gates } : {}),
      stages: this.stages,
      hud: { forceKeys: true, ...(m.turnBand ? { turnBand: true } : {}) },
    };
    const base = this.L.build();
    const route = base.route && base.route.length > 0 ? { route: base.route } : {};
    const { route: _r, ...rest } = base;
    void _r;
    return { ...rest, ...route, training };
  }
}

// ---------------------------------------------------------------- Validierungsvertrag

/** Eingabe je Tick; bekommt den Live-Zustand (wie Game: pm.state) und die Surf-Normale. */
export interface Driver {
  next(s: PlayerSnapshot, surfNormal: Vector3, session: TrainingSession): PlayerInput;
}

export interface DriverContext {
  readonly level: CompiledLevel;
  readonly cfg: MovementConfig;
  /** Kollisionswelt des Laufs (GatedWorld mit den Toren) — Landevorhersage der Bots. */
  readonly world: CollisionWorld;
  readonly seed: number;
  /** Stufen-Spawn (Füße, yaw °). */
  readonly spawn: { readonly pos: Vector3; readonly yaw: number };
}

/**
 * Eine Zeile der Bot-Matrix: Modell `model` spielt ab Stufe `from` (Stufen-Spawn, vorige Tore offen)
 * bis Stufe `to` (inklusive) erledigt ist — oder `seconds` vorbei sind. Erwartet: mindestens `min`
 * bzw. höchstens `max` von `seeds` Läufen bestanden. `level` = Schwere bei Verfehlen.
 */
export interface MatrixRow {
  readonly model: string;
  readonly from: string;
  readonly to?: string;
  readonly make: (ctx: DriverContext) => Driver;
  readonly expect: { readonly min: number } | { readonly max: number };
  readonly level: 'error' | 'warning' | 'info';
  readonly seconds?: number;
  readonly seeds?: number;
  /** Urteile des Judge mitzählen und ausgeben. */
  readonly verdicts?: boolean;
}

export interface LessonCheck {
  readonly rows: readonly MatrixRow[];
  /** Zusätzliche Proben (Diagnose-Treffsicherheit, Fenster-Raster …) — Zeilen für den Bericht. */
  readonly extra?: (level: CompiledLevel, cfg: MovementConfig) => { readonly errors: string[]; readonly warnings: string[]; readonly info: string[] };
}

export interface LessonEntry {
  readonly id: string;
  readonly build: () => LevelFile;
  readonly check: LessonCheck;
}
