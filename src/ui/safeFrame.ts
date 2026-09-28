/**
 * Safe-Frame für Rand-Elemente des HUD (Plan 005): auf Ultrawide (21:9, 32:9) liegen
 * View-Hand (unten rechts) und Showkeys (unten links) sonst weit im peripheren Blickfeld.
 * Sie hängen deshalb an einem zentrierten Rahmen mit höchstens 16:9.
 *
 * Warum genau 16:9 und nicht 18:9: Die Hand ist an der Bildhöhe bemessen (Größe, Abstand
 * zum rechten Rand) und auf 16:9 gegen Landepunkt und Bildmitte abgenommen (Plan 004).
 * Mit einem 16:9-Rahmen bleibt ihr Abstand zur Bildmitte auf jedem breiteren Bild exakt
 * derselbe wie auf 16:9 — nichts muss neu geprüft werden, und das Auge findet Hand und
 * Tasten an derselben Stelle relativ zum Fadenkreuz. 18:9 hätte auf 21:9 nur 6 % mehr
 * Abstand gebracht, dafür eine zweite, ungeprüfte Geometrie. Bei 16:9 und schmaler
 * (16:10, 4:3) ist der Rahmen das ganze Bild — alles bleibt wie vorher.
 */
export const SAFE_ASPECT = 16 / 9;

/** Linke Kante des Rahmens (px) — w/h im selben Raster (Low-Res-HUD oder CSS-Pixel). */
export function safeLeft(w: number, h: number): number {
  const sw = safeWidth(w, h);
  return Math.floor((w - sw) / 2);
}

/** Rechte Kante (exklusiv, px). */
export function safeRight(w: number, h: number): number {
  return safeLeft(w, h) + safeWidth(w, h);
}

/** Breite des Rahmens (px, ganzzahlig, ≤ w). */
export function safeWidth(w: number, h: number): number {
  const ww = Math.max(0, Math.floor(w));
  const cap = Math.round(Math.max(0, h) * SAFE_ASPECT);
  // 1 % Toleranz: 1366×768 (1.7786) und gerundete Low-Res-Breiten sollen nicht um 1 px springen.
  return ww <= cap * 1.01 ? ww : cap;
}
