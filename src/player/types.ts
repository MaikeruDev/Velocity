import type { Vector3 } from 'three';

/**
 * Ein Tick Eingabe (entspricht Source `CUserCmd`). Wird pro Physik-Tick von
 * der Engine gebaut; Bots bauen ihn selbst.
 *
 * Blickwinkel-Konvention (three.js): yaw = 0 schaut nach -Z, positiver yaw
 * dreht nach links (gegen den Uhrzeigersinn von oben). pitch > 0 schaut nach oben.
 *   forward = (-sin(yaw), 0, -cos(yaw))
 *   right   = ( cos(yaw), 0, -sin(yaw))
 */
export interface PlayerInput {
  /** -1..1: W = +1, S = -1 */
  readonly forward: number;
  /** -1..1: D = +1, A = -1 */
  readonly side: number;
  /** Sprungtaste gehalten. */
  readonly jumpHeld: boolean;
  /** Sprungtaste in diesem Tick neu gedrückt (Flanke; auch Mausrad). */
  readonly jumpPressed: boolean;
  readonly crouch: boolean;
  readonly sprint: boolean;
  /** Radiant. */
  readonly yaw: number;
  readonly pitch: number;
}

export const NO_INPUT: PlayerInput = {
  forward: 0,
  side: 0,
  jumpHeld: false,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yaw: 0,
  pitch: 0,
};

/**
 * Lesbarer Zustand des Spielers nach einem Tick. `pos` ist der Origin an der
 * Unterkante der Hull (Füße), nicht die Kamera.
 */
export interface PlayerSnapshot {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly onGround: boolean;
  /** Normale des Bodens, (0,1,0) in der Luft. */
  readonly groundNormal: Vector3;
  /** Hull ist geduckt. */
  readonly ducked: boolean;
  /** Augenhöhe über `pos` (weich interpoliert beim Ducken am Boden). */
  readonly eyeHeight: number;
  /** Horizontale Geschwindigkeit u/s. */
  readonly speed: number;
  /** Anzahl Hops in Folge (Landung → Sprung innerhalb der Chain-Gnadenfrist). 0 am Boden ohne Sprung. */
  readonly hopChain: number;
  /** 0..1 Schrittzyklus (zwei Schritte pro Zyklus) — Head-Bob und Schrittgeräusche hängen daran. */
  readonly stridePhase: number;
  /** Anteil der Luft-Ticks der letzten ~1 s mit Geschwindigkeitsgewinn (Strafe-Sync). */
  readonly strafeSync: number;
  /** Sekunden seit dem letzten Bodenkontakt (0 am Boden). */
  readonly airTime: number;
  /** Surft gerade (berührt eine zu steile Fläche in der Luft). */
  readonly surfing: boolean;
  /** Normale der zuletzt berührten Surf-Fläche; (0,0,0), wenn nicht surfend. Wird nicht interpoliert. */
  readonly surfNormal: Vector3;
  /**
   * Rutscht gerade (Plan 007, MovementConfig.slideMinSpeed). Diskret, wird nicht interpoliert
   * (Interpolation übernimmt den neueren Snapshot). Bis Phase 1 immer false.
   */
  readonly sliding: boolean;
}

/** Ereignisse, die die Bewegung pro Tick meldet. */
export type MovementEvent =
  | {
      readonly type: 'jump';
      /** horizontale Geschwindigkeit beim Absprung */
      readonly speed: number;
      /** Differenz zur Absprunggeschwindigkeit des vorherigen Hops in der Kette (0 beim ersten). */
      readonly gain: number;
      /** 0 Boden-Ticks zwischen Landung und Sprung (keine Friction angewandt). */
      readonly perfect: boolean;
      /**
       * Verlustfreier Hop (Plan 007): perfect ODER innerhalb der Lande-Gnade
       * (MovementConfig.landGraceTime). HUD/Audio/Kamera loben hiermit; `perfect` bleibt tick-genau.
       * Ohne Lande-Gnade (CS2, Phase 0) = perfect.
       */
      readonly clean: boolean;
      readonly chain: number;
      /** Sync des gerade beendeten Luftabschnitts der Kette, 0..1 (0, wenn keine Kette lief). */
      readonly sync: number;
      readonly crouched: boolean;
      /** Coyote-Sprung (nach Verlassen der Kante). */
      readonly coyote: boolean;
    }
  | {
      readonly type: 'land';
      /** Abwärtsgeschwindigkeit beim Aufprall, u/s (positiv). */
      readonly impact: number;
      readonly speed: number;
      readonly airTime: number;
      /**
       * Im nächsten Tick folgt voraussichtlich ein Sprung (Puffer oder Auto-Hop
       * gehalten) — Bhop-Landung. Audio/Kamera dürfen Landegeräusch und -dip
       * dann dämpfen, ohne auf den Sprung warten zu müssen.
       */
      readonly jumpQueued: boolean;
    }
  | { readonly type: 'footstep'; readonly speed: number; readonly left: boolean }
  | { readonly type: 'duck'; readonly down: boolean }
  | { readonly type: 'surfStart' }
  | { readonly type: 'surfEnd' }
  /** Rutschen beginnt (Plan 007). speed = Horizontal-Tempo nach dem Eintritt, boost = Schub gab es. */
  | { readonly type: 'slideStart'; readonly speed: number; readonly boost: boolean }
  /** Rutschen endet (zu langsam, aufgestanden, abgesprungen, Kante). speed = Tempo beim Ende. */
  | { readonly type: 'slideEnd'; readonly speed: number }
  /**
   * Kanten-Assist (Plan 007): step = Lip-Step in der Luft (≤ ledgeStep), vault = Landung auf der
   * Kante nach einem frontalen Anprall. speed = Tempo danach, dy = Höhenversatz (u) für die Kamera.
   */
  | { readonly type: 'ledge'; readonly kind: 'step' | 'vault'; readonly speed: number; readonly dy: number };

/** Beschreibbare Variante von PlayerSnapshot — für PlayerMovement, Interpolation und Snapshot-Puffer. */
export type MutablePlayerSnapshot = { -readonly [K in keyof PlayerSnapshot]: PlayerSnapshot[K] };

/** Beschreibbare Variante von PlayerInput — Bots und Engine füllen ein wiederverwendetes Objekt. */
export type MutablePlayerInput = { -readonly [K in keyof PlayerInput]: PlayerInput[K] };
