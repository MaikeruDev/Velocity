/**
 * Renderer kaputt (Review C4): abgestürzt (render-process-gone), hängt (unresponsive) oder lädt nicht
 * (did-fail-load). Einmal neu laden; kommt der nächste Fehler, bevor das Spiel RECOVERY_STABLE_MS lief, aufgeben:
 * Fehlerdialog und sauber beenden — nie ein unsichtbarer Prozess, der den Single-Instance-Lock hält (dann täte ein
 * Neustart aus Steam nichts). Reine Regeln, die Verdrahtung macht main.ts.
 */

/** Nach so langer fehlerfreier Zeit seit dem letzten Neuladen gilt ein Fehler wieder als erster. */
export const RECOVERY_STABLE_MS = 5 * 60_000;
/** Kommt ready-to-show so lange nicht (Renderer tot vor dem ersten Bild), wird das Fenster trotzdem gezeigt. */
export const READY_FALLBACK_MS = 10_000;
/** Fehlerdialog im Test-Modus (--fault) nach so langer Zeit selbst schließen — der Smoke kann nicht klicken. */
export const FAULT_DIALOG_MS = 1500;

export type RendererFailure = 'gone' | 'unresponsive' | 'load';
export type RecoveryAction = 'reload' | 'fatal';

/** render-process-gone: nur 'clean-exit' ist kein Fehler ('killed' kann der Task-Manager sein). */
export function isRendererCrash(reason: string): boolean {
  return reason !== 'clean-exit';
}

/** did-fail-load zählt nur fürs Hauptdokument; -3 (ERR_ABORTED) = ersetzte/abgebrochene Navigation, kein Fehler. */
export function isLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== 0 && errorCode !== -3;
}

export class RendererRecovery {
  private lastReloadAt: number | null = null;

  constructor(private readonly stableMs = RECOVERY_STABLE_MS) {}

  /** Erster Fehler (oder lange nach dem letzten Neuladen) → neu laden, sonst aufgeben. */
  next(now: number): RecoveryAction {
    if (this.lastReloadAt !== null && now - this.lastReloadAt < this.stableMs) return 'fatal';
    this.lastReloadAt = now;
    return 'reload';
  }
}

/** Text des Fehlerdialogs (deutsch, ein Grund in Klammern für Fehlerberichte). */
export function fatalMessage(kind: RendererFailure | 'start', detail: string): string {
  const what =
    kind === 'gone'
      ? 'VELOCITY ist abgestürzt'
      : kind === 'unresponsive'
        ? 'VELOCITY reagiert nicht mehr'
        : kind === 'load'
          ? 'VELOCITY konnte nicht geladen werden'
          : 'VELOCITY konnte nicht starten';
  return `${what} (${detail.slice(0, 200)}). Das Spiel wird beendet — bitte neu starten.`;
}
