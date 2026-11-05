/**
 * Trailer-Musik (30 s, 48 kHz Stereo) aus der Spiel-Engine rendern, mastern, prüfen.
 *
 *   node tools/trailer/music.mjs            alles (Musik, SFX-Stems, One-Shots, Analyse)
 *   node tools/trailer/music.mjs --music    nur Musik + Analyse
 *
 * Ablauf: Vite-Dev-Server (Port 5603) + Chromium, tools/trailer/trailerRender.ts per
 * Vite-Import, Offline-Renders als Float32 zurück. Hier: LEAD vorne abschneiden (Takt n
 * liegt dann exakt bei n · BAR), Hall-Ausklang überblenden, ausblenden, mit ffmpeg
 * loudnorm zweistufig (linear) auf −14 LUFS / −1.5 dBTP. Die SFX-Stems bekommen
 * dieselbe Verstärkung wie die Musik, damit Musik + Stems im Spiel-Verhältnis bleiben.
 *
 * Ausgaben: media/audio/trailer_music.wav, media/audio/stems/**, media/audio/cues.json,
 * media/audio/analysis/* (Spektrogramm, Wellenform, analysis.json).
 */
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDevServer, launchBrowser } from '../lib/devServer.mjs';

const PORT = Number(process.env.TRAILER_PORT ?? 5603);
const FFMPEG = process.env.FFMPEG ?? 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const OUT = 'media/audio';
const SR = 48000;
const LENGTH = 30;
const N = LENGTH * SR;
const TARGET_I = -14;
const TARGET_TP = -1.5;
const ONLY_MUSIC = process.argv.includes('--music');

// ------------------------------------------------------------------ WAV / PCM

function decodeF32(r) {
  const bytes = Buffer.from(r.pcm, 'base64');
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const n = all.length / r.channels;
  const ch = [];
  for (let c = 0; c < r.channels; c++) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = all[i * r.channels + c];
    ch.push(d);
  }
  return ch;
}

/** WAV schreiben: 'f32' (IEEE float, Zwischenstufe) oder 's24' (Auslieferung). */
function writeWav(path, ch, bits = 's24') {
  const n = ch[0].length;
  const nc = ch.length;
  const bps = bits === 'f32' ? 4 : 3;
  const data = Buffer.alloc(n * nc * bps);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const v = ch[c][i];
      if (bits === 'f32') data.writeFloatLE(v, o);
      else data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607))), o, 3);
      o += bps;
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(bits === 'f32' ? 3 : 1, 20);
  h.writeUInt16LE(nc, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * nc * bps, 28);
  h.writeUInt16LE(nc * bps, 32);
  h.writeUInt16LE(bps * 8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
  return r.stderr;
}

/** Datei → Float32-Kanäle (über ffmpeg, Format egal). */
function readAudio(path) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const buf = r.stdout;
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const n = all.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = all[2 * i];
    R[i] = all[2 * i + 1];
  }
  return [L, R];
}

const lastJson = (s) => JSON.parse(s.slice(s.lastIndexOf('{'), s.lastIndexOf('}') + 1));
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// ------------------------------------------------------------------ Signal-Helfer

/** Ab Sample `from` genau `n` Samples (fehlende = 0). */
function slice(ch, from, n) {
  return ch.map((d) => {
    const o = new Float32Array(n);
    o.set(d.subarray(from, Math.min(d.length, from + n)));
    return o;
  });
}

function peakOf(ch) {
  let p = 0;
  for (const d of ch) for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
}

/** Raised-Cosine-Rampe 0→1 über [a, b] Sekunden. */
const ramp = (t, a, b) => (t <= a ? 0 : t >= b ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - a)) / (b - a)));

/** Stille am Ende kappen (unter −70 dBFS), 20 ms Ausblende. */
function trimTail(ch) {
  const th = 10 ** (-70 / 20);
  let last = 0;
  for (const d of ch) for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > th) { last = i; break; }
  const n = Math.min(ch[0].length, last + Math.round(0.03 * SR));
  const out = slice(ch, 0, n);
  const f = Math.round(0.02 * SR);
  for (const d of out) for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  return out;
}

/** RBJ-Biquad (Q 1/√2). */
function biquad(x, type, f) {
  const w = (2 * Math.PI * f) / SR;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const b = type === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [(1 - c) / 2, 1 - c, (1 - c) / 2];
  const a0 = 1 + al;
  const a1 = -2 * c;
  const a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const filt = (x, chain) => chain.reduce((acc, [t, f]) => biquad(acc, t, f), x);
const mono = (ch) => ch[0].map((v, i) => 0.5 * (v + ch[1][i]));

/** Leistung in dB über [a, b) s. */
function powDb(x, a, b) {
  const i0 = Math.max(0, Math.floor(a * SR));
  const i1 = Math.min(x.length, Math.floor(b * SR));
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-15);
}

/** Frame-Energie (dB) in 5-ms-Rahmen. */
function frames(x, hop = 0.005) {
  const h = Math.round(hop * SR);
  const out = new Float32Array(Math.floor(x.length / h));
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let i = k * h; i < (k + 1) * h; i++) s += x[i] * x[i];
    out[k] = 10 * Math.log10(s / h + 1e-15);
  }
  return out;
}

/**
 * Einsatz nahe `t`: im Fenster [t − 0.08, t + 0.12] der Rahmen mit dem größten
 * Anstieg gegen das Mittel der 60 ms davor (Onset-Stärke).
 */
function onsetNear(fr, t, hop = 0.005) {
  let best = { t: NaN, rise: -Infinity };
  for (let k = Math.floor((t - 0.08) / hop); k <= Math.floor((t + 0.12) / hop); k++) {
    let base = 0;
    for (let j = 1; j <= 12; j++) base += 10 ** (fr[k - j] / 10);
    const rise = fr[k] - 10 * Math.log10(base / 12 + 1e-15);
    if (rise > best.rise) best = { t: k * hop, rise };
  }
  return best;
}

/** Stärkste Onsets im ganzen Track (positiver Fluss der Rahmen-Energie, Mindestabstand). */
function topOnsets(fr, count, gap, hop = 0.005) {
  const flux = [];
  for (let k = 12; k < fr.length; k++) {
    let base = 0;
    for (let j = 1; j <= 12; j++) base += 10 ** (fr[k - j] / 10);
    flux.push({ t: k * hop, v: fr[k] - 10 * Math.log10(base / 12 + 1e-15), lvl: fr[k] });
  }
  // Nur Ereignisse, die auch laut sind (sonst gewinnt jeder Hat-Einsatz in der Stille).
  let max = -Infinity;
  for (const f of flux) max = Math.max(max, f.lvl);
  for (let i = flux.length - 1; i >= 0; i--) if (flux[i].lvl < max - 20) flux.splice(i, 1);
  flux.sort((a, b) => b.v - a.v);
  const out = [];
  for (const f of flux) {
    if (out.length >= count) break;
    if (out.every((o) => Math.abs(o.t - f.t) >= gap)) out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ Hauptablauf

async function main() {
  mkdirSync(`${OUT}/stems/oneshots`, { recursive: true });
  mkdirSync(`${OUT}/analysis`, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'vel-trailer-'));
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}]`, m.text());
    });
    await page.goto(`${srv.url}dev/audio.html`);
    await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 30000 });
    const job = async (name) => {
      const t0 = Date.now();
      const r = await page.evaluate(async (n) => (await import('/tools/trailer/trailerRender.ts')).run(n), name);
      console.log(`  render ${name.padEnd(12)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return { ...r, ch: decodeF32(r) };
    };
    const arr = await page.evaluate(async () => (await import('/tools/trailer/trailerRender.ts')).arrangement());
    const LEAD = await page.evaluate(async () => (await import('/tools/trailer/trailerRender.ts')).LEAD);
    const BAR = arr.bar;
    const BEAT = arr.beat;
    const bar = (n) => n * BAR;
    const off = Math.round(LEAD * SR);

    // ---------------------------------------------------------------- Musik
    const A = await job('music');
    const B = await job('tail');
    const A0 = await job('musicNoAccent');
    console.log('  Takte (Energie/Layer/Breakdown): ' + A.bars.map((b) => `${b.bar}:${b.energy.toFixed(2)}/L${b.layer}${b.breakdown ? 'B' : ''}`).join(' '));
    const a = slice(A.ch, off, N);
    const b = slice(B.ch, off, N);
    const [x0, x1] = arr.tailXfade;
    const [f0, f1] = arr.fadeOut;
    const pre = a.map((d, c) => {
      const o = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const w = ramp(t, x0, x1);
        // Korrelierte Signale (Pad/Stabs/FX in beiden): lineare Summe, keine Gleichleistung.
        o[i] = ((1 - w) * d[i] + w * b[c][i]) * (1 - ramp(t, f0, f1));
      }
      return o;
    });
    const rawPeak = peakOf(A.ch);
    console.log(`  Engine-Peak (mit Sicherheits-Clipper) ${fmt(db(rawPeak))} dBFS`);
    const prePath = join(tmp, 'pre.wav');
    writeWav(prePath, pre, 'f32');

    // ---------------------------------------------------------------- Mastering: loudnorm zweistufig
    const p1 = lastJson(ffmpeg(['-i', prePath, '-af', `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=20:print_format=json`, '-f', 'null', '-']));
    console.log(`  loudnorm 1: I ${p1.input_i} LUFS, TP ${p1.input_tp} dBTP, LRA ${p1.input_lra}`);
    const musicPath = `${OUT}/trailer_music.wav`;
    const ln2 =
      `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=20:measured_I=${p1.input_i}:measured_TP=${p1.input_tp}:` +
      `measured_LRA=${p1.input_lra}:measured_thresh=${p1.input_thresh}:offset=${p1.target_offset}:linear=true:print_format=json`;
    // loudnorm rechnet intern mit 192 kHz → zurück auf 48 kHz, Länge exakt 30.0 s erzwingen.
    const p2 = lastJson(
      ffmpeg(['-y', '-i', prePath, '-af', `${ln2},aresample=${SR},apad=whole_len=${N},atrim=end_sample=${N}`, '-ar', String(SR), '-c:a', 'pcm_s24le', musicPath]),
    );
    console.log(`  loudnorm 2: ${p2.normalization_type}, out I ${p2.output_i} LUFS, TP ${p2.output_tp} dBTP`);
    // Tatsächliche Verstärkung aus Ein- vs. Ausgangspegel (linear: konstant).
    const gainDb = Number(p2.output_i) - Number(p2.input_i);

    // ---------------------------------------------------------------- Stems
    const stems = [];
    const writeStem = (file, ch, kind, note) => {
      let g = 10 ** (gainDb / 20);
      const pk = peakOf(ch) * g;
      let extra = 0;
      // Über −1 dBFS: Stem leiser, Abweichung vom Spiel-Verhältnis dokumentieren.
      if (pk > 10 ** (-1 / 20)) {
        extra = -1 - db(pk);
        g *= 10 ** (extra / 20);
      }
      const out = ch.map((d) => d.map((v) => v * g));
      writeWav(`${OUT}/stems/${file}`, out, 's24');
      stems.push({ file: `stems/${file}`, kind, lengthS: +(out[0].length / SR).toFixed(3), peakDbfs: +db(peakOf(out)).toFixed(2), gainVsMusicDb: +extra.toFixed(2), note });
    };
    if (!ONLY_MUSIC) {
      const synced = (r, fadeOut) => {
        const s = slice(r.ch, off, N);
        for (const d of s) for (let i = 0; i < N; i++) d[i] *= 1 - ramp(i / SR, fadeOut[0], fadeOut[1]);
        return s;
      };
      writeStem('sfx_wind_surf_synced.wav', synced(await job('sfxWind'), arr.fadeOut), 'synced', 'Wind (folgt der Speed) + Surf-Zischen in Takt 3 und 12–13; gleiche Zeitbasis wie trailer_music.wav');
      writeStem('sfx_events_synced.wav', synced(await job('sfxEvents'), [29.9, 30]), 'synced', 'Vorschlag: Hops/Blips, Zaps, Checkpoint, Finish auf dem Raster (Zeiten in cues.json sfxEvents)');
      const shotOff = Math.round((LEAD + BEAT) * SR);
      const shot = async (name, file, note, offset = shotOff) => {
        const r = await job(name);
        writeStem(`oneshots/${file}`, trimTail(slice(r.ch, offset, r.ch[0].length - offset)), 'oneshot', note);
      };
      for (let c = 2; c <= 12; c++) {
        await shot(`hop${c}`, `hop_chain${String(c).padStart(2, '0')}.wav`, `Bhop-Sprung, Chain ${c}: Whoomp + Shepard-Blip (Pentatonik-Stufe ${c - 2}, steigt mit der Chain)`);
      }
      await shot('checkpoint', 'checkpoint_chime.wav', 'Checkpoint: Glocken-Arpeggio A C E A + Stab (Spiel-SFX)');
      await shot('finish', 'finish_stab.wav', 'Ziel: Stab + Crash + Riser + Glocken (Spiel-SFX)');
      await shot('landHard', 'land_hard.wav', 'harte Landung (Aufprall 900)');
      await shot('runStart', 'run_start.wav', 'Lauf-Start: Thump + Glocke');
      for (const s of [500, 750, 1000, 1250, 1500]) await shot(`zap${s}`, `zap_${s}.wav`, `Speed-Meilenstein ${s} u/s (Zap)`);
      // Whoosh: Differenz-Render, Start bei Kontextzeit 0 — vorne bleibt der Anlauf (0.4 s).
      await shot('whooshL', 'whoosh_pass_L.wav', 'Vorbeizieh-Whoosh links, 900 u/s, nächster Punkt bei ~0.95 s', 0);
      await shot('whooshR', 'whoosh_pass_R.wav', 'Vorbeizieh-Whoosh rechts, 900 u/s, nächster Punkt bei ~0.95 s', 0);
      await shot('pssht', 'can_pssht.wav', 'Dosen-Pssht — NICHT aus der Engine (dort nur Animation): mit Engine-Bausteinen (Rauschen, Biquads) synthetisiert', 0);
    }

    // ---------------------------------------------------------------- Analyse am fertigen WAV
    const fin = readAudio(musicPath);
    const m = mono(fin);
    const samples = fin[0].length;
    const ebu = ffmpeg(['-i', musicPath, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ebu.slice(ebu.lastIndexOf('Summary')))?.[1]);
    const TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(ebu.slice(ebu.lastIndexOf('True peak')))?.[1]);
    const LRA = Number(/LRA:\s+(-?[\d.]+) LU/.exec(ebu.slice(ebu.lastIndexOf('Summary')))?.[1]);
    const samplePeak = db(peakOf(fin));
    let clipped = 0;
    for (const d of fin) for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= 0.999) clipped++;

    const hf = filt(m, [['hp', 5000], ['hp', 5000]]);
    const kb = filt(m, [['hp', 40], ['lp', 120], ['lp', 120]]);
    const hfF = frames(hf);
    const kbF = frames(kb);

    // RMS-Verlauf je Takt und alle 0.5 s.
    const perBar = [];
    for (let n = 0; bar(n) < LENGTH; n++) {
      const e = Math.min(LENGTH, bar(n + 1));
      perBar.push({ bar: n, t: +bar(n).toFixed(3), rmsDb: +powDb(m, bar(n), e).toFixed(1), kickBandDb: +powDb(kb, bar(n), e).toFixed(1), hfDb: +powDb(hf, bar(n), e).toFixed(1) });
    }
    const rms05 = [];
    for (let t = 0; t < LENGTH; t += 0.5) rms05.push(+powDb(m, t, t + 0.5).toFixed(1));

    // Crash-Cues gegen Takte ohne Crash (gleicher Abschnitt): HF-Anstieg und Einsatzzeit.
    const crashCues = [
      { name: 'Build-Start (Mini-Drop-Crash)', t: bar(2) },
      { name: 'DROP (Kick zurück, Crash, Stabs)', t: bar(4) },
      { name: 'Overdrive L4 (Crash nach Clap-Roll)', t: bar(6) },
      { name: 'Phrasen-Crash nach Fill', t: bar(8) },
      { name: 'Checkpoint-Akzent (Crash + Stab + Terz)', t: bar(10) },
      { name: 'FINALE-Impact (Crash + Schlussstab)', t: bar(14) },
    ];
    const refBars = [5, 7, 9, 11].map((n) => bar(n));
    const hfJump = (t) => powDb(hf, t, t + 0.15) - powDb(hf, t - 0.3, t - 0.05);
    const refJump = Math.max(...refBars.map(hfJump));
    const crashes = crashCues.map((c) => {
      const on = onsetNear(hfF, c.t);
      return { ...c, onset: +on.t.toFixed(3), errMs: +((on.t - c.t) * 1000).toFixed(1), riseDb: +on.rise.toFixed(1), hfJumpDb: +hfJump(c.t).toFixed(1) };
    });
    // Kick-Band: Drop auf Takt 4 (nach Breakdown), Kick raus ab Takt 12, Outro ohne Kick ab 14.
    const kickDrop = onsetNear(kbF, bar(4));
    const kickChecks = {
      dropOnsetErrMs: +((kickDrop.t - bar(4)) * 1000).toFixed(1),
      breakdown1VsDropDb: +(powDb(kb, bar(3) + 0.1, bar(4) - 0.05) - powDb(kb, bar(4), bar(5))).toFixed(1),
      breakdown2VsL4Db: +(powDb(kb, bar(12) + 0.15, bar(14) - 0.05) - powDb(kb, bar(10), bar(12))).toFixed(1),
      outroVsL4Db: +(powDb(kb, bar(14) + 0.2, bar(16)) - powDb(kb, bar(10), bar(12))).toFixed(1),
    };
    const top = topOnsets(hfF, 10, 0.9).map((o) => +o.t.toFixed(3));
    // Checkpoint-Akzent: Differenz zur Referenz ohne Checkpoint (vor dem Mastering, gleiche Verstärkung) —
    // im L4-Teppich (Ride, Hats, Shaker) ist ein Crash 0.42 kein eindeutiger HF-Sprung im Mix.
    const g = 10 ** (gainDb / 20);
    const a0 = slice(A0.ch, off, N);
    const dAcc = a[0].map((v, i) => g * 0.5 * (v - a0[0][i] + a[1][i] - a0[1][i]));
    const accOn = onsetNear(frames(dAcc), bar(10));
    const accent = {
      onsetErrMs: +((accOn.t - bar(10)) * 1000).toFixed(1),
      levelDb: +powDb(dAcc, bar(10), bar(10) + 0.5).toFixed(1),
      vsMixDb: +(powDb(dAcc, bar(10), bar(10) + 0.5) - powDb(m, bar(10), bar(10) + 0.5)).toFixed(1),
      hfVsMixDb: +(powDb(filt(dAcc, [['hp', 5000], ['hp', 5000]]), bar(10), bar(10) + 0.5) - powDb(hf, bar(10), bar(10) + 0.5)).toFixed(1),
      duckAtStartDb: +(powDb(dAcc, 0, 0.35)).toFixed(1),
      elsewhereDb: +powDb(dAcc, 1, bar(10) - 0.2).toFixed(1),
    };

    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    check('Länge exakt 30.0 s @ 48 kHz', samples === N, `${samples} Samples`);
    check('Lautheit −14 LUFS ±0.5', Math.abs(I - TARGET_I) <= 0.5, `${fmt(I, 1)} LUFS`);
    check('True Peak ≤ −1 dBTP', TP <= -1, `${fmt(TP, 2)} dBTP`);
    check('Sample-Peak ≤ −1 dBFS', samplePeak <= -1, `${fmt(samplePeak)} dBFS`);
    check('kein Clipping (|x| ≥ 0.999)', clipped === 0, `${clipped} Samples`);
    check('loudnorm linear (keine Dynamik-Kompression)', p2.normalization_type === 'linear', p2.normalization_type);
    for (const c of crashes.filter((x) => !x.name.startsWith('Checkpoint'))) {
      check(`${c.name} @ ${fmt(c.t, 3)} s: Einsatz ±15 ms`, Math.abs(c.errMs) <= 15, `${c.errMs} ms`);
      check(`${c.name}: HF-Sprung deutlich über Takten ohne Crash`, c.hfJumpDb >= refJump + 3, `${c.hfJumpDb} dB vs ${fmt(refJump, 1)} dB`);
    }
    check('Checkpoint-Akzent: Einsatz auf Takt 10 (±10 ms, Differenz-Render)', Math.abs(accent.onsetErrMs) <= 10, `${accent.onsetErrMs} ms`);
    check('Checkpoint-Akzent: hörbar (Differenz ≥ Mix − 12 dB)', accent.vsMixDb >= -12, `${accent.vsMixDb} dB (HF ${accent.hfVsMixDb} dB)`);
    check('Checkpoint-Akzent: sonst keine Änderung (≤ −80 dBFS zwischen 1 s und Takt 10)', accent.elsewhereDb <= -80, `${accent.elsewhereDb} dBFS`);
    check('Drop: Kick setzt auf Takt 4 ein (±10 ms)', Math.abs(kickChecks.dropOnsetErrMs) <= 10, `${kickChecks.dropOnsetErrMs} ms`);
    check('Breakdown 1 (Takt 3): Kick-Band ≥ 10 dB unter dem Drop', kickChecks.breakdown1VsDropDb <= -10, `${kickChecks.breakdown1VsDropDb} dB`);
    check('Breakdown 2 (Takt 12–13): Kick-Band ≥ 10 dB unter L4', kickChecks.breakdown2VsL4Db <= -10, `${kickChecks.breakdown2VsL4Db} dB`);
    const layers = Object.fromEntries(A.bars.map((x) => [x.bar, x.layer]));
    check('Layer-Plan: T0–1 L0, T2 ≥ L1, T4–5 L3, T6–11 L4', layers[0] === 0 && layers[1] === 0 && layers[2] >= 1 && layers[4] === 3 && layers[5] === 3 && [6, 7, 8, 9, 10, 11].every((n) => layers[n] === 4), JSON.stringify(layers));

    // Bilder: Spektrogramm (log-Frequenz) und Wellenform.
    ffmpeg(['-y', '-i', musicPath, '-lavfi', 'showspectrumpic=s=1800x640:legend=1:fscale=log:scale=log:color=fiery:gain=2', `${OUT}/analysis/trailer_music_spectrogram.png`]);
    ffmpeg(['-y', '-i', musicPath, '-lavfi', 'showwavespic=s=1800x300:split_channels=0:colors=0x5ee0ff:scale=sqrt', `${OUT}/analysis/trailer_music_wave.png`]);

    // ---------------------------------------------------------------- cues.json
    const sections = [
      { name: 'Intro', from: 0, to: bar(2), bars: '0–1', what: 'Stand/L0: Nebenraum-Kick (leise, dumpf), Pad, leise Hats; Raumfilter öffnet in Takt 1 einen Spalt' },
      { name: 'Build', from: bar(2), to: bar(4), bars: '2–3', what: 'Takt 2: erste Hops L1→L2 (Hats, Clap, Bass, Rumble, Filter auf), Mini-Drop-Crash auf Takt 2; Takt 3: Surf-Breakdown (Kick/Bass raus, Acid + Pad offen, Surf-Riser)' },
      { name: 'Volle Energie', from: bar(4), to: bar(12), bars: '4–11', what: 'Takt 4 DROP in L3 (Acid, Ride, Shaker, Drop-Stabs); Takt 6 Overdrive L4 (Stabs, Crash, nach Clap-Roll); ab Takt 8 L4+ (zweite Stab-Figur, Acid weiter offen)' },
      { name: 'Surf-Breakdown / Höhepunkt', from: bar(12), to: bar(14), bars: '12–13', what: 'Kick/Bass/Clap raus, Pad + Acid offen, Surf-Riser steigt; ab ~22.7 s Bestzeit-Riser, letzter Beat Clap-Roll' },
      { name: 'Finale / Endkarte', from: bar(14), to: LENGTH, bars: '14–16½', what: 'Impact auf Takt 14 (Crash 1.0 + Schlussstab Am9 + Oktav-Stab), 1 Takt hell (Hats/Ride ohne Kick), ab 26.75 s Überblendung in Hall-Ausklang (Pad/Stab/FX), Ausblende 28.3–30 s' },
    ];
    const accents = [
      { t: bar(2), kind: 'mini-crash', what: 'Build-Start: Mini-Drop-Crash (leicht)' },
      { t: bar(3), kind: 'cut', what: 'Breakdown 1: Kick raus, Surf-Riser (Pre-Drop)' },
      { t: bar(4), kind: 'DROP', what: 'Kick zurück + Crash + Drop-Stabs (L3, Acid)' },
      { t: bar(6) - BEAT, kind: 'lead-in', what: 'Clap-Roll + Rausch-Sweep (1 Beat)' },
      { t: bar(6), kind: 'crash', what: 'Overdrive L4: Crash, Stabs setzen ein' },
      { t: bar(8) - BEAT, kind: 'fill', what: 'Fill im letzten Beat der Phrase' },
      { t: bar(8), kind: 'crash', what: 'Phrasen-Crash nach Fill' },
      { t: bar(10), kind: 'accent', what: 'Checkpoint-Akzent: Crash + Stab + steigende Terz' },
      { t: bar(12), kind: 'cut', what: 'Breakdown 2: Kick raus (Surf-Höhepunkt)' },
      { t: arr.finishEventAt, kind: 'riser', what: 'Bestzeit-Riser startet (bis Takt 14)' },
      { t: bar(14) - BEAT, kind: 'lead-in', what: 'Clap-Roll in den Impact' },
      { t: bar(14), kind: 'IMPACT', what: 'Finale: Crash + Schlussstab, Endkarte' },
      { t: x0, kind: 'tail', what: `Überblendung auf Hall-Ausklang bis ${x1} s` },
      { t: f0, kind: 'fade', what: 'Ausblende bis 30.0 s' },
    ].map((x) => ({ ...x, t: +x.t.toFixed(4) }));
    const cues = {
      generated: new Date().toISOString(),
      file: 'trailer_music.wav',
      sampleRate: SR,
      lengthS: LENGTH,
      bpm: arr.bpm,
      beatS: +BEAT.toFixed(6),
      barS: +BAR.toFixed(6),
      note: 'Alle Zeiten in Sekunden ab Dateianfang. Takt n beginnt exakt bei n · barS (erster Downbeat = 0.000). Beats: n · beatS.',
      bars: Array.from({ length: 17 }, (_, n) => ({ bar: n, t: +bar(n).toFixed(4), layer: layers[n] ?? null })),
      sections: sections.map((s) => ({ ...s, from: +s.from.toFixed(4), to: +s.to.toFixed(4) })),
      accents,
      sfxEvents: arr.sfxEvents.map((s) => ({ t: +s.t.toFixed(4), what: s.what })),
      stems,
      mastering: { integratedLufs: I, truePeakDbtp: TP, samplePeakDbfs: +samplePeak.toFixed(2), lra: LRA, gainDb: +gainDb.toFixed(2), loudnorm: p2.normalization_type },
    };
    writeFileSync(`${OUT}/cues.json`, JSON.stringify(cues, null, 2));
    writeFileSync(`${OUT}/analysis/analysis.json`, JSON.stringify({ perBar, rms05, crashes, refJumpDb: refJump, kickChecks, accent, topHfOnsets: top, checks, timeline: A.bars }, null, 2));

    console.log('\nRMS je Takt (dBFS, mono):');
    for (const p of perBar) console.log(`  T${String(p.bar).padStart(2)} ${fmt(p.t, 3).padStart(7)} s  RMS ${fmt(p.rmsDb, 1).padStart(6)}  Kick-Band ${fmt(p.kickBandDb, 1).padStart(6)}  >5k ${fmt(p.hfDb, 1).padStart(6)}  L${layers[p.bar]}`);
    console.log('RMS alle 0.5 s: ' + rms05.join(' '));
    console.log('Crash-Onsets: ' + crashes.map((c) => `${fmt(c.t, 3)}→${fmt(c.onset, 3)} (${c.errMs} ms, HF +${c.hfJumpDb} dB)`).join(' · ') + ` | Referenz-Takte max +${fmt(refJump, 1)} dB`);
    console.log('Stärkste HF-Onsets (Detektor, blind): ' + top.join(' '));
    console.log('Kick: ' + JSON.stringify(kickChecks));
    console.log('Akzent (Differenz): ' + JSON.stringify(accent));
    console.log('');
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}  [${c.detail}]`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} Prüfungen grün`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await browser.close();
    await srv.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
