/**
 * Kritik-Linse AUDIO: Hörbarkeit der SFX gegen die Musik je Layer (Maskierung).
 * Rendert pro Energiestufe drei Spuren (Musik allein, SFX mit Events, SFX ohne
 * Events = Wind) und vergleicht je Event in Terzbändern (40 Hz–12 kHz):
 * Band-SNR = Event-Energie / (Musik + Wind) im 150-ms-Fenster nach dem Event.
 *
 *   node tools/critique/audio/sfxmask.mjs      (Port CRIT_AUDIO_PORT2, Default 5207)
 */
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_AUDIO_PORT2 ?? 5207);
const OUT = 'shots/verify1/audio';
const SR = 48000;

const LEVELS = [
  { name: 'L0 Stand', drive: { speed: 0 } },
  { name: 'L1 Laufen 300', drive: { speed: 300 } },
  { name: 'L2 Bhop 500', drive: { speed: 500, hopChain: 3, strafeSync: 0.6, onGround: false } },
  { name: 'L3 Bhop 700', drive: { speed: 700, hopChain: 3, strafeSync: 0.6, onGround: false } },
  { name: 'L4 Flow 1000', drive: { speed: 1000, hopChain: 8, strafeSync: 0.8, onGround: false } },
];

const EVENTS = [
  { label: 'Sprung (Chain 1)', at: 1.0, ev: { type: 'jump', speed: 300, gain: 0, perfect: false, chain: 1, sync: 0, crouched: false, coyote: false } },
  { label: 'Bhop + Blip (Chain 6)', at: 2.0, ev: [{ type: 'land', impact: 302, speed: 500, airTime: 0.75 }, { type: 'jump', speed: 500, gain: 20, perfect: true, chain: 6, sync: 0.8, crouched: false, coyote: false }] },
  { label: 'Bhop + Blip (Chain 20)', at: 3.0, ev: [{ type: 'land', impact: 302, speed: 800, airTime: 0.75 }, { type: 'jump', speed: 800, gain: 12, perfect: true, chain: 20, sync: 0.8, crouched: false, coyote: false }] },
  { label: 'Harte Landung (700)', at: 4.0, ev: { type: 'land', impact: 700, speed: 300, airTime: 1.2 }, delay: 0.042 },
  { label: 'Checkpoint', at: 5.0, ev: { type: 'checkpoint', index: 1, total: 3, time: 10, split: null } },
  { label: 'Speed-Meilenstein 750', at: 6.0, ev: { type: 'speedMilestone', speed: 750 } },
  { label: 'Speed-Meilenstein 1000', at: 7.0, ev: { type: 'speedMilestone', speed: 1000 } },
  { label: 'Schritt', at: 8.0, ev: { type: 'footstep', speed: 300, left: true } },
  { label: 'Surf-Zischen (1 s)', at: 9.2, ev: { type: 'surfStart' }, window: 0.8 },
  { label: 'Finish', at: 11.0, ev: { type: 'finish', time: 20, best: true, previousBest: 21 }, window: 0.5 },
];
const SECONDS = 13.5;

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const out = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${srv.url}dev/audio.html`);
  await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 30000 });
  for (const L of LEVELS) {
    const tracks = {};
    for (const [name, vol, withEv] of [
      ['music', { master: 0.8, music: 0.8, sfx: 0 }, true],
      ['sfx', { master: 0.8, music: 0, sfx: 0.8 }, true],
      ['wind', { master: 0.8, music: 0, sfx: 0.8 }, false],
    ]) {
      tracks[name] = await page.evaluate(
        async ([drv, events, vv, we, secs]) => {
          const off = await import('/src/audio/offline.ts');
          const base = { speed: 0, onGround: true, hopChain: 0, strafeSync: 0, airTime: 0, surfing: false, active: true, ...drv };
          const evs = [];
          if (we) {
            for (const e of events) for (const x of Array.isArray(e.ev) ? e.ev : [e.ev]) evs.push({ time: e.at, event: x });
            evs.push({ time: 10.2, event: { type: 'surfEnd' } });
          }
          const r = await off.renderOffline({
            seconds: secs,
            sampleRate: 48000,
            drive: (t) => ({ ...base, surfing: we && t >= 9.2 && t < 10.2 ? true : base.surfing }),
            settle: true,
            events: evs,
            volumes: vv,
            clipper: false,
          });
          const b = r.buffer;
          const L0 = b.getChannelData(0);
          const R0 = b.getChannelData(1);
          const mono = new Float32Array(L0.length);
          for (let i = 0; i < mono.length; i++) mono[i] = (L0[i] + R0[i]) / 2;
          return Array.from(mono);
        },
        [L.drive, EVENTS, vol, withEv, SECONDS],
      );
    }
    const row = { level: L.name, events: {} };
    for (const e of EVENTS) {
      const t0 = e.at + (e.delay ?? 0) - 0.01;
      const win = e.window ?? 0.08;
      const a = Math.round(t0 * SR);
      const n = Math.round(win * SR);
      const bands = thirdOctaves();
      const pm = bandPower(tracks.music, a, n, bands);
      const ps = bandPower(tracks.sfx, a, n, bands);
      const pw = bandPower(tracks.wind, a, n, bands);
      let best = -Infinity;
      let bestF = 0;
      let audible = 0;
      let evTot = 0;
      let masker = 0;
      for (let k = 0; k < bands.length; k++) {
        const ev = Math.max(0, ps[k] - pw[k]);
        const mk = pm[k] + pw[k];
        evTot += ev;
        masker += mk;
        const snr = 10 * Math.log10((ev + 1e-14) / (mk + 1e-14));
        if (snr > best) {
          best = snr;
          bestF = bands[k][1];
        }
        if (snr > 0) audible++;
      }
      row.events[e.label] = {
        maxBandSnr: Math.round(best * 10) / 10,
        atHz: Math.round(bestF),
        bandsAbove0: audible,
        broadbandSnr: Math.round(10 * Math.log10((evTot + 1e-14) / (masker + 1e-14)) * 10) / 10,
      };
    }
    {
      // Wind gegen Musik über 0.5–0.95 s (vor dem ersten Event), Terzbänder
      const bands = thirdOctaves();
      const a = Math.round(0.3 * SR);
      const n = Math.round(0.6 * SR);
      const pm = bandPower(tracks.music, a, n, bands);
      const pw = bandPower(tracks.wind, a, n, bands);
      let best = -Infinity;
      let bestF = 0;
      let tw = 0;
      let tm = 0;
      for (let k = 0; k < bands.length; k++) {
        tw += pw[k];
        tm += pm[k];
        const snr = 10 * Math.log10((pw[k] + 1e-14) / (pm[k] + 1e-14));
        if (snr > best) { best = snr; bestF = bands[k][1]; }
      }
      row.wind = { maxBandSnr: Math.round(best * 10) / 10, atHz: Math.round(bestF), broadband: Math.round(10 * Math.log10((tw + 1e-14) / (tm + 1e-14)) * 10) / 10 };
      console.log(`  Wind (Dauer)             max Band-SNR ${row.wind.maxBandSnr} dB @ ${row.wind.atHz} Hz · breitbandig ${row.wind.broadband} dB`);
    }
    out.push(row);
    console.log(`\n${L.name}`);
    for (const [k, v] of Object.entries(row.events)) console.log(`  ${k.padEnd(24)} max Band-SNR ${String(v.maxBandSnr).padStart(6)} dB @ ${String(v.atHz).padStart(5)} Hz · Bänder > 0 dB: ${String(v.bandsAbove0).padStart(2)} · breitbandig ${v.broadbandSnr} dB`);
  }
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(`${OUT}/sfxmask.json`, JSON.stringify(out, null, 1));

function thirdOctaves() {
  const out = [];
  for (let i = -14; i <= 11; i++) {
    const fc = 1000 * 2 ** (i / 3);
    if (fc < 40 || fc > 12500) continue;
    out.push([fc / 2 ** (1 / 6), fc, fc * 2 ** (1 / 6)]);
  }
  return out;
}

function bandPower(x, a, n, bands) {
  const N = 8192;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < Math.min(n, N); i++) {
    const m = Math.min(n, N);
    const tp = Math.round(0.004 * SR);
    const w = i < tp ? 0.5 - 0.5 * Math.cos((Math.PI * i) / tp) : i > m - tp ? 0.5 - 0.5 * Math.cos((Math.PI * (m - i)) / tp) : 1;
    re[i] = (x[a + i] ?? 0) * w;
  }
  fft(re, im);
  const p = bands.map(() => 0);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    const pw = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < bands.length; b++) if (f >= bands[b][0] && f < bands[b][2]) p[b] += pw;
  }
  return p;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar;
        im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar;
        im[i + j] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
