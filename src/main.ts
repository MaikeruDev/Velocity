import './style.css';
import { TechnoAudio } from './audio/TechnoAudio';
import { installDebug, installFpsOverlay } from './engine/debug';
import { Game } from './engine/Game';
import { InputManager } from './engine/Input';
import { BestTimes, SettingsStore, movementConfigFor } from './engine/Settings';
import { UnlockStore } from './engine/Unlocks';
import { MENU_STYLE_IDS } from './engine/settingsTypes';
import { createOnlineService, onlineBackend } from './online';
import { platform } from './platform';
import { installSaveMirror } from './platform/saveMirror';
import { PS2Renderer } from './render/PS2Renderer';
import { Hud } from './ui/Hud';
import { Menu } from './ui/Menu';
import { TuningPanel } from './ui/TuningPanel';

/**
 * Einstieg: Module erzeugen und an Game übergeben. Query:
 *   ?level=<id>   startet das Level direkt (Dev; ohne Geste erst Pause → "Weiter")
 *   &lockless     dabei ohne Pointer Lock spielen (Playwright)
 *   ?debug        FPS-Anzeige + Event-Log ab Start
 *   ?online=off|mock|supabase   Online-Schicht (Plan 009) statt VITE_ONLINE (Default: supabase, wenn VITE_SUPABASE_URL gesetzt, sonst mock)
 *   ?menu=<id>    Hauptmenü-Stil nur für diese Sitzung (Plan 010)
 * Am Desktop (Electron) gelten diese Dev-Parameter nur mit --dev (Plan 011 §2.2.13; der Hauptprozess hängt ohne
 * --dev ohnehin keine Query an — hier zusätzlich, falls doch eine durchkommt).
 */

const TOAST_MS = 6000;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} fehlt in index.html`);
  return el;
}

function hasWebGL2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** Nicht spielbar — lesbarer Grund statt schwarzem Bild. */
function showFatal(title: string, detail: string): void {
  const el = byId('vel-fatal');
  el.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  el.append(h, p);
  el.hidden = false;
}

function makeToast(el: HTMLElement): (message: string) => void {
  let timer = 0;
  return (message) => {
    el.textContent = message;
    el.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      el.hidden = true;
    }, TOAST_MS);
  };
}

async function main(): Promise<void> {
  if (!hasWebGL2()) {
    showFatal(
      'WebGL2 nicht verfügbar',
      'VELOCITY braucht WebGL2. Bitte einen aktuellen Chrome, Edge oder Firefox verwenden und die Hardwarebeschleunigung in den Browser-Einstellungen einschalten.',
    );
    return;
  }

  const app = byId('app');
  const canvas = document.createElement('canvas');
  canvas.id = 'vel-canvas';
  app.appendChild(canvas);

  const plat = platform();
  // Speicher-Spiegel (Desktop): leeren localStorage aus save.json füllen, BEVOR ein Store liest (Plan 011 §2.7).
  const mirror = installSaveMirror(plat.saveMirror, localStorage, window);
  const settings = new SettingsStore();
  let renderer: PS2Renderer;
  try {
    // Mit den gespeicherten Einstellungen: lowLatency (desynchronized) geht nur beim Erzeugen des Kontexts.
    renderer = new PS2Renderer(canvas, settings.get().render);
  } catch (err) {
    showFatal('Grafik konnte nicht starten', err instanceof Error ? err.message : String(err));
    return;
  }

  const best = new BestTimes();
  const unlocks = new UnlockStore();
  // Früh erzeugen: rechnet die Hall-Impulsantworten im Leerlauf vor (vor dem ersten Klick).
  const audio = new TechnoAudio();
  const input = new InputManager(canvas, () => settings.get(), plat);
  const hud = new Hud();
  const menu = new Menu(byId('menu-root'), settings, best, unlocks);
  menu.setPlatform(plat);
  // Beenden (nur Desktop): Spiegel synchron sichern, dann den Hauptprozess beenden lassen.
  menu.on('quit', () => {
    mirror?.flush();
    plat.quit();
  });
  const tuning = new TuningPanel(settings, movementConfigFor(settings.get()));

  // Dev-Parameter am Desktop nur mit --dev (Admin/Level-Sprung/Mock würden Achievements und Bestenliste entwerten).
  const q = new URLSearchParams(plat.kind === 'web' || plat.dev ? location.search : '');
  // Menü-Labor (Plan 010): Takt fürs Menü und ?menu=<id> als Sitzungs-Override (nicht gespeichert).
  menu.setAudio(audio);
  // VITE_TEST_MENU_STYLE: Playwright-Werkzeuge pinnen den klassischen Titel (tools/lib/devServer.mjs), ?menu gewinnt.
  const menuStyle = MENU_STYLE_IDS.find((id) => id === (q.get('menu') ?? import.meta.env.VITE_TEST_MENU_STYLE));
  if (menuStyle) menu.setStyleOverride(menuStyle);
  // Online-Schicht (Plan 009). Die Prüfung braucht kompilierte Level — aus dem Cache des Spiels (spät gebunden).
  let gameRef: Game | null = null;
  const online = await createOnlineService(onlineBackend(q.get('online')), {
    loadLevel: (id) => (gameRef ? gameRef.levelById(id) : Promise.reject(new Error('Spiel startet noch'))),
    levelIds: () => (gameRef ? gameRef.levelIds() : []),
    mockDev: q.has('mockdev'),
    // Desktop: Login im System-Browser + Sitzung verschlüsselt (Plan 011 §3.1); Web: null → Redirect wie bisher.
    desktopAuth: plat.auth,
  }).catch(() => null); // SDK-Chunk nicht ladbar (offline) → Spiel startet offline

  const game = new Game({
    canvas,
    renderer,
    audio,
    input,
    settings,
    best,
    unlocks,
    hud,
    menu,
    tuning,
    notify: makeToast(byId('vel-toast')),
    baseUrl: import.meta.env.BASE_URL,
    online,
  });
  gameRef = game;
  // Steam (Plan 011 Phase 4, nur Desktop mit --steam): eigener Chunk — das Web lädt ihn nie, im Web-Bundle steckt kein
  // Steamworks. Achievements nur aus echten Zielen/Lektionen (Game.onLiveProgress), Rich Presence, Overlay → Pause.
  if (plat.steam) {
    void import('./platform/steam')
      .then((m) => m.installSteam(plat, game))
      .catch((err: unknown) => console.warn('[velocity] Steam-Schicht nicht geladen', err));
  }

  const debug = q.has('debug');
  installDebug({ game, audio, settings, unlocks, record: debug });
  if (debug) installFpsOverlay(game, byId('vel-debug'));

  await game.boot();
  const level = q.get('level');
  if (level) await game.startLevel(level, { lockless: q.has('lockless') });
}

main().catch((err: unknown) => {
  console.error(err);
  showFatal('Start fehlgeschlagen', err instanceof Error ? err.message : String(err));
});
