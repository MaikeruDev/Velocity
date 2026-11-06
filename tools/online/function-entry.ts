/**
 * Einstieg des Verifier-Bundles für die Supabase Edge Function `submit-run` (Plan 009). esbuild
 * (tools/online/build-function.mjs) bündelt das zu EINER ESM-Datei für Deno: SubmissionVerifier (=
 * src/engine/replay/verify.ts + Physik + compileLevel + three) und die Level aus public/levels
 * (virtuelles Modul `velocity:levels`, nur die Level aus index.json — kein Training, keine Sandbox).
 */
import levels from 'velocity:levels';
import { GAME_VERSION, PHYSICS_VERSION } from '../../src/engine/replay/format';
import { MAX_SUBMIT_BYTES, SubmissionVerifier } from '../../src/online/submitVerifier';

export type { SubmissionAccepted, SubmissionRejected, SubmissionResult } from '../../src/online/submitVerifier';
export { GAME_VERSION, MAX_SUBMIT_BYTES, PHYSICS_VERSION, SubmissionVerifier };

/** Verifier mit den mitgebündelten Leveln (einmal je Function-Instanz anlegen). */
export function createVerifier(): SubmissionVerifier {
  return new SubmissionVerifier(levels);
}

export const LEVEL_IDS: readonly string[] = Object.keys(levels);
