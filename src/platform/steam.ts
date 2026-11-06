/**
 * Steam-Schicht im Renderer (Plan 011 Schritte 4.2–4.4) — DOM-frei, spricht NUR über `PlatformApi.steam` (Bridge →
 * electron/steam.ts); im Web-Bundle steckt kein Steamworks. main.ts lädt diese Datei nur am Desktop mit `--steam`
 * als eigenen Chunk.
 *
 *  - Achievements: Game.onLiveProgress → AchievementTracker (achievements.ts) → unlockAchievement (480: Test-Tabelle).
 *    Komplett aus mit --dev (platform.dev) oder Debug-Zugang (Sitzung meldet achievements=false, Review Phase 2):
 *    dann kein Buch, keine Zustellung.
 *  - Rich Presence: Key/Value — bei 480 gibt es keine steam_display-Tokens (die brauchen die eigene App-ID).
 *    `status` = "Menü" / "L2 SCHLEIFE" / "Training T3" / "Gegen Ghost · L2 SCHLEIFE", dazu `mode` und `level` für
 *    spätere Lokalisierungs-Tokens. Gesendet wird nur, was sich geändert hat (einmal je Sekunde geprüft).
 *  - Overlay geöffnet → Pause (GameOverlayActivated; steamworks.js 0.4.0 meldet es nicht, siehe electron/steam.ts).
 */
import { AchievementTracker } from './achievements';
import type { LiveProgress } from './live';
import type { PlatformApi, PlatformSteamSession } from './types';
import type { StorageLike } from '../engine/storage';
import { defaultStorage } from '../engine/storage';

/** Was die Steam-Schicht vom Spiel braucht (Game erfüllt es; Tests geben ein Fake). */
export interface SteamGame {
  readonly state: string;
  readonly currentLevelId: string;
  readonly currentLevel: { readonly def: { readonly name: string } } | null;
  readonly lessonSession: object | null;
  readonly ghostRace: { readonly levelId: string } | null;
  levelIds(): readonly string[];
  lessonList(): readonly { readonly id: string; readonly short: string }[];
  pause(kind: 'menu'): void;
  onLiveProgress: ((e: LiveProgress) => void) | null;
}

export type PresenceMode = 'menu' | 'level' | 'training' | 'ghost';

export interface Presence {
  readonly mode: PresenceMode;
  /** Steam-Schlüssel `status` (Freundesliste → "Spielinfo anzeigen"). */
  readonly status: string;
  /** Level-/Lektions-ID, null im Menü. */
  readonly level: string | null;
}

export interface PresenceInput {
  readonly state: string;
  readonly levelId: string;
  readonly levelName: string | null;
  /** Position im Level-Index ab 1 (0 = nicht im Index, z. B. Sandbox). */
  readonly levelNumber: number;
  /** Kürzel der laufenden Lektion ("T3"), null = keine Lektion. */
  readonly lesson: string | null;
  /** Fährt gegen einen Ghost aus der Bestenliste. */
  readonly race: boolean;
}

/** "02 SCHLEIFE" an Position 2 → "L2 SCHLEIFE" (die Nummer im Namen ist Deko, die Position zählt). */
export function levelLabel(name: string | null, n: number): string {
  const base = (name ?? '').replace(/^\d+\s+/, '').trim();
  if (n > 0) return base ? `L${n} ${base}` : `L${n}`;
  return base || 'Level';
}

export function presenceFor(p: PresenceInput): Presence {
  if (p.state === 'title' || p.levelId === '') return { mode: 'menu', status: 'Menü', level: null };
  if (p.lesson !== null) return { mode: 'training', status: `Training ${p.lesson}`, level: p.levelId };
  const label = levelLabel(p.levelName, p.levelNumber);
  if (p.race) return { mode: 'ghost', status: `Gegen Ghost · ${label}`, level: p.levelId };
  return { mode: 'level', status: label, level: p.levelId };
}

export const PRESENCE_POLL_MS = 1000;

export interface SteamTimers {
  /** fn alle ms Millisekunden; Rückgabe = anhalten. */
  every(fn: () => void, ms: number): () => void;
}

const DEFAULT_TIMERS: SteamTimers = {
  every: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

export interface SteamLinkOptions {
  /** Buch der Achievements (Standard: localStorage). */
  readonly storage?: StorageLike | null;
  readonly timers?: SteamTimers;
}

/** Steam ans Spiel gehängt: Achievements, Rich Presence, Overlay → Pause. */
export class SteamLink {
  /** null = Achievements aus (--dev/Debug-Zugang). */
  readonly tracker: AchievementTracker | null;
  private last: Presence | null = null;
  private lastKey = '';
  private readonly stopPoll: () => void;
  private readonly unOverlay: () => void;
  private readonly onLive: ((e: LiveProgress) => void) | null;

  constructor(
    private readonly steam: PlatformSteamSession,
    private readonly game: SteamGame,
    dev: boolean,
    opts: SteamLinkOptions = {},
  ) {
    if (!dev && steam.achievements) {
      const tracker = new AchievementTracker(opts.storage === undefined ? defaultStorage() : opts.storage, {
        appId: steam.appId,
        unlock: (name) => steam.unlockAchievement(name),
      });
      this.tracker = tracker;
      this.onLive = (e) => {
        tracker.record(e);
      };
      game.onLiveProgress = this.onLive;
    } else {
      this.tracker = null;
      this.onLive = null;
    }
    // Overlay offen = der Spieler schaut weg (Shift+Tab): wie Esc pausieren, nie automatisch weiter.
    this.unOverlay = steam.onOverlay((active) => {
      if (active) game.pause('menu');
    });
    this.stopPoll = (opts.timers ?? DEFAULT_TIMERS).every(() => this.updatePresence(), PRESENCE_POLL_MS);
    this.updatePresence();
  }

  /** Aktuell gesendete Presence (Tests, Werkzeuge). */
  get presence(): Presence | null {
    return this.last;
  }

  /** Spielzustand → Presence; sendet nur Geändertes. Nicht im Frame-Pfad (Intervall). */
  updatePresence(): void {
    const g = this.game;
    // Beim Laden zeigt Game noch das alte Level — erst nach dem Wechsel melden.
    if (g.state === 'loading') return;
    const id = g.currentLevelId;
    const race = g.ghostRace !== null && g.ghostRace.levelId === id;
    const key = `${g.state === 'title' ? 'title' : 'game'}|${id}|${g.lessonSession !== null}|${race}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const lesson = g.lessonSession !== null ? (g.lessonList().find((l) => l.id === id)?.short ?? id) : null;
    this.send(
      presenceFor({ state: g.state, levelId: id, levelName: g.currentLevel?.def.name ?? null, levelNumber: g.levelIds().indexOf(id) + 1, lesson, race }),
    );
  }

  dispose(): void {
    this.stopPoll();
    this.unOverlay();
    if (this.onLive !== null && this.game.onLiveProgress === this.onLive) this.game.onLiveProgress = null;
  }

  private send(p: Presence): void {
    const last = this.last;
    this.last = p;
    const set = (key: string, value: string | null): void => {
      void this.steam.setPresence(key, value).catch(() => false);
    };
    if (last === null || last.status !== p.status) set('status', p.status);
    if (last === null || last.mode !== p.mode) set('mode', p.mode);
    if (last === null || last.level !== p.level) set('level', p.level);
  }
}

/**
 * main.ts (Desktop mit --steam): auf die Steam-Sitzung warten (init läuft nach dem ersten Bild) und das Spiel
 * anhängen. Ohne Sitzung (kein Client, init gescheitert): null, das Spiel läuft unverändert.
 */
export async function installSteam(plat: PlatformApi, game: SteamGame, opts: SteamLinkOptions = {}): Promise<SteamLink | null> {
  const session = plat.steam ? await plat.steam.ready() : null;
  return session ? new SteamLink(session, game, plat.dev, opts) : null;
}
