/**
 * Trailer-Musik (30-s-Spot) aus der spieleigenen Techno-Engine — läuft im Browser
 * (OfflineAudioContext), wird von tools/trailer/music.mjs per Vite-Import geladen.
 *
 * Kein eigener Synth für die Musik: TechnoAudio wird wie im Spiel über einen
 * zeitgesteuerten MusicDrive und Spiel-Ereignisse gefahren. Das Arrangement
 * entsteht nur aus den Regeln der Engine (Layer, Surf-Breakdown, Drop,
 * Overdrive-Anlauf, Checkpoint-Akzent, Bestzeit-Outro). Darum sind die Zeiten
 * unten so gewählt, dass die Engine-Entscheidungen exakt auf Taktgrenzen fallen.
 *
 * Zeitbasis: T = Trailerzeit (0 = erster Downbeat im fertigen WAV). Der
 * Sequencer startet offline bei ORIGIN, der Limiter verzögert um 6 ms — das
 * Node-Skript schneidet LEAD vorne ab, dann liegt Takt n exakt bei n · BAR.
 */
import type { GameEvent } from '../../src/engine/events';
import type { AudioVolumes, MusicDrive } from '../../src/audio/types';
import { BPM, type MusicPart } from '../../src/audio/Music';
import { TechnoAudio } from '../../src/audio/TechnoAudio';
import { drive } from '../../src/audio/dev/scenarios';
import { clamp01, createNoiseBuffer, createRng, lerp, makeFilter, makeGain, makePanner, noiseBurst } from '../../src/audio/dsp';

export const SAMPLE_RATE = 48000;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
/** TechnoAudio OFFLINE_START: erster Schritt so weit nach Kontextstart. */
export const ORIGIN = 0.02;
/** Mixer LIMITER_PREDELAY: hörbar wird alles 6 ms nach der Planung. */
export const LIMITER_LATENCY = 0.006;
/** Wird vorne abgeschnitten. */
export const LEAD = ORIGIN + LIMITER_LATENCY;
export const LENGTH = 30;
/** Default-Seed der Engine (TechnoAudio DEFAULT_SEED) — dieselben Patterns wie im Spiel ohne Level-Seed. */
const SEED = 0x7ec4;

export const bar = (n: number): number => n * BAR;
const ctxT = (T: number): number => T + ORIGIN;

// ------------------------------------------------------------------ Arrangement (Trailerzeit)

/** Surf 1: ein Beat vor Takt 3 → Breakdown ab Takt 3 (Engine: ≥ 1 Beat Surf). */
const SURF1_START = bar(3) - BEAT - 0.01;
/** Landung kurz vor Takt 4 → Drop auf Takt 4. */
const LAND1 = bar(4) - 0.04;
/**
 * Energiesprung in den Flow: nur EIN 16tel vor dem letzten Beat von Takt 5, damit
 * die Energie an diesem Beat ≥ L4-Schwelle − 0.12 ist (Anlauf startet), aber noch
 * unter 0.86 (sonst stiege der Layer ohne Anlauf). Anlauf 1 Beat → Crash auf Takt 6.
 */
const FLOW_AT = bar(6) - BEAT - 0.05;
/** Surf 2: Breakdown ab Takt 12. */
const SURF2_START = bar(12) - BEAT - 0.01;
/**
 * Ziel (Bestzeit) im letzten Beat von Takt 12: Outro landet auf dem nächsten
 * Downbeat ≥ t + 1 Beat = Takt 14; davor Riser (~2.2 s) und Clap-Roll im letzten Beat.
 */
const FINISH_AT = bar(13) - BEAT + 0.05;
/** Ab hier blendet der Mix vom vollen Outro auf den Hall-Ausklang (nur Pad, Stabs, FX). */
export const TAIL_XFADE: readonly [number, number] = [26.75, 27.2];
/** Früh genug, dass der Nebenraum-Wechsel der Engine auf Takt 16 (29.09 s) in der Ausblende verschwindet. */
export const FADE_OUT: readonly [number, number] = [28.3, 30.0];

/** Drive über die Trailerzeit — bestimmt Energie, Layer und Surf wie im Spiel. */
function trailerDrive(T: number): MusicDrive {
  if (T < bar(1)) return drive({ speed: 0 });
  // Intro Takt 1: Speed bis knapp unter Laufen — der Raumfilter öffnet einen Spalt, Layer bleibt 0.
  if (T < bar(2) - 0.001) return drive({ speed: lerp(0, 190, (T - bar(1)) / BAR) });
  // Build Takt 2: erste Hops (L1 → L2: Hats, Clap, Bass, Rumble).
  if (T < SURF1_START) {
    const u = clamp01((T - bar(2)) / BAR);
    return drive({ speed: lerp(400, 450, u), hopChain: Math.round(lerp(1, 3, u)), strafeSync: 0.75, onGround: false });
  }
  // Surf-Breakdown Takt 3: Energie in L3 (Acid kommt), aber sicher unter L4.
  if (T < LAND1) return drive({ speed: lerp(500, 560, clamp01((T - SURF1_START) / BAR)), surfing: true, strafeSync: 0.8, onGround: false });
  if (T < bar(4) + 0.12) return drive({ speed: 600, hopChain: 4, strafeSync: 0.6, onGround: true });
  // Takt 4–5: L3-Groove nach dem Drop.
  if (T < FLOW_AT) return drive({ speed: 600, hopChain: 4, strafeSync: 0.6, onGround: false });
  // Takt 6–11: Overdrive (L4), ab Takt 8 schneller → L4+ (zweite Stab-Figur, Acid weiter offen).
  if (T < SURF2_START) {
    const speed = T < bar(8) ? 900 : lerp(900, 1300, clamp01((T - bar(8)) / (2 * BAR)));
    return drive({ speed, hopChain: 12, strafeSync: 0.85, onGround: false });
  }
  // Takt 12–13: Surf-Breakdown als Höhepunkt, Riser zieht mit dem Surf-Tempo an.
  if (T < bar(14)) return drive({ speed: lerp(1150, 1450, clamp01((T - SURF2_START) / (2 * BAR))), surfing: true, strafeSync: 0.85, onGround: false });
  return drive({ speed: 1000, hopChain: 12, strafeSync: 0.85, onGround: true });
}

interface Action {
  /** Bis hierhin planen (Kontextzeit), dann das Ereignis abschicken. */
  readonly planUntil: number;
  /** Zeitpunkt des Ereignisses (Kontextzeit). */
  readonly at: number;
  readonly event: GameEvent;
}

const ev = (T: number, event: GameEvent): Action => ({ planUntil: ctxT(T), at: ctxT(T), event });

function musicActions(withAccent = true): Action[] {
  const all: Action[] = [
    ev(SURF1_START, { type: 'surfStart' }),
    ev(LAND1 - 0.002, { type: 'surfEnd' }),
    ev(LAND1, { type: 'land', impact: 700, speed: 600, airTime: 0.3, jumpQueued: false }),
    // Checkpoint-Akzent auf Takt 10. Das Ereignis selbst duckt die Musik 3.5 dB (Sfx.rewardDuck,
    // damit die Glocke oben liegt) — ohne Glocke wäre das ein Loch genau im Akzent. Darum erst
    // Takt 10 planen, dann das Ereignis mit Zeit ~0 nachreichen: die Musik trägt den Akzent auf
    // dem schon geplanten Beat nach (RETRO), der Duck fällt auf den allerersten, leisen Intro-Kick.
    { planUntil: ctxT(bar(10)) + 0.001, at: 0.001, event: { type: 'checkpoint', index: 2, total: 3, time: 18, split: -0.4 } },
    ev(SURF2_START, { type: 'surfStart' }),
    ev(FINISH_AT, { type: 'finish', time: 25.4, best: true, previousBest: 26.1 }),
  ];
  return withAccent ? all : all.filter((a) => a.event.type !== 'checkpoint');
}

// ------------------------------------------------------------------ Render-Kern

export interface BarInfo {
  readonly bar: number;
  readonly t: number;
  readonly energy: number;
  readonly layer: number;
  readonly breakdown: boolean;
}

export interface RenderResult {
  readonly sampleRate: number;
  readonly channels: number;
  /** Base64, Float32 LE, Kanäle verschachtelt; beginnt bei Kontextzeit 0 (LEAD noch drin). */
  readonly pcm: string;
  readonly bars: readonly BarInfo[];
}

interface Job {
  readonly seconds: number;
  readonly driveAt: (T: number) => MusicDrive;
  readonly actions: readonly Action[];
  readonly mute?: readonly MusicPart[];
  readonly volumes: AudioVolumes;
}

async function renderJob(j: Job): Promise<{ buffer: AudioBuffer; bars: BarInfo[] }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(j.seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  // Sicherheits-Clipper an wie im Spiel; Pegel-Reserve prüft music.mjs am Ergebnis.
  const audio = new TechnoAudio({ context: ctx, seed: SEED, clipper: true });
  for (const p of j.mute ?? []) audio.setMuted(p, true);
  audio.setVolumes(j.volumes);
  await audio.unlock();
  const driveAt = (t: number): MusicDrive => j.driveAt(t - ORIGIN);
  audio.settle(driveAt(0));
  // Taktanfänge als Messpunkte (wie renderOffline), Ereignisse in Planungsreihenfolge.
  const marks: { planUntil: number; action: Action | null; bar: number }[] = j.actions.map((a) => ({ planUntil: a.planUntil, action: a, bar: -1 }));
  for (let n = 0; ctxT(bar(n)) < j.seconds; n++) marks.push({ planUntil: ctxT(bar(n)) + 0.03, action: null, bar: n });
  marks.sort((a, b) => a.planUntil - b.planUntil);
  const bars: BarInfo[] = [];
  for (const m of marks) {
    audio.scheduleOffline(m.planUntil, driveAt);
    if (m.action !== null) audio.emitAt(m.action.event, m.action.at);
    else bars.push({ bar: m.bar, t: bar(m.bar), energy: audio.energyValue, layer: audio.scheduledLayer, breakdown: audio.inBreakdown });
  }
  audio.scheduleOffline(j.seconds, driveAt);
  const buffer = await ctx.startRendering();
  return { buffer, bars };
}

function toBase64F32(chans: readonly Float32Array[]): string {
  const n = chans[0].length;
  const ch = chans.length;
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const d = chans[c];
    for (let i = 0; i < n; i++) out[i * ch + c] = d[i];
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function channelsOf(buf: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c));
  return out;
}

const result = (chans: readonly Float32Array[], bars: readonly BarInfo[] = []): RenderResult => ({
  sampleRate: SAMPLE_RATE,
  channels: chans.length,
  pcm: toBase64F32(chans),
  bars,
});

const MUSIC_ONLY: AudioVolumes = { master: 1, music: 1, sfx: 0 };
const SFX_ONLY: AudioVolumes = { master: 1, music: 0, sfx: 1 };
const RENDER_SECONDS = LENGTH + LEAD + 0.05;
const ALL_PARTS: readonly MusicPart[] = ['kick', 'hats', 'clap', 'perc', 'bass', 'rumble', 'acid', 'ride', 'shaker', 'stabs', 'pad', 'fx'];

// ------------------------------------------------------------------ SFX-Zeitleiste (Vorschlag, synchron zur Musik)

/** Hops auf dem Beat-Raster: Landung (angekündigt) + Sprung, Chain steigt → Blips steigen. */
function hopActions(times: readonly number[], chain0: number, speedAt: (T: number) => number): Action[] {
  const out: Action[] = [];
  let chain = chain0;
  for (const T of times) {
    const sp = speedAt(T);
    if (chain > 1) out.push(ev(T, { type: 'land', impact: 300, speed: sp, airTime: 0.8, jumpQueued: true }));
    out.push(ev(T + 0.004, { type: 'jump', speed: sp, gain: chain > 1 ? 14 : 0, perfect: true, clean: true, chain, sync: 0.85, crouched: false, coyote: false }));
    chain++;
  }
  return out;
}

export interface SfxCue {
  readonly t: number;
  readonly what: string;
}

/** Hop-Zeitpunkte: Takt 2 auf jedem Beat (3 Hops), Takte 4–11 alle 2 Beats. */
function hopTimes(): { build: number[]; drive: number[] } {
  const build = [bar(2), bar(2) + BEAT, bar(2) + 2 * BEAT];
  const drv: number[] = [];
  for (let k = 1; k <= 15; k++) drv.push(bar(4) + k * 2 * BEAT);
  return { build, drive: drv };
}

function sfxEventActions(): Action[] {
  const speed = (T: number): number => trailerDrive(T).speed;
  const h = hopTimes();
  return [
    ev(bar(2), { type: 'runStart' }),
    ...hopActions(h.build, 1, speed),
    ev(LAND1, { type: 'land', impact: 750, speed: 600, airTime: 0.6, jumpQueued: false }),
    ...hopActions(h.drive, 4, speed),
    ev(bar(6), { type: 'speedMilestone', speed: 750 }),
    ev(bar(8), { type: 'speedMilestone', speed: 1000 }),
    ev(bar(9) + 2 * BEAT, { type: 'speedMilestone', speed: 1250 }),
    ev(bar(10), { type: 'checkpoint', index: 2, total: 3, time: 18, split: -0.4 }),
    ev(bar(14), { type: 'finish', time: 25.4, best: true, previousBest: 26.1 }),
  ];
}

export function sfxEventCues(): SfxCue[] {
  const h = hopTimes();
  const cues: SfxCue[] = [{ t: bar(2), what: 'runStart (Thump + Glocke)' }];
  h.build.forEach((t, i) => cues.push({ t, what: `Hop Chain ${i + 1}${i + 1 >= 2 ? ' (Blip, auf 32tel gerastert)' : ''}` }));
  cues.push({ t: LAND1, what: 'harte Landung nach Surf 1' });
  h.drive.forEach((t, i) => cues.push({ t, what: `Hop Chain ${i + 4} (Blip steigt)` }));
  cues.push(
    { t: bar(6), what: 'Speed-Zap 750' },
    { t: bar(8), what: 'Speed-Zap 1000' },
    { t: bar(9) + 2 * BEAT, what: 'Speed-Zap 1250' },
    { t: bar(10), what: 'Checkpoint-Chime' },
    { t: bar(14), what: 'Finish-Stab (Ziel-SFX)' },
  );
  return cues.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ One-Shots

/** One-Shot: Ereignis bei Kontextzeit ORIGIN + 1 Beat (auf dem Raster), Engine-Stand ohne Wind. */
async function oneShot(events: readonly GameEvent[], seconds: number, spacing = 0): Promise<RenderResult> {
  const at = ORIGIN + BEAT;
  const actions = events.map((event, i) => ({ planUntil: at + i * spacing, at: at + i * spacing, event }));
  const r = await renderJob({ seconds: at + seconds, driveAt: () => drive({ speed: 0 }), actions, volumes: SFX_ONLY });
  return result(channelsOf(r.buffer));
}

/**
 * Vorbeizieh-Whoosh solo: zwei Renders mit gleichem Wind (900 u/s), einer mit Wand
 * (Annäherung 160 → 40 u → wieder weg), Differenz = nur der Whoosh (wie audiocheck A10).
 */
async function whooshPass(side: 'L' | 'R'): Promise<RenderResult> {
  const from = 0.4;
  const dur = 1.1;
  const pass = (T: number, wall: boolean): MusicDrive => {
    const u = (T - from) / dur;
    const inPass = wall && u >= 0 && u <= 1;
    // V-Form: nah in der Mitte, Doppler-Andeutung über die Distanzänderung.
    const dist = inPass ? lerp(40, 170, Math.abs(2 * u - 1)) : Number.POSITIVE_INFINITY;
    return drive({ speed: 900, hopChain: 12, strafeSync: 0.8, onGround: false, nearL: side === 'L' ? dist : undefined, nearR: side === 'R' ? dist : undefined });
  };
  const seconds = from + dur + 0.8;
  const a = await renderJob({ seconds, driveAt: (T) => pass(T, true), actions: [], volumes: SFX_ONLY });
  const b = await renderJob({ seconds, driveAt: (T) => pass(T, false), actions: [], volumes: SFX_ONLY });
  const ca = channelsOf(a.buffer);
  const cb = channelsOf(b.buffer);
  const out = ca.map((x, c) => {
    const d = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) d[i] = x[i] - cb[c][i];
    return d;
  });
  return result(out);
}

/**
 * Dosen-"Pssht": im Spiel nur Hand-Animation (canTricks), kein Klang in der Engine.
 * Gebaut aus denselben Bausteinen wie die SFX (Rausch-Buffer, Biquads): Laschen-Knack,
 * Gas-Zischen (Bandpass fällt), Perl-Knistern.
 */
async function canPssht(): Promise<RenderResult> {
  const seconds = 1.6;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  const rng = createRng(0xc0ca);
  const noise = createNoiseBuffer(ctx, 2, rng, 2);
  const out = makeGain(ctx, 0.9);
  out.connect(ctx.destination);
  const t0 = 0.02;
  // Knack der Lasche: zwei sehr kurze Klicks (Metall + Lasche schlägt an).
  for (const [dt, f, v] of [
    [0, 3800, 0.9],
    [0.011, 2600, 0.6],
  ] as const) {
    const src = noiseBurst(ctx, noise, rng, t0 + dt, 0.012);
    const bp = makeFilter(ctx, 'bandpass', f, 3);
    const env = makeGain(ctx, 0);
    env.gain.setValueAtTime(0, t0 + dt);
    env.gain.linearRampToValueAtTime(v, t0 + dt + 0.0008);
    env.gain.setTargetAtTime(0, t0 + dt + 0.001, 0.0025);
    src.connect(bp).connect(env).connect(out);
  }
  // Gas: breites Zischen, Band fällt von 7.5 auf 3.5 kHz, schneller Abfall + kurzer Nachhauch.
  const gas = noiseBurst(ctx, noise, rng, t0 + 0.006, 0.9);
  const hp = makeFilter(ctx, 'highpass', 1600, 0.7);
  const bp = makeFilter(ctx, 'bandpass', 7500, 0.9);
  bp.frequency.setValueAtTime(7500, t0 + 0.006);
  bp.frequency.exponentialRampToValueAtTime(3500, t0 + 0.4);
  const gEnv = makeGain(ctx, 0);
  gEnv.gain.setValueAtTime(0, t0 + 0.006);
  gEnv.gain.linearRampToValueAtTime(0.75, t0 + 0.018);
  gEnv.gain.setTargetAtTime(0.22, t0 + 0.03, 0.06);
  gEnv.gain.setTargetAtTime(0, t0 + 0.2, 0.14);
  gas.connect(hp).connect(bp).connect(gEnv).connect(out);
  // Perlen: spärliche, zufällig verteilte Mini-Klicks, links/rechts gestreut, klingen aus.
  for (let i = 0; i < 70; i++) {
    const t = t0 + 0.05 + Math.pow(rng(), 1.6) * 1.2;
    const fade = 1 - (t - t0) / 1.35;
    const src = noiseBurst(ctx, noise, rng, t, 0.004);
    const f = makeFilter(ctx, 'bandpass', 5000 + 5000 * rng(), 4);
    const env = makeGain(ctx, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.18 * fade * (0.4 + 0.6 * rng()), t + 0.0004);
    env.gain.setTargetAtTime(0, t + 0.0005, 0.0012);
    const pan = makePanner(ctx, rng() * 1.4 - 0.7);
    src.connect(f).connect(env).connect(pan).connect(out);
  }
  const buf = await ctx.startRendering();
  return result(channelsOf(buf));
}

// ------------------------------------------------------------------ Einstieg für music.mjs

export type JobName =
  | 'music'
  | 'musicNoAccent'
  | 'tail'
  | 'sfxWind'
  | 'sfxEvents'
  | 'whooshL'
  | 'whooshR'
  | 'checkpoint'
  | 'finish'
  | 'pssht'
  | 'landHard'
  | 'runStart'
  | `hop${number}`
  | `zap${number}`;

export async function run(name: JobName): Promise<RenderResult> {
  if (name === 'music') {
    const r = await renderJob({ seconds: RENDER_SECONDS, driveAt: trailerDrive, actions: musicActions(), volumes: MUSIC_ONLY });
    return result(channelsOf(r.buffer), r.bars);
  }
  if (name === 'musicNoAccent') {
    // Prüf-Referenz: dieselbe Musik ohne Checkpoint — die Differenz zeigt den Akzent allein.
    const r = await renderJob({ seconds: RENDER_SECONDS, driveAt: trailerDrive, actions: musicActions(false), volumes: MUSIC_ONLY });
    return result(channelsOf(r.buffer), r.bars);
  }
  if (name === 'tail') {
    // Gleiche Zeitleiste, nur Pad, Stabs, FX: der Hall-Ausklang für die Endkarte.
    const keep: readonly MusicPart[] = ['pad', 'stabs', 'fx'];
    const mute = ALL_PARTS.filter((p) => !keep.includes(p));
    const r = await renderJob({ seconds: RENDER_SECONDS, driveAt: trailerDrive, actions: musicActions(), mute, volumes: MUSIC_ONLY });
    return result(channelsOf(r.buffer), r.bars);
  }
  if (name === 'sfxWind') {
    // Wind/Surf-Zischen folgt demselben Drive wie die Musik; Surf-Ereignisse nur für den Zeitpunkt.
    const actions = [ev(SURF1_START, { type: 'surfStart' }), ev(LAND1 - 0.002, { type: 'surfEnd' }), ev(SURF2_START, { type: 'surfStart' })];
    const r = await renderJob({ seconds: RENDER_SECONDS, driveAt: trailerDrive, actions, volumes: SFX_ONLY });
    return result(channelsOf(r.buffer));
  }
  if (name === 'sfxEvents') {
    // Ereignis-SFX ohne Wind (Speed 0 im Drive): nur die Einzelklänge, synchron zum Raster.
    const r = await renderJob({ seconds: RENDER_SECONDS, driveAt: () => drive({ speed: 0 }), actions: sfxEventActions(), volumes: SFX_ONLY });
    return result(channelsOf(r.buffer));
  }
  if (name === 'whooshL') return whooshPass('L');
  if (name === 'whooshR') return whooshPass('R');
  if (name === 'pssht') return canPssht();
  if (name === 'checkpoint') return oneShot([{ type: 'checkpoint', index: 1, total: 3, time: 12, split: -0.3 }], 2.5);
  if (name === 'finish') return oneShot([{ type: 'finish', time: 25.4, best: true, previousBest: 26.1 }], 3.5);
  if (name === 'landHard') return oneShot([{ type: 'land', impact: 900, speed: 0, airTime: 1.4, jumpQueued: false }], 1.2);
  if (name === 'runStart') return oneShot([{ type: 'runStart' }], 1.2);
  if (name.startsWith('zap')) return oneShot([{ type: 'speedMilestone', speed: Number(name.slice(3)) }], 1.2);
  // hopN: Sprung mit Chain N (ab 2 mit Blip; Tonhöhe steigt mit N, Shepard-Ton ohne Rücksprung).
  const chain = Number(name.slice(3));
  return oneShot([{ type: 'jump', speed: 700, gain: 14, perfect: true, clean: true, chain, sync: 0.85, crouched: false, coyote: false }], 1.0);
}

/** Cue-Daten des Arrangements (für cues.json). */
export function arrangement(): {
  bpm: number;
  beat: number;
  bar: number;
  finishEventAt: number;
  surf1Start: number;
  land1: number;
  flowAt: number;
  surf2Start: number;
  tailXfade: readonly number[];
  fadeOut: readonly number[];
  sfxEvents: SfxCue[];
} {
  return {
    bpm: BPM,
    beat: BEAT,
    bar: BAR,
    finishEventAt: FINISH_AT,
    surf1Start: SURF1_START,
    land1: LAND1,
    flowAt: FLOW_AT,
    surf2Start: SURF2_START,
    tailXfade: TAIL_XFADE,
    fadeOut: FADE_OUT,
    sfxEvents: sfxEventCues(),
  };
}
