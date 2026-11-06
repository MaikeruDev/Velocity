/** Web-Plattform (Default): keine Desktop-Fähigkeiten, alles no-op — das Spiel verhält sich wie bisher. */
import type { PlatformApi } from './types';

export const WEB_PLATFORM: PlatformApi = {
  kind: 'web',
  caps: { quit: false, displayMode: false, saveMirror: false, steam: false },
  dev: false,
  versions: null,
  quit: () => {},
  window: null,
  openExternal: (url) => {
    // Ohne 'noopener' im Feature-String: damit liefert window.open laut Spec IMMER null (Ergebnis wäre stets false).
    // Stattdessen den Opener sofort kappen — die neue Seite bekommt trotzdem keinen Zugriff auf window.opener.
    const w = typeof window === 'undefined' ? null : window.open(url, '_blank');
    if (w) w.opener = null;
    return Promise.resolve(w !== null);
  },
  saveMirror: null,
  auth: null,
  steam: null,
};
