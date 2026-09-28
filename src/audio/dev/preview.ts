/**
 * Audio-Werkbank (dev/audio.html): Echtzeit-Vorschau mit Reglern für den
 * Drive, Ereignis-Knöpfe, Beat-Anzeige — und Offline-Renders mit Messung,
 * Spektrogramm und PCM-Export für tools/audiocheck.mjs.
 */
import type { GameEvent } from '../../engine/events';
import type { AudioVolumes, MusicDrive } from '../types';
import type { MusicPart } from '../Music';
import { TechnoAudio } from '../TechnoAudio';
import { renderOffline, type OfflineRenderOptions, type TimelinePoint } from '../offline';
import { targetEnergy } from '../energy';
import { analyzeBuffer, drawSpectrogram, type AudioMetrics } from './analysis';
import { drive, scenario, SCENARIOS, type ScenarioName } from './scenarios';

export interface RenderHookOptions {
  readonly pcm?: boolean;
  readonly seed?: number;
  readonly mute?: readonly MusicPart[];
  /** Sekunden am Anfang, die nicht in die Messung eingehen (Hall/Pad baut sich auf). */
  readonly skip?: number;
  readonly title?: string;
  /** SFX (Wind, Surf) mitrendern? Default: nein — Musik-Messungen sollen nur Musik sehen. */
  readonly sfx?: boolean;
  /** Sicherheits-Clipper hinter dem Limiter (Default an). Aus = Peak vor dem Clipper messen. */
  readonly clipper?: boolean;
  /** Lautstärken überschreiben (Szenarien: z. B. Spiel-Defaults 0.8/0.8/0.8). */
  readonly volumes?: AudioVolumes;
  /** Szenario ohne seine Ereignisse rendern (Referenz für Differenzmessungen, gleiche Musik bis auf ≤ 1 LSB). */
  readonly withoutEvents?: boolean;
  /** Abtastrate (Default 44.1 kHz bzw. die des Szenarios); 48 kHz für K-gewichtete Lautheit. */
  readonly sampleRate?: number;
}

export interface RenderHookResult {
  readonly metrics: AudioMetrics;
  readonly energy: number;
  readonly targetEnergy: number;
  readonly layer: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly renderMs: number;
  /** Energie/Layer je Takt (Zeitleisten-Renders). */
  readonly timeline: readonly TimelinePoint[];
  /** Base64, Int16 LE, Kanäle verschachtelt. */
  readonly pcm?: string;
}

declare global {
  interface Window {
    __audioReady?: boolean;
    __audioRenderOffline?: (d: Partial<MusicDrive>, seconds: number, opts?: RenderHookOptions) => Promise<RenderHookResult>;
    __audioRenderScenario?: (name: ScenarioName, opts?: RenderHookOptions) => Promise<RenderHookResult>;
    /** Die Live-Instanz (nach Start) — für Playwright-Checks der Echtzeit-Planung. */
    __audioLive?: TechnoAudio | null;
    /** Live-Drive von außen setzen (Playwright). */
    __audioSetDrive?: (d: Partial<MusicDrive>) => void;
  }
}

const BAR = (4 * 60) / 132;
const PARTS: readonly MusicPart[] = ['kick', 'hats', 'clap', 'perc', 'bass', 'rumble', 'acid', 'ride', 'shaker', 'stabs', 'pad', 'fx'];

// ------------------------------------------------------------------ Offline

function toBase64Pcm16(buf: AudioBuffer): string {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const out = new Int16Array(len * ch);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, d[i]));
      out[i * ch + c] = Math.round(v * 32767);
    }
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let lastBuffer: AudioBuffer | null = null;

async function runRender(o: OfflineRenderOptions, target: number, opts: RenderHookOptions, title: string): Promise<RenderHookResult> {
  const t0 = performance.now();
  const r = await renderOffline({
    ...o,
    seed: opts.seed ?? o.seed,
    mute: opts.mute ?? o.mute,
    clipper: opts.clipper ?? o.clipper,
    volumes: opts.volumes ?? o.volumes,
    sampleRate: opts.sampleRate ?? o.sampleRate,
    events: opts.withoutEvents === true ? [] : o.events,
  });
  const renderMs = performance.now() - t0;
  lastBuffer = r.buffer;
  const metrics = analyzeBuffer(r.buffer, 132, opts.skip ?? BAR);
  const canvas = document.getElementById('spec');
  if (canvas instanceof HTMLCanvasElement) drawSpectrogram(canvas, r.buffer, opts.title ?? title);
  showMetrics(metrics, r.energy, r.layer, renderMs);
  return {
    metrics,
    energy: r.energy,
    targetEnergy: target,
    layer: r.layer,
    sampleRate: r.buffer.sampleRate,
    channels: r.buffer.numberOfChannels,
    renderMs,
    timeline: r.timeline,
    pcm: opts.pcm === true ? toBase64Pcm16(r.buffer) : undefined,
  };
}

window.__audioRenderOffline = (d, seconds, opts = {}) => {
  const dr = drive(d);
  const volumes = opts.volumes ?? { master: 1, music: 1, sfx: opts.sfx === true ? 1 : 0 };
  return runRender({ seconds, drive: dr, settle: true, volumes }, targetEnergy(dr), opts, `drive speed=${dr.speed} chain=${dr.hopChain} surf=${dr.surfing}`);
};

window.__audioRenderScenario = (name, opts = {}) => runRender(scenario(name), 0, { skip: 0, ...opts }, `scenario ${name}`);

// ------------------------------------------------------------------ UI

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function section(title: string): HTMLElement {
  const s = el('section');
  s.append(el('h2', {}, title));
  document.getElementById('app')?.append(s);
  return s;
}

function button(parent: HTMLElement, label: string, fn: () => void): HTMLButtonElement {
  const b = el('button', {}, label);
  b.addEventListener('click', fn);
  parent.append(b);
  return b;
}

/** Liefert einen Setter, der den Regler von außen nachführt (z. B. nach __audioSetDrive). */
function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, fn: (v: number) => void): (v: number) => void {
  const wrap = el('label', { class: 'slider' });
  const name = el('span', {}, label);
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', {}, String(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = String(v);
    fn(v);
  });
  wrap.append(name, input, out);
  parent.append(wrap);
  return (v) => {
    input.value = String(v);
    out.textContent = String(v);
  };
}

function checkbox(parent: HTMLElement, label: string, value: boolean, fn: (v: boolean) => void): (v: boolean) => void {
  const wrap = el('label', { class: 'check' });
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => fn(input.checked));
  wrap.append(input, el('span', {}, label));
  parent.append(wrap);
  return (v) => {
    input.checked = v;
  };
}

/** Regler-Setter für den Live-Drive, damit __audioSetDrive die Anzeige mitnimmt. */
const driveViews: { -readonly [K in keyof MusicDrive]?: (v: MusicDrive[K]) => void } = {};

function meter(parent: HTMLElement, label: string): (v: number, text: string) => void {
  const wrap = el('div', { class: 'meter' });
  const name = el('span', {}, label);
  const bar = el('div', { class: 'bar' });
  const fill = el('div', { class: 'fill' });
  const txt = el('span', { class: 'val' });
  bar.append(fill);
  wrap.append(name, bar, txt);
  parent.append(wrap);
  return (v, text) => {
    fill.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
    txt.textContent = text;
  };
}

function showMetrics(m: AudioMetrics, energy: number, layer: number, ms: number): void {
  const pre = document.getElementById('metrics');
  if (pre === null) return;
  const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
  pre.textContent = [
    `Energie ${energy.toFixed(3)} · Layer ${layer} · Render ${ms.toFixed(0)} ms`,
    `Peak ${m.peak.toFixed(3)} (${m.peakDb.toFixed(1)} dB) · RMS ${m.rmsDb.toFixed(1)} dB · Crest ${m.crestDb.toFixed(1)} dB · Clipper ${pct(m.clipperActivity)}`,
    `Schwerpunkt ${m.centroidHz.toFixed(0)} Hz · > 5 kHz ${pct(m.highShare)} · Seite/Mitte ${m.sideToMid.toFixed(3)}`,
    `Bänder: sub ${pct(m.bands.sub)} · low ${pct(m.bands.low)} · mid ${pct(m.bands.mid)} · presence ${pct(m.bands.presence)} · high ${pct(m.bands.high)} · air ${pct(m.bands.air)}`,
    `Laptop (HP 200 Hz): ${m.smallSpeaker.lossDb.toFixed(1)} dB · Mitten ${pct(m.smallSpeaker.midShare)} · > 5 kHz ${pct(m.smallSpeaker.highShare)}`,
    `Kick: ${m.kick.onsets}/${m.kick.expected} Onsets · Abstand ${m.kick.meanIntervalMs.toFixed(2)} ms · max. Abweichung ${m.kick.maxDeviationMs.toFixed(2)} ms · Tiefton in Kick ${pct(m.kick.lowShareInKick)} · Tiefband-Spitze ${m.kick.lowPeak.toFixed(2)}`,
  ].join('\n');
}

let audio: TechnoAudio | null = null;
const state: { -readonly [K in keyof MusicDrive]: MusicDrive[K] } = {
  speed: 0,
  onGround: true,
  hopChain: 0,
  strafeSync: 0,
  airTime: 0,
  surfing: false,
  active: true,
};
const volumes = { master: 0.8, music: 0.8, sfx: 0.8 };
let chain = 0;
let autoHop = false;
let nextHop = 0;

function emit(e: GameEvent): void {
  audio?.emit(e);
}

function jumpEvent(): GameEvent {
  chain++;
  return { type: 'jump', speed: state.speed, gain: chain > 1 ? 12 : 0, perfect: true, chain, sync: state.strafeSync, crouched: false, coyote: false };
}

function buildUi(): void {
  const live = section('Live');
  button(live, 'Start (unlock)', () => {
    if (audio === null) audio = new TechnoAudio({ seed: 0x7ec4 });
    window.__audioLive = audio;
    audio.setVolumes(volumes);
    void audio.unlock();
  });
  button(live, 'Stop', () => {
    void audio?.dispose();
    audio = null;
    window.__audioLive = null;
  });
  const drv = el('div', { class: 'grid' });
  live.append(drv);
  driveViews.speed = slider(drv, 'speed', 0, 1600, 10, 0, (v) => (state.speed = v));
  driveViews.hopChain = slider(drv, 'hopChain', 0, 20, 1, 0, (v) => (state.hopChain = v));
  driveViews.strafeSync = slider(drv, 'strafeSync', 0, 1, 0.01, 0, (v) => (state.strafeSync = v));
  driveViews.surfing = checkbox(drv, 'surfing', false, (v) => (state.surfing = v));
  driveViews.active = checkbox(drv, 'active', true, (v) => (state.active = v));
  checkbox(drv, 'Auto-Bhop (0.72 s)', false, (v) => {
    autoHop = v;
    chain = 0;
  });
  const vol = el('div', { class: 'grid' });
  live.append(vol);
  slider(vol, 'master', 0, 1, 0.01, volumes.master, (v) => {
    volumes.master = v;
    audio?.setVolumes(volumes);
  });
  slider(vol, 'music', 0, 1, 0.01, volumes.music, (v) => {
    volumes.music = v;
    audio?.setVolumes(volumes);
  });
  slider(vol, 'sfx', 0, 1, 0.01, volumes.sfx, (v) => {
    volumes.sfx = v;
    audio?.setVolumes(volumes);
  });

  const meters = el('div', { class: 'meters' });
  live.append(meters);
  const mBeat = meter(meters, 'beat');
  const mBar = meter(meters, 'bar');
  const mKick = meter(meters, 'kick');
  const mEnergy = meter(meters, 'energy');
  const mLayer = meter(meters, 'layer');

  const ev = section('Ereignisse');
  button(ev, 'jump', () => emit(jumpEvent()));
  button(ev, 'bhop (land+jump)', () => {
    emit({ type: 'land', impact: 300, speed: state.speed, airTime: 0.7, jumpQueued: true });
    emit(jumpEvent());
  });
  button(ev, 'land weich', () => emit({ type: 'land', impact: 300, speed: 0, airTime: 0.7, jumpQueued: false }));
  button(ev, 'land hart', () => emit({ type: 'land', impact: 900, speed: 0, airTime: 1.5, jumpQueued: false }));
  button(ev, 'footstep L', () => emit({ type: 'footstep', speed: 250, left: true }));
  button(ev, 'footstep R', () => emit({ type: 'footstep', speed: 250, left: false }));
  button(ev, 'duck', () => emit({ type: 'duck', down: true }));
  button(ev, 'surfStart', () => emit({ type: 'surfStart' }));
  button(ev, 'surfEnd', () => emit({ type: 'surfEnd' }));
  button(ev, 'runStart', () => emit({ type: 'runStart' }));
  button(ev, 'checkpoint', () => emit({ type: 'checkpoint', index: 0, total: 3, time: 12.3, split: null }));
  button(ev, 'finish', () => emit({ type: 'finish', time: 40.1, best: true, previousBest: null }));
  button(ev, 'respawn (fall)', () => emit({ type: 'respawn', reason: 'fall' }));
  button(ev, 'respawn (restart)', () => emit({ type: 'respawn', reason: 'restart' }));
  for (const s of [500, 750, 1000, 1250]) button(ev, `milestone ${s}`, () => emit({ type: 'speedMilestone', speed: s }));
  button(ev, 'levelLoaded', () => emit({ type: 'levelLoaded', id: `lvl${Math.floor(Math.random() * 99)}`, name: 'Test' }));

  const mutes = section('Spuren');
  for (const p of PARTS) checkbox(mutes, p, true, (on) => audio?.setMuted(p, !on));

  const off = section('Offline-Render (8 Takte, konstanter Drive)');
  const presets: readonly [string, Partial<MusicDrive>][] = [
    ['E0 Stand', { speed: 0 }],
    ['E25 Laufen', { speed: 320, hopChain: 3, strafeSync: 0.5 }],
    ['E50 Bhop', { speed: 450, hopChain: 4, strafeSync: 0.6, onGround: false }],
    ['E75 schnell', { speed: 700, hopChain: 4, strafeSync: 0.6, onGround: false }],
    ['E100 Flow', { speed: 1000, hopChain: 12, strafeSync: 0.8, onGround: false }],
    ['E100+ 1250 u/s', { speed: 1250, hopChain: 12, strafeSync: 0.8, onGround: false }],
  ];
  for (const [label, d] of presets) button(off, label, () => void window.__audioRenderOffline?.(d, BAR * 8 + 0.3));
  for (const s of SCENARIOS) button(off, `Szenario ${s}`, () => void window.__audioRenderScenario?.(s));
  button(off, '▶ letzten Render abspielen', () => {
    if (lastBuffer === null) return;
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = lastBuffer;
    src.connect(ctx.destination);
    src.start();
    src.addEventListener('ended', () => void ctx.close());
  });

  let last = performance.now();
  const frame = (): void => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (audio !== null && audio.unlocked) {
      if (autoHop && now >= nextHop) {
        nextHop = now + 720;
        emit({ type: 'land', impact: 300, speed: state.speed, airTime: 0.72, jumpQueued: true });
        emit(jumpEvent());
      }
      audio.update({ ...state, hopChain: autoHop ? chain : state.hopChain, onGround: !autoHop && state.speed < 1 }, dt);
      const b = audio.beat();
      mBeat(b.beatPhase, b.beat.toFixed(2));
      mBar(b.barPhase, b.barPhase.toFixed(2));
      mKick(b.kick, b.kick.toFixed(2));
      mEnergy(b.energy, `${b.energy.toFixed(3)} (Ziel ${targetEnergy({ ...state, hopChain: autoHop ? chain : state.hopChain }).toFixed(3)})`);
      mLayer(b.layer / 4, `${b.layer} (geplant ${audio.scheduledLayer})`);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

buildUi();
window.__audioSetDrive = (d) => {
  Object.assign(state, d);
  if (d.speed !== undefined) driveViews.speed?.(d.speed);
  if (d.hopChain !== undefined) driveViews.hopChain?.(d.hopChain);
  if (d.strafeSync !== undefined) driveViews.strafeSync?.(d.strafeSync);
  if (d.surfing !== undefined) driveViews.surfing?.(d.surfing);
  if (d.active !== undefined) driveViews.active?.(d.active);
};
window.__audioReady = true;
