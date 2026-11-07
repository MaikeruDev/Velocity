/**
 * Menü-Klänge (Fokus wandert, Bestätigen, Zurück). Das Menü und die Front Doors melden nur die Art; main.ts hängt
 * die Audio-Engine an (TechnoAudio.uiSound). Ohne Senke oder vor dem Audio-Start passiert nichts.
 *
 * Entprellt, weil eine Geste oft mehrere Meldungen auslöst (Enter = Menü-Aktion + nativer Klick; ein neuer Screen
 * setzt danach den Fokus): Bestätigen/Zurück höchstens einmal je 60 ms, "move" nicht direkt danach.
 */
export type MenuSoundKind = 'move' | 'confirm' | 'back';

const STRONG_GAP_MS = 60;
/** Fokuswechsel durch den Screen-Wechsel nach Bestätigen/Zurück nicht noch als Bewegung hören. */
const MOVE_AFTER_STRONG_MS = 140;
const MOVE_GAP_MS = 30;

let sink: ((kind: MenuSoundKind) => void) | null = null;
let lastStrong = Number.NEGATIVE_INFINITY;
let lastMove = Number.NEGATIVE_INFINITY;

export function setMenuSoundSink(fn: ((kind: MenuSoundKind) => void) | null): void {
  sink = fn;
}

export function menuSound(kind: MenuSoundKind, now: number = performance.now()): void {
  if (kind === 'move') {
    if (now - lastStrong < MOVE_AFTER_STRONG_MS || now - lastMove < MOVE_GAP_MS) return;
    lastMove = now;
  } else {
    if (now - lastStrong < STRONG_GAP_MS) return;
    lastStrong = now;
  }
  sink?.(kind);
}

/** Nur für Tests: Entprell-Zustand zurücksetzen. */
export function resetMenuSound(): void {
  lastStrong = Number.NEGATIVE_INFINITY;
  lastMove = Number.NEGATIVE_INFINITY;
}
