import type { GameEvent } from '../engine/events';

/** Was das Spiel der Musik pro Frame mitteilt. Die Audio-Engine glättet selbst. */
export interface MusicDrive {
  /** Horizontale Geschwindigkeit, u/s. Laufen = 250, guter Bhop 400–700, Surf 1000+. */
  readonly speed: number;
  readonly onGround: boolean;
  readonly hopChain: number;
  /** 0..1 Strafe-Sync (siehe PlayerSnapshot). */
  readonly strafeSync: number;
  readonly airTime: number;
  readonly surfing: boolean;
  /**
   * false in Menü/Pause/Ergebnis — Pause: dumpf gefiltert, nicht stumm. Nach
   * einem 'finish' gilt false als Ergebnis-Zustand: die Musik spielt ihr Outro
   * und filtert erst nach ca. 4 Takten weich (bis 'respawn' oder 'levelLoaded').
   */
  readonly active: boolean;
  /**
   * Optional: seitlicher Abstand zur nächsten Geometrie links/rechts in u
   * (Infinity oder fehlend = nichts in Reichweite). Treibt den Vorbeizieh-Whoosh;
   * ohne die Felder klingt alles wie bisher.
   */
  readonly nearL?: number;
  readonly nearR?: number;
}

export interface BeatInfo {
  readonly bpm: number;
  /** Beats seit Musikstart (kontinuierlich). */
  readonly beat: number;
  /** 0..1 innerhalb des aktuellen Beats. */
  readonly beatPhase: number;
  /** 0..1 innerhalb des aktuellen Takts (4 Beats). */
  readonly barPhase: number;
  /** 0..1 Hüllkurve der Kick (1 beim Schlag, fällt in ~150 ms ab) — für Neon-Puls. */
  readonly kick: number;
  /** 0..1 geglättete Musik-Intensität. */
  readonly energy: number;
  /** Aktive Layer-Stufe 0..4. */
  readonly layer: number;
}

export interface AudioVolumes {
  readonly master: number;
  readonly music: number;
  readonly sfx: number;
}

export interface AudioApi {
  /** Muss aus einer User-Geste heraus aufgerufen werden (Klick/Taste). */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  /** Pro Frame. */
  update(drive: MusicDrive, dt: number): void;
  /** Spiel-Ereignisse → Sound-Effekte und Musik-Akzente. */
  emit(event: GameEvent): void;
  setVolumes(v: AudioVolumes): void;
  /**
   * Aktueller Beat-Zustand, synchron zu dem, was gerade hörbar ist. Das
   * zurückgegebene Objekt darf pro Aufruf wiederverwendet werden — Werte lesen,
   * nicht aufbewahren.
   */
  beat(): BeatInfo;
  /** Timer stoppen, eigenen Kontext schließen. Danach ist unlock() erneut möglich. */
  dispose(): Promise<void>;
}

export const SILENT_BEAT: BeatInfo = { bpm: 132, beat: 0, beatPhase: 0, barPhase: 0, kick: 0, energy: 0, layer: 0 };
