/**
 * Preload (sandboxed → CommonJS, nur `require('electron')` erlaubt, keine eigenen Module).
 * Gibt dem Renderer genau ein schmales Objekt `window.velocityDesktop` (Vertrag: src/platform/bridgeTypes.ts).
 * Kein ipcRenderer, kein Node-API nach außen — nur fest verdrahtete Kanäle mit geprüften Argumenten.
 * Kanalnamen gespiegelt in electron/policy.ts (IPC) — beide Seiten ändern.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAuthBegin, DesktopAuthResult, DesktopBridge, DisplayMode } from '../src/platform/bridgeTypes.js';
import type { DesktopSteamBridge, DesktopSteamStatus } from '../src/platform/bridgeTypes.js';

// Einmal synchron beim Laden: ob --dev aktiv ist (process.argv ist im Sandbox-Preload nicht verlässlich).
const dev = ipcRenderer.sendSync('vel:info') === true;

const bridge: DesktopBridge = {
  version: 1,
  versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' },
  dev,
  quit: () => ipcRenderer.send('vel:quit'),
  window: {
    getMode: () => ipcRenderer.invoke('vel:window:get') as Promise<DisplayMode>,
    setMode: (mode) => ipcRenderer.invoke('vel:window:set', mode === 'windowed' ? 'windowed' : 'fullscreen') as Promise<DisplayMode>,
    // Alt+Enter/F11 schaltet im Hauptprozess (C7) — der Renderer erfährt es nur hierüber.
    onModeChange: (cb) => {
      const fn = (_e: unknown, mode: unknown): void => cb(mode === 'windowed' ? 'windowed' : 'fullscreen');
      ipcRenderer.on('vel:window:mode', fn);
      return () => {
        ipcRenderer.removeListener('vel:window:mode', fn);
      };
    },
  },
  openExternal: (url) => ipcRenderer.invoke('vel:open-external', String(url)) as Promise<boolean>,
  saveMirror: {
    readSync: () => {
      const r: unknown = ipcRenderer.sendSync('vel:save:read');
      return typeof r === 'string' ? r : null;
    },
    write: (json) => ipcRenderer.invoke('vel:save:write', String(json)) as Promise<boolean>,
    writeSync: (json) => ipcRenderer.sendSync('vel:save:write-sync', String(json)) === true,
    // Windows-Abmeldung (query-session-end): kein pagehide — der Hauptprozess bittet ausdrücklich ums Sichern.
    onFlushRequest: (cb) => {
      const fn = (): void => cb();
      ipcRenderer.on('vel:save:flush', fn);
      return () => {
        ipcRenderer.removeListener('vel:save:flush', fn);
      };
    },
  },
  // S3 Desktop-Login (Plan 011 §3.1); Kanäle = AUTH_IPC in electron/auth.ts. Ohne Login-Modul lehnt invoke ab → Renderer meldet es.
  auth: {
    begin: () => ipcRenderer.invoke('vel:auth:begin') as Promise<DesktopAuthBegin>,
    openExternal: (url) => ipcRenderer.invoke('vel:auth:open', String(url)) as Promise<DesktopAuthResult>,
    cancel: () => {
      ipcRenderer.invoke('vel:auth:cancel').catch(() => undefined);
    },
    session: {
      read: async () => {
        const r: unknown = await ipcRenderer.invoke('vel:auth:session:read');
        return typeof r === 'string' ? r : null;
      },
      write: async (value) => (await ipcRenderer.invoke('vel:auth:session:write', String(value))) === true,
      remove: async () => (await ipcRenderer.invoke('vel:auth:session:remove')) === true,
    },
  },
};

// S4 Steam (Plan 011 Phase 4); Kanäle = STEAM_IPC in electron/steam.ts. Feld nur, wenn der Hauptprozess steamworks.js
// geladen hat (--steam) — init läuft erst nach dem ersten Bild, der Renderer wartet über ready().
const steam: DesktopSteamBridge | null =
  ipcRenderer.sendSync('vel:steam:requested') === true
    ? {
        ready: () => ipcRenderer.invoke('vel:steam:ready') as Promise<DesktopSteamStatus>,
        achievement: (name) => ipcRenderer.invoke('vel:steam:achievement', String(name)) as Promise<boolean>,
        presence: (key, value) => ipcRenderer.invoke('vel:steam:presence', String(key), value === null ? null : String(value)) as Promise<boolean>,
        onOverlay: (cb) => {
          const fn = (_e: unknown, active: unknown): void => cb(active === true);
          ipcRenderer.on('vel:steam:overlay', fn);
          return () => {
            ipcRenderer.removeListener('vel:steam:overlay', fn);
          };
        },
      }
    : null;

contextBridge.exposeInMainWorld('velocityDesktop', steam ? { ...bridge, steam } : bridge);
