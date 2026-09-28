import type { Vector3 } from 'three';
import type { StorageLike } from './Settings';
import { defaultStorage } from './Settings';

/**
 * Ghost der Bestzeit (Plan 003, S7): Aufnahme, Kompression, Speicherung und
 * zeitsynchrone Wiedergabe. DOM-frei (Vitest).
 *
 * Aufnahme: GHOST_HZ Samples pro Sekunde, Sample k liegt exakt bei Laufzeit k/GHOST_HZ
 * (0 = Tick, in dem die Start-Zone verlassen wird — derselbe Nullpunkt wie der
 * RunState-Timer). Bei 128 und 64 Tick fällt jedes Sample genau auf einen Tick;
 * für andere Tickraten wird zwischen den beiden Ticks linear interpoliert.
 * Puffer vorab allokiert — im Tick-Pfad entsteht kein Objekt.
 *
 * Kein Ring im Wortsinn: ein Ring überschriebe den Start des Laufs, und ein Ghost
 * ohne Anfang ist wertlos. Läuft der Puffer über (> MAX_SECONDS), gilt die Aufnahme
 * als ungültig und wird nicht gespeichert.
 */

export const GHOST_HZ = 32;
/** Längster aufnehmbarer Lauf (s). 10 min × 32 Hz × 4 Floats = 300 KiB, einmal allokiert. */
const MAX_SECONDS = 600;
const CAPACITY = MAX_SECONDS * GHOST_HZ + 2;
/** Positions-Raster in u. 0.25 u sind bei 300 u/s unter 1 ms Zeitfehler — unsichtbar und billig. */
const POS_Q = 0.25;
/** Yaw-Raster: 1024 Stufen pro Umdrehung (0.35°). */
const YAW_STEPS = 1024;
/** Obergrenze pro Level im localStorage (Zeichen ≈ Bytes; Plan: < 40 KB). */
export const GHOST_MAX_CHARS = 40000;
export const GHOST_KEY_PREFIX = 'velocity.ghost.v1.';
const FORMAT_VERSION = 1;
/** So lange bleibt der Ghost nach seinem Ziel noch stehen, dann blendet er aus (s). */
const HOLD_AFTER_END = 0.6;
const TAU = Math.PI * 2;

/** Dekodierter Ghost: Samples im 32-Hz-Raster, Laufzeit und Checkpoint-Zeiten des Bestlaufs. */
export interface GhostTrack {
  readonly levelSig: string;
  /** Zielzeit (s, RunState-Timer). */
  readonly time: number;
  /** Kumulierte Checkpoint-Zeiten (s). */
  readonly splits: readonly number[];
  /** Anzahl Samples. */
  readonly count: number;
  /** x, y, z, yaw je Sample (Füße, Radiant). */
  readonly data: Float32Array;
}

/**
 * Nimmt einen Lauf auf. Game ruft reset() bei 'runStart' und sample() nach jedem
 * Tick mit laufendem Timer. Keine Allokation in sample().
 */
export class GhostRecorder {
  private readonly buf = new Float32Array(CAPACITY * 4);
  private n = 0;
  private overflow = false;
  private active = false;
  private prevT = 0;
  private lastYaw = 0;
  private readonly prevPos = new Float64Array(3);
  /** Geschwindigkeit zwischen den letzten beiden Ticks (u/s) — für das Schluss-Sample. */
  private readonly lastVel = new Float64Array(3);

  get count(): number {
    return this.n;
  }

  get recording(): boolean {
    return this.active;
  }

  /** Neuer Lauf: Sample 0 bei Laufzeit 0. */
  reset(): void {
    this.n = 0;
    this.overflow = false;
    this.active = true;
    this.prevT = -1;
  }

  /** Aufnahme verwerfen (Respawn vor dem Start, Levelwechsel). */
  stop(): void {
    this.active = false;
  }

  /**
   * Nach einem Tick: Laufzeit t (s) und Position/Yaw DIESES Ticks. Legt alle
   * Raster-Samples k/GHOST_HZ in (vorige Laufzeit, t] ab, linear zwischen den Ticks.
   */
  sample(t: number, pos: Vector3, yaw: number): void {
    if (!this.active) return;
    if (this.prevT < 0) {
      // Erster Tick (Timer steht auf 0): genau Sample 0.
      this.push(pos.x, pos.y, pos.z, yaw);
    } else {
      const span = t - this.prevT;
      // span > 0 immer (Timer + dt); der Fall 0 ist nur Schutz.
      // Sample k liegt bei k / GHOST_HZ; nächstes fälliges k = n.
      while (this.n / GHOST_HZ <= t + 1e-9 && !this.overflow) {
        const f = span > 0 ? (this.n / GHOST_HZ - this.prevT) / span : 1;
        const p = this.prevPos;
        this.push(p[0] + (pos.x - p[0]) * f, p[1] + (pos.y - p[1]) * f, p[2] + (pos.z - p[2]) * f, yaw);
      }
    }
    const span = this.prevT >= 0 ? t - this.prevT : 0;
    const inv = span > 0 ? 1 / span : 0;
    this.lastVel[0] = (pos.x - this.prevPos[0]) * inv;
    this.lastVel[1] = (pos.y - this.prevPos[1]) * inv;
    this.lastVel[2] = (pos.z - this.prevPos[2]) * inv;
    this.lastYaw = yaw;
    this.prevT = t;
    this.prevPos[0] = pos.x;
    this.prevPos[1] = pos.y;
    this.prevPos[2] = pos.z;
  }

  private push(x: number, y: number, z: number, yaw: number): void {
    if (this.n >= CAPACITY) {
      this.overflow = true;
      return;
    }
    const o = this.n * 4;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = z;
    this.buf[o + 3] = yaw;
    this.n++;
  }

  /** Fertige Aufnahme als Track (allokiert — nur beim Ziel aufrufen). null = unbrauchbar. */
  finish(levelSig: string, time: number, splits: readonly number[]): GhostTrack | null {
    this.active = false;
    // Ziel liegt meist zwischen zwei Raster-Samples: eines über das Ziel hinaus extrapolieren
    // (letzte Tick-Geschwindigkeit), sonst stünde der Ghost dort bis zu 1/32 s zu früh still.
    if (this.prevT >= 0 && (this.n - 1) / GHOST_HZ < time - 1e-9) {
      const dt = this.n / GHOST_HZ - this.prevT;
      const p = this.prevPos;
      const v = this.lastVel;
      this.push(p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt, this.lastYaw);
    }
    if (this.overflow || this.n < 2) return null;
    return { levelSig, time, splits: [...splits], count: this.n, data: this.buf.slice(0, this.n * 4) };
  }
}

// ------------------------------------------------------------------ Wiedergabe

/**
 * Ghost-Pose zur Laufzeit t in `out` (Füße) schreiben; Rückgabe Yaw (Radiant) oder
 * NaN, wenn der Ghost nicht (mehr) zu sehen ist. t < 0 = vor dem Start (Sample 0).
 */
export function ghostPoseAt(track: GhostTrack, t: number, out: Vector3): number {
  if (t > track.time + HOLD_AFTER_END) return Number.NaN;
  const last = track.count - 1;
  const u = Math.max(0, t) * GHOST_HZ;
  const i = Math.min(Math.floor(u), last);
  const j = Math.min(i + 1, last);
  const f = i === j ? 0 : u - i;
  const d = track.data;
  const a = i * 4;
  const b = j * 4;
  out.set(d[a] + (d[b] - d[a]) * f, d[a + 1] + (d[b + 1] - d[a + 1]) * f, d[a + 2] + (d[b + 2] - d[a + 2]) * f);
  // Yaw über den kürzeren Weg interpolieren.
  let dy = (d[b + 3] - d[a + 3]) % TAU;
  if (dy > Math.PI) dy -= TAU;
  else if (dy < -Math.PI) dy += TAU;
  return d[a + 3] + dy * f;
}

/** Differenz Lauf − Ghost am Checkpoint `index` (ab 1) bzw. im Ziel (index = 0). null = keine Referenz. */
export function ghostDiff(track: GhostTrack, index: number, runTime: number): number | null {
  const ref = index === 0 ? track.time : track.splits[index - 1];
  return ref !== undefined && Number.isFinite(ref) ? runTime - ref : null;
}

// ------------------------------------------------------------------ Kompression

/**
 * Binärformat (dann Base64): Varint-Kopf (Anzahl), dann je Sample x/y/z als
 * zweite Differenz im 0.25-u-Raster (Flugbahnen sind fast Parabeln → meist 1 Byte)
 * und Yaw als erste Differenz im 1024er-Raster, alles ZigZag-Varint.
 */
export function encodeSamples(data: Float32Array, count: number): string {
  const bytes: number[] = [];
  writeVarint(bytes, count);
  const prev1 = [0, 0, 0];
  const prev2 = [0, 0, 0];
  let prevYaw = 0;
  for (let k = 0; k < count; k++) {
    const o = k * 4;
    for (let c = 0; c < 3; c++) {
      const q = Math.round(data[o + c] / POS_Q);
      const pred = k === 0 ? 0 : k === 1 ? prev1[c] : 2 * prev1[c] - prev2[c];
      writeVarint(bytes, zigzag(q - pred));
      prev2[c] = prev1[c];
      prev1[c] = q;
    }
    const y = ((Math.round((data[o + 3] / TAU) * YAW_STEPS) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
    let dy = y - prevYaw;
    if (dy > YAW_STEPS / 2) dy -= YAW_STEPS;
    else if (dy < -YAW_STEPS / 2) dy += YAW_STEPS;
    writeVarint(bytes, zigzag(dy));
    prevYaw = y;
  }
  return toBase64(bytes);
}

export function decodeSamples(b64: string): { count: number; data: Float32Array } | null {
  const bytes = fromBase64(b64);
  if (!bytes) return null;
  const r = { i: 0 };
  const count = readVarint(bytes, r);
  if (count === null || count < 2 || count > CAPACITY) return null;
  const data = new Float32Array(count * 4);
  const prev1 = [0, 0, 0];
  const prev2 = [0, 0, 0];
  let prevYaw = 0;
  for (let k = 0; k < count; k++) {
    for (let c = 0; c < 3; c++) {
      const v = readVarint(bytes, r);
      if (v === null) return null;
      const pred = k === 0 ? 0 : k === 1 ? prev1[c] : 2 * prev1[c] - prev2[c];
      const q = pred + unzigzag(v);
      prev2[c] = prev1[c];
      prev1[c] = q;
      data[k * 4 + c] = q * POS_Q;
    }
    const v = readVarint(bytes, r);
    if (v === null) return null;
    const y = (((prevYaw + unzigzag(v)) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
    prevYaw = y;
    data[k * 4 + 3] = (y / YAW_STEPS) * TAU;
  }
  return r.i === bytes.length ? { count, data } : null;
}

function zigzag(v: number): number {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

function unzigzag(v: number): number {
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

function writeVarint(out: number[], v: number): void {
  // Zahlen bis 2^53 — keine Bit-Operatoren (die kappen auf 32 Bit).
  let x = v;
  while (x >= 128) {
    out.push((x % 128) + 128);
    x = Math.floor(x / 128);
  }
  out.push(x);
}

function readVarint(bytes: Uint8Array, r: { i: number }): number | null {
  let v = 0;
  let mul = 1;
  for (let n = 0; n < 8; n++) {
    if (r.i >= bytes.length) return null;
    const b = bytes[r.i++];
    v += (b % 128) * mul;
    if (b < 128) return v;
    mul *= 128;
  }
  return null;
}

function toBase64(bytes: readonly number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.slice(i, i + 4096));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Speicher

interface StoredGhost {
  readonly v: number;
  readonly sig: string;
  readonly time: number;
  readonly splits: readonly number[];
  readonly hz: number;
  readonly data: string;
}

function isStoredGhost(v: unknown): v is StoredGhost {
  if (typeof v !== 'object' || v === null) return false;
  const o: Record<string, unknown> = { ...v };
  return (
    o.v === FORMAT_VERSION &&
    typeof o.sig === 'string' &&
    typeof o.time === 'number' &&
    Number.isFinite(o.time) &&
    Array.isArray(o.splits) &&
    o.splits.every((x) => typeof x === 'number') &&
    o.hz === GHOST_HZ &&
    typeof o.data === 'string'
  );
}

/** Ein Ghost pro Level in localStorage (Schlüssel versioniert). Fehlt Storage, bleibt er nur in der Sitzung. */
export class GhostStore {
  private readonly storage: StorageLike | null;
  private readonly memory = new Map<string, GhostTrack>();

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
  }

  /** Ghost für das Level, nur wenn er zur aktuellen Level-Geometrie passt. */
  load(levelId: string, levelSig: string): GhostTrack | null {
    const mem = this.memory.get(levelId);
    if (mem) return mem.levelSig === levelSig ? mem : null;
    if (!this.storage) return null;
    let raw: unknown = null;
    try {
      const s = this.storage.getItem(GHOST_KEY_PREFIX + levelId);
      raw = s === null ? null : JSON.parse(s);
    } catch {
      return null;
    }
    if (!isStoredGhost(raw) || raw.sig !== levelSig) return null;
    const dec = decodeSamples(raw.data);
    if (!dec) return null;
    const track: GhostTrack = { levelSig: raw.sig, time: raw.time, splits: raw.splits, count: dec.count, data: dec.data };
    this.memory.set(levelId, track);
    return track;
  }

  /**
   * Neuen Bestlauf ablegen. Zurück: gespeicherte Zeichen, 0 = nur im Speicher
   * (zu groß oder Storage voll — der alte Ghost wird dann gelöscht, er gehört nicht mehr zur Bestzeit).
   */
  save(levelId: string, track: GhostTrack): number {
    this.memory.set(levelId, track);
    const entry: StoredGhost = {
      v: FORMAT_VERSION,
      sig: track.levelSig,
      time: track.time,
      splits: track.splits,
      hz: GHOST_HZ,
      data: encodeSamples(track.data, track.count),
    };
    const json = JSON.stringify(entry);
    if (!this.storage) return 0;
    try {
      if (json.length > GHOST_MAX_CHARS) {
        this.storage.removeItem(GHOST_KEY_PREFIX + levelId);
        return 0;
      }
      this.storage.setItem(GHOST_KEY_PREFIX + levelId, json);
      return json.length;
    } catch {
      return 0;
    }
  }

  /** Länge des gespeicherten Eintrags (Zeichen), 0 = keiner. */
  storedChars(levelId: string): number {
    try {
      return this.storage?.getItem(GHOST_KEY_PREFIX + levelId)?.length ?? 0;
    } catch {
      return 0;
    }
  }

  clear(levelId: string): void {
    this.memory.delete(levelId);
    try {
      this.storage?.removeItem(GHOST_KEY_PREFIX + levelId);
    } catch {
      // Storage gesperrt — nichts zu löschen.
    }
  }
}

/** Fingerabdruck der Level-Geometrie: ein Ghost aus einem umgebauten Level führt in die Irre. */
export function levelSignature(def: {
  readonly brushes: readonly unknown[];
  readonly triggers: readonly unknown[];
  readonly spawn: { readonly pos: readonly number[] };
  readonly killY: number;
}): string {
  // FNV-1a über die Brush-/Trigger-Daten — billig, einmal pro Levelstart.
  const text = JSON.stringify([def.brushes, def.triggers, def.spawn.pos, def.killY]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
