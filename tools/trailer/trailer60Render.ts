/**
 * Musik für den 60-s-Trailer — dieselbe Engine und dieselben Regeln wie trailerRender.ts (30 s), zwei Renders:
 *
 *   coldOpen  2 Takte volle Energie (L4), aber "aus dem Nebenraum" (Menü-Tiefpass, drive.active = false)
 *   main      31 Takte ab ruhigem Intro: Build → Surf-Breakdown → DROP (m4) → Overdrive L4 (m8) → Checkpoint-
 *             Akzent (m12) → Breakdown 2 (m14–15) → zweiter Drop (m16) → L4+ → Breakdown 3 + Bestzeit-Riser
 *             (m24–25) → IMPACT (m26) → Outro/Hall-Ausklang
 *
 * music60.mjs klebt sie auf dem Raster zusammen: Trailer-Takt n = main-Takt n − 2 (n ≥ 2), Gesamtlänge 33 Takte = 60.0 s.
 */
import type { MusicDrive } from '../../src/audio/types';
import type { MusicPart } from '../../src/audio/Music';
import { drive } from '../../src/audio/dev/scenarios';
import { clamp01, lerp } from '../../src/audio/dsp';
import { ALL_PARTS, BAR, BEAT, LEAD, MUSIC_ONLY, SFX_ONLY, type Action, bar, channelsOf, ctxT, ev, renderJob, result, type RenderResult } from './trailerRender';

export const MAIN_BARS = 31;
export const COLD_BARS = 2;
export const MAIN_SECONDS = MAIN_BARS * BAR;
const RENDER_MAIN = MAIN_SECONDS + LEAD + 0.05;
const RENDER_COLD = COLD_BARS * BAR + LEAD + 1.5;

const SURF1 = bar(3) - BEAT - 0.01;
const LAND1 = bar(4) - 0.04;
const FLOW_AT = bar(8) - BEAT - 0.05;
const ACCENT_BAR = 12;
const SURF2 = bar(14) - BEAT - 0.01;
const LAND2 = bar(16) - 0.04;
const SURF3 = bar(24) - BEAT - 0.01;
const FINISH_AT = bar(25) - BEAT + 0.05;
export const IMPACT_BAR = 26;
/** Hall-Ausklang (Sekunden in main). */
export const TAIL_XFADE: readonly [number, number] = [bar(28) + 0.2, bar(28) + 0.65];
export const FADE_OUT: readonly [number, number] = [bar(30) - 0.3, MAIN_SECONDS];

function mainDrive(T: number): MusicDrive {
  if (T < bar(1)) return drive({ speed: 0 });
  if (T < bar(2) - 0.001) return drive({ speed: lerp(0, 190, (T - bar(1)) / BAR) });
  if (T < SURF1) {
    const u = clamp01((T - bar(2)) / BAR);
    return drive({ speed: lerp(400, 450, u), hopChain: Math.round(lerp(1, 3, u)), strafeSync: 0.75, onGround: false });
  }
  if (T < LAND1) return drive({ speed: lerp(500, 560, clamp01((T - SURF1) / BAR)), surfing: true, strafeSync: 0.8, onGround: false });
  if (T < bar(4) + 0.12) return drive({ speed: 600, hopChain: 4, strafeSync: 0.6, onGround: true });
  if (T < FLOW_AT) return drive({ speed: 600, hopChain: 4, strafeSync: 0.6, onGround: false });
  if (T < SURF2) {
    const speed = T < bar(10) ? 900 : lerp(900, 1150, clamp01((T - bar(10)) / (4 * BAR)));
    return drive({ speed, hopChain: 12, strafeSync: 0.85, onGround: false });
  }
  if (T < LAND2) return drive({ speed: lerp(1100, 1300, clamp01((T - SURF2) / (2 * BAR))), surfing: true, strafeSync: 0.85, onGround: false });
  if (T < LAND2 + 0.16) return drive({ speed: 1200, hopChain: 12, strafeSync: 0.85, onGround: true });
  if (T < SURF3) {
    const speed = lerp(1150, 1350, clamp01((T - bar(16)) / (8 * BAR)));
    return drive({ speed, hopChain: 14, strafeSync: 0.9, onGround: false });
  }
  if (T < bar(IMPACT_BAR)) return drive({ speed: lerp(1250, 1500, clamp01((T - SURF3) / (2 * BAR))), surfing: true, strafeSync: 0.9, onGround: false });
  return drive({ speed: 1000, hopChain: 12, strafeSync: 0.85, onGround: true });
}

function mainActions(): Action[] {
  return [
    ev(SURF1, { type: 'surfStart' }),
    ev(LAND1 - 0.002, { type: 'surfEnd' }),
    ev(LAND1, { type: 'land', impact: 700, speed: 600, airTime: 0.3, jumpQueued: false }),
    { planUntil: ctxT(bar(ACCENT_BAR)) + 0.001, at: 0.001, event: { type: 'checkpoint', index: 2, total: 3, time: 18, split: -0.4 } },
    ev(SURF2, { type: 'surfStart' }),
    ev(LAND2 - 0.002, { type: 'surfEnd' }),
    ev(LAND2, { type: 'land', impact: 800, speed: 1200, airTime: 0.4, jumpQueued: false }),
    ev(SURF3, { type: 'surfStart' }),
    ev(FINISH_AT, { type: 'finish', time: 25.4, best: true, previousBest: 26.1 }),
  ];
}

/** Cold Open: sofort L4 (settle), Menü-Tiefpass zu — klingt wie durch die Wand. */
function coldDrive(): MusicDrive {
  return drive({ speed: 1250, hopChain: 14, strafeSync: 0.9, onGround: false, active: false });
}

export type Job60 = 'main' | 'mainTail' | 'cold' | 'coldOpen' | 'mainWind';

export async function run(name: Job60): Promise<RenderResult> {
  if (name === 'main' || name === 'mainTail') {
    const keep: readonly MusicPart[] = ['pad', 'stabs', 'fx'];
    const mute = name === 'mainTail' ? ALL_PARTS.filter((p) => !keep.includes(p)) : [];
    const r = await renderJob({ seconds: RENDER_MAIN, driveAt: mainDrive, actions: mainActions(), mute, volumes: MUSIC_ONLY });
    return result(channelsOf(r.buffer), r.bars);
  }
  if (name === 'mainWind') {
    const actions = [ev(SURF1, { type: 'surfStart' }), ev(LAND1 - 0.002, { type: 'surfEnd' }), ev(SURF2, { type: 'surfStart' }), ev(LAND2 - 0.002, { type: 'surfEnd' }), ev(SURF3, { type: 'surfStart' })];
    const r = await renderJob({ seconds: RENDER_MAIN, driveAt: mainDrive, actions, volumes: SFX_ONLY });
    return result(channelsOf(r.buffer));
  }
  // Cold Open (gedämpft) bzw. 'cold' = dasselbe offen (zum Vergleich/Überblenden).
  const muffled = name === 'coldOpen';
  const r = await renderJob({ seconds: RENDER_COLD, driveAt: () => ({ ...coldDrive(), active: !muffled }), actions: [], volumes: MUSIC_ONLY });
  return result(channelsOf(r.buffer), r.bars);
}

export function info(): { bar: number; beat: number; lead: number; mainBars: number; coldBars: number; impactBar: number; tailXfade: readonly number[]; fadeOut: readonly number[]; finishAt: number } {
  return { bar: BAR, beat: BEAT, lead: LEAD, mainBars: MAIN_BARS, coldBars: COLD_BARS, impactBar: IMPACT_BAR, tailXfade: TAIL_XFADE, fadeOut: FADE_OUT, finishAt: FINISH_AT };
}

