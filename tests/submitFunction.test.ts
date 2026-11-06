import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordBotRun } from '../src/engine/replay/botRun';
import { packReplay, unpackReplay } from '../src/engine/replay/codec';
import { levelHash } from '../src/engine/replay/hash';
import { verifyReplay } from '../src/engine/replay/verify';
import { MAX_SUBMIT_BYTES, SubmissionVerifier } from '../src/online/submitVerifier';
import type { SubmissionResult } from '../src/online/submitVerifier';
import { loadLevelById } from '../tools/replay/levels';
import type { LevelFile } from '../src/world/level/LevelFormat';

/**
 * Plan 009 (Supabase): das Verifier-Bundle der Edge Function `submit-run` (esbuild, eine ESM-Datei) prüft
 * GENAU wie der Node-Verifier (tools/replay/verify.ts) — gleiche Gültigkeit, bitgleiche Zeit, gleicher Level-Hash.
 * Außerdem: das eingecheckte Bundle ist aktuell (frisch gebaut = byte-gleich), sonst prüft der Server alten Stand.
 */

interface BundleModule {
  createVerifier(): { verify(bytes: Uint8Array, opts?: { rejectAssisted?: boolean }): Promise<SubmissionResult>; level(id: string): { hash: string } | null };
  LEVEL_IDS: readonly string[];
  PHYSICS_VERSION: number;
  MAX_SUBMIT_BYTES: number;
}

const LEVELS = ['level1', 'level2', 'level3', 'level4'];
const COMMITTED = join(process.cwd(), 'supabase', 'functions', 'submit-run', 'verifier.bundle.js');

let bundle: BundleModule;
let freshPath = '';
const packed = new Map<string, Uint8Array>();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vel-fn-'));
  freshPath = join(dir, 'verifier.bundle.js');
  execFileSync(process.execPath, [join('tools', 'online', 'build-function.mjs'), '--out', freshPath], { cwd: process.cwd(), stdio: 'pipe' });
  bundle = (await import(pathToFileURL(freshPath).href)) as BundleModule;
  for (const id of LEVELS) {
    const rep = recordBotRun(loadLevelById(id), { follower: { aimNoiseDeg: 1, seed: 1 } });
    if (!rep) throw new Error(`Bot kam in ${id} nicht ins Ziel`);
    packed.set(id, await packReplay(rep));
  }
}, 120_000);

describe('submit-run: Verifier-Bundle', () => {
  it('eingechecktes Bundle ist aktuell (node tools/online/build-function.mjs)', () => {
    const fresh = readFileSync(freshPath);
    const committed = readFileSync(COMMITTED);
    expect(committed.equals(fresh), 'supabase/functions/submit-run/verifier.bundle.js veraltet — neu bauen und deployen').toBe(true);
  });

  it('index.ts pinnt genau dieses Bundle (SHA-256, tools/online/upload-bundle.mjs)', () => {
    const sha = createHash('sha256').update(readFileSync(COMMITTED)).digest('hex');
    const index = readFileSync(join(process.cwd(), 'supabase', 'functions', 'submit-run', 'index.ts'), 'utf8');
    expect(/const BUNDLE_SHA256 = '([0-9a-f]{64})'/.exec(index)?.[1], 'Bundle hochladen + index.ts neu deployen').toBe(sha);
  });

  it('enthält genau die vier Level aus index.json, gleiche Hashes wie im Spiel', () => {
    expect([...bundle.LEVEL_IDS]).toEqual(LEVELS);
    const v = bundle.createVerifier();
    for (const id of LEVELS) expect(v.level(id)?.hash).toBe(levelHash(loadLevelById(id)));
    expect(bundle.MAX_SUBMIT_BYTES).toBe(MAX_SUBMIT_BYTES);
  });

  it('Bot-Replays L1–L4: Bundle = Node-Verifier (gültig, bitgleiche Zeit, Splits)', async () => {
    const v = bundle.createVerifier();
    for (const id of LEVELS) {
      const bytes = packed.get(id);
      if (!bytes) throw new Error(id);
      const node = verifyReplay(await unpackReplay(bytes), loadLevelById(id));
      expect(node.valid, id).toBe(true);
      const res = await v.verify(bytes, { rejectAssisted: false });
      if (!res.valid) throw new Error(`${id}: ${res.reason} ${res.detail ?? ''}`);
      expect(res.levelId).toBe(id);
      expect(res.time).toBe(node.time);
      expect(res.timeMs).toBe(Math.round((node.time ?? 0) * 1000));
      expect(res.splitsMs).toEqual(node.splits.map((s) => Math.round(s * 1000)));
      expect(res.physicsVersion).toBe(bundle.PHYSICS_VERSION);
    }
  });

  it('Bot/Override-Läufe lehnt der Server ab (assisted)', async () => {
    const res = await bundle.createVerifier().verify(packed.get('level1') ?? new Uint8Array());
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('assisted');
  });

  it('kaputte, zu große und manipulierte Einreichungen', async () => {
    const v = bundle.createVerifier();
    const junk = await v.verify(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(junk.valid ? null : junk.reason).toBe('format');
    const big = await v.verify(new Uint8Array(MAX_SUBMIT_BYTES + 1));
    expect(big.valid ? null : big.reason).toBe('size');
    // Behauptete Zeit um einen Tick geschönt → der Verifier rechnet nach (claim).
    const rep = await unpackReplay(packed.get('level2') ?? new Uint8Array());
    const forged = await packReplay({ ...rep, header: { ...rep.header, time: rep.header.time - 1 / 128 } });
    const res = await v.verify(forged, { rejectAssisted: false });
    expect(res.valid ? null : res.reason).toBe('claim');
  });

  it('Deflate-Bombe: entpackter Rumpf über dem Deckel → format, ohne den Speicher zu füllen', async () => {
    // 64 MB Nullen → deflate-raw ~64 KB; der Deckel (4 MB) bricht beim Lesen ab.
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const z = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const bytes = new Uint8Array(z.length + 5);
    bytes.set([0x56, 0x52, 0x50, 1, 1]);
    bytes.set(z, 5);
    expect(bytes.length).toBeLessThan(MAX_SUBMIT_BYTES);
    const res = await bundle.createVerifier().verify(bytes);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.detail ?? '').toMatch(/größer als/);
  });

  it('Quell-Verifier (SubmissionVerifier) und Bundle liefern dasselbe', async () => {
    const files: Record<string, LevelFile> = {};
    const dir = join(process.cwd(), 'public', 'levels');
    for (const id of LEVELS) files[id] = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as LevelFile;
    const src = new SubmissionVerifier(files);
    const bytes = packed.get('level3') ?? new Uint8Array();
    expect(await src.verify(bytes, { rejectAssisted: false })).toEqual(await bundle.createVerifier().verify(bytes, { rejectAssisted: false }));
  });
});
