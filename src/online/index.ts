import type { CompiledLevel } from '../world/level/compileLevel';
import { LocalMockService } from './LocalMockService';
import { SupabaseService } from './SupabaseService';
import type { OnlineBackend, OnlineService } from './types';

export * from './types';
export { LocalMockService } from './LocalMockService';
export { SupabaseService } from './SupabaseService';

/** Vite-Env, soweit die Online-Schicht sie liest (.env.local; nie Secrets — alles VITE_* landet im Browser). */
export interface OnlineEnv {
  readonly VITE_ONLINE?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

function viteEnv(): OnlineEnv {
  const env: unknown = import.meta.env;
  return typeof env === 'object' && env !== null ? (env as OnlineEnv) : {};
}

/**
 * Backend wählen (Plan 009): `?online=off|mock|supabase` in der URL schlägt `VITE_ONLINE`; ohne beides
 * Supabase, sobald VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY gesetzt sind, sonst mock. ('firebase' ist
 * verworfen und fällt auf den Default.)
 */
export function onlineBackend(query?: string | null, env: OnlineEnv = viteEnv()): OnlineBackend {
  const pick = (v: unknown): OnlineBackend | null => (v === 'mock' || v === 'supabase' || v === 'off' ? v : null);
  return pick(query) ?? pick(env.VITE_ONLINE) ?? (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY ? 'supabase' : 'mock');
}

export interface OnlineDeps {
  readonly loadLevel: (levelId: string) => Promise<CompiledLevel>;
  /** Mock: simulierte Latenz (ms) und Ausfallrate. */
  readonly latencyMs?: number;
  readonly failRate?: number;
  readonly env?: OnlineEnv;
}

/**
 * null = online aus (Offline-Spiel, alles Online-UI zeigt "offline"). Das Supabase-SDK (supabaseApi) wird erst
 * hier dynamisch geladen — eigener Chunk (~57 KB gzip), nur wenn das Backend gewählt ist.
 */
export async function createOnlineService(backend: OnlineBackend, deps: OnlineDeps): Promise<OnlineService | null> {
  switch (backend) {
    case 'off':
      return null;
    case 'supabase': {
      const env = deps.env ?? viteEnv();
      const url = env.VITE_SUPABASE_URL;
      const key = env.VITE_SUPABASE_ANON_KEY;
      if (!url || !key) return null;
      const { createSupabaseApi } = await import('./supabaseApi');
      return new SupabaseService({ api: createSupabaseApi(url, key), loadLevel: deps.loadLevel });
    }
    case 'mock':
      return new LocalMockService({ loadLevel: deps.loadLevel, latencyMs: deps.latencyMs, failRate: deps.failRate });
  }
}
