import type { MovementPresetId } from '../../player/MovementConfig';
import type { Replay, ReplayEvent, ReplayHeader } from './format';
import { KEYFRAME_EVERY, MAX_REPLAY_EVENTS, MAX_REPLAY_TICKS, MAX_SPLITS, PRESET_IDS, REPLAY_FORMAT_VERSION } from './format';

/**
 * Binärkodierung der Replays (Plan 009 §3). DOM-frei; Kompression über `CompressionStream`
 * ('deflate-raw' — gibt es im Browser UND in Node ≥ 18, also kein zlib-Sonderweg).
 *
 * Container: 'V' 'R' 'P' Version, Flags (1 = Rumpf deflate-raw), Rumpf.
 * Rumpf: Kopf (Strings als Varint-Länge + UTF-16-Codes als Varints, Zahlen als Varint/f64/f32),
 * Ereignisse (Tick-Deltas), dann die Tick-Ströme:
 * - Tasten: Lauflängen (Byte, Varint-Länge) — Tasten ändern sich selten.
 * - Yaw: erster Wert, danach ZWEITE Differenzen, Nullen als Lauflänge — die Maus wird pro Frame
 *   gesampelt und nach Tick-Zeit linear verteilt (fallen.md #45), innerhalb eines Frames ist die zweite
 *   Differenz also 0.
 * - Pitch: erste Differenzen mit Null-Lauflängen.
 * - Keyframes: Float32 roh.
 * Ergebnis (L1–L4, Bot-Läufe): siehe Plan 009 §3 (Größen-Tabelle) und tests/replay.test.ts.
 */

const MAGIC0 = 0x56; // V
const MAGIC1 = 0x52; // R
const MAGIC2 = 0x50; // P
const FLAG_DEFLATE = 1;

export class ReplayFormatError extends Error {}

// ------------------------------------------------------------------ Schreiben

class ByteWriter {
  private buf = new Uint8Array(4096);
  private n = 0;
  private readonly f64 = new Float64Array(1);
  private readonly f32 = new Float32Array(1);
  private readonly b64 = new Uint8Array(this.f64.buffer);
  private readonly b32 = new Uint8Array(this.f32.buffer);

  private ensure(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.n++] = v & 0xff;
  }

  /** Nicht-negative Ganzzahl bis 2^53 — ohne Bit-Operatoren (die kappen auf 32 Bit). */
  varint(v: number): void {
    let x = v;
    while (x >= 128) {
      this.byte((x % 128) + 128);
      x = Math.floor(x / 128);
    }
    this.byte(x);
  }

  svarint(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  f64le(v: number): void {
    this.f64[0] = v;
    this.ensure(8);
    // Plattform-Endianness egal: wir schreiben in Little Endian.
    for (let i = 0; i < 8; i++) this.buf[this.n++] = this.b64[LE ? i : 7 - i];
  }

  f32le(v: number): void {
    this.f32[0] = v;
    this.ensure(4);
    for (let i = 0; i < 4; i++) this.buf[this.n++] = this.b32[LE ? i : 3 - i];
  }

  str(s: string): void {
    this.varint(s.length);
    for (let i = 0; i < s.length; i++) this.varint(s.charCodeAt(i));
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ------------------------------------------------------------------ Lesen

class ByteReader {
  private i = 0;
  private readonly f64 = new Float64Array(1);
  private readonly f32 = new Float32Array(1);
  private readonly b64 = new Uint8Array(this.f64.buffer);
  private readonly b32 = new Uint8Array(this.f32.buffer);

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.i >= this.buf.length;
  }

  byte(): number {
    if (this.i >= this.buf.length) throw new ReplayFormatError('Replay abgeschnitten');
    return this.buf[this.i++];
  }

  varint(): number {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      const b = this.byte();
      v += (b % 128) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
    throw new ReplayFormatError('Varint zu lang');
  }

  svarint(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  f64le(): number {
    for (let k = 0; k < 8; k++) this.b64[LE ? k : 7 - k] = this.byte();
    return this.f64[0];
  }

  f32le(): number {
    for (let k = 0; k < 4; k++) this.b32[LE ? k : 3 - k] = this.byte();
    return this.f32[0];
  }

  str(max = 256): string {
    const n = this.varint();
    if (n > max) throw new ReplayFormatError('Text zu lang');
    let s = '';
    for (let k = 0; k < n; k++) {
      const c = this.varint();
      if (c > 0xffff) throw new ReplayFormatError('Zeichen ungültig');
      s += String.fromCharCode(c);
    }
    return s;
  }
}

// ------------------------------------------------------------------ Ströme

/** Werte mit Null-Lauflängen: 0 → Marke 0 + (Länge − 1), sonst ZigZag(v) (nie 0). */
function writeZeroRun(w: ByteWriter, values: ArrayLike<number>, count: number): void {
  let i = 0;
  while (i < count) {
    const v = values[i];
    if (v === 0) {
      let r = 1;
      while (i + r < count && values[i + r] === 0) r++;
      w.varint(0);
      w.varint(r - 1);
      i += r;
    } else {
      w.svarint(v);
      i++;
    }
  }
}

function readZeroRun(r: ByteReader, out: Float64Array, count: number): void {
  let i = 0;
  while (i < count) {
    const t = r.varint();
    if (t === 0) {
      const run = r.varint() + 1;
      if (i + run > count) throw new ReplayFormatError('Lauflänge über das Ende');
      for (let k = 0; k < run; k++) out[i++] = 0;
    } else out[i++] = t % 2 === 0 ? t / 2 : -(t + 1) / 2;
  }
}

// ------------------------------------------------------------------ Rumpf

/** Rumpf ohne Kompression (sync, Tests). */
export function encodeReplayBody(rep: Replay): Uint8Array {
  const h = rep.header;
  const n = h.ticks;
  const w = new ByteWriter();
  w.str(h.gameVersion);
  w.varint(h.physicsVersion);
  w.str(h.levelId);
  w.str(h.levelHash);
  w.str(h.configHash);
  w.varint(h.tickRate);
  const preset = PRESET_IDS.indexOf(h.settings.preset);
  if (preset < 0) throw new ReplayFormatError(`Preset ${h.settings.preset} unbekannt`);
  w.byte(preset);
  w.byte((h.settings.autoHop ? 1 : 0) | (h.settings.strafeAssist ? 2 : 0) | (h.settings.airControl ? 4 : 0) | (h.assisted ? 8 : 0));
  w.varint(n);
  w.varint(h.startTick + 1);
  w.varint(h.finishTick + 1);
  w.f64le(h.time);
  w.varint(h.splitTicks.length);
  for (const t of h.splitTicks) w.varint(t);
  w.f32le(h.endPos[0]);
  w.f32le(h.endPos[1]);
  w.f32le(h.endPos[2]);

  w.varint(rep.events.length);
  let prev = 0;
  for (const e of rep.events) {
    w.varint(e.tick - prev);
    w.byte(0); // kind 0 = respawn
    prev = e.tick;
  }

  // Tasten als Lauflängen.
  let i = 0;
  while (i < n) {
    const b = rep.buttons[i];
    let run = 1;
    while (i + run < n && rep.buttons[i + run] === b) run++;
    w.byte(b);
    w.varint(run - 1);
    i += run;
  }

  // Yaw: erster Wert, dann zweite Differenzen.
  const d2 = new Float64Array(n);
  if (n > 0) {
    let pd = 0;
    for (let k = 1; k < n; k++) {
      const d = rep.yaw[k] - rep.yaw[k - 1];
      d2[k] = d - pd;
      pd = d;
    }
    w.svarint(rep.yaw[0]);
    writeZeroRun(w, d2.subarray(1), n - 1);
  }
  // Pitch: erste Differenzen.
  const d1 = new Float64Array(n);
  for (let k = 0; k < n; k++) d1[k] = rep.pitch[k] - (k > 0 ? rep.pitch[k - 1] : 0);
  writeZeroRun(w, d1, n);

  const kf = Math.floor(n / KEYFRAME_EVERY);
  for (let k = 0; k < kf * 3; k++) w.f32le(rep.keyframes[k]);
  return w.bytes();
}

export function decodeReplayBody(bytes: Uint8Array): Replay {
  const r = new ByteReader(bytes);
  const gameVersion = r.str(32);
  const physicsVersion = r.varint();
  const levelId = r.str(64);
  const levelHash = r.str(32);
  const configHash = r.str(32);
  const tickRate = r.varint();
  const preset: MovementPresetId | undefined = PRESET_IDS[r.byte()];
  if (preset === undefined) throw new ReplayFormatError('Preset unbekannt');
  const flags = r.byte();
  const n = r.varint();
  if (n < 1 || n > MAX_REPLAY_TICKS) throw new ReplayFormatError(`Tickzahl ${n} außerhalb 1…${MAX_REPLAY_TICKS}`);
  const startTick = r.varint() - 1;
  const finishTick = r.varint() - 1;
  const time = r.f64le();
  const ns = r.varint();
  if (ns > MAX_SPLITS) throw new ReplayFormatError('Zu viele Checkpoints');
  const splitTicks: number[] = [];
  for (let k = 0; k < ns; k++) splitTicks.push(r.varint());
  const endPos: [number, number, number] = [r.f32le(), r.f32le(), r.f32le()];

  const ne = r.varint();
  if (ne > MAX_REPLAY_EVENTS) throw new ReplayFormatError('Zu viele Ereignisse');
  const events: ReplayEvent[] = [];
  let tick = 0;
  for (let k = 0; k < ne; k++) {
    tick += r.varint();
    if (r.byte() !== 0) throw new ReplayFormatError('Ereignis-Art unbekannt');
    events.push({ tick, kind: 'respawn' });
  }

  const buttons = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const b = r.byte();
    const run = r.varint() + 1;
    if (i + run > n) throw new ReplayFormatError('Tasten-Lauflänge über das Ende');
    buttons.fill(b, i, i + run);
    i += run;
  }

  const yaw = new Float64Array(n);
  yaw[0] = r.svarint();
  const d2 = new Float64Array(n);
  readZeroRun(r, d2.subarray(1), n - 1);
  let d = 0;
  for (let k = 1; k < n; k++) {
    d += d2[k];
    yaw[k] = yaw[k - 1] + d;
  }

  const d1 = new Float64Array(n);
  readZeroRun(r, d1, n);
  const pitch = new Int16Array(n);
  let p = 0;
  for (let k = 0; k < n; k++) {
    p += d1[k];
    if (p < -32768 || p > 32767) throw new ReplayFormatError('Pitch außerhalb');
    pitch[k] = p;
  }

  const kf = Math.floor(n / KEYFRAME_EVERY);
  const keyframes = new Float32Array(kf * 3);
  for (let k = 0; k < kf * 3; k++) keyframes[k] = r.f32le();
  if (!r.done) throw new ReplayFormatError('Daten nach dem Ende');

  const header: ReplayHeader = {
    gameVersion,
    physicsVersion,
    levelId,
    levelHash,
    configHash,
    tickRate,
    settings: { preset, autoHop: (flags & 1) !== 0, strafeAssist: (flags & 2) !== 0, airControl: (flags & 4) !== 0 },
    assisted: (flags & 8) !== 0,
    ticks: n,
    startTick,
    finishTick,
    time,
    splitTicks,
    endPos,
  };
  return { header, buttons, yaw, pitch, events, keyframes };
}

// ------------------------------------------------------------------ Container + Kompression

/** Kompression verfügbar (Browser, Node ≥ 18)? */
export function canDeflate(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxOut = Infinity): Promise<Uint8Array> {
  // Eigene Kopie mit reinem ArrayBuffer (BlobPart verlangt keinen SharedArrayBuffer).
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const piped = new Blob([copy.buffer]).stream().pipeThrough(stream);
  if (maxOut === Infinity) return new Uint8Array(await new Response(piped).arrayBuffer());
  // Mit Obergrenze stückweise lesen: eine Deflate-Bombe (256 KB → 256 MB) bricht ab, bevor sie den Speicher füllt.
  const reader = piped.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxOut) {
      await reader.cancel();
      throw new ReplayFormatError(`Replay entpackt größer als ${maxOut} Bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Replay → Bytes (Container). compress: deflate-raw, wenn verfügbar und kleiner. */
export async function packReplay(rep: Replay, opts: { readonly compress?: boolean } = {}): Promise<Uint8Array> {
  const body = encodeReplayBody(rep);
  let flags = 0;
  let payload = body;
  if ((opts.compress ?? true) && canDeflate()) {
    const z = await pipe(body, new CompressionStream('deflate-raw'));
    if (z.length < body.length) {
      payload = z;
      flags |= FLAG_DEFLATE;
    }
  }
  const out = new Uint8Array(payload.length + 5);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = MAGIC2;
  out[3] = REPLAY_FORMAT_VERSION;
  out[4] = flags;
  out.set(payload, 5);
  return out;
}

/**
 * Bytes → Replay. Wirft ReplayFormatError bei kaputten/fremden Daten. maxBodyBytes: Obergrenze für den
 * entpackten Rumpf (Server: fremde Uploads; Default unbegrenzt).
 */
export async function unpackReplay(bytes: Uint8Array, opts: { readonly maxBodyBytes?: number } = {}): Promise<Replay> {
  if (bytes.length < 5 || bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1 || bytes[2] !== MAGIC2) throw new ReplayFormatError('Kein VELOCITY-Replay');
  if (bytes[3] !== REPLAY_FORMAT_VERSION) throw new ReplayFormatError(`Replay-Format ${bytes[3]} unbekannt`);
  const flags = bytes[4];
  let body = bytes.subarray(5);
  if (flags & FLAG_DEFLATE) {
    if (!canDeflate()) throw new ReplayFormatError('Dekompression nicht verfügbar');
    try {
      body = await pipe(body, new DecompressionStream('deflate-raw'), opts.maxBodyBytes);
    } catch (err) {
      if (err instanceof ReplayFormatError) throw err;
      throw new ReplayFormatError('Dekompression fehlgeschlagen');
    }
  }
  return decodeReplayBody(body);
}

// ------------------------------------------------------------------ Base64 (localStorage, JSON-APIs)

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  let s: string;
  try {
    s = atob(b64);
  } catch {
    throw new ReplayFormatError('Base64 ungültig');
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
