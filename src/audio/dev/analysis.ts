/**
 * Messungen an gerenderten Puffern: Pegel, Spektrum, Kick-Timing, Stereo.
 * Läuft im Browser (Dev-Seite) — die Zahlen landen in shots/audio/report.json.
 */

export interface BandShares {
  /** < 60 Hz */
  readonly sub: number;
  /** 60–250 Hz */
  readonly low: number;
  /** 250–2000 Hz */
  readonly mid: number;
  /** 2–5 kHz */
  readonly presence: number;
  /** 5–10 kHz */
  readonly high: number;
  /** > 10 kHz */
  readonly air: number;
}

export interface KickMetrics {
  readonly onsets: number;
  /** Erwartete Viertel im Messfenster. */
  readonly expected: number;
  readonly meanIntervalMs: number;
  /** Größte Abweichung eines Onset-Abstands vom Viertel-Raster, ms. */
  readonly maxDeviationMs: number;
  /** Anteil der Tiefton-Energie (< 150 Hz), der in den 150 ms nach einer Kick liegt. */
  readonly lowShareInKick: number;
  /** Spitze im Tiefband (< 150 Hz). Vergleich Kick solo vs. Rest zeigt, ob die Kick das Low-End besitzt. */
  readonly lowPeak: number;
}

/** Wie klingt es auf Laptop-/Handy-Lautsprechern? Näherung: Hochpass 200 Hz, 4. Ordnung. */
export interface SmallSpeakerMetrics {
  /** Pegelverlust gegenüber vollem Frequenzgang, dB (negativ). */
  readonly lossDb: number;
  /** Leistungsanteil > 5 kHz im Rest — hoch = dünn und hat-lastig. */
  readonly highShare: number;
  /** Leistungsanteil 250 Hz–2 kHz im Rest (Körper). */
  readonly midShare: number;
}

export interface AudioMetrics {
  readonly seconds: number;
  readonly sampleRate: number;
  readonly peak: number;
  readonly peakDb: number;
  readonly rms: number;
  readonly rmsDb: number;
  readonly crestDb: number;
  /** Magnitudengewichteter spektraler Schwerpunkt, Hz. */
  readonly centroidHz: number;
  /** Leistungsanteil oberhalb 5 kHz. */
  readonly highShare: number;
  readonly bands: BandShares;
  readonly kick: KickMetrics;
  /** Anteil Samples, in denen der Sicherheits-Clipper greift (|x| > 0.86). */
  readonly clipperActivity: number;
  /** Seiten- zu Mitten-Energie (0 = mono). */
  readonly sideToMid: number;
  readonly smallSpeaker: SmallSpeakerMetrics;
}

const SMALL_SPEAKER_HP = 200;

const FFT_SIZE = 4096;

export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function monoMix(buf: AudioBuffer): Float32Array {
  const l = buf.getChannelData(0);
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  const m = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]);
  return m;
}

/** Gemittelte Magnituden- und Leistungsspektren über [start, end) Samples. */
function averageSpectrum(x: Float32Array, start: number, end: number): { mag: Float64Array; pow: Float64Array } {
  const win = hann(FFT_SIZE);
  const half = FFT_SIZE / 2;
  const mag = new Float64Array(half);
  const pow = new Float64Array(half);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let frames = 0;
  for (let s = start; s + FFT_SIZE <= end; s += FFT_SIZE / 2) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = x[s + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      pow[k] += p;
      mag[k] += Math.sqrt(p);
    }
    frames++;
  }
  if (frames > 0) {
    for (let k = 0; k < half; k++) {
      mag[k] /= frames;
      pow[k] /= frames;
    }
  }
  return { mag, pow };
}

function onePoleLowpass(x: Float32Array, hz: number, sr: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += a * (x[i] - s);
    y[i] = s;
  }
  return y;
}

const DECIMATE = 8;
const TEMPLATE_SECONDS = 0.06;

/** Kick-Schablone wie in instruments/Kick.ts: Sinus-Chirp 160 → 48 Hz in 90 ms, 2 ms Attack. */
function kickTemplate(sr: number): Float32Array {
  const n = Math.floor(TEMPLATE_SECONDS * sr);
  const t = new Float32Array(n);
  let phase = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const s = i / sr;
    const f = s < 0.09 ? 160 * Math.pow(48 / 160, s / 0.09) : 48;
    phase += (2 * Math.PI * f) / sr;
    const env = Math.min(1, s / 0.002) * (s < 0.027 ? 1 : Math.exp(-(s - 0.027) / 0.085));
    t[i] = Math.sin(phase) * env;
    mean += t[i];
  }
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    t[i] -= mean;
    norm += t[i] * t[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < n; i++) t[i] /= norm;
  return t;
}

/**
 * Kick-Onsets per Matched Filter: normierte Kreuzkorrelation des (dezimierten)
 * Mixes mit der Chirp-Schablone. Bass und Rumble haben keinen Pitch-Fall und
 * korrelieren schwach; Pegelschwellen scheitern dagegen am rollenden Bass.
 * Sub-Sample-Genauigkeit per Parabel-Interpolation um das Maximum.
 */
export interface KickOnset {
  readonly time: number;
  readonly corr: number;
}

export function detectKickOnsets(mono: Float32Array, sr: number, start: number): KickOnset[] {
  // Anti-Alias (4× Einpol 600 Hz) und Dezimation auf sr/8.
  let aa = mono;
  for (let k = 0; k < 4; k++) aa = onePoleLowpass(aa, 600, sr);
  const dsr = sr / DECIMATE;
  const x = new Float32Array(Math.floor(aa.length / DECIMATE));
  for (let i = 0; i < x.length; i++) x[i] = aa[i * DECIMATE];
  const tpl = kickTemplate(dsr);
  const m = tpl.length;
  const d0 = Math.floor(start / DECIMATE);
  const d1 = Math.max(d0, x.length - m);
  const corr = new Float32Array(x.length);
  const rms = new Float32Array(x.length);
  let win = 0;
  for (let k = 0; k < m && d0 + k < x.length; k++) win += x[d0 + k] * x[d0 + k];
  let maxRms = 0;
  for (let n = d0; n < d1; n++) {
    let dot = 0;
    for (let k = 0; k < m; k++) dot += x[n + k] * tpl[k];
    const e = Math.sqrt(Math.max(win, 0));
    corr[n] = e > 1e-9 ? dot / e : 0;
    rms[n] = e;
    if (e > maxRms) maxRms = e;
    win += x[n + m] * x[n + m] - x[n] * x[n];
  }
  // Non-Maximum-Suppression: stärkster Treffer im ±200-ms-Fenster gewinnt (sonst
  // kann ein schwacher Fehltreffer kurz vor der Kick deren Platz blockieren).
  const nms = Math.floor(0.2 * dsr);
  let bestCorr = 0;
  for (let n = d0; n < d1; n++) if (rms[n] >= 0.25 * maxRms && corr[n] > bestCorr) bestCorr = corr[n];
  const thr = Math.max(0.5, 0.75 * bestCorr);
  const coarse: number[] = [];
  for (let n = d0 + 1; n < d1 - 1; n++) {
    const c = corr[n];
    if (c < thr || rms[n] < 0.25 * maxRms) continue;
    let isMax = true;
    for (let j = Math.max(d0, n - nms); j < Math.min(d1, n + nms) && isMax; j++) if (corr[j] > c) isMax = false;
    if (isMax) coarse.push(n);
  }
  // Verfeinerung in voller Rate: Korrelation ±1.5 Grob-Samples um das Maximum, dann Parabel.
  const full = kickTemplate(sr);
  const fm = full.length;
  const onsets: KickOnset[] = [];
  for (const n of coarse) {
    const center = n * DECIMATE;
    const lo = Math.max(0, center - Math.round(1.5 * DECIMATE));
    const hi = Math.min(aa.length - fm - 1, center + Math.round(1.5 * DECIMATE));
    let bestI = center;
    let bestV = Number.NEGATIVE_INFINITY;
    const vals = new Map<number, number>();
    for (let i = lo; i <= hi; i++) {
      let dot = 0;
      let en = 0;
      for (let k = 0; k < fm; k++) {
        const v = aa[i + k];
        dot += v * full[k];
        en += v * v;
      }
      const c = en > 1e-12 ? dot / Math.sqrt(en) : 0;
      vals.set(i, c);
      if (c > bestV) {
        bestV = c;
        bestI = i;
      }
    }
    const a = vals.get(bestI - 1) ?? bestV;
    const cc = vals.get(bestI + 1) ?? bestV;
    const den = a - 2 * bestV + cc;
    const delta = den !== 0 ? (0.5 * (a - cc)) / den : 0;
    onsets.push({ time: (bestI + delta) / sr, corr: corr[n] });
  }
  return onsets;
}

function analyzeKick(mono: Float32Array, sr: number, start: number, end: number, bpm: number): KickMetrics {
  // Tiefband für Energie-Kennzahlen (~< 150 Hz, zweipolig).
  const lp = onePoleLowpass(onePoleLowpass(mono, 150, sr), 150, sr);
  let lowPeak = 0;
  for (let i = start; i < end; i++) lowPeak = Math.max(lowPeak, Math.abs(lp[i]));
  const onsets = detectKickOnsets(mono, sr, start).map((o) => o.time);

  const beat = 60 / bpm;
  let maxDev = 0;
  let sumInt = 0;
  let nInt = 0;
  for (let i = 1; i < onsets.length; i++) {
    const dt = onsets[i] - onsets[i - 1];
    const n = Math.max(1, Math.round(dt / beat));
    maxDev = Math.max(maxDev, Math.abs(dt - n * beat));
    if (n === 1) {
      sumInt += dt;
      nInt++;
    }
  }
  // Tiefton-Energie in den 150 ms nach jeder Kick vs. gesamt.
  const inKick = new Uint8Array(lp.length);
  for (const o of onsets) {
    const a = Math.floor((o - 0.005) * sr);
    const b = Math.min(lp.length, Math.floor((o + 0.15) * sr));
    for (let i = Math.max(0, a); i < b; i++) inKick[i] = 1;
  }
  let eIn = 0;
  let eAll = 0;
  for (let i = start; i < end; i++) {
    const p = lp[i] * lp[i];
    eAll += p;
    if (inKick[i]) eIn += p;
  }
  return {
    onsets: onsets.length,
    expected: Math.round((end - start) / sr / beat),
    meanIntervalMs: nInt > 0 ? (sumInt / nInt) * 1000 : 0,
    maxDeviationMs: maxDev * 1000,
    lowShareInKick: eAll > 0 ? eIn / eAll : 0,
    lowPeak,
  };
}

export function analyzeBuffer(buf: AudioBuffer, bpm: number, skipSeconds: number): AudioMetrics {
  const sr = buf.sampleRate;
  const l = buf.getChannelData(0);
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  const start = Math.min(l.length, Math.floor(skipSeconds * sr));
  const end = l.length;
  let peak = 0;
  let sum = 0;
  let clip = 0;
  let mid = 0;
  let side = 0;
  for (let i = start; i < end; i++) {
    const a = l[i];
    const b = r[i];
    const aa = Math.abs(a);
    const ab = Math.abs(b);
    if (aa > peak) peak = aa;
    if (ab > peak) peak = ab;
    if (aa > 0.86 || ab > 0.86) clip++;
    sum += a * a + b * b;
    const m = 0.5 * (a + b);
    const s = 0.5 * (a - b);
    mid += m * m;
    side += s * s;
  }
  const n = Math.max(1, end - start);
  const rms = Math.sqrt(sum / (2 * n));
  const mono = monoMix(buf);
  const { mag, pow } = averageSpectrum(mono, start, end);
  const binHz = sr / FFT_SIZE;
  let cNum = 0;
  let cDen = 0;
  let pTot = 0;
  const band = { sub: 0, low: 0, mid: 0, presence: 0, high: 0, air: 0 };
  let lapTot = 0;
  let lapHigh = 0;
  let lapMid = 0;
  for (let k = 1; k < mag.length; k++) {
    const f = k * binHz;
    cNum += f * mag[k];
    cDen += mag[k];
    const p = pow[k];
    pTot += p;
    // |H|² eines Butterworth-Hochpasses 4. Ordnung
    const r8 = Math.pow(f / SMALL_SPEAKER_HP, 8);
    const lp = (p * r8) / (1 + r8);
    lapTot += lp;
    if (f >= 5000) lapHigh += lp;
    else if (f >= 250 && f < 2000) lapMid += lp;
    if (f < 60) band.sub += p;
    else if (f < 250) band.low += p;
    else if (f < 2000) band.mid += p;
    else if (f < 5000) band.presence += p;
    else if (f < 10000) band.high += p;
    else band.air += p;
  }
  const share = (x: number): number => (pTot > 0 ? x / pTot : 0);
  const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
  return {
    seconds: buf.duration,
    sampleRate: sr,
    peak,
    peakDb: db(peak),
    rms,
    rmsDb: db(rms),
    crestDb: db(peak) - db(rms),
    centroidHz: cDen > 0 ? cNum / cDen : 0,
    highShare: share(band.high + band.air),
    bands: {
      sub: share(band.sub),
      low: share(band.low),
      mid: share(band.mid),
      presence: share(band.presence),
      high: share(band.high),
      air: share(band.air),
    },
    kick: analyzeKick(mono, sr, start, end, bpm),
    clipperActivity: clip / n,
    sideToMid: mid > 0 ? side / mid : 0,
    smallSpeaker: {
      lossDb: pTot > 0 && lapTot > 0 ? 10 * Math.log10(lapTot / pTot) : 0,
      highShare: lapTot > 0 ? lapHigh / lapTot : 0,
      midShare: lapTot > 0 ? lapMid / lapTot : 0,
    },
  };
}

const INFERNO: readonly (readonly [number, number, number])[] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];

/** Wahrnehmungsgleichmäßige Farbskala (Inferno-Näherung) — Pegelunterschiede bleiben lesbar. */
function inferno(v: number, out: Uint8ClampedArray, o: number): void {
  const x = v * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(x));
  const f = x - i;
  const a = INFERNO[i];
  const b = INFERNO[i + 1];
  out[o] = a[0] + (b[0] - a[0]) * f;
  out[o + 1] = a[1] + (b[1] - a[1]) * f;
  out[o + 2] = a[2] + (b[2] - a[2]) * f;
  out[o + 3] = 255;
}

/** Spektrogramm (log-Frequenz 30 Hz–20 kHz) + Hüllkurve unten, zum Anschauen per Screenshot. */
export function drawSpectrogram(canvas: HTMLCanvasElement, buf: AudioBuffer, title: string): void {
  const g = canvas.getContext('2d');
  if (g === null) return;
  const W = canvas.width;
  const H = canvas.height;
  const specH = Math.floor(H * 0.78);
  g.fillStyle = '#07070c';
  g.fillRect(0, 0, W, H);
  const mono = monoMix(buf);
  const sr = buf.sampleRate;
  const N = 2048;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const img = g.createImageData(W, specH);
  const fLo = Math.log(30);
  const fHi = Math.log(Math.min(20000, sr / 2));
  const cols = W;
  const hop = Math.max(1, Math.floor((mono.length - N) / cols));
  for (let x = 0; x < cols; x++) {
    const s = x * hop;
    for (let i = 0; i < N; i++) {
      re[i] = (s + i < mono.length ? mono[s + i] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let y = 0; y < specH; y++) {
      const f = Math.exp(fHi - ((fHi - fLo) * y) / (specH - 1));
      const k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / sr)));
      const p = (re[k] * re[k] + im[k] * im[k]) / (N * N);
      const dbv = 10 * Math.log10(p + 1e-14);
      const v = Math.max(0, Math.min(1, (dbv + 115) / 95));
      const o = (y * W + x) * 4;
      inferno(v, img.data, o);
    }
  }
  g.putImageData(img, 0, 0);
  // Frequenz-Gitter
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = '11px monospace';
  for (const f of [50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
    const y = ((fHi - Math.log(f)) / (fHi - fLo)) * (specH - 1);
    g.fillRect(0, y, 6, 1);
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 8, y + 4);
  }
  // Pegel-Hüllkurve
  const envY = specH + 4;
  const envH = H - envY - 2;
  g.fillStyle = '#12121c';
  g.fillRect(0, envY, W, envH);
  const l = buf.getChannelData(0);
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  const per = Math.max(1, Math.floor(l.length / W));
  for (let x = 0; x < W; x++) {
    let pk = 0;
    for (let i = x * per; i < Math.min(l.length, (x + 1) * per); i++) pk = Math.max(pk, Math.abs(l[i]), Math.abs(r[i]));
    const h = pk * envH;
    g.fillStyle = pk > 0.86 ? '#ff4040' : '#5ee0ff';
    g.fillRect(x, envY + envH - h, 1, h);
  }
  g.fillStyle = '#fff';
  g.font = '13px monospace';
  g.fillText(title, 60, 16);
}
