/**
 * Musik für den 60-s-Trailer (tools/trailer/trailer60Render.ts) rendern, zusammenkleben, mastern.
 *
 *   node tools/trailer/music60.mjs
 *
 * Aufbau (Trailer-Zeit): Takt 0–1 Cold Open (L4 gedämpft "aus dem Nebenraum", letzter Beat als Tape-Stop),
 * ab Takt 2 der main-Render (dessen Takt m liegt auf Trailer-Takt m + 2). Hall-Ausklang + Ausblende am Ende.
 * Ausgaben: media/audio/trailer60_music.wav, media/audio/stems/sfx_wind_60.wav, media/audio/cues60.json.
 */
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDevServer, launchBrowser } from '../lib/devServer.mjs';

const PORT = Number(process.env.TRAILER_PORT ?? 5604);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const SR = 48000;
const LENGTH = 60;
const N = LENGTH * SR;

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

function writeWav(path, ch, bits = 's24') {
  const n = ch[0].length;
  const nc = ch.length;
  const bps = bits === 'f32' ? 4 : 3;
  const data = Buffer.alloc(n * nc * bps);
  let o = 0;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nc; c++) {
      const v = ch[c][i];
      if (bits === 'f32') data.writeFloatLE(v, o);
      else data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607))), o, 3);
      o += bps;
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
const lastJson = (s) => JSON.parse(s.slice(s.lastIndexOf('{'), s.lastIndexOf('}') + 1));
const ramp = (t, a, b) => (t <= a ? 0 : t >= b ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - a)) / (b - a)));

async function main() {
  mkdirSync('media/audio/stems', { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'vel-t60-'));
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`${srv.url}dev/audio.html`);
    await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 30000 });
    const job = async (name) => {
      const t0 = Date.now();
      const r = await page.evaluate(async (n) => (await import('/tools/trailer/trailer60Render.ts')).run(n), name);
      console.log(`  render ${name.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return { ...r, ch: decodeF32(r) };
    };
    const info = await page.evaluate(async () => (await import('/tools/trailer/trailer60Render.ts')).info());
    const BAR = info.bar;
    const BEAT = info.beat;
    const off = Math.round(info.lead * SR);
    const cold = await job('coldOpen');
    const main = await job('main');
    const tail = await job('mainTail');
    const wind = await job('mainWind');
    console.log('  main-Takte: ' + main.bars.map((b) => `${b.bar}:${b.energy.toFixed(2)}/L${b.layer}${b.breakdown ? 'B' : ''}`).join(' '));
    console.log('  cold-Takte: ' + cold.bars.map((b) => `${b.bar}:${b.energy.toFixed(2)}/L${b.layer}`).join(' '));

    const coldLen = Math.round(info.coldBars * BAR * SR);
    const out = [new Float32Array(N), new Float32Array(N)];
    // Cold Open mit Tape-Stop im letzten Beat: Lesekopf bremst quadratisch auf 0 (Tonhöhe fällt mit).
    const stopFrom = coldLen - Math.round(BEAT * SR);
    for (let c = 0; c < 2; c++) {
      const src = cold.ch[c];
      let pos = off;
      for (let i = 0; i < coldLen; i++) {
        let rate = 1;
        if (i >= stopFrom) {
          const u = (i - stopFrom) / (coldLen - stopFrom);
          rate = (1 - u) * (1 - u);
        }
        const k = Math.floor(pos);
        const fr = pos - k;
        const v = (src[k] ?? 0) * (1 - fr) + (src[k + 1] ?? 0) * fr;
        // Kurze Ausblende ganz am Ende, gegen den Knack.
        const tailGain = i > coldLen - 240 ? (coldLen - i) / 240 : 1;
        out[c][i] = v * tailGain;
        pos += rate;
      }
    }
    // main ab Takt 2, Hall-Ausklang + Ausblende.
    const [x0, x1] = info.tailXfade;
    const [f0, f1] = info.fadeOut;
    for (let c = 0; c < 2; c++) {
      const a = main.ch[c];
      const b = tail.ch[c];
      for (let i = coldLen; i < N; i++) {
        const j = i - coldLen + off;
        const t = (i - coldLen) / SR;
        const w = ramp(t, x0, x1);
        out[c][i] = ((1 - w) * (a[j] ?? 0) + w * (b[j] ?? 0)) * (1 - ramp(t, f0, f1));
      }
    }
    const pre = join(tmp, 'pre.wav');
    writeWav(pre, out, 'f32');
    const p1 = lastJson(ffmpeg(['-i', pre, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=20:print_format=json', '-f', 'null', '-']));
    const ln2 = `loudnorm=I=-14:TP=-1.5:LRA=20:measured_I=${p1.input_i}:measured_TP=${p1.input_tp}:measured_LRA=${p1.input_lra}:measured_thresh=${p1.input_thresh}:offset=${p1.target_offset}:linear=true:print_format=json`;
    const p2 = lastJson(ffmpeg(['-y', '-i', pre, '-af', `${ln2},aresample=${SR},apad=whole_len=${N},atrim=end_sample=${N}`, '-ar', String(SR), '-c:a', 'pcm_s24le', 'media/audio/trailer60_music.wav']));
    const gainDb = Number(p2.output_i) - Number(p2.input_i);
    console.log(`  Musik: ${p2.normalization_type}, ${p2.output_i} LUFS, TP ${p2.output_tp} dBTP, Gain ${gainDb.toFixed(2)} dB`);
    // Wind-Stem auf dieselbe Zeitbasis (ab Takt 2), gleiche Verstärkung wie die Musik.
    const g = 10 ** (gainDb / 20);
    const w = [new Float32Array(N), new Float32Array(N)];
    for (let c = 0; c < 2; c++) for (let i = coldLen; i < N; i++) w[c][i] = (wind.ch[c][i - coldLen + off] ?? 0) * g * (1 - ramp((i - coldLen) / SR, f0, f1));
    writeWav('media/audio/stems/sfx_wind_60.wav', w, 's24');
    const T = (mainBar) => +((mainBar + info.coldBars) * BAR).toFixed(4);
    const cues = {
      bpm: 132,
      beatS: BEAT,
      barS: BAR,
      note: 'Trailer-Zeit; Takt n beginnt bei n · barS. main-Takt m = Trailer-Takt m + 2.',
      accents: [
        { t: 0, what: 'Cold Open (L4 gedämpft)' },
        { t: +(2 * BAR - BEAT).toFixed(4), what: 'Tape-Stop' },
        { t: T(0), what: 'Intro (ruhig)' },
        { t: T(2), what: 'Build: erste Hops' },
        { t: T(3), what: 'Surf-Breakdown 1' },
        { t: T(4), what: 'DROP 1' },
        { t: T(8), what: 'Overdrive L4 (Crash)' },
        { t: T(12), what: 'Checkpoint-Akzent' },
        { t: T(14), what: 'Breakdown 2' },
        { t: T(16), what: 'DROP 2' },
        { t: T(24), what: 'Breakdown 3 + Bestzeit-Riser' },
        { t: T(26), what: 'IMPACT' },
        { t: +(info.tailXfade[0] + 2 * BAR).toFixed(4), what: 'Hall-Ausklang' },
      ],
      bars: main.bars.map((b) => ({ trailerBar: b.bar + info.coldBars, t: T(b.bar), energy: +b.energy.toFixed(3), layer: b.layer, breakdown: b.breakdown })),
      mastering: { lufs: p2.output_i, tp: p2.output_tp, gainDb },
    };
    writeFileSync('media/audio/cues60.json', JSON.stringify(cues, null, 2));
    const ebu = ffmpeg(['-i', 'media/audio/trailer60_music.wav', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    console.log(ebu.slice(ebu.lastIndexOf('Summary')).replace(/\n\s*\n/g, '\n'));
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
