import type { FrontDoorFactory, FrontDoorStyleId, MenuStyleInfo } from './types';

/**
 * Menü-Labor (Plan 010): Stil → lazy geladene Front Door. Jeder Stil liegt in ./<id>/index.ts
 * (default export: FrontDoorFactory) und wird erst geladen, wenn er gewählt ist — so kostet ein
 * Stil (z. B. die three.js-Hub-Szene) nichts, solange man ihn nicht ansieht.
 * Gemeinsame Datei: Stil-Agenten ändern sie NICHT (Name/Beschreibung → beim Integrator melden).
 */
export const FRONT_DOOR_LOADERS: Readonly<Record<FrontDoorStyleId, () => Promise<FrontDoorFactory>>> = {
  ps2: () => import('./ps2/index').then((m) => m.default),
  hub: () => import('./hub/index').then((m) => m.default),
  rave: () => import('./rave/index').then((m) => m.default),
  arcade: () => import('./arcade/index').then((m) => m.default),
};

/** Karten im Menü-Labor, in dieser Reihenfolge. */
export const MENU_STYLES: readonly MenuStyleInfo[] = [
  { id: 'classic', name: 'Klassik', description: 'Das bisherige Menü: Neon-Panels, Levelliste, System-Spalte.' },
  { id: 'ps2', name: 'PS2-Konsole', description: 'Boot-Sequenz, Memory-Card-Screen fürs Profil, rotierende 3D-Objekte als Menüpunkte.' },
  { id: 'hub', name: 'Hub-Raum', description: 'Neon-Raum mit Stationen: Portale zu den Leveln, Spind für Kosmetik, Trophäenwand.' },
  { id: 'rave', name: 'Rave-Flyer', description: 'Riesige schräge Schrift, Club-Flyer-Look, alles pulst im Techno-Takt.' },
  { id: 'arcade', name: 'Arcade-Automat', description: 'INSERT COIN, Attract-Mode mit Highscore-Tabelle, gewölbte Röhre.' },
];

/** Cache der geladenen Fabriken — ein Stil wird höchstens einmal importiert. */
const loaded = new Map<FrontDoorStyleId, Promise<FrontDoorFactory>>();

export function loadFrontDoor(id: FrontDoorStyleId): Promise<FrontDoorFactory> {
  let p = loaded.get(id);
  if (!p) {
    p = FRONT_DOOR_LOADERS[id]();
    // Fehlschlag nicht cachen: ein zweiter Versuch (z. B. nach Netzwackler) soll neu laden.
    p.catch(() => loaded.delete(id));
    loaded.set(id, p);
  }
  return p;
}
