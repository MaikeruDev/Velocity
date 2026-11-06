/**
 * Desktop-Plattform: dünner Adapter auf das Preload-Bridge (`window.velocityDesktop`).
 * Bewusst OHNE Electron-Import — nur Typen aus bridgeTypes, damit das Web-Bundle frei von Node/Electron bleibt.
 */
import type { DesktopAuthBridge, DesktopBridge, DesktopSteamBridge } from './bridgeTypes';
import type { PlatformApi, PlatformSteam, PlatformSteamSession } from './types';

/** Login-Feld nur vollständig (älterer/fremder Bridge → kein Desktop-Login, Sitzung wie im Web). */
function authBridge(a: unknown): DesktopAuthBridge | null {
  if (typeof a !== 'object' || a === null) return null;
  const b = a as Partial<DesktopAuthBridge>;
  const s: unknown = b.session;
  const vault = typeof s === 'object' && s !== null ? (s as Partial<DesktopAuthBridge['session']>) : null;
  const ok =
    typeof b.begin === 'function' &&
    typeof b.openExternal === 'function' &&
    typeof b.cancel === 'function' &&
    vault !== null &&
    typeof vault.read === 'function' &&
    typeof vault.write === 'function' &&
    typeof vault.remove === 'function';
  return ok ? (a as DesktopAuthBridge) : null;
}

/** Steam-Feld nur vollständig (älterer/fremder Bridge → ohne Steam). */
function steamBridge(s: unknown): DesktopSteamBridge | null {
  if (typeof s !== 'object' || s === null) return null;
  const b = s as Partial<DesktopSteamBridge>;
  const ok = typeof b.ready === 'function' && typeof b.achievement === 'function' && typeof b.presence === 'function' && typeof b.onOverlay === 'function';
  return ok ? (s as DesktopSteamBridge) : null;
}

/** ready() fragt den Hauptprozess genau einmal; `onActive` setzt caps.steam, sobald eine Sitzung da ist. */
function desktopSteam(b: DesktopSteamBridge, onActive: () => void): PlatformSteam {
  let session: Promise<PlatformSteamSession | null> | null = null;
  const connect = async (): Promise<PlatformSteamSession | null> => {
    const st = await b.ready().catch(() => null);
    if (!st || st.active !== true) return null;
    onActive();
    return {
      appId: typeof st.appId === 'number' ? st.appId : 0,
      achievements: st.achievements === true,
      unlockAchievement: (name) => b.achievement(name).then((ok) => ok === true, () => false),
      setPresence: (key, value) => b.presence(key, value).then((ok) => ok === true, () => false),
      onOverlay: (cb) => b.onOverlay(cb),
    };
  };
  return { ready: () => (session ??= connect()) };
}

export function desktopPlatform(bridge: DesktopBridge): PlatformApi {
  // caps.steam folgt dem init im Hauptprozess (läuft nach dem ersten Bild): erst true mit aktiver Sitzung.
  const caps = { quit: true, displayMode: true, saveMirror: true, steam: false };
  const sb = steamBridge(bridge.steam);
  const steam = sb
    ? desktopSteam(sb, () => {
        caps.steam = true;
      })
    : null;
  void steam?.ready();
  return {
    kind: 'desktop',
    caps,
    dev: bridge.dev === true,
    // Objekt durchreichen statt Felder einzeln zu nennen: kein "electron"-Bezeichner im Web-Bundle (dist-Grep, 2.2).
    versions: bridge.versions,
    quit: () => bridge.quit(),
    window: {
      getMode: () => bridge.window.getMode(),
      setMode: (mode) => bridge.window.setMode(mode),
    },
    openExternal: (url) => bridge.openExternal(url),
    saveMirror: bridge.saveMirror,
    auth: authBridge(bridge.auth),
    steam,
  };
}
