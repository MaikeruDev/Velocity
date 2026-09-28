/**
 * npm run audio:check — rendert den Techno offline (OfflineAudioContext im
 * echten Chromium) für fünf Energiestufen und mehrere Szenarien, misst Pegel,
 * Spektrum, Kick-Timing, Übergänge und Respawn-Dips, schreibt
 * shots/audio/report.json, WAVs zum Anhören und Spektrogramm-Screenshots.
 * Exit-Code 1, wenn eine Prüfung fällt.
 *
 * Pegel werden OHNE den Sicherheits-Clipper gemessen (clipper: false): mit ihm
 * läge jeder Peak unter 0.985 und eine Übersteuerung wäre unsichtbar.
 *
 *   --stems   jede Spur einzeln messen → shots/audio/stems.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.AUDIO_PORT ?? 5182);
const OUT = 'shots/audio';
const BPM = 132;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const SECONDS = BAR * 8 + 0.3;
/** Spiel-Defaults (settingsTypes.ts): 0.8 → Gain 0.64. */
const DEFAULT_VOLUMES = { master: 0.8, music: 0.8, sfx: 0.8 };
const FULL_VOLUMES = { master: 1, music: 1, sfx: 1 };
/** Muss zu src/audio/dev/scenarios.ts passen. */
const FLOW_ENTRY_AT = 6;
const SURF_FROM = 6;
const SURF_TO = 10;
const FINISH_AT = 8;
const WALK_AT = 8;
const WHOOSH_FROM = 3;
const WHOOSH_TO = 5;
/** Offline-Taktanker (TechnoAudio OFFLINE_START). */
const ORIGIN = 0.02;
const RESPAWN_TIMES = [4, 13, 15.5, 18, 20.5];
const RESPAWN_FULL = [true, true, false, false, false];

// Formel B (energy.ts): Stufen ohne Surf — Surf ist ein eigener Zustand (Breakdown, eigenes Szenario).
const LEVELS = [
  { name: 'e000', label: 'Energie ~0 (Stand)', drive: { speed: 0 } },
  // Nicht L1: dort ist die Kick voll da, die leise L0-Kick (Breakdown) ließe den Schwerpunkt "fallen".
  { name: 'e025', label: 'Energie ~0.26 (Laufen mit ersten Hops, L2)', drive: { speed: 300, hopChain: 3, strafeSync: 0.75 } },
  { name: 'e050', label: 'Energie ~0.52 (Bhop, L2)', drive: { speed: 500, hopChain: 4, strafeSync: 0.6, onGround: false } },
  { name: 'e075', label: 'Energie ~0.75 (schnell, L3)', drive: { speed: 700, hopChain: 4, strafeSync: 0.6, onGround: false } },
  { name: 'e100', label: 'Energie ~1 (Flow, L4)', drive: { speed: 1000, hopChain: 12, strafeSync: 0.8, onGround: false } },
];

const PARTS = ['kick', 'hats', 'clap', 'perc', 'bass', 'rumble', 'acid', 'ride', 'shaker', 'stabs', 'pad', 'fx'];
const only = (...keep) => PARTS.filter((p) => !keep.includes(p));

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

/** PCM → getrennte Kanäle (Float64). */
function channels(r) {
  const pcm = new Int16Array(new Uint8Array(Buffer.from(r.pcm, 'base64')).buffer);
  const ch = r.channels;
  const n = pcm.length / ch;
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = pcm[i * ch] / 32768;
    R[i] = pcm[i * ch + (ch > 1 ? 1 : 0)] / 32768;
  }
  return { L, R, sr: r.sampleRate };
}

/** RBJ-Biquad (lp/hp, Q = 1/√2) über ein ganzes Signal. */
function biquad(x, sr, type, f) {
  const w = (2 * Math.PI * f) / sr;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const b = type === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [(1 - c) / 2, 1 - c, (1 - c) / 2];
  const a0 = 1 + al;
  const a1 = -2 * c;
  const a2 = 1 - al;
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Filterkette [[typ, f], …] auf ein Signal. */
const filt = (x, sr, chain) => chain.reduce((acc, [type, fc]) => biquad(acc, sr, type, fc), x);
const mid = (c) => c.L.map((v, i) => 0.5 * (v + c.R[i]));
const side = (c) => c.L.map((v, i) => 0.5 * (v - c.R[i]));

/** Mittlere Leistung in dB über [a, b) Sekunden. */
function powDb(x, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(x.length, Math.floor(b * sr));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / Math.max(1, i1 - i0) + 1e-15);
}

/** Einsätze: erste Überschreitung von `th`, danach `gap` Sekunden Sperre. */
function onsets(x, sr, th, gap) {
  const out = [];
  let next = 0;
  for (let i = 0; i < x.length; i++) {
    if (i >= next && Math.abs(x[i]) > th) {
      out.push(i / sr);
      next = i + Math.round(gap * sr);
    }
  }
  return out;
}

/** Nächster Beat ≥ t auf dem Offline-Raster. */
const beatAtOrAfter = (t) => ORIGIN + Math.ceil((t - ORIGIN) / BEAT - 1e-9) * BEAT;

/** PCM (base64, Int16 LE, verschachtelt) → Pegel-Helfer. */
function pcmView(r) {
  const pcm = new Int16Array(new Uint8Array(Buffer.from(r.pcm, 'base64')).buffer);
  const ch = r.channels;
  const sr = r.sampleRate;
  /** RMS in dBFS über [a, b) Sekunden. */
  const rmsDb = (a, b) => {
    const i0 = Math.max(0, Math.floor(a * sr));
    const i1 = Math.min(pcm.length / ch, Math.floor(b * sr));
    let sum = 0;
    for (let i = i0; i < i1; i++) for (let c = 0; c < ch; c++) sum += (pcm[i * ch + c] / 32768) ** 2;
    return 10 * Math.log10(sum / Math.max(1, (i1 - i0) * ch) + 1e-12);
  };
  /** Lautestes Fenster (Länge w) im Bereich [a, b) — Startzeit und Pegel. */
  const loudest = (a, b, w) => {
    let best = { t: a, db: -Infinity };
    for (let t = a; t + w <= b; t += 0.01) {
      const db = rmsDb(t, t + w);
      if (db > best.db) best = { t, db };
    }
    return best;
  };
  return { rmsDb, loudest };
}

async function stems(page) {
  const out = {};
  for (const L of [LEVELS[0], LEVELS[2], LEVELS[4]]) {
    out[L.name] = {};
    console.log(`\n${L.label}`);
    for (const solo of ['ALL', ...PARTS]) {
      const mute = solo === 'ALL' ? [] : only(solo);
      const r = await page.evaluate(([d, s2, m]) => window.__audioRenderOffline(d, s2, { mute: m, clipper: false }), [L.drive, BAR * 4 + 0.2, mute]);
      const m = r.metrics;
      const bandDb = (share) => m.rmsDb + 10 * Math.log10(Math.max(share, 1e-12));
      const row = {
        rmsDb: m.rmsDb,
        peak: m.peak,
        lowDb: bandDb(m.bands.sub + m.bands.low),
        midDb: bandDb(m.bands.mid),
        presDb: bandDb(m.bands.presence),
        highDb: bandDb(m.bands.high + m.bands.air),
        centroid: m.centroidHz,
      };
      out[L.name][solo] = row;
      if (m.rms < 1e-5) continue;
      console.log(
        `  ${solo.padEnd(7)} RMS ${fmt(row.rmsDb).padStart(6)}  peak ${fmt(row.peak, 3)}  low ${fmt(row.lowDb).padStart(6)}  ` +
          `mid ${fmt(row.midDb).padStart(6)}  pres ${fmt(row.presDb).padStart(6)}  high ${fmt(row.highDb).padStart(6)}  centroid ${fmt(row.centroid, 0)} Hz`,
      );
    }
  }
  writeFileSync(`${OUT}/stems.json`, JSON.stringify(out, null, 2));
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pct2 = (x) => `${(x * 100).toFixed(3)}%`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1260, height: 1500 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}]`, m.text());
    });
    await page.goto(`${srv.url}dev/audio.html`);
    await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 30000 });
    if (process.argv.includes('--stems')) {
      await stems(page);
      return;
    }

    // ---------------------------------------------------------------- Energiestufen
    const levels = [];
    for (const L of LEVELS) {
      const r = await page.evaluate(
        ([d, s, title]) => window.__audioRenderOffline(d, s, { pcm: true, title, clipper: false }),
        [L.drive, SECONDS, L.label],
      );
      writeWav(`${OUT}/${L.name}.wav`, r.pcm, r.sampleRate, r.channels);
      await page.locator('#spec').screenshot({ path: `${OUT}/spec_${L.name}.png` });
      const entry = { ...L, energy: r.energy, targetEnergy: r.targetEnergy, layer: r.layer, renderMs: Math.round(r.renderMs), metrics: r.metrics };
      levels.push(entry);
      const m = r.metrics;
      console.log(
        `${L.name}  E=${fmt(r.energy, 3)} L${r.layer}  peak ${fmt(m.peak, 3)}  RMS ${fmt(m.rmsDb)} dB  crest ${fmt(m.crestDb)} dB  ` +
          `centroid ${fmt(m.centroidHz, 0)} Hz  >5k ${pct(m.highShare)}  mid ${pct(m.bands.mid)}  kick ${m.kick.onsets}/${m.kick.expected} ` +
          `dev ${fmt(m.kick.maxDeviationMs, 2)} ms  lowInKick ${pct(m.kick.lowShareInKick)}  S/M ${fmt(m.sideToMid, 3)}  ` +
          `laptop ${fmt(m.smallSpeaker.lossDb)} dB mid ${pct(m.smallSpeaker.midShare)} >5k ${pct(m.smallSpeaker.highShare)}  ` +
          `clip ${pct2(m.clipperActivity)}  (${Math.round(r.renderMs)} ms)`,
      );
    }

    // Determinismus: gleicher Seed, gleicher Drive → gleiche PCM. Chromium summiert
    // Fan-in-Verbindungen in unbestimmter Reihenfolge (Float-Rundung ~1e-7), daher
    // Toleranz von wenigen LSB statt Bitgleichheit.
    const hashOf = (b64) => createHash('sha1').update(b64).digest('hex');
    const detA = await page.evaluate(([d, s]) => window.__audioRenderOffline(d, s, { pcm: true }), [LEVELS[4].drive, BAR * 2]);
    const detB = await page.evaluate(([d, s]) => window.__audioRenderOffline(d, s, { pcm: true }), [LEVELS[4].drive, BAR * 2]);
    const pa = new Int16Array(new Uint8Array(Buffer.from(detA.pcm, 'base64')).buffer);
    const pb = new Int16Array(new Uint8Array(Buffer.from(detB.pcm, 'base64')).buffer);
    let maxLsb = pa.length === pb.length ? 0 : Infinity;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) maxLsb = Math.max(maxLsb, Math.abs(pa[i] - pb[i]));
    check(
      'Deterministisch (2 Renders ≤ 16 LSB ≈ −66 dBFS Abweichung)',
      maxLsb <= 16,
      `max ${maxLsb} LSB, ${hashOf(detA.pcm) === hashOf(detB.pcm) ? 'bitgleich' : 'nicht bitgleich'}`,
    );

    // Tiefband-Besitz: Spitze des Mixes ohne (trockene) Kick vs. Kick solo — Bass, Rumble & Co. müssen darunter bleiben.
    for (const l of levels.slice(1)) {
      const rest = await page.evaluate(([d, s]) => window.__audioRenderOffline(d, s, { mute: ['kick'] }), [l.drive, BAR * 4 + 0.2]);
      const solo = await page.evaluate(([d, s, m]) => window.__audioRenderOffline(d, s, { mute: m }), [l.drive, BAR * 4 + 0.2, only('kick')]);
      l.lowPeakRest = rest.metrics.kick.lowPeak;
      l.lowPeakKick = solo.metrics.kick.lowPeak;
      const relDb = 20 * Math.log10(l.lowPeakRest / l.lowPeakKick);
      console.log(`${l.name}  Tiefband-Spitze: Kick solo ${fmt(l.lowPeakKick, 3)}, Rest ${fmt(l.lowPeakRest, 3)} (${fmt(relDb)} dB)`);
    }

    // ---------------------------------------------------------------- Szenarien mit SFX
    const scenarios = [];
    const runScenario = async (name, file, opts) => {
      const r = await page.evaluate(([n, o]) => window.__audioRenderScenario(n, { pcm: true, clipper: false, ...o }), [name, opts]);
      if (file !== null) {
        writeWav(`${OUT}/${file}.wav`, r.pcm, r.sampleRate, r.channels);
        await page.locator('#spec').screenshot({ path: `${OUT}/spec_${file}.png` });
      }
      return r;
    };
    for (const [name, file, vol, label] of [
      ['buildup', 'scenario_buildup', FULL_VOLUMES, 'Lautstärken 1/1/1'],
      ['buildup', null, DEFAULT_VOLUMES, 'Spiel-Defaults 0.8'],
      ['sfx', 'scenario_sfx', null, 'nur SFX'],
    ]) {
      const r = await runScenario(name, file, vol === null ? {} : { volumes: vol });
      const key = `${name} (${label})`;
      scenarios.push({ name: key, renderMs: Math.round(r.renderMs), metrics: r.metrics, timeline: r.timeline });
      if (name === 'buildup' && vol === FULL_VOLUMES) {
        console.log('  Verlauf (Takt: Energie/Layer): ' + r.timeline.map((p, i) => `${i}:${p.energy.toFixed(2)}/L${p.layer}`).join(' '));
      }
      console.log(`scenario ${key}: peak ${fmt(r.metrics.peak, 3)}  RMS ${fmt(r.metrics.rmsDb)} dB  clip ${pct2(r.metrics.clipperActivity)}  (${Math.round(r.renderMs)} ms)`);
    }

    // ---------------------------------------------------------------- Übergang in den Overdrive
    // Wie im Spiel: L3 eingeschwungen, dann Surf-Start (Energiesprung). fx-Spur solo findet den Crash,
    // fx+Clap misst den Anlauf davor (Sweep + Clap-Roll).
    const transitions = {};
    for (const name of ['flowEntry', 'gradual']) {
      const fxOnly = pcmView(await runScenario(name, null, { mute: only('fx'), volumes: { master: 1, music: 1, sfx: 0 } }));
      const lead = pcmView(await runScenario(name, null, { mute: only('fx', 'clap'), volumes: { master: 1, music: 1, sfx: 0 } }));
      const from = name === 'flowEntry' ? FLOW_ENTRY_AT : 2;
      const crash = fxOnly.loudest(from, from + 12, 0.05);
      const leadDb = lead.rmsDb(crash.t - 0.3, crash.t - 0.03);
      const riserDb = fxOnly.rmsDb(crash.t - 1.5, crash.t - 0.1);
      transitions[name] = { crashAt: crash.t, crashDb: crash.db, leadInDb: leadDb, riserDb };
      console.log(`${name}: Crash bei ${fmt(crash.t, 2)} s (${fmt(crash.db)} dB), Anlauf 300 ms davor ${fmt(leadDb)} dB, fx 1.5 s davor ${fmt(riserDb)} dB`);
    }
    const se = transitions.flowEntry;
    check(
      'Flow-Sprung: L4-Crash spätestens 2 Beats nach dem Energiesprung',
      se.crashAt - FLOW_ENTRY_AT <= 2 * BEAT + 0.02,
      `${fmt((se.crashAt - FLOW_ENTRY_AT) * 1000, 0)} ms (≤ ${fmt(2 * BEAT * 1000, 0)})`,
    );
    check('Flow-Sprung: hörbarer Anlauf vor dem Crash (≥ Crash − 20 dB)', se.leadInDb >= se.crashDb - 20, `${fmt(se.leadInDb)} vs ${fmt(se.crashDb)} dB`);

    // ---------------------------------------------------------------- Surf als Breakdown mit Drop (Plan 003 A5)
    // Musik allein: Kick-Band (40–120 Hz) im Breakdown gegen L4 nach dem Drop; Drop-Einsatz (Kick solo)
    // gegen das Beat-Raster (Versatz der Kick im Groove davor als Referenz: Limiter-Latenz, Attack).
    const musicOnlyVol = { volumes: { master: 1, music: 1, sfx: 0 } };
    {
      const c = channels(await runScenario('surf', 'scenario_surf', musicOnlyVol));
      const kb = filt(mid(c), c.sr, [['hp', 40], ['lp', 120], ['lp', 120]]);
      const bdFrom = beatAtOrAfter(SURF_FROM + BEAT) + 0.05;
      const inBd = powDb(kb, c.sr, bdFrom, SURF_TO - 0.3);
      const l4 = powDb(kb, c.sr, SURF_TO + 1, 14.5);
      const kc = channels(await runScenario('surf', null, { ...musicOnlyVol, mute: only('kick') }));
      const km = mid(kc);
      let kPeak = 0;
      for (const v of km) kPeak = Math.max(kPeak, Math.abs(v));
      const ks = onsets(km, kc.sr, 0.3 * kPeak, 0.2);
      const pre = ks
        .filter((x) => x > 1 && x < SURF_FROM)
        .map((x) => x - (ORIGIN + Math.round((x - ORIGIN) / BEAT) * BEAT))
        .sort((a, b) => a - b);
      const ref = pre[Math.floor(pre.length / 2)] ?? 0;
      const drop = ks.find((x) => x > SURF_TO - 0.01) ?? Number.NaN;
      const dropErrMs = (drop - (beatAtOrAfter(SURF_TO) + ref)) * 1000;
      console.log(`Surf: Kick-Band Breakdown − L4 ${fmt(inBd - l4)} dB, Drop ${fmt(drop, 3)} s (Fehler ${fmt(dropErrMs, 1)} ms)`);
      check('Surf-Breakdown: Kick-Band ≥ 10 dB unter L4', inBd - l4 <= -10, `${fmt(inBd - l4)} dB`);
      check('Surf-Drop: Kick auf dem ersten Beat nach der Landung (±5 ms)', Math.abs(dropErrMs) <= 5, `${fmt(dropErrMs, 1)} ms`);
    }

    // ---------------------------------------------------------------- Ziel als Outro, Pause dumpf (A4)
    // Pegel und Höhen (> 4 kHz) 4 s nach dem Ziel gegen den Zielmoment; die echte Pause muss dumpf werden.
    {
      const measure = async (name) => {
        const c = channels(await runScenario(name, null, { volumes: DEFAULT_VOLUMES }));
        const m = mid(c);
        const hi = filt(m, c.sr, [['hp', 4000], ['hp', 4000]]);
        return {
          at: powDb(m, c.sr, FINISH_AT - 0.5, FINISH_AT + 0.5),
          plus4: powDb(m, c.sr, FINISH_AT + 2.5, FINISH_AT + 5.5),
          hiAt: powDb(hi, c.sr, FINISH_AT - 0.5, FINISH_AT + 1),
          hiPlus4: powDb(hi, c.sr, FINISH_AT + 3, FINISH_AT + 5),
        };
      };
      const fin = await measure('finish');
      const pau = await measure('pause');
      console.log(
        `Ziel: +4 s ${fmt(fin.plus4 - fin.at)} dB, Höhen ${fmt(fin.hiPlus4 - fin.hiAt)} dB | Pause: +4 s ${fmt(pau.plus4 - pau.at)} dB, Höhen ${fmt(pau.hiPlus4 - pau.hiAt)} dB`,
      );
      check('Ziel-Outro: 4 s nach dem Ziel höchstens 6 dB leiser', fin.plus4 - fin.at >= -6, `${fmt(fin.plus4 - fin.at)} dB`);
      check('Ziel-Outro: Höhen > 4 kHz höchstens 6 dB unter dem Zielmoment', fin.hiPlus4 - fin.hiAt >= -6, `${fmt(fin.hiPlus4 - fin.hiAt)} dB`);
      check('Pause bleibt dumpf: Höhen > 4 kHz ≥ 25 dB weg', pau.hiPlus4 - pau.hiAt <= -25, `${fmt(pau.hiPlus4 - pau.hiAt)} dB`);
    }

    // ---------------------------------------------------------------- Stillstand und erster Schritt (A8)
    {
      const render = async (name, mute) => {
        const c = channels(await runScenario(name, null, { ...musicOnlyVol, mute }));
        return { m: mid(c), sr: c.sr };
      };
      const peakDb = (x, sr, a, b) => {
        let p = 0;
        for (let i = Math.floor(a * sr); i < Math.min(x.length, Math.floor(b * sr)); i++) p = Math.max(p, Math.abs(x[i]));
        return 20 * Math.log10(p + 1e-9);
      };
      const idle = await render('idleStart', []);
      const step = powDb(idle.m, idle.sr, WALK_AT + 2.5, 15.5) - powDb(idle.m, idle.sr, 3, WALK_AT - 0.1);
      const fxA = await render('idleStart', only('fx'));
      const fxB = await render('idleRespawns', only('fx'));
      const dropSolo = peakDb(fxA.m, fxA.sr, WALK_AT, WALK_AT + 3);
      const dropSeries = peakDb(fxB.m, fxB.sr, WALK_AT, WALK_AT + 3);
      console.log(`Stand → erster Schritt: +${fmt(step)} dB; Mini-Drop fx-Spitze ${fmt(dropSolo)} dB, nach Respawn-Serie ${fmt(dropSeries)} dB`);
      check('Erster Schritt nach Stand: Musik ≥ 4 dB lauter', step >= 4, `+${fmt(step)} dB`);
      check('Mini-Drop nach Stand hörbar (fx-Spitze > −40 dBFS)', dropSolo > -40, `${fmt(dropSolo)} dB`);
      check('Kein Mini-Drop nach Respawn-Serie (fx ≥ 20 dB leiser)', dropSeries <= dropSolo - 20, `${fmt(dropSeries)} vs ${fmt(dropSolo)} dB`);
    }

    // ---------------------------------------------------------------- Vorbeizieh-Whoosh (A10)
    // Nur SFX, gegen denselben Drive ohne nearL (Referenz): während der Wand links deutlich mehr als
    // rechts dazu, danach (nearL wieder Infinity) nur noch der Ausklang — kein Dauerrest.
    {
      const sfxVol = { master: 0.8, music: 0, sfx: 0.8 };
      const c = channels(await runScenario('whoosh', null, { volumes: sfxVol }));
      const r = channels(await runScenario('whooshRef', null, { volumes: sfxVol }));
      const n = Math.min(c.L.length, r.L.length);
      const dl = new Float64Array(n);
      const dr = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        dl[i] = c.L[i] - r.L[i];
        dr[i] = c.R[i] - r.R[i];
      }
      const a = WHOOSH_FROM + 0.1;
      const b = WHOOSH_TO - 0.5;
      const pass = powDb(dl, c.sr, a, b) - powDb(dr, c.sr, a, b);
      const overBed = powDb(dl, c.sr, a, b) - powDb(r.L, c.sr, a, b);
      const rest = powDb(dl, c.sr, WHOOSH_TO + 0.5, 6.9) - powDb(r.L, c.sr, WHOOSH_TO + 0.5, 6.9);
      console.log(`Whoosh: links ${fmt(overBed)} dB über dem Wind, L − R ${fmt(pass)} dB, Rest danach ${fmt(rest)} dB`);
      check('Whoosh: Wand links → links ≥ 6 dB mehr als rechts', pass >= 6, `${fmt(pass)} dB`);
      check('Whoosh: ohne nearL/nearR kein Rest (≤ −40 dB)', rest <= -40, `${fmt(rest)} dB`);
    }

    // ---------------------------------------------------------------- Breite ab L2 (A7)
    {
      const c = channels(
        await page.evaluate(([d, s2]) => window.__audioRenderOffline(d, s2, { pcm: true, clipper: false }), [LEVELS[2].drive, BAR * 4 + 0.2]),
      );
      const sm = powDb(filt(side(c), c.sr, [['hp', 1000]]), c.sr, 1, BAR * 4) - powDb(filt(mid(c), c.sr, [['hp', 1000]]), c.sr, 1, BAR * 4);
      console.log(`Breite L2: Seite/Mitte > 1 kHz ${fmt(sm)} dB`);
      check('Breite ab L2: Seite/Mitte > 1 kHz ≥ −10 dB', sm >= -10, `${fmt(sm)} dB`);
    }
    const gr = transitions.gradual;
    check('Langsamer Anstieg: Riser trägt die 1.5 s vor dem Crash (≥ Crash − 22 dB)', gr.riserDb >= gr.crashDb - 22, `${fmt(gr.riserDb)} vs ${fmt(gr.crashDb)} dB`);

    // ---------------------------------------------------------------- Respawn: voll vs. leicht
    // Musik allein, Differenz zu einem Render desselben Szenarios ohne Respawns (bis auf ≤ 1 LSB
    // dieselbe Musik): Tiefe = stärkste Absenkung je 50-ms-Fenster, Dauer = Zeit unter −1 dB.
    const musicOnly = { volumes: { master: 1, music: 1, sfx: 0 } };
    const resp = pcmView(await runScenario('respawns', null, musicOnly));
    const ref = pcmView(await runScenario('respawns', null, { ...musicOnly, withoutEvents: true }));
    const dips = RESPAWN_TIMES.map((t, i) => {
      let depth = 0;
      let below = 0;
      for (let s = t; s < t + 1; s += 0.025) {
        const d = resp.rmsDb(s, s + 0.05) - ref.rmsDb(s, s + 0.05);
        depth = Math.min(depth, d);
        if (d < -1) below += 0.025;
      }
      return { t, full: RESPAWN_FULL[i], depthDb: depth, durationS: below };
    });
    console.log('Respawn-Dips (Musik ggü. Render ohne Respawn): ' + dips.map((d) => `${d.t}s ${d.full ? 'voll' : 'leicht'} ${fmt(d.depthDb)} dB/${fmt(d.durationS, 2)} s`).join(' · '));
    for (const d of dips) {
      if (d.full) {
        check(`Respawn ${d.t} s nach längerem Lauf: voller Tape-Stop (≤ −10 dB, ≥ 0.35 s)`, d.depthDb <= -10 && d.durationS >= 0.35, `${fmt(d.depthDb)} dB, ${fmt(d.durationS, 2)} s`);
      } else {
        check(
          `Respawn ${d.t} s (Serie/Restart): nur kurzer, flacher Dip (−8 … −1 dB, ≤ 0.3 s)`,
          d.depthDb > -8 && d.depthDb <= -1 && d.durationS <= 0.3,
          `${fmt(d.depthDb)} dB, ${fmt(d.durationS, 2)} s`,
        );
      }
    }

    // ---------------------------------------------------------------- Prüfungen
    const M = levels.map((l) => l.metrics);
    for (const l of levels) check(`${l.name}: kein Clipping vor dem Sicherheits-Clipper (Peak < 1.0)`, l.metrics.peak < 1.0, fmt(l.metrics.peak, 3));
    for (const l of levels) check(`${l.name}: Sicherheits-Clipper griffe kaum (< 0.05 % der Samples > 0.86)`, l.metrics.clipperActivity < 0.0005, pct2(l.metrics.clipperActivity));
    for (const s of scenarios) {
      if (s.name.includes('Defaults') || s.name.includes('nur SFX')) {
        check(`scenario ${s.name}: kein Clipping vor dem Sicherheits-Clipper (Peak < 1.0)`, s.metrics.peak < 1.0, fmt(s.metrics.peak, 3));
      }
      if (s.name.includes('Defaults')) {
        // Plan 003 A3/A9: lauter, aber mit Reserve — Belohnungen dürfen den Pegel nicht an die Decke treiben.
        check(`scenario ${s.name}: Peak ≤ −1 dBFS`, s.metrics.peak <= 0.891, `${fmt(20 * Math.log10(s.metrics.peak))} dBFS`);
      }
      check(`scenario ${s.name}: Sicherheits-Clipper griffe kaum (< 0.05 %)`, s.metrics.clipperActivity < 0.0005, pct2(s.metrics.clipperActivity));
    }
    for (let i = 1; i < M.length; i++) {
      check(`RMS steigt ${levels[i - 1].name} → ${levels[i].name}`, M[i].rms > M[i - 1].rms, `${fmt(M[i - 1].rmsDb)} → ${fmt(M[i].rmsDb)} dB`);
      check(
        `Schwerpunkt steigt ${levels[i - 1].name} → ${levels[i].name}`,
        M[i].centroidHz > M[i - 1].centroidHz,
        `${fmt(M[i - 1].centroidHz, 0)} → ${fmt(M[i].centroidHz, 0)} Hz`,
      );
    }
    for (let i = 1; i < levels.length; i++) {
      check(`Layer steigt nicht ab ${levels[i - 1].name} → ${levels[i].name}`, levels[i].layer >= levels[i - 1].layer, `${levels[i - 1].layer} → ${levels[i].layer}`);
    }
    check('Energie 0 hörbar (RMS > −40 dBFS)', M[0].rmsDb > -40, `${fmt(M[0].rmsDb)} dB`);
    check('Energie 0 deutlich dumpfer (Schwerpunkt < 45 % von E50)', M[0].centroidHz < 0.45 * M[2].centroidHz, `${fmt(M[0].centroidHz, 0)} vs ${fmt(M[2].centroidHz, 0)} Hz`);
    check('Energie 0 kaum Höhen (> 5 kHz < 20 % von E50)', M[0].highShare < 0.2 * M[2].highShare, `${pct(M[0].highShare)} vs ${pct(M[2].highShare)}`);
    const beatMs = BEAT * 1000;
    for (const l of levels) {
      const k = l.metrics.kick;
      check(`${l.name}: Kick-Timing stabil (< 5 ms)`, k.maxDeviationMs < 5 && k.onsets >= k.expected - 2, `${k.onsets}/${k.expected}, max ${fmt(k.maxDeviationMs, 2)} ms`);
      check(`${l.name}: Kick-Abstand = Viertel`, Math.abs(k.meanIntervalMs - beatMs) < 1, `${fmt(k.meanIntervalMs, 2)} ms (soll ${fmt(beatMs, 2)})`);
    }
    // Club-Mix: Kick trägt das Tiefband, Höhen präsent aber nicht schneidend.
    for (const l of levels.slice(1)) {
      const m = l.metrics;
      check(`${l.name}: Kick dominiert Tiefband (Anteil in Kick-Fenstern > 45 %)`, m.kick.lowShareInKick > 0.45, pct(m.kick.lowShareInKick));
      const ratio = l.lowPeakRest / l.lowPeakKick;
      check(`${l.name}: Bass/Rumble ≥ 4 dB unter Kick im Tiefband`, ratio < 0.63, `${fmt(20 * Math.log10(ratio))} dB`);
    }
    for (const l of levels.slice(2)) {
      const m = l.metrics;
      check(`${l.name}: Höhen präsent, nicht schneidend (1–15 % > 5 kHz)`, m.highShare > 0.01 && m.highShare < 0.15, pct(m.highShare));
      // Browser-Spieler ohne Kopfhörer: auf Laptop-Lautsprechern (≈ HP 200 Hz) nicht dünn und hat-lastig.
      // Regressionsschutz: vor der Mitten-Überarbeitung lagen hier 23–32 %.
      check(`${l.name}: Laptop-Lautsprecher: > 5 kHz < 25 % vom Rest`, m.smallSpeaker.highShare < 0.25, pct(m.smallSpeaker.highShare));
    }

    // Aufbau-Szenario: Musik muss mit dem Movement bis Layer 4 hochschaukeln und im Stand wieder abklingen.
    const tl = scenarios.find((s) => s.name.startsWith('buildup'))?.timeline ?? [];
    const maxLayer = tl.reduce((m, p) => Math.max(m, p.layer), 0);
    const endLayer = tl.length > 0 ? tl[tl.length - 1].layer : -1;
    check('Aufbau erreicht Layer 4 (Flow/Surf) und klingt im Stand bis L0 ab', maxLayer === 4 && endLayer === 0, `max L${maxLayer}, Ende L${endLayer}`);

    const failed = checks.filter((c) => !c.ok);
    const report = {
      generated: new Date().toISOString(),
      bpm: BPM,
      seconds: SECONDS,
      note: 'Pegel ohne Sicherheits-Clipper gemessen (clipper: false).',
      levels,
      scenarios,
      transitions,
      respawnDips: dips,
      checks,
      ok: failed.length === 0,
    };
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    console.log('');
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}  [${c.detail}]`);
    console.log(`\n${checks.length - failed.length}/${checks.length} Prüfungen grün → ${OUT}/report.json`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
    await srv.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
