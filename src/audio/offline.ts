import type { GameEvent } from '../engine/events';
import type { AudioVolumes, MusicDrive } from './types';
import { BPM, type MusicPart } from './Music';
import { TechnoAudio } from './TechnoAudio';

export interface OfflineEvent {
  readonly time: number;
  readonly event: GameEvent;
}

export interface OfflineRenderOptions {
  readonly seconds: number;
  /** Konstanter Drive oder Zeitleiste (Energie wird dann pro 16tel fortgeschrieben). */
  readonly drive: MusicDrive | ((t: number) => MusicDrive);
  readonly seed?: number;
  readonly sampleRate?: number;
  /** Energie sofort einschwingen (Default: bei konstantem Drive ja, bei Zeitleiste nein). */
  readonly settle?: boolean;
  readonly events?: readonly OfflineEvent[];
  readonly volumes?: AudioVolumes;
  readonly mute?: readonly MusicPart[];
  /** Sicherheits-Clipper (Default an). Aus: Messung sieht, was er kaschieren würde. */
  readonly clipper?: boolean;
}

export interface TimelinePoint {
  /** Kontextzeit (Taktanfang). */
  readonly t: number;
  readonly energy: number;
  readonly layer: number;
}

export interface OfflineRender {
  readonly buffer: AudioBuffer;
  /** Energie/Layer je Taktanfang, wie geplant. */
  readonly timeline: readonly TimelinePoint[];
  /** Energie und Layer am Ende der Planung. */
  readonly energy: number;
  readonly layer: number;
}

/**
 * Rendert Musik (+ SFX) deterministisch per OfflineAudioContext, 2 Kanäle.
 * Gleicher Seed + gleiche Optionen = gleiches Ergebnis bis auf Float-Rundung
 * (Chromium summiert Fan-in in unbestimmter Reihenfolge, siehe fallen.md).
 */
export async function renderOffline(o: OfflineRenderOptions): Promise<OfflineRender> {
  const sr = o.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(o.seconds * sr), sampleRate: sr });
  const audio = new TechnoAudio({ context: ctx, seed: o.seed, clipper: o.clipper });
  for (const p of o.mute ?? []) audio.setMuted(p, true);
  audio.setVolumes(o.volumes ?? { master: 1, music: 1, sfx: 1 });
  await audio.unlock();
  const drive = o.drive;
  const driveAt = typeof drive === 'function' ? drive : undefined;
  const first = typeof drive === 'function' ? drive(0) : drive;
  if (o.settle ?? driveAt === undefined) audio.settle(first);
  else audio.update(first, 0);
  // Ereignisse und Taktgrenzen in Zeitreihenfolge abarbeiten: Planung bis dorthin, dann Ereignis bzw. Messpunkt.
  const barDur = (4 * 60) / BPM;
  const marks: { time: number; event: GameEvent | null }[] = (o.events ?? []).map((e) => ({ time: e.time, event: e.event }));
  for (let t = 0; t < o.seconds; t += barDur) marks.push({ time: t + 0.03, event: null });
  marks.sort((a, b) => a.time - b.time);
  const timeline: TimelinePoint[] = [];
  for (const m of marks) {
    audio.scheduleOffline(m.time, driveAt);
    if (m.event !== null) audio.emitAt(m.event, m.time);
    else timeline.push({ t: m.time, energy: audio.energyValue, layer: audio.scheduledLayer });
  }
  audio.scheduleOffline(o.seconds, driveAt);
  const energy = audio.energyValue;
  const layer = audio.scheduledLayer;
  const buffer = await ctx.startRendering();
  return { buffer, timeline, energy, layer };
}
