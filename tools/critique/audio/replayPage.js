/**
 * Kritik-Linse AUDIO, Browser-Seite: rendert eine Aufzeichnung (rec_*.json)
 * mit der echten TechnoAudio-Engine auf einem OfflineAudioContext nach.
 * Geladen per dynamic import aus replay.mjs (Vite transformiert die TS-Imports).
 */
import { TechnoAudio } from '/src/audio/TechnoAudio.ts';
import { BPM } from '/src/audio/Music.ts';
import { drawSpectrogram } from '/src/audio/dev/analysis.ts';

const SR = 48000;
const BEAT = 60 / BPM;

/** Drive aus den Frames: Sample-and-hold nach Zeit. */
export function makeDriveAt(frames) {
  const ts = frames.map((f) => f.t);
  const find = (t) => {
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo];
  };
  return (t) => {
    const f = find(t);
    return {
      speed: f.sp,
      onGround: f.g,
      hopChain: f.ch,
      strafeSync: f.sy,
      airTime: 0,
      surfing: f.sf,
      active: f.m === null && (f.gs === 'playing' || f.gs === 'finished'),
    };
  };
}

/**
 * Ein Render. opts: { seconds, driveAt, events, volumes, clipper, level, withEvents, mute }
 * Liefert Buffer + Zeitleiste (Energie/Layer je 16tel, wie geplant).
 */
export async function render(opts) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(opts.seconds * SR), sampleRate: SR });
  const audio = new TechnoAudio({ context: ctx, clipper: opts.clipper });
  for (const p of opts.mute ?? []) audio.setMuted(p, true);
  audio.setVolumes(opts.volumes);
  // Wie im Spiel: levelLoaded vor unlock → Level-Seed ab dem ersten Takt.
  audio.emit({ type: 'levelLoaded', id: opts.level, name: '' });
  await audio.unlock();
  audio.update(opts.driveAt(0), 0);
  const marks = [];
  if (opts.withEvents !== false) for (const e of opts.events) marks.push({ time: Math.max(0.021, e.t), event: e });
  const step = BEAT / 4;
  for (let t = 0.03; t < opts.seconds; t += step) marks.push({ time: t, event: null });
  marks.sort((a, b) => a.time - b.time);
  const timeline = [];
  for (const m of marks) {
    audio.scheduleOffline(m.time, opts.driveAt);
    if (m.event !== null) audio.emitAt(m.event, m.time);
    else timeline.push([m.time, audio.energyValue, audio.scheduledLayer]);
  }
  audio.scheduleOffline(opts.seconds, opts.driveAt);
  const buffer = await ctx.startRendering();
  return { buffer, timeline };
}

// ------------------------------------------------------------------ Messungen (roh, Auswertung in Node)

/** K-Gewichtung (BS.1770, Koeffizienten für 48 kHz). */
function kWeight(x) {
  const out = new Float64Array(x.length);
  const s1b = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const s1a = [1, -1.69065929318241, 0.73248077421585];
  const s2b = [1.0, -2.0, 1.0];
  const s2a = [1, -1.99004745483398, 0.99007225036621];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const tmp = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const y = s1b[0] * x[i] + s1b[1] * x1 + s1b[2] * x2 - s1a[1] * y1 - s1a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    tmp[i] = y;
  }
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = s2b[0] * tmp[i] + s2b[1] * x1 + s2b[2] * x2 - s2a[1] * y1 - s2a[2] * y2;
    x2 = x1; x1 = tmp[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Rohdaten je Buffer: K-gewichtete Mittelquadrate je 100 ms (Summe L+R),
 * RMS je 10 ms (Mono-Mittel der Quadrate), Peak je 10 ms, Clip-Zähler,
 * Knackser-Kandidaten (2. Differenz weit über ihrem lokalen RMS).
 */
export function measure(buffer) {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const n = L.length;
  const kL = kWeight(L);
  const kR = kWeight(R);
  const blk = SR / 10;
  const kms100 = [];
  for (let b = 0; b + blk <= n; b += blk) {
    let s = 0;
    for (let i = b; i < b + blk; i++) s += kL[i] * kL[i] + kR[i] * kR[i];
    kms100.push(s / blk);
  }
  const w = SR / 100;
  const rms10 = [];
  const peak10 = [];
  let peak = 0;
  let over086 = 0;
  let over1 = 0;
  for (let b = 0; b + w <= n; b += w) {
    let s = 0;
    let p = 0;
    for (let i = b; i < b + w; i++) {
      const a = Math.abs(L[i]);
      const c = Math.abs(R[i]);
      s += L[i] * L[i] + R[i] * R[i];
      const m = a > c ? a : c;
      if (m > p) p = m;
      if (m > 0.86) over086++;
      if (m >= 1) over1++;
    }
    rms10.push(Math.sqrt(s / (2 * w)));
    peak10.push(p);
    if (p > peak) peak = p;
  }
  // Knackser: |2. Differenz| > 10× ihr RMS der umgebenden 40 ms und absolut > 0.03.
  const clicks = [];
  for (const [ch, X] of [[0, L], [1, R]]) {
    const d = new Float32Array(n);
    for (let i = 2; i < n; i++) d[i] = X[i] - 2 * X[i - 1] + X[i - 2];
    const win = Math.round(0.04 * SR);
    let acc = 0;
    const sq = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      acc += d[i] * d[i];
      sq[i + 1] = acc;
    }
    let lastClick = -1;
    for (let i = win; i < n - win; i++) {
      const a = Math.abs(d[i]);
      if (a < 0.03) continue;
      const loc = Math.sqrt((sq[i + win] - sq[i - win] - a * a) / (2 * win - 1));
      if (a > 10 * loc && i - lastClick > SR * 0.02) {
        clicks.push({ t: i / SR, ch, d: a, ratio: a / Math.max(loc, 1e-9) });
        lastClick = i;
      }
    }
  }
  return { peak, over086, over1, samples: n, kms100, rms10, peak10, clicks: clicks.slice(0, 400) };
}

export function toBase64Pcm16(buf) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const out = new Int16Array(len * ch);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) out[i * ch + c] = Math.round(Math.max(-1, Math.min(1, d[i])) * 32767);
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------------ Bild: Spektrogramm + Zeitleiste

/** Zeichnet in #crit (wird angelegt): Spektrogramm oben, darunter Speed/Energie/Layer/Events. */
export function drawReport(buffer, rec, timeline, title) {
  let root = document.getElementById('crit');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'crit';
  root.style.cssText = 'position:absolute;left:0;top:0;background:#07070c;z-index:99;padding:0;margin:0';
  document.body.appendChild(root);
  const W = 1800;
  const spec = document.createElement('canvas');
  spec.width = W;
  spec.height = 460;
  spec.style.display = 'block';
  root.appendChild(spec);
  drawSpectrogram(spec, buffer, title);
  const tl = document.createElement('canvas');
  tl.width = W;
  tl.height = 300;
  tl.style.display = 'block';
  root.appendChild(tl);
  const g = tl.getContext('2d');
  const dur = buffer.length / buffer.sampleRate;
  const X = (t) => (t / dur) * W;
  g.fillStyle = '#0c0c14';
  g.fillRect(0, 0, W, 300);
  // Sekundenraster
  g.font = '11px monospace';
  for (let s = 0; s <= dur; s += 1) {
    g.fillStyle = s % 5 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    g.fillRect(X(s), 0, 1, 300);
    if (s % 5 === 0) {
      g.fillStyle = '#aaa';
      g.fillText(`${s}s`, X(s) + 2, 296);
    }
  }
  // Layer-Bänder (Echtzeit aus dem Spiel) oben: 0..4
  const layerColors = ['#222233', '#2b4a6b', '#2f7f6f', '#b48a2a', '#c23a8a'];
  for (let i = 1; i < rec.frames.length; i++) {
    const f = rec.frames[i - 1];
    g.fillStyle = layerColors[f.l];
    g.fillRect(X(f.t), 0, Math.max(1, X(rec.frames[i].t) - X(f.t)), 22);
  }
  // Offline-Layer (geplant) darunter
  for (let i = 1; i < timeline.length; i++) {
    const [t, , l] = timeline[i - 1];
    g.fillStyle = layerColors[l];
    g.fillRect(X(t), 24, Math.max(1, X(timeline[i][0]) - X(t)), 10);
  }
  g.fillStyle = '#fff';
  g.fillText('Layer (Spiel, oben) / Layer (Offline, unten)   0 grau · 1 blau · 2 gruen · 3 gold · 4 magenta', 6, 14);
  // Speed (0..1400) und Energie (0..1)
  const top = 40;
  const h = 200;
  const Y = (v) => top + h - v * h;
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  for (const v of [0.04, 0.3, 0.58, 0.86]) {
    g.beginPath();
    g.moveTo(0, Y(v));
    g.lineTo(W, Y(v));
    g.stroke();
  }
  g.lineWidth = 1.5;
  g.strokeStyle = '#5ee0ff';
  g.beginPath();
  rec.frames.forEach((f, i) => (i === 0 ? g.moveTo(X(f.t), Y(Math.min(1, f.sp / 1400))) : g.lineTo(X(f.t), Y(Math.min(1, f.sp / 1400)))));
  g.stroke();
  g.strokeStyle = '#ff4fd8';
  g.beginPath();
  rec.frames.forEach((f, i) => (i === 0 ? g.moveTo(X(f.t), Y(f.e)) : g.lineTo(X(f.t), Y(f.e))));
  g.stroke();
  g.fillStyle = '#5ee0ff';
  g.fillText('Speed (0..1400 u/s)', 6, top + 12);
  g.fillStyle = '#ff4fd8';
  g.fillText('Energie (0..1, Linien = Layer-Schwellen)', 160, top + 12);
  // Events
  const evY = top + h + 8;
  const col = { jump: '#8f8', land: '#fa6', checkpoint: '#ff0', finish: '#fff', respawn: '#f33', speedMilestone: '#0ff', runStart: '#fff', surfStart: '#f0f', surfEnd: '#a0a' };
  for (const e of rec.events) {
    const c = col[e.type];
    if (!c) continue;
    g.fillStyle = c;
    const big = e.type !== 'jump' && e.type !== 'land';
    g.fillRect(X(e.t), evY + (e.type === 'land' ? 10 : 0), big ? 3 : 1, big ? 30 : 10);
    if (big) g.fillText(e.type === 'speedMilestone' ? String(e.speed) : e.type.slice(0, 5), X(e.t) + 4, evY + 26);
  }
  return true;
}
