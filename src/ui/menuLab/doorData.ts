/**
 * Reine Abbildungen für den Front-Door-Vertrag (Plan 010 Runde 4) — DOM- und three-frei, damit Vitest sie in Node lädt.
 * Menu.ts baut damit FrontDoorContext.board(), Game.ts die Level-Farben (FrontDoorLevel.theme).
 */
import type { LeaderboardEntry, LeaderboardPage } from '../../online/types';
import type { FrontDoorBoard, FrontDoorBoardEntry, FrontDoorLevelTheme } from './types';

/** LeaderboardEntry → Vertrag; mine über die eigene uid (null = nicht angemeldet → nie mine). */
export function doorBoardEntry(e: LeaderboardEntry, meUid: string | null): FrontDoorBoardEntry {
  return { rank: e.rank, uid: e.uid, name: e.name, avatarUrl: e.avatarUrl, dev: e.dev, bot: e.bot, time: e.time, runId: e.runId, mine: meUid !== null && e.uid === meUid };
}

/** Top-10- und Um-mich-Seite → FrontDoorBoard. Ohne eigenen Eintrag ist around leer (wie die klassische Tabelle). */
export function doorBoard(levelId: string, top: LeaderboardPage, around: LeaderboardPage, meUid: string | null): FrontDoorBoard {
  const map = (e: LeaderboardEntry): FrontDoorBoardEntry => doorBoardEntry(e, meUid);
  return {
    levelId,
    top: top.entries.map(map),
    around: around.me ? around.entries.map(map) : [],
    total: top.total,
    me: around.me ? map(around.me) : null,
  };
}

/** environment einer Level-Datei → Menü-Farben, null bei fehlenden/kaputten Feldern. */
export function levelTheme(data: unknown): FrontDoorLevelTheme | null {
  if (typeof data !== 'object' || data === null) return null;
  const env = (data as { environment?: unknown }).environment;
  if (typeof env !== 'object' || env === null) return null;
  const e = env as Record<string, unknown>;
  const str = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null);
  const trim = str('trimColor');
  const skyTop = str('skyTop');
  const skyHorizon = str('skyHorizon');
  const skyBottom = str('skyBottom');
  const sun = str('sunColor');
  if (!trim || !skyTop || !skyHorizon || !skyBottom || !sun) return null;
  return { trim, trimAlt: str('trimColorAlt'), skyTop, skyHorizon, skyBottom, sun, moon: e.moon === true };
}
