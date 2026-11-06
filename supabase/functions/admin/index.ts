// VELOCITY — Supabase Edge Function `admin` (Plan 009 §15). Deno, verify_jwt = true.
//
// Entwickler-Aktionen, die mehr als eine Datenbank-Anweisung brauchen. Alles andere (Läufe/Spieler listen,
// Bann, Umbenennen, Protokoll) sind RPCs mit eigener Dev-Prüfung (Migration online_admin).
//
// POST JSON { action: 'deleteRun', runId: <uuid>, reason: <1–200 Zeichen> }
//       Authorization: Bearer <Session-JWT>
//   → 200 { ok: true, runId, userId, levelId, wasBest, newBestRunId, newBestMs, replayPath, replayRemoved }
//   → 400 { error: 'invalid' }    Eingabe ungültig (auch: Begründung fehlt)
//   → 401 { error: 'auth' }       kein Nutzer (anon-Key, abgelaufen)
//   → 403 { error: 'forbidden' }  angemeldet, aber kein Dev (Prüfung IN der Datenbank: admin_delete_run)
//   → 404 { error: 'notFound' }   Lauf unbekannt
// OPTIONS → CORS-Preflight.
//
// Sicherheit: Nutzer aus dem JWT per auth.getUser (vom Auth-Server geprüft, nie aus dem Body). admin_delete_run
// ist NUR für service_role ausführbar und prüft p_actor selbst auf role = 'dev' (nicht gebannt). Erst danach
// wird das Replay über die Storage-API gelöscht (nie direkt in storage.objects).

import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const BUCKET = 'replays';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** Neuer Secret-Key (sb_secret_…) bevorzugt, Legacy service_role als Rückfall (wie submit-run). */
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

/** SQLSTATE der Admin-RPCs → HTTP. */
function rpcError(err: { code?: string; message: string }): Response {
  if (err.code === '42501') return json(403, { error: 'forbidden', message: 'Nur für Entwickler' });
  if (err.code === '22023') return json(400, { error: 'invalid', message: err.message.replace(/^invalid:\s*/, '') });
  if (err.code === 'P0002') return json(404, { error: 'notFound', message: 'Lauf nicht gefunden' });
  console.error('admin rpc', err.code, err.message);
  return json(500, { error: 'server', message: 'Datenbankfehler' });
}

async function deleteRun(actor: string, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === 'string' ? body.runId : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!UUID.test(runId)) return json(400, { error: 'invalid', message: 'runId fehlt oder ist keine UUID' });
  if (reason.trim().length === 0 || reason.length > 200) return json(400, { error: 'invalid', message: 'Begründung nötig (1–200 Zeichen)' });

  const rec = await admin.rpc('admin_delete_run', { p_actor: actor, p_run: runId, p_reason: reason });
  if (rec.error) return rpcError(rec.error);
  const row: unknown = Array.isArray(rec.data) ? rec.data[0] : null;
  if (typeof row !== 'object' || row === null) return json(500, { error: 'server', message: 'keine Antwort' });
  const r = row as { user_id: string; level_id: string; replay_path: string | null; was_best: boolean; new_best_run_id: string | null; new_best_ms: number | null };

  let replayRemoved = false;
  if (r.replay_path) {
    const rm = await admin.storage.from(BUCKET).remove([r.replay_path]);
    // Lauf ist schon weg; ein verbliebenes Objekt ist nur Müll (kein runs-Eintrag zeigt mehr darauf).
    if (rm.error) console.error(`admin: Replay ${r.replay_path} nicht gelöscht: ${rm.error.message}`);
    else replayRemoved = true;
  }
  console.log(`admin: ${actor} löscht Lauf ${runId} (${r.level_id}, best=${r.was_best}, replay=${replayRemoved})`);
  return json(200, {
    ok: true,
    runId,
    userId: r.user_id,
    levelId: r.level_id,
    wasBest: r.was_best,
    newBestRunId: r.new_best_run_id,
    newBestMs: r.new_best_ms,
    replayPath: r.replay_path,
    replayRemoved,
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method' });
  try {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return json(401, { error: 'auth', message: 'Anmeldung nötig' });
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const user = userData?.user ?? null;
    if (userErr || !user || user.is_anonymous) return json(401, { error: 'auth', message: 'Anmeldung nötig' });

    let body: Record<string, unknown>;
    try {
      const j: unknown = await req.json();
      if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('kein Objekt');
      body = j as Record<string, unknown>;
    } catch {
      return json(400, { error: 'invalid', message: 'JSON-Objekt erwartet' });
    }
    if (body.action === 'deleteRun') return await deleteRun(user.id, body);
    return json(400, { error: 'invalid', message: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('admin', err instanceof Error ? (err.stack ?? err.message) : String(err));
    return json(500, { error: 'server', message: 'Interner Fehler' });
  }
});
