import type { CompiledLevel } from '../world/level/compileLevel';
import { FirebaseService } from './FirebaseService';
import { LocalMockService } from './LocalMockService';
import type { OnlineBackend, OnlineService } from './types';

export * from './types';
export { LocalMockService } from './LocalMockService';
export { FirebaseService } from './FirebaseService';

/**
 * Backend wählen (Plan 009): `VITE_ONLINE=mock|firebase|off` (Vite-Env, .env.local), Default mock.
 * `?online=off|mock` in der URL schlägt die Env (Tests, Offline-Fallback prüfen).
 */
export function onlineBackend(query?: string | null): OnlineBackend {
  const env: unknown = import.meta.env?.VITE_ONLINE;
  const pick = (v: unknown): OnlineBackend | null => (v === 'mock' || v === 'firebase' || v === 'off' ? v : null);
  return pick(query) ?? pick(env) ?? 'mock';
}

export interface OnlineDeps {
  readonly loadLevel: (levelId: string) => Promise<CompiledLevel>;
  /** Mock: simulierte Latenz (ms) und Ausfallrate. */
  readonly latencyMs?: number;
  readonly failRate?: number;
}

/** null = online aus (Offline-Spiel, alles Online-UI zeigt "offline"). */
export function createOnlineService(backend: OnlineBackend, deps: OnlineDeps): OnlineService | null {
  switch (backend) {
    case 'off':
      return null;
    case 'firebase':
      return new FirebaseService();
    case 'mock':
      return new LocalMockService({ loadLevel: deps.loadLevel, latencyMs: deps.latencyMs, failRate: deps.failRate });
  }
}
