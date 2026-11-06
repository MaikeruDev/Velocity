import { unpackReplay, ReplayFormatError } from '../engine/replay/codec';
import type { ReplaySettings } from '../engine/replay/format';
import { PHYSICS_VERSION } from '../engine/replay/format';
import { levelHash } from '../engine/replay/hash';
import { verifyReplay } from '../engine/replay/verify';
import { compileLevel } from '../world/level/compileLevel';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { LevelFile } from '../world/level/LevelFormat';

/**
 * Server-Prüfung einer Einreichung (Plan 009, Supabase Edge Function `submit-run`): Bytes → entpacken
 * (mit Größen-Deckel) → Level aus dem mitgebündelten public/levels → DERSELBE verifyReplay wie im Spiel und
 * in tools/replay/verify.ts. DOM-frei; läuft in Node (Tests), im Browser und in Deno (als esbuild-Bundle,
 * tools/online/build-function.mjs). Gewertet wird nur die nachgerechnete Zeit.
 */

/** Größte angenommene Einreichung (gepackt) — gleich dem Storage-Limit des Buckets 'replays'. */
export const MAX_SUBMIT_BYTES = 256 * 1024;
/** Größter entpackter Rumpf (20 min Lauf ≈ 0.5–1 MB) — Schutz gegen Deflate-Bomben. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface SubmissionAccepted {
  readonly valid: true;
  readonly levelId: string;
  readonly levelHash: string;
  readonly physicsVersion: number;
  /** Nachgerechnete Zeit (s). */
  readonly time: number;
  /** round(time · 1000) — so speichert die Datenbank (Ticks liegen 7.8 ms auseinander, Reihenfolge bleibt). */
  readonly timeMs: number;
  readonly ticks: number;
  /** Nachgerechnete Checkpoint-Zeiten (ms). */
  readonly splitsMs: readonly number[];
  readonly settings: ReplaySettings;
  readonly assisted: boolean;
  readonly bytes: number;
}

export interface SubmissionRejected {
  readonly valid: false;
  /** VerifyReason des Verifiers oder 'format' | 'size' | 'level' | 'assisted'. */
  readonly reason: string;
  readonly detail: string | null;
}

export type SubmissionResult = SubmissionAccepted | SubmissionRejected;

export interface SubmissionOptions {
  /** Bot/Override-Läufe ablehnen (Plan 009 §6.1). Default true; Tests mit Bot-Replays setzen false. */
  readonly rejectAssisted?: boolean;
}

export class SubmissionVerifier {
  private readonly files: Readonly<Record<string, LevelFile>>;
  private readonly compiled = new Map<string, { readonly level: CompiledLevel; readonly hash: string }>();

  /** files: Level-ID → Level-Datei (Inhalt von public/levels/<file>.json). */
  constructor(files: Readonly<Record<string, LevelFile>>) {
    this.files = files;
  }

  levelIds(): string[] {
    return Object.keys(this.files);
  }

  /** Kompiliertes Level + Hash (einmal je Instanz, Kaltstart-Kosten nur für benutzte Level). */
  level(levelId: string): { readonly level: CompiledLevel; readonly hash: string } | null {
    let c = this.compiled.get(levelId);
    if (!c) {
      if (!Object.prototype.hasOwnProperty.call(this.files, levelId)) return null;
      const level = compileLevel(this.files[levelId]);
      c = { level, hash: levelHash(level) };
      this.compiled.set(levelId, c);
    }
    return c;
  }

  async verify(bytes: Uint8Array, opts: SubmissionOptions = {}): Promise<SubmissionResult> {
    if (bytes.length === 0 || bytes.length > MAX_SUBMIT_BYTES) return reject('size', `Replay ${bytes.length} Bytes (erlaubt 1…${MAX_SUBMIT_BYTES})`);
    let rep;
    try {
      rep = await unpackReplay(bytes, { maxBodyBytes: MAX_BODY_BYTES });
    } catch (err) {
      return reject('format', err instanceof ReplayFormatError ? err.message : 'Replay unlesbar');
    }
    const h = rep.header;
    if ((opts.rejectAssisted ?? true) && h.assisted) return reject('assisted', 'Lauf mit Bot/Eingabe-Override aufgenommen');
    const lv = this.level(h.levelId);
    if (!lv) return reject('level', `Level ${h.levelId} unbekannt`);
    const res = verifyReplay(rep, lv.level, { levelId: h.levelId });
    if (!res.valid || res.time === null) return reject(res.reason ?? 'invalid', res.detail);
    return {
      valid: true,
      levelId: h.levelId,
      levelHash: lv.hash,
      physicsVersion: PHYSICS_VERSION,
      time: res.time,
      timeMs: Math.round(res.time * 1000),
      ticks: res.ticks,
      splitsMs: res.splits.map((s) => Math.round(s * 1000)),
      settings: h.settings,
      assisted: h.assisted,
      bytes: bytes.length,
    };
  }
}

function reject(reason: string, detail: string | null): SubmissionRejected {
  return { valid: false, reason, detail };
}
