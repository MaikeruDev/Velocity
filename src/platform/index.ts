/**
 * `platform()`: Bridge vorhanden → desktop, sonst web (Plan 011 §2.2). Einmal bestimmt und gecacht —
 * das Bridge-Objekt setzt der Preload vor jedem Seitenskript, es kommt und geht nicht zur Laufzeit.
 */
import type { DesktopBridge } from './bridgeTypes';
import { desktopPlatform } from './desktop';
import type { PlatformApi } from './types';
import { WEB_PLATFORM } from './web';

export type { PlatformApi, PlatformCaps, PlatformKind, PlatformWindow, DisplayMode } from './types';

let cached: PlatformApi | null = null;

/** Minimalprüfung statt blindem Cast: ein fremdes `velocityDesktop` (Erweiterung, Test) macht nichts kaputt. */
export function isDesktopBridge(v: unknown): v is DesktopBridge {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Partial<DesktopBridge>;
  return b.version === 1 && typeof b.quit === 'function' && typeof b.window === 'object' && typeof b.saveMirror === 'object';
}

/** Plattform aus einem globalen Objekt bestimmen (Tests übergeben ein eigenes). */
export function detectPlatform(scope: { readonly velocityDesktop?: unknown } | undefined): PlatformApi {
  const bridge = scope?.velocityDesktop;
  return isDesktopBridge(bridge) ? desktopPlatform(bridge) : WEB_PLATFORM;
}

export function platform(): PlatformApi {
  if (!cached) cached = detectPlatform(typeof window === 'undefined' ? undefined : (window as { velocityDesktop?: unknown }));
  return cached;
}
