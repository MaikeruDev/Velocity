// VELOCITY — Supabase Edge Function `submit-run` (Plan 009). Deno, verify_jwt = true.
//
// POST  Body: Replay-Bytes (application/octet-stream, packReplay) ODER JSON { "replay": "<base64>" }
//       Authorization: Bearer <Session-JWT eines Discord-Nutzers>
//   → 200 { valid: true, runId, time, timeMs, rank, total, personalBest, improved, previousMs, levelId, levelHash, physicsVersion }
//   → 200 { valid: false, reason, detail }            Replay ungültig (Verifier-Grund, z. B. desync/claim/config/assisted)
//   → 401 { error: 'auth' }                           kein Nutzer (z. B. nur anon-Key)
//   → 403 { error: 'banned' | 'noprofile' }
//   → 413 / 400 { error: 'size' | 'body' }
//   → 429 { error: 'rate', window: 'minute' | 'day' }
// GET   → { ok, physicsVersion, gameVersion, bundle, levels: [{ id, hash }], loadMs, loadVia, compileMs }  (Diagnose)
// OPTIONS → CORS-Preflight.
//
// Ablauf: Nutzer aus dem JWT (auth.getUser) → Ban-Check + Rate-Limit (claim_submit_slot) → Replay mit
// DEMSELBEN Verifier wie im Spiel nachspielen (verifier.bundle.js aus tools/online/build-function.mjs, SHA-256-gepinnt
// aus dem privaten Bucket 'function-assets' geladen)
// → bei persönlicher Bestzeit Replay nach Storage replays/<level>/<run>.vrp → record_verified_run (runs +
// best_runs-Upsert nur bei Verbesserung + Rang). Gewertet wird nur die nachgerechnete Zeit.

import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

/**
 * Verifier-Bundle (tools/online/build-function.mjs → verifier.bundle.js, ~680 KB mit Leveln). Liegt
 * inhaltsadressiert im privaten Bucket 'function-assets' (tools/online/upload-bundle.mjs) und wird beim Kaltstart
 * geladen; ausgeführt wird es NUR, wenn der SHA-256 diesem Wert entspricht (upload-bundle.mjs trägt ihn ein).
 * Grund: die MCP-Deploy-Schnittstelle überträgt Dateien als Text — das Bundle ist dafür zu groß.
 */
const BUNDLE_SHA256 = 'e02d9814f19ac2a22dce8f0aa38252252c277958da370c316358988391dd0e51';
const ASSET_BUCKET = 'function-assets';

// ---- Typen des Bundles (src/online/submitVerifier.ts) — bei Änderungen dort mitziehen.
interface ReplaySettings {
  readonly preset: string;
  readonly autoHop: boolean;
  readonly strafeAssist: boolean;
  readonly airControl: boolean;
}
type SubmissionResult =
  | {
      readonly valid: true;
      readonly levelId: string;
      readonly levelHash: string;
      readonly physicsVersion: number;
      readonly time: number;
      readonly timeMs: number;
      readonly ticks: number;
      readonly splitsMs: readonly number[];
      readonly settings: ReplaySettings;
      readonly assisted: boolean;
      readonly bytes: number;
    }
  | { readonly valid: false; readonly reason: string; readonly detail: string | null };
interface Verifier {
  level(levelId: string): { readonly hash: string } | null;
  verify(bytes: Uint8Array): Promise<SubmissionResult>;
}
interface Bundle {
  readonly createVerifier: () => Verifier;
  readonly GAME_VERSION: string;
  readonly PHYSICS_VERSION: number;
  readonly MAX_SUBMIT_BYTES: number;
  readonly LEVEL_IDS: readonly string[];
}

const PER_MINUTE = 20;
const PER_DAY = 500;
const BUCKET = 'replays';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** Neuer Secret-Key (sb_secret_…) bevorzugt, Legacy service_role als Rückfall. */
function adminKey(): string {
  try {
    const keys: unknown = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (typeof keys === 'object' && keys !== null && 'default' in keys) {
      const k = (keys as { default: unknown }).default;
      if (typeof k === 'string' && k.length > 0) return k;
    }
  } catch {
    // weiter mit dem Legacy-Key
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('Kein Admin-Key in der Function-Umgebung');
  return legacy;
}

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', adminKey(), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function isBundle(m: unknown): m is Bundle {
  return typeof m === 'object' && m !== null && typeof (m as { createVerifier?: unknown }).createVerifier === 'function';
}

/** ESM-Bundle ohne Modul-Lader ausführen: das abschließende `export{a as X,…}` wird zu `return {X: a, …}`. */
function evalEsm(code: string): unknown {
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(code);
  if (!m) throw new Error('Bundle ohne abschließendes export{…}');
  const props = m[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}: ${local}`;
    });
  return new Function(`${code.slice(0, m.index)}\nreturn { ${props.join(', ')} };`)();
}

async function loadBundle(): Promise<{ bundle: Bundle; ms: number; via: string }> {
  const t0 = performance.now();
  const { data, error } = await admin.storage.from(ASSET_BUCKET).download(`submit-run/verifier-${BUNDLE_SHA256}.js`);
  if (error || !data) throw new Error(`Verifier-Bundle nicht ladbar: ${error?.message ?? 'leer'}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== BUNDLE_SHA256) throw new Error(`Verifier-Bundle: SHA-256 ${digest} ≠ erwartet`);
  let mod: unknown = null;
  let via = 'import';
  try {
    mod = await import(`data:text/javascript;base64,${bytesToBase64(bytes)}`);
  } catch (err) {
    console.log(`submit-run: data:-Import nicht möglich (${err instanceof Error ? err.message : String(err)}), Function-Fallback`);
    mod = evalEsm(new TextDecoder().decode(bytes));
    via = 'function';
  }
  if (!isBundle(mod)) throw new Error('Verifier-Bundle ohne createVerifier');
  return { bundle: mod, ms: Math.round(performance.now() - t0), via };
}

let loaded: Promise<{ bundle: Bundle; verifier: Verifier; ms: number; via: string }> | null = null;
/** Einmal je Isolate laden; ein Fehlschlag wird beim nächsten Aufruf neu versucht. */
function engine(): Promise<{ bundle: Bundle; verifier: Verifier; ms: number; via: string }> {
  if (!loaded) {
    loaded = loadBundle().then((b) => ({ ...b, verifier: b.bundle.createVerifier() }));
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

// Kaltstart: Bundle schon beim Start der Instanz holen, nicht erst mit der ersten Einreichung.
void engine().catch((err) => console.error('submit-run: Bundle', err instanceof Error ? err.message : String(err)));

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function readReplay(req: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const len = Number(req.headers.get('content-length') ?? '0');
  // JSON/Base64 ist ~4/3 größer als die Bytes.
  if (len > maxBytes * 1.4 + 64) return json(413, { error: 'size', message: `Replay zu groß (${len} Bytes)` });
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes * 1.4 + 64) return json(413, { error: 'size', message: 'Replay zu groß' });
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(buf));
      if (typeof body === 'object' && body !== null && 'replay' in body && typeof (body as { replay: unknown }).replay === 'string') {
        return base64ToBytes((body as { replay: string }).replay);
      }
    } catch {
      // unten
    }
    return json(400, { error: 'body', message: 'JSON { replay: base64 } erwartet' });
  }
  return buf;
}

async function levelInfo(): Promise<Response> {
  const { bundle, verifier, ms, via } = await engine();
  const t0 = performance.now();
  const levels = bundle.LEVEL_IDS.map((id) => ({ id, hash: verifier.level(id)?.hash ?? null }));
  return json(200, {
    ok: true,
    physicsVersion: bundle.PHYSICS_VERSION,
    gameVersion: bundle.GAME_VERSION,
    bundle: BUNDLE_SHA256.slice(0, 12),
    levels,
    loadMs: ms,
    loadVia: via,
    compileMs: Math.round(performance.now() - t0),
  });
}

async function submit(req: Request): Promise<Response> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'auth', message: 'Anmeldung nötig' });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user ?? null;
  if (userErr || !user || user.is_anonymous) {
    console.log(`submit-run: kein Nutzer (${userErr?.message ?? 'anonym/leer'})`);
    return json(401, { error: 'auth', message: 'Mit Discord anmelden, um Läufe einzureichen' });
  }

  const slot = await admin.rpc('claim_submit_slot', { p_user: user.id, p_per_minute: PER_MINUTE, p_per_day: PER_DAY });
  if (slot.error) {
    console.error('claim_submit_slot', slot.error.message);
    return json(500, { error: 'server', message: 'Datenbank nicht erreichbar' });
  }
  if (slot.data === 'banned' || slot.data === 'noprofile') return json(403, { error: slot.data, message: slot.data === 'banned' ? 'Konto gesperrt' : 'Kein Spielerprofil' });
  if (slot.data === 'minute' || slot.data === 'day') {
    return json(429, { error: 'rate', window: slot.data, message: slot.data === 'minute' ? `Höchstens ${PER_MINUTE} Läufe pro Minute` : `Höchstens ${PER_DAY} Läufe pro Tag` });
  }

  const { bundle, verifier } = await engine();
  const bytes = await readReplay(req, bundle.MAX_SUBMIT_BYTES);
  if (bytes instanceof Response) return bytes;

  const t0 = performance.now();
  const res = await verifier.verify(bytes);
  const verifyMs = Math.round(performance.now() - t0);
  if (!res.valid) {
    console.log(`submit-run: abgelehnt ${res.reason} (${verifyMs} ms) ${res.detail ?? ''}`);
    return json(200, { valid: false, reason: res.reason, detail: res.detail });
  }

  // Replay nur hochladen, wenn es die neue persönliche Bestzeit ist (nur die braucht einen Ghost).
  const prev = await admin
    .from('best_runs')
    .select('time_ms')
    .eq('user_id', user.id)
    .eq('level_id', res.levelId)
    .eq('level_hash', res.levelHash)
    .eq('physics_version', res.physicsVersion)
    .maybeSingle();
  const prevMs = prev.data ? Number(prev.data.time_ms) : null;
  const runId = crypto.randomUUID();
  let path: string | null = null;
  if (prevMs === null || res.timeMs < prevMs) {
    path = `${res.levelId}/${runId}.vrp`;
    const up = await admin.storage.from(BUCKET).upload(path, new Blob([bytes], { type: 'application/octet-stream' }), {
      contentType: 'application/octet-stream',
      upsert: false,
      cacheControl: '31536000',
    });
    if (up.error) {
      console.error('storage upload', up.error.message);
      return json(500, { error: 'server', message: 'Replay konnte nicht gespeichert werden' });
    }
  }

  const rec = await admin.rpc('record_verified_run', {
    p_run_id: runId,
    p_user: user.id,
    p_level: res.levelId,
    p_level_hash: res.levelHash,
    p_physics: res.physicsVersion,
    p_time_ms: res.timeMs,
    p_ticks: res.ticks,
    p_splits: res.splitsMs,
    p_replay_path: path,
    p_replay_bytes: path ? res.bytes : null,
    p_settings: res.settings,
  });
  const row: unknown = Array.isArray(rec.data) ? rec.data[0] : null;
  if (rec.error || typeof row !== 'object' || row === null) {
    console.error('record_verified_run', rec.error?.message ?? 'keine Zeile');
    if (path) await admin.storage.from(BUCKET).remove([path]);
    return json(500, { error: 'server', message: 'Lauf konnte nicht gespeichert werden' });
  }
  const r = row as { rank: number; total: number; personal_best: boolean; improved: boolean; previous_ms: number | null };
  console.log(`submit-run: ${user.id} ${res.levelId} ${res.timeMs} ms → Rang ${r.rank}/${r.total} (${verifyMs} ms Prüfung)`);
  return json(200, {
    valid: true,
    runId,
    time: res.time,
    timeMs: res.timeMs,
    rank: Number(r.rank),
    total: Number(r.total),
    personalBest: r.personal_best,
    improved: r.improved,
    previousMs: r.previous_ms,
    levelId: res.levelId,
    levelHash: res.levelHash,
    physicsVersion: res.physicsVersion,
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') return await levelInfo();
    if (req.method !== 'POST') return json(405, { error: 'method' });
    return await submit(req);
  } catch (err) {
    console.error('submit-run', err instanceof Error ? err.stack ?? err.message : String(err));
    return json(500, { error: 'server', message: 'Interner Fehler' });
  }
});
