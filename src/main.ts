import './style.css';
import { TechnoAudio } from './audio/TechnoAudio';
import { installDebug, installFpsOverlay } from './engine/debug';
import { Game } from './engine/Game';
import { InputManager } from './engine/Input';
import { BestTimes, SettingsStore, movementConfigFor } from './engine/Settings';
import { UnlockStore } from './engine/Unlocks';
import { PS2Renderer } from './render/PS2Renderer';
import { Hud } from './ui/Hud';
import { Menu } from './ui/Menu';
import { TuningPanel } from './ui/TuningPanel';

/**
 * Einstieg: Module erzeugen und an Game übergeben. Query:
 *   ?level=<id>   startet das Level direkt (Dev; ohne Geste erst Pause → "Weiter")
 *   &lockless     dabei ohne Pointer Lock spielen (Playwright)
 *   ?debug        FPS-Anzeige + Event-Log ab Start
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
  const input = new InputManager(canvas, () => settings.get());
  const hud = new Hud();
  const menu = new Menu(byId('menu-root'), settings, best, unlocks);
  const tuning = new TuningPanel(settings, movementConfigFor(settings.get()));

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
  });

  const q = new URLSearchParams(location.search);
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
