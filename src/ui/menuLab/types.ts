/**
 * Menü-Labor (Plan 010) — Vertrag zwischen Menu.ts und den Hauptmenü-Stilen ("Front Doors").
 *
 * Eine Front Door ersetzt NUR den Titel-Screen (Hauptmenü + Levelauswahl). Alle anderen Screens
 * (Einstellungen, Steuerung, Kosmetik, Training, Bestenliste, Admin, Pause, Ergebnis, Labor, Profil)
 * bleiben die bestehenden aus Menu.ts; jeder Stil darf sie per CSS umfärben, aber nur unter
 * `.vel-menu.vel-style--<id>` (die Klasse hängt immer am Menü-Root, auf allen Screens).
 *
 * Ein Stil importiert NIE Menu-Interna — alles, was der klassische Titel zeigt und kann, steht hier als
 * Daten + Rückrufe. Lebenszyklus: mount → update* → unmount (siehe FrontDoor).
 */
import type { MenuStyleId } from '../../engine/settingsTypes';
import type { LevelMedals } from '../../world/level/LevelFormat';
import type { MedalId } from '../medals';

export type { MenuStyleId } from '../../engine/settingsTypes';
export { MENU_STYLE_IDS } from '../../engine/settingsTypes';
export type { MedalId } from '../medals';
export type { LevelMedals } from '../../world/level/LevelFormat';

/** Stile mit eigener Front Door (alles außer 'classic'). */
export type FrontDoorStyleId = Exclude<MenuStyleId, 'classic'>;
export const FRONT_DOOR_IDS: readonly FrontDoorStyleId[] = ['ps2', 'hub', 'rave', 'arcade'];

/** Ein Level der Auswahl, fertig aufbereitet (Reihenfolge = index.json). */
export interface FrontDoorLevel {
  readonly id: string;
  /** 0-basiert, = Position in FrontDoorContext.levels. */
  readonly index: number;
  /** "01", "02", … (wie die klassische Liste). */
  readonly num: string;
  /** Anzeigename ohne führende Nummer, z. B. "GRUNDKURS". */
  readonly name: string;
  /** Untertitel ("Halt die Linie."), null = keiner. */
  readonly subtitle: string | null;
  /** Medaillen-Grenzen in s (bronze > silver > gold > velocity ≥ author), null = Level ohne Medaillen. */
  readonly medals: LevelMedals | null;
  /** Lokale Bestzeit in s, null = noch nie im Ziel. */
  readonly bestTime: number | null;
  /** Bestzeit formatiert ("1:02.34" bzw. "--:--.--"). */
  readonly bestText: string;
  /** Beste erreichte Medaille, null = keine. */
  readonly medal: MedalId | null;
  /** Nächstes Ziel (Medaille + Grenze in s), null = alles geholt oder keine Medaillen. */
  readonly nextMedal: { readonly id: MedalId; readonly limit: number } | null;
  /** Gesperrt? Es gibt (noch) keine Level-Sperren — immer false. Feld steht da, damit Stile es vorsehen können. */
  readonly locked: boolean;
  /** "Empfohlen: T7/T8" — Vorbereitungs-Lektionen ohne Stern, null = keine offen. */
  readonly recommended: string | null;
}

/** Eine Trainings-Lektion (kurz, für Hinweise/Knöpfe). */
export interface FrontDoorLesson {
  readonly id: string;
  /** "T1" … "T8". */
  readonly short: string;
  readonly name: string;
  readonly subtitle: string | null;
  /** 0..3 Sterne. */
  readonly stars: number;
}

export interface FrontDoorTraining {
  /** Lektionsliste geladen (false = lädt noch oder fehlt im Build). */
  readonly available: boolean;
  /** Lektionen startbar (Logik geladen). */
  readonly playable: boolean;
  /** Bestandene Lektionen (≥ 1 Stern) / alle. */
  readonly passed: number;
  readonly total: number;
  /** "3/8" ('' ohne Lektionen) — wie der klassische Trainings-Knopf. */
  readonly countText: string;
  /** Erste Lektion ohne Stern, null = alle bestanden. */
  readonly recommended: FrontDoorLesson | null;
  /**
   * Neuling: keine Bestzeit irgendwo und kein Trainingsfortschritt. Der klassische Titel bietet dann
   * groß "Training starten" (recommended) an — Stile sollten das auch tun, aber nie erzwingen.
   */
  readonly newbie: boolean;
}

export interface FrontDoorCosmetics {
  /** Freigeschaltete Kosmetik / alle (14). */
  readonly unlocked: number;
  readonly total: number;
  /** Wirksame Wahl (gesperrte gespeicherte Wahl → Standard/Nichts) als Anzeigename. */
  readonly gloveName: string;
  readonly itemName: string;
  /** Zuletzt freigeschaltet (Anzeigename), null = nichts. Es gibt keinen "neu"-Merker; das ist das Nächstbeste. */
  readonly latest: string | null;
}

export interface FrontDoorAccount {
  /** Online-Schicht vorhanden (false = offline: Bestenliste zeigt "offline"). */
  readonly online: boolean;
  /** 'supabase' | 'mock' | 'off' (nur Anzeige). */
  readonly backend: string;
  /** Backend hat Discord-Login (supabase). false (mock/offline) → keinen Login-Knopf zeigen. */
  readonly loginRequired: boolean;
  readonly signedIn: boolean;
  /** Anzeigename (angemeldet bzw. Mock-Name), null = unbekannt. */
  readonly name: string | null;
  /** Discord-Avatar-URL, null = keiner. Pixelig anzeigen: `?size=16` + image-rendering: pixelated. */
  readonly avatarUrl: string | null;
  /** Entwickler (profiles.role = 'dev') → DEV-Abzeichen / Namens-Effekt. */
  readonly dev: boolean;
}

/** Zustand des Pointer-Lock-Versuchs nach play() (siehe FrontDoorContext.play). */
export interface FrontDoorLock {
  /** Versuch läuft: Startknöpfe sperren (Buttons mit data-lock tut Menu.ts das automatisch). */
  readonly pending: boolean;
  /** Lesbarer Fehlertext ("Maus konnte nicht gefangen werden …"), null = alles gut. Sichtbar anzeigen! */
  readonly error: string | null;
}

/**
 * Musik-Takt fürs Pulsieren. `live` = echter Techno (AudioApi.beat(), synchron zum Hörbaren). Vor dem ersten
 * Klick ist kein AudioContext da (Browser-Autoplay) — dann läuft eine deterministische Ersatz-Uhr mit der BPM
 * des Tracks (132) ab Seitenstart (performance.now()), kick als 150-ms-Hüllkurve, energy fest 0.35.
 * Im Menü läuft die Musik nach dem ersten Spiel gedämpft weiter (MusicDrive.active = false) → live.
 */
export interface FrontDoorBeat {
  readonly bpm: number;
  /** Beats seit Musikstart, kontinuierlich. */
  readonly beat: number;
  /** 0..1 innerhalb des Beats (0 = Schlag). */
  readonly phase: number;
  /** Ganzzahliger Takt-Index (4 Beats). */
  readonly bar: number;
  /** 0..1 innerhalb des Takts. */
  readonly barPhase: number;
  /** 0..1 Kick-Hüllkurve (1 beim Schlag). */
  readonly kick: number;
  /** 0..1 geglättete Intensität. */
  readonly energy: number;
  /** true = echte Musik, false = Ersatz-Uhr. */
  readonly live: boolean;
}

/** Statische Assets für Stile (Vite-URLs, erst bei Benutzung geladen). */
export interface FrontDoorAssets {
  /**
   * Logo-Bild (media/velocity_font.png, 2172×724, transparent, Neon-Verlauf). Gebaut als eigene Datei (~1 MB),
   * nur geladen, wenn ein Stil es als <img src> setzt. Hochauflösend: für Pixel-Look kleiner zeichnen
   * und `image-rendering: pixelated` NICHT erwarten (Quelle ist schon detailreich).
   */
  readonly logoUrl: string;
}

/**
 * Alles, was eine Front Door braucht. Daten sind ein Schnappschuss (bei Änderungen kommt ein neuer ctx über
 * update()); die Funktionen sind stabil und dürfen gemerkt werden.
 */
export interface FrontDoorContext {
  readonly style: FrontDoorStyleId;
  /**
   * 'boot' = erster Mount dieses Stils in dieser Sitzung (Intro/Boot-Sequenz zeigen), 'return' = zurück aus einem
   * anderen Screen oder Level (Intro überspringen bzw. stark kürzen — die Front Door wird bei jedem Titel neu gemountet).
   */
  readonly entry: 'boot' | 'return';

  // ---- Daten
  readonly levels: readonly FrontDoorLevel[];
  /** Gewähltes Level (Index in levels; 0 bei leerer Liste). Menu.ts merkt es sich über Screenwechsel hinweg. */
  readonly selected: number;
  /** Level-Index lädt noch (levels leer). */
  readonly loading: boolean;
  readonly training: FrontDoorTraining;
  readonly cosmetics: FrontDoorCosmetics;
  readonly account: FrontDoorAccount;
  readonly lock: FrontDoorLock;
  /** "v0.1.0 · Physik 1 · dev" */
  readonly version: string;
  /** prefers-reduced-motion: reduce → keine Dauer-Animationen, kein Pulsieren/Kamerafahrten (harte Schnitte ok). */
  readonly reducedMotion: boolean;
  readonly assets: FrontDoorAssets;

  // ---- Lesen pro Frame
  /** Takt (siehe FrontDoorBeat). Das Objekt wird wiederverwendet — Werte lesen, nicht aufbewahren. Nie null. */
  beat(): FrontDoorBeat;

  // ---- Aktionen
  /** Auswahl ändern (merkt Menu.ts; löst KEIN update() aus — der Stil zeichnet selbst). */
  select(index: number): void;
  /**
   * Level starten (Training-Lektionen gehen auch: play(lesson.id)). WICHTIG Pointer Lock: der Browser fängt die
   * Maus nur innerhalb einer User-Geste. play() SYNCHRON im click-/keydown-Handler aufrufen, nicht nach einem
   * await/setTimeout/Animationsende. Das Menü verschwindet sofort (kein Outro möglich). Während lock.pending
   * ignoriert play() weitere Aufrufe (Chrome drosselt Spam). Fehlschlag → lock.error per update().
   */
  play(levelId: string): void;
  /** play(levels[selected].id). */
  playSelected(): void;
  /** Lektionsliste (bestehender Screen). */
  openTraining(): void;
  openCosmetics(): void;
  /** Bestenliste; ohne levelId das gewählte Level. */
  openLeaderboard(levelId?: string): void;
  openSettings(): void;
  openControls(): void;
  /** Profil (Platzhalter-Screen "Profil — kommt", bis der Profil-Strang ihn baut). */
  openProfile(): void;
  /** Admin-Menü (Freischaltungen/Medaillen; auch F8). Bewusst unauffällig anbieten. */
  openAdmin(): void;
  /** Menü-Labor (Stil wechseln). Jede Front Door MUSS einen Weg dorthin anbieten. */
  openLab(): void;
  /** Discord-Login (verlässt die Seite; nur sinnvoll bei account.loginRequired && !signedIn). */
  signIn(): void;
  signOut(): void;
  /** Vollbild umschalten (User-Geste nötig, also auch synchron im Handler). */
  fullscreen(): void;
  /**
   * Musik jetzt starten (AudioContext entsperren) — NUR aus einer User-Geste. Danach liefert beat() live.
   * Optional für Stile, die im Menü Musik wollen (Musik läuft gedämpft, wie im Pause-Menü).
   */
  startMusic(): void;
  /**
   * Button als Startknopf markieren (data-lock): Menu.ts sperrt ihn, solange ein Lock-Versuch läuft. Für alle
   * Knöpfe, die play() auslösen.
   */
  markLockButton(el: HTMLButtonElement): void;
}

/** Engine-Tasten, die Menu.ts an die Front Door weiterreicht (InputManager → Menu.handleAction). */
export type FrontDoorAction = 'confirm' | 'back' | 'restart';

export interface FrontDoor {
  /**
   * root ist ein leeres, vollflächiges Element (position:absolute; inset:0) im Menü, schon im DOM. Hier DOM bauen,
   * eigene Listener (window keydown für Pfeile etc.) und rAF-Schleifen starten.
   */
  mount(root: HTMLElement, ctx: FrontDoorContext): void;
  /** Neue Daten (Bestzeiten, Login, Training, Lock-Status, Levels geladen …). Zustand/Animationen behalten. */
  update(ctx: FrontDoorContext): void;
  /** ALLES abbauen: Listener, rAF, Timer, WebGL-Kontexte (renderer.dispose + forceContextLoss). root leert Menu.ts. */
  unmount(): void;
  /**
   * Enter ('confirm'), Esc ('back'), R ('restart') kommen NUR hierüber — nicht selbst auf Enter/Escape lauschen,
   * sonst doppelt. Läuft im Frame nach dem Tastendruck (gilt noch als User-Geste: play() hier ist ok).
   * Fehlt die Methode, tut Enter nichts.
   */
  onAction?(a: FrontDoorAction): void;
}

/** Jeder Stil exportiert default eine FrontDoorFactory aus src/ui/menuLab/<id>/index.ts. */
export type FrontDoorFactory = () => FrontDoor;

/** Eintrag im Menü-Labor. */
export interface MenuStyleInfo {
  readonly id: MenuStyleId;
  readonly name: string;
  /** Eine Zeile. */
  readonly description: string;
}
