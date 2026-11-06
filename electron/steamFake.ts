/**
 * Fake-steamworks (Plan 011 Phase 4) für Vitest und die Hülle (`--dev --steam --steam-fake[=fail]`): dieselbe Form
 * wie steamworks.js 0.4.0 — plus GameOverlayActivated, das 0.4.0 fehlt, damit der Pause-Pfad prüfbar ist —, spricht
 * aber nie mit einem Steam-Client. Aufrufe stehen in `calls`; Werkzeuge erreichen den Fake der laufenden Hülle im
 * Hauptprozess über `globalThis.__velSteamFake` (app.evaluate).
 */
import type { SteamClientLike, SteamworksLike } from './steam.js';

export interface FakeSteamCall {
  readonly fn: string;
  readonly args: readonly unknown[];
}

export interface FakeSteamworks extends SteamworksLike {
  readonly calls: FakeSteamCall[];
  /** Diese Namen lehnt activate() ab (Steam-Fehler nachstellen). */
  readonly failNames: Set<string>;
  /** Overlay öffnen/schließen wie der Client: ruft die registrierten GameOverlayActivated-Handler. */
  overlay(active: boolean): void;
}

export interface FakeSteamOptions {
  /** init wirft wie ohne laufenden Client ("Steam is not running"). */
  readonly failInit?: boolean;
  /** Wird als App-ID gemeldet (Standard 480). */
  readonly appId?: number;
}

/** Wert des Fake-Callbacks (frei gewählt, nicht in 0.4.0). */
export const FAKE_OVERLAY_CALLBACK = 99;

export function createFakeSteamworks(opts: FakeSteamOptions = {}): FakeSteamworks {
  const calls: FakeSteamCall[] = [];
  const failNames = new Set<string>();
  const handlers = new Map<number, Set<(value: unknown) => void>>();
  let appId = 0;
  const client: SteamClientLike = {
    achievement: {
      activate: (name) => {
        calls.push({ fn: 'achievement.activate', args: [name] });
        return !failNames.has(name);
      },
    },
    localplayer: {
      setRichPresence: (key, value) => {
        calls.push({ fn: 'localplayer.setRichPresence', args: [key, value ?? null] });
      },
    },
    utils: { getAppId: () => appId },
    callback: {
      register: (id, handler) => {
        calls.push({ fn: 'callback.register', args: [id] });
        let set = handlers.get(id);
        if (!set) {
          set = new Set();
          handlers.set(id, set);
        }
        const own = set;
        own.add(handler);
        return {
          disconnect: () => {
            calls.push({ fn: 'callback.disconnect', args: [id] });
            own.delete(handler);
          },
        };
      },
    },
  };
  const fake: FakeSteamworks = {
    calls,
    failNames,
    SteamCallback: { PersonaStateChange: 0, SteamServersConnected: 1, GameOverlayActivated: FAKE_OVERLAY_CALLBACK },
    init: (id) => {
      calls.push({ fn: 'init', args: [id] });
      if (opts.failInit) throw new Error('Steam is not running (Fake)');
      appId = opts.appId ?? id;
      return client;
    },
    electronEnableSteamOverlay: (disable) => {
      // Bewusst ohne echte Chromium-Schalter: der Fake misst nur, OB sie gesetzt würden.
      calls.push({ fn: 'electronEnableSteamOverlay', args: [disable ?? false] });
    },
    overlay: (active) => {
      for (const h of handlers.get(FAKE_OVERLAY_CALLBACK) ?? []) h({ active });
    },
  };
  (globalThis as { __velSteamFake?: FakeSteamworks }).__velSteamFake = fake;
  return fake;
}
