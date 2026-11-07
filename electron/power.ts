/**
 * Bildschirm wach halten, solange das Spiel vorn ist (Review C3): Gamepad-Eingaben setzen den Windows-Leerlauf-Timer
 * nicht zurück — wer nur mit dem Pad spielt, sähe nach der Energiespar-Zeit ein schwarzes Bild. Darum
 * `powerSaveBlocker('prevent-display-sleep')`, solange das Fenster fokussiert, sichtbar und nicht minimiert ist; bei
 * Blur/Minimieren/Schließen/Beenden wieder frei. Ohne Electron-Laufzeitimport (Vitest mit Fake-API).
 */

/** Ausschnitt aus Electron `powerSaveBlocker`. */
export interface PowerBlockerApi {
  start(type: 'prevent-display-sleep'): number;
  stop(id: number): unknown;
  isStarted(id: number): boolean;
}

export class DisplaySleepGuard {
  private id: number | null = null;

  constructor(private readonly api: PowerBlockerApi) {}

  /** Blocker-ID (Smoke prüft damit `powerSaveBlocker.isStarted`), null = frei. */
  get blockerId(): number | null {
    return this.id;
  }

  get active(): boolean {
    return this.id !== null && this.api.isStarted(this.id);
  }

  /** Gewünschten Zustand setzen; mehrfach mit demselben Wert ist ein No-op (Ereignisse kommen doppelt). */
  set(want: boolean): void {
    if (want) {
      if (this.id === null || !this.api.isStarted(this.id)) this.id = this.api.start('prevent-display-sleep');
      return;
    }
    if (this.id === null) return;
    const id = this.id;
    this.id = null;
    if (this.api.isStarted(id)) this.api.stop(id);
  }

  dispose(): void {
    this.set(false);
  }
}

/** Was der Wächter vom Fenster liest (BrowserWindow erfüllt es). */
export interface FocusWindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
}

/** Spiel vorn = fokussiert, sichtbar, nicht minimiert. */
export function isForeground(win: FocusWindowLike): boolean {
  return !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized();
}
