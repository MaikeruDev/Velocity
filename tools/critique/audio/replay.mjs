/**
 * Kritik-Linse AUDIO: rendert Aufzeichnungen (rec_<run>.json aus record.mjs)
 * offline mit der echten Engine nach und misst.
 *
 *   node tools/critique/audio/replay.mjs [run ...]
 *
 * Ausgabe je Run unter shots/critique/audio/:
 *   run_<id>.wav        so wie gehört (Spiel-Defaults 0.8/0.8/0.8, Sicherheits-Clipper an)
 *   spec_<id>.png       Spektrogramm + Zeitleiste (Speed, Energie, Layer Spiel/Offline, Events)
 *   ana_<id>.json       Messwerte (LUFS, Peaks, Wind, SFX-Prominenz, Knackser, Layer-Zeiten)
 * Port: CRIT_AUDIO_PORT2 (Default 5207).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_AUDIO_PORT2 ?? 5207);
const OUT = 'shots/critique/audio';
const DEF = { master: 0.8, music: 0.8, sfx: 0.8 };

const args = process.argv.slice(2);
const ids = args.length > 0 ? args : ['l1', 'l1mid', 'l2', 'l2mid', 'beginner'];

const ANALYZE_ONLY = process.argv.includes('--analyze');
async function main() {
mkdirSync(OUT, { recursive: true });
if (ANALYZE_ONLY) {
  for (const id of ids.filter((x) => x !== '--analyze')) {
    const rec = JSON.parse(readFileSync(`${OUT}/rec_${id}.json`, 'utf8'));
    const res = JSON.parse(readFileSync(`${OUT}/raw_${id}.json`, 'utf8'));
    const ana = analyze(rec, res);
    writeFileSync(`${OUT}/ana_${id}.json`, JSON.stringify(ana, null, 1));
    printSummary(id, ana);
  }
  return;
}
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 800 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console]', m.text());
  });
  await page.goto(`${srv.url}dev/audio.html`);
  await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 30000 });
  for (const id of ids.filter((x) => !x.startsWith('--'))) {
    const rec = JSON.parse(readFileSync(`${OUT}/rec_${id}.json`, 'utf8'));
    const seconds = Math.ceil(rec.duration) + 0.5;
    const variants = {
      heard: { volumes: DEF, clipper: true, pcm: true, draw: true },
      full: { volumes: { master: 1, music: 1, sfx: 1 }, clipper: false },
      music: { volumes: { master: 0.8, music: 0.8, sfx: 0 }, clipper: false },
      sfx: { volumes: { master: 0.8, music: 0, sfx: 0.8 }, clipper: false },
      wind: { volumes: { master: 0.8, music: 0, sfx: 0.8 }, clipper: false, withEvents: false },
    };
    const res = {};
    for (const [name, v] of Object.entries(variants)) {
      const t0 = Date.now();
      const r = await page.evaluate(
        async ([recIn, secs, vv, title]) => {
          const m = await import('/tools/critique/audio/replayPage.js');
          const driveAt = m.makeDriveAt(recIn.frames);
          const out = await m.render({
            seconds: secs,
            driveAt,
            events: recIn.events,
            volumes: vv.volumes,
            clipper: vv.clipper,
            level: recIn.level,
            withEvents: vv.withEvents,
          });
          const meas = m.measure(out.buffer);
          if (vv.draw) m.drawReport(out.buffer, recIn, out.timeline, title);
          return { meas, timeline: out.timeline, pcm: vv.pcm ? m.toBase64Pcm16(out.buffer) : null };
        },
        [rec, seconds, v, `${id} (${rec.level}) — so gehört: Defaults 0.8, Clipper an`],
      );
      if (v.pcm) writeWav(`${OUT}/run_${id}.wav`, r.pcm, 48000, 2);
      if (v.draw) await page.locator('#crit').screenshot({ path: `${OUT}/spec_${id}.png` });
      res[name] = { meas: r.meas, timeline: r.timeline };
      console.log(`${id}/${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    writeFileSync(`${OUT}/raw_${id}.json`, JSON.stringify(res));
    const ana = analyze(rec, res);
    writeFileSync(`${OUT}/ana_${id}.json`, JSON.stringify(ana, null, 1));
    printSummary(id, ana);
  }
} finally {
  await browser.close();
  await srv.close();
}
}

// ------------------------------------------------------------------ Auswertung

function lufsFromMs(ms) {
  return -0.691 + 10 * Math.log10(ms + 1e-15);
}

/** Integrierte Lautheit nach BS.1770 (400-ms-Blöcke, 75 % Überlappung, Gates −70/−10). */
function integrated(kms100, from = 0, to = kms100.length) {
  const blocks = [];
  for (let i = from; i + 4 <= to; i++) blocks.push((kms100[i] + kms100[i + 1] + kms100[i + 2] + kms100[i + 3]) / 4);
  const abs = blocks.filter((b) => lufsFromMs(b) > -70);
  if (abs.length === 0) return -Infinity;
  const mean1 = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((b) => lufsFromMs(b) > lufsFromMs(mean1) - 10);
  return lufsFromMs(rel.reduce((a, b) => a + b, 0) / rel.length);
}

function momentary(kms100) {
  const out = [];
  for (let i = 0; i + 4 <= kms100.length; i++) out.push(lufsFromMs((kms100[i] + kms100[i + 1] + kms100[i + 2] + kms100[i + 3]) / 4));
  return out;
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function frameAt(frames, t) {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}

function analyze(rec, res) {
  const f = rec.frames;
  const move = f.find((x) => x.sp > 20);
  const moveT = move ? move.t : 0;
  // Layer-Zeiten im Spiel (Echtzeit) und Offline (geplant)
  const firstReal = {};
  for (const x of f) if (firstReal[x.l] === undefined) firstReal[x.l] = r2(x.t - moveT);
  const firstOff = {};
  for (const [t, , l] of res.heard.timeline) if (firstOff[l] === undefined) firstOff[l] = r2(t - moveT);
  // Zeitanteile je Layer (Spiel), nur solange aktiv gespielt wird
  const share = [0, 0, 0, 0, 0];
  let playT = 0;
  for (let i = 1; i < f.length; i++) {
    if (f[i - 1].gs !== 'playing' || f[i - 1].t < moveT) continue;
    const dt = f[i].t - f[i - 1].t;
    share[f[i - 1].l] += dt;
    playT += dt;
  }
  // Layer-Abstiege (Spiel): Zeitpunkt, von→nach, Speed-Einbruch davor
  const drops = [];
  for (let i = 1; i < f.length; i++) if (f[i].l < f[i - 1].l) drops.push({ t: r2(f[i].t), from: f[i - 1].l, to: f[i].l, speed: Math.round(f[i].sp), e: r2(f[i].e), gs: f[i].gs });

  const out = { id: rec.id, level: rec.level, result: rec.result, duration: r1(rec.duration), moveAt: r2(moveT), layerFirst: firstReal, layerFirstOffline: firstOff };
  out.layerShare = share.map((s) => r2(s / Math.max(playT, 1e-9)));
  out.layerDrops = drops;

  // Lautheit
  for (const k of ['heard', 'full', 'music', 'sfx', 'wind']) {
    const m = res[k].meas;
    const mom = momentary(m.kms100);
    out[k] = {
      lufsI: r1(integrated(m.kms100)),
      momMax: r1(Math.max(...mom)),
      peak: Math.round(m.peak * 1000) / 1000,
      peakDb: r1(db(m.peak)),
      over086: m.over086,
      over1: m.over1,
      clicks: m.clicks.length,
    };
  }
  // Lautheit je Layer-Phase (Musik allein, Momentary-Mittel auf Energie-Basis)
  const musicMom = momentary(res.music.meas.kms100);
  const byLayer = [[], [], [], [], []];
  for (let i = 0; i < musicMom.length; i++) {
    const t = i * 0.1 + 0.2;
    const fr = frameAt(f, t);
    if (fr.gs !== 'playing') continue;
    byLayer[fr.l].push(musicMom[i]);
  }
  out.musicMomentaryByLayer = byLayer.map((a) => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null));

  // Wind: K-gewichteter Pegel des Dauer-SFX (ohne Events) vs. Musik, gebinnt nach Speed
  const bins = [[0, 150], [150, 300], [300, 450], [450, 600], [600, 750], [750, 900], [900, 1100], [1100, 2000]];
  const windMom = momentary(res.wind.meas.kms100);
  out.windVsSpeed = bins.map(([a, b]) => {
    const w = [];
    const mu = [];
    for (let i = 0; i < windMom.length; i++) {
      const fr = frameAt(f, i * 0.1 + 0.2);
      if (fr.gs !== 'playing' || fr.sp < a || fr.sp >= b) continue;
      w.push(windMom[i]);
      mu.push(musicMom[i]);
    }
    if (w.length === 0) return { speed: `${a}-${b}`, n: 0 };
    const mw = w.reduce((x, y) => x + y, 0) / w.length;
    const mm = mu.reduce((x, y) => x + y, 0) / mu.length;
    return { speed: `${a}-${b}`, n: w.length, windLufs: r1(mw), musicLufs: r1(mm), windMinusMusic: r1(mw - mm) };
  });

  // SFX-Prominenz je Event-Typ: Spitzen-RMS (10 ms) der SFX-Spur 0–250 ms nach dem Event
  // relativ zum Musik-RMS (Mittel 400 ms um das Event). Nur Events ohne anderes SFX-Event ±150 ms.
  const sfxR = res.sfx.meas.rms10;
  const musR = res.music.meas.rms10;
  const windR = res.wind.meas.rms10;
  const byType = {};
  const evs = rec.events;
  for (const e of evs) {
    const i0 = Math.round(e.t * 100);
    if (i0 < 20 || i0 + 25 >= sfxR.length) continue;
    let pk = 0;
    for (let i = i0; i < i0 + 25; i++) {
      // Wind abziehen (Energie)
      const ev = Math.sqrt(Math.max(0, sfxR[i] ** 2 - windR[i] ** 2));
      if (ev > pk) pk = ev;
    }
    let mm = 0;
    for (let i = i0 - 20; i < i0 + 20; i++) mm += musR[i] ** 2;
    mm = Math.sqrt(mm / 40);
    const key = e.type === 'jump' ? (e.chain >= 2 ? 'jump+blip' : 'jump') : e.type === 'land' ? (evs.some((j) => j.type === 'jump' && Math.abs(j.t - e.t) < 0.07) ? 'land(bhop)' : 'land') : e.type;
    (byType[key] ??= []).push(db(pk) - db(mm));
  }
  out.sfxOverMusicDb = Object.fromEntries(
    Object.entries(byType).map(([k, a]) => {
      const s = [...a].sort((x, y) => x - y);
      return [k, { n: a.length, median: r1(s[Math.floor(s.length / 2)]), min: r1(s[0]), max: r1(s[s.length - 1]) }];
    }),
  );
  // Knackser im Gehörten: welchen Events liegen sie nahe?
  out.clicksHeard = res.heard.meas.clicks.slice(0, 60).map((c) => {
    const near = evs.filter((e) => Math.abs(e.t - c.t) < 0.08).map((e) => `${e.type}${e.reason ? ':' + e.reason : ''}@${r2(c.t - e.t)}`);
    return { t: r2(c.t), ch: c.ch, d: Math.round(c.d * 1000) / 1000, ratio: r1(c.ratio), near };
  });
  out.clicksMusic = res.music.meas.clicks.length;
  out.clicksSfx = res.sfx.meas.clicks.length;
  out.clicksSfxList = res.sfx.meas.clicks.slice(0, 40).map((c) => {
    const near = evs.filter((e) => Math.abs(e.t - c.t) < 0.08).map((e) => `${e.type}@${r2(c.t - e.t)}`);
    return { t: r2(c.t), d: Math.round(c.d * 1000) / 1000, ratio: r1(c.ratio), near };
  });
  out.clicksMusicList = res.music.meas.clicks.slice(0, 40).map((c) => ({ t: r2(c.t), d: Math.round(c.d * 1000) / 1000, ratio: r1(c.ratio) }));
  // Short-term-Kurve (3 s) der gehörten Mischung, 0.5-s-Raster
  const hk = res.heard.meas.kms100;
  out.shortTerm = [];
  for (let i = 0; i + 30 <= hk.length; i += 5) {
    let s = 0;
    for (let j = i; j < i + 30; j++) s += hk[j];
    out.shortTerm.push([r1((i + 30) / 10), r1(lufsFromMs(s / 30))]);
  }
  return out;
}

function printSummary(id, a) {
  console.log(`\n=== ${id} (${a.level}) ${a.result}, ${a.duration} s, Bewegung ab ${a.moveAt} s`);
  console.log(`Layer erstmals (s nach Bewegungsbeginn) Spiel ${JSON.stringify(a.layerFirst)}  Offline ${JSON.stringify(a.layerFirstOffline)}`);
  console.log(`Zeitanteil je Layer (Spiel, beim Spielen): ${a.layerShare.join(' / ')}`);
  console.log(`Abstiege: ${a.layerDrops.map((d) => `${d.t}s L${d.from}→${d.to} (${d.speed} u/s, E ${d.e}, ${d.gs})`).join('; ')}`);
  for (const k of ['heard', 'full', 'music', 'sfx', 'wind']) {
    const m = a[k];
    console.log(`${k.padEnd(6)} LUFS-I ${m.lufsI}  mom.max ${m.momMax}  peak ${m.peak} (${m.peakDb} dBFS)  >0.86 ${m.over086}  ≥1 ${m.over1}  Knackser ${m.clicks}`);
  }
  console.log(`Musik momentary je Layer: ${JSON.stringify(a.musicMomentaryByLayer)}`);
  console.log('Wind vs Speed: ' + a.windVsSpeed.filter((w) => w.n > 0).map((w) => `${w.speed}: Wind ${w.windLufs} / Musik ${w.musicLufs} (${w.windMinusMusic} LU)`).join(' | '));
  console.log('SFX über Musik (dB, Median [min..max]): ' + Object.entries(a.sfxOverMusicDb).map(([k, v]) => `${k} n${v.n} ${v.median} [${v.min}..${v.max}]`).join(' | '));
  console.log(`Knackser: gehört ${a.heard.clicks}, Musik ${a.clicksMusic}, SFX ${a.clicksSfx}`);
}

function writeWav(path, b64, sampleRate, channels) {
  const pcm = Buffer.from(b64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
