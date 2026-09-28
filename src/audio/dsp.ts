/**
 * Kleine DSP-Bausteine für die Audio-Engine: deterministischer Zufall,
 * Rauschpuffer, generierte Impulsantworten, Waveshaper-Kennlinien, Hüllkurven.
 * Alles ohne Audiodateien — jeder Klang entsteht aus diesen Teilen.
 */

export type Rng = () => number;

/** mulberry32 — gleicher Seed, gleiche Musik (Offline-Render muss reproduzierbar sein). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, um aus Level-IDs Seeds zu machen. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Exponentielle Interpolation zwischen zwei Frequenzen (wahrnehmungslinear). */
export function expLerp(a: number, b: number, t: number): number {
  return a * Math.pow(b / a, t);
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

/** Weißes Rauschen; Instrumente spielen es mit Zufallsoffset ab, damit kein Schlag identisch klingt. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds: number, rng: Rng, channels = 1): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
  }
  return buf;
}

export interface ImpulseOptions {
  readonly seconds: number;
  readonly preDelay: number;
  /** Tiefpass des Nachhalls am Anfang und am Ende (Luftdämpfung: der Schwanz wird dunkler). */
  readonly brightHz: number;
  readonly darkHz: number;
  readonly channels: 1 | 2;
}

/** Filterkoeffizienten der IR nur alle N Samples neu — exp/pow pro Sample kostete bei 96 kHz > 100 ms Aufbau. */
const IR_BLOCK = 32;
const IR_CACHE_MAX = 12;
const irCache = new Map<string, readonly Float32Array<ArrayBuffer>[]>();

/**
 * Hall-Impulsantwort als Rohdaten (ohne AudioContext, daher vorab im Leerlauf
 * berechenbar): gefiltertes Rauschen mit exponentiellem Abklingen (−60 dB am
 * Ende). Der Tiefpass läuft zeitvariant, damit der Schwanz wie in einem
 * echten Raum die Höhen zuerst verliert. L/R dekorreliert → Breite.
 * Gecacht je Rate/Seed/Form — ein zweites unlock() oder Offline-Render zahlt nichts.
 */
export function impulseResponseData(sr: number, seed: number, o: ImpulseOptions): readonly Float32Array<ArrayBuffer>[] {
  const key = `${sr}|${seed >>> 0}|${o.seconds}|${o.preDelay}|${o.brightHz}|${o.darkHz}|${o.channels}`;
  const hit = irCache.get(key);
  if (hit !== undefined) return hit;
  const rng = createRng(seed);
  const len = Math.max(2, Math.floor(o.seconds * sr));
  const pre = Math.floor(o.preDelay * sr);
  const tail = Math.max(0.05, o.seconds - o.preDelay);
  const decayStep = Math.exp(-6.91 / (tail * sr));
  const fadeInLen = 0.004 * sr;
  const fadeOutLen = Math.floor(0.08 * sr);
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < o.channels; c++) {
    const d = new Float32Array(len);
    let lp = 0;
    let decay = 1;
    let a = 1;
    let comp = 1;
    for (let i = pre; i < len; i++) {
      const k = i - pre;
      if (k % IR_BLOCK === 0) {
        const fc = expLerp(o.brightHz, o.darkHz, Math.min(1, (k + IR_BLOCK / 2) / sr / tail));
        a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
        // Leistungsausgleich des Einpol-Tiefpasses, sonst würde der Pegel mit der Dämpfung mitfallen.
        comp = Math.sqrt((2 - a) / a);
      }
      lp += a * (rng() * 2 - 1 - lp);
      const fadeIn = k < fadeInLen ? k / fadeInLen : 1;
      const fadeOut = len - i < fadeOutLen ? (len - i) / fadeOutLen : 1;
      d[i] = lp * comp * decay * fadeIn * fadeOut * 0.25;
      decay *= decayStep;
    }
    out.push(d);
  }
  if (irCache.size >= IR_CACHE_MAX) {
    const oldest = irCache.keys().next();
    if (oldest.done !== true) irCache.delete(oldest.value);
  }
  irCache.set(key, out);
  return out;
}

export function createImpulseResponse(ctx: BaseAudioContext, seed: number, o: ImpulseOptions): AudioBuffer {
  const data = impulseResponseData(ctx.sampleRate, seed, o);
  const buf = ctx.createBuffer(o.channels, data[0].length, ctx.sampleRate);
  for (let c = 0; c < data.length; c++) buf.copyToChannel(data[c], c);
  return buf;
}

/**
 * tanh-Sättigung, bei ±1 Eingang auf ±1 normiert. `range` > 1 erweitert die
 * Kurve über ±1 hinaus (Eingang vorher durch `range` teilen): ein WaveShaper
 * hält außerhalb der Kurve den Endwert — ohne Reserve wird tanh bei heißem
 * Eingang zum harten Clipper. Ungerade Länge, damit 0 exakt auf 0 abbildet.
 */
export function tanhCurve(drive: number, n = 4097, range = 1): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    c[i] = Math.tanh(drive * x) / norm;
  }
  return c;
}

/**
 * Sicherheits-Clipper hinter dem Limiter: bis `knee` exakt linear, darüber
 * weich auf `ceiling`. Greift nur bei Transienten, die der Kompressor durchlässt.
 */
export function softClipCurve(knee: number, ceiling: number, n = 8193): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/**
 * Perkussive Hüllkurve: 0 → peak (linear in `attack`), dann exponentiell mit
 * Zeitkonstante `tau`. Liefert den Zeitpunkt, ab dem die Stimme stumm ist
 * (−70 dB) — dort wird die Quelle gestoppt, ohne Knacks.
 */
export function percEnvelope(p: AudioParam, t: number, peak: number, attack: number, tau: number, hold = 0): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
  p.setTargetAtTime(0, t + attack + hold, tau);
  return t + attack + hold + tau * 8;
}

/**
 * Trennt eine Stimme nach dem Ende aller Quellen vom Graphen, damit der
 * Garbage Collector sie holen kann. Ohne das wächst der Graph pro Note.
 */
export function releaseWhenEnded(sources: readonly AudioScheduledSourceNode[], nodes: readonly AudioNode[]): void {
  // Offline nicht trennen: das 'ended'-Event kommt über den Main-Thread zu einem
  // zufälligen Render-Zeitpunkt und würde Filter-Ausklänge nichtdeterministisch kappen.
  if (sources.length === 0 || (isOfflineContext(sources[0].context) && !offlineCleanup)) return;
  let left = sources.length;
  const done = (): void => {
    left--;
    if (left > 0) return;
    for (const s of sources) s.disconnect();
    for (const n of nodes) n.disconnect();
  };
  for (const s of sources) s.addEventListener('ended', done, { once: true });
}

let offlineCleanup = false;

/** Nur für Last-Messungen: offline wie in Echtzeit aufräumen (dann nicht mehr reproduzierbar). */
export function setOfflineVoiceCleanup(on: boolean): void {
  offlineCleanup = on;
}

export function isOfflineContext(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

/** Rauschquelle mit Zufallsoffset, die nach `duration` endet. */
export function noiseBurst(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  rng: Rng,
  t: number,
  duration: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const offset = rng() * Math.max(0, noise.duration - 0.01);
  src.start(t, offset);
  src.stop(t + duration);
  return src;
}

export function makeGain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function makeFilter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function makePanner(ctx: BaseAudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  return p;
}

/**
 * Haas-Doppel: `src` einmal direkt auf `pan`, einmal `delay` später auf −`pan`.
 * Für Rauschklänge (Hats, Shaker, Ride-Metall) ist die verzögerte Kopie praktisch
 * dekorreliert — echte Breite statt Panorama-Position, ohne zweite Stimme pro Schlag.
 * `level` gleicht die Leistungsaddition der beiden Wege aus.
 */
export function haasPair(ctx: BaseAudioContext, src: AudioNode, dest: AudioNode, pan: number, delay: number, level: number): void {
  const direct = makeGain(ctx, level);
  src.connect(direct).connect(makePanner(ctx, pan)).connect(dest);
  const d = ctx.createDelay(Math.max(0.05, delay * 2));
  d.delayTime.value = delay;
  const late = makeGain(ctx, level * 0.94);
  src.connect(d).connect(late).connect(makePanner(ctx, -pan)).connect(dest);
}

export function makeShaper(ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>, oversample: OverSampleType): WaveShaperNode {
  const s = ctx.createWaveShaper();
  s.curve = curve;
  s.oversample = oversample;
  return s;
}
