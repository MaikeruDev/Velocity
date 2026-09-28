import type { LevelMedals } from '../world/level/LevelFormat';

/**
 * Medaillen-Stufen, beste zuerst. VELOCITY liegt zwischen Gold und der Autor-Zeit
 * (LevelMedals.velocity); die Autor-Zeit selbst ist keine Medaille, nur Referenz.
 */
export type MedalId = 'velocity' | 'gold' | 'silver' | 'bronze';

export const MEDAL_ORDER: readonly MedalId[] = ['velocity', 'gold', 'silver', 'bronze'];

export const MEDAL_NAMES: Readonly<Record<MedalId, string>> = {
  velocity: 'VELOCITY',
  gold: 'GOLD',
  silver: 'SILBER',
  bronze: 'BRONZE',
};

/**
 * Farbe je Medaille im HUD (Bitmap-Font, feste Palette). VELOCITY ist kein Metall,
 * sondern Neon — das HUD lässt es zwischen Cyan und Magenta schimmern (MEDAL_SHIMMER).
 */
export const MEDAL_COLORS: Readonly<Record<MedalId, string>> = {
  velocity: '#33f0ff',
  gold: '#ffd84a',
  silver: '#cfd6e6',
  bronze: '#e0915a',
};
export const MEDAL_SHIMMER = '#ff3fd0';

/** Beste erreichte Medaille (Zeit ≤ Grenze), null = keine. */
export function medalFor(time: number | null, m: LevelMedals | null | undefined): MedalId | null {
  if (time === null || !m || !Number.isFinite(time)) return null;
  for (const id of MEDAL_ORDER) if (time <= m[id]) return id;
  return null;
}

/** Nächste noch nicht erreichte Medaille und ihre Grenze, null = alles geholt. */
export function nextMedal(time: number | null, m: LevelMedals): { readonly id: MedalId; readonly limit: number } | null {
  const have = medalFor(time, m);
  const idx = have === null ? MEDAL_ORDER.length : MEDAL_ORDER.indexOf(have);
  if (idx === 0) return null;
  const id = MEDAL_ORDER[idx - 1];
  return { id, limit: m[id] };
}

/** Medaille a ist mindestens so gut wie b (null = keine). */
export function medalAtLeast(a: MedalId | null, b: MedalId): boolean {
  return a !== null && MEDAL_ORDER.indexOf(a) <= MEDAL_ORDER.indexOf(b);
}

/**
 * Admin-Menü: Bestzeit, die genau die Medaille `medal` ergibt (null = Lauf ohne Medaille).
 * Knapp unter der Grenze (−0.01 s), damit Levelauswahl/Ergebnis/HUD dieselbe Medaille
 * zeigen und das "Nächste Ziel" realistisch nah bleibt. Liegt die nächstbessere Grenze
 * näher als 0.01 s, nimmt sie die Mitte — die Zeit darf nie in die bessere Medaille rutschen.
 * Ohne Medaille: 10 % über Bronze (ein abgeschlossener, aber langsamer Lauf).
 */
export function adminTimeFor(medal: MedalId | null, m: LevelMedals): number {
  if (medal === null) return Math.ceil(m.bronze * 1.1 * 100) / 100;
  const i = MEDAL_ORDER.indexOf(medal);
  const limit = m[medal];
  const better = i > 0 ? m[MEDAL_ORDER[i - 1]] : 0;
  const t = Math.round((limit - 0.01) * 1000) / 1000;
  return t > better ? t : (limit + better) / 2;
}
