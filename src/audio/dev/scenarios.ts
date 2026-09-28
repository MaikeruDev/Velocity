import type { MusicDrive } from '../types';
import type { OfflineEvent, OfflineRenderOptions } from '../offline';
import { clamp01, lerp } from '../dsp';

/**
 * Gescriptete Zeitleisten zum Anhören und Messen: so klingt eine Session,
 * ohne dass jemand spielen muss.
 */

export type ScenarioName =
  | 'buildup'
  | 'sfx'
  | 'flowEntry'
  | 'surf'
  | 'gradual'
  | 'respawns'
  | 'finish'
  | 'finishBest'
  | 'pause'
  | 'idleStart'
  | 'idleRespawns'
  | 'whoosh'
  | 'whooshRef';

export const SCENARIOS: readonly ScenarioName[] = [
  'buildup',
  'sfx',
  'flowEntry',
  'surf',
  'gradual',
  'respawns',
  'finish',
  'finishBest',
  'pause',
  'idleStart',
  'idleRespawns',
  'whoosh',
  'whooshRef',
];

/** Zeitpunkte in den kurzen Übergangs-Szenarien (audiocheck misst darum herum). */
export const FLOW_ENTRY_AT = 6;
export const SURF_FROM = 6;
export const SURF_TO = 10;
export const RESPAWN_TIMES: readonly number[] = [4, 13, 15.5, 18, 20.5];
export const FINISH_AT = 8;
/** Ergebnis-Menü erscheint so lange nach dem Ziel (Game: FINISH_MENU_DELAY). */
export const FINISH_MENU_AFTER = 1.2;
export const WALK_AT = 8;
export const IDLE_RESPAWNS: readonly number[] = [3, 7];
export const WHOOSH_FROM = 3;
export const WHOOSH_TO = 5;

export function drive(p: Partial<MusicDrive>): MusicDrive {
  return {
    speed: p.speed ?? 0,
    onGround: p.onGround ?? true,
    hopChain: p.hopChain ?? 0,
    strafeSync: p.strafeSync ?? 0,
    airTime: p.airTime ?? 0,
    surfing: p.surfing ?? false,
    active: p.active ?? true,
    nearL: p.nearL,
    nearR: p.nearR,
  };
}

interface Key {
  readonly t: number;
  readonly speed: number;
  readonly chain: number;
  readonly sync: number;
  readonly surf: boolean;
}

function keyed(keys: readonly Key[]): (t: number) => MusicDrive {
  return (t: number) => {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const u = clamp01((t - a.t) / Math.max(1e-6, b.t - a.t));
    return drive({
      speed: lerp(a.speed, b.speed, u),
      hopChain: Math.round(lerp(a.chain, b.chain, u)),
      strafeSync: lerp(a.sync, b.sync, u),
      surfing: a.surf,
      onGround: a.chain === 0 && !a.surf,
    });
  };
}

/** Bhop-Ereignisse (Landung + Sprung im selben Frame) im Abstand `period` zwischen t0 und t1. */
function hops(t0: number, t1: number, period: number, speedAt: (t: number) => number, chain0: number): OfflineEvent[] {
  const out: OfflineEvent[] = [];
  let chain = chain0;
  let prev = speedAt(t0);
  for (let t = t0; t < t1; t += period) {
    const sp = speedAt(t);
    if (chain > 0) out.push({ time: t, event: { type: 'land', impact: 300, speed: sp, airTime: period, jumpQueued: true } });
    chain++;
    out.push({
      time: t + 0.008,
      event: { type: 'jump', speed: sp, gain: chain > 1 ? sp - prev : 0, perfect: true, clean: true, chain, sync: 0.8, crouched: false, coyote: false },
    });
    prev = sp;
  }
  return out;
}

function buildup(): OfflineRenderOptions {
  const keys: Key[] = [
    { t: 0, speed: 0, chain: 0, sync: 0, surf: false },
    { t: 5, speed: 0, chain: 0, sync: 0, surf: false },
    { t: 6, speed: 250, chain: 0, sync: 0, surf: false },
    { t: 10, speed: 280, chain: 0, sync: 0, surf: false },
    { t: 10.5, speed: 320, chain: 1, sync: 0.5, surf: false },
    { t: 20, speed: 620, chain: 12, sync: 0.75, surf: false },
    { t: 28, speed: 900, chain: 22, sync: 0.8, surf: false },
    { t: 29, speed: 1050, chain: 0, sync: 0.8, surf: true },
    { t: 37, speed: 1350, chain: 0, sync: 0.8, surf: false },
    { t: 38, speed: 700, chain: 0, sync: 0.3, surf: false },
    { t: 40, speed: 0, chain: 0, sync: 0, surf: false },
    { t: 58, speed: 0, chain: 0, sync: 0, surf: false },
  ];
  const at = keyed(keys);
  const events: OfflineEvent[] = [
    { time: 5.5, event: { type: 'runStart' } },
    ...hops(10.5, 28.5, 0.72, (t) => at(t).speed, 0),
    { time: 16, event: { type: 'speedMilestone', speed: 500 } },
    { time: 22, event: { type: 'checkpoint', index: 0, total: 3, time: 16.5, split: null } },
    { time: 24.5, event: { type: 'speedMilestone', speed: 750 } },
    { time: 29, event: { type: 'surfStart' } },
    { time: 30, event: { type: 'speedMilestone', speed: 1000 } },
    { time: 37, event: { type: 'surfEnd' } },
    { time: 37.2, event: { type: 'land', impact: 850, speed: 700, airTime: 1.4, jumpQueued: false } },
    { time: 46, event: { type: 'respawn', reason: 'restart' } },
  ];
  return { seconds: 58, drive: at, events, settle: false };
}

function sfxDemo(): OfflineRenderOptions {
  const keys: Key[] = [
    { t: 0, speed: 0, chain: 0, sync: 0, surf: false },
    { t: 1, speed: 250, chain: 0, sync: 0, surf: false },
    { t: 4, speed: 250, chain: 0, sync: 0, surf: false },
    { t: 12, speed: 900, chain: 10, sync: 0.8, surf: false },
    { t: 13, speed: 1100, chain: 0, sync: 0.8, surf: true },
    { t: 17, speed: 1500, chain: 0, sync: 0.8, surf: false },
    { t: 18, speed: 300, chain: 0, sync: 0, surf: false },
    { t: 26, speed: 0, chain: 0, sync: 0, surf: false },
  ];
  const at = keyed(keys);
  const events: OfflineEvent[] = [];
  for (let i = 0; i < 8; i++) {
    events.push({ time: 1 + i * 0.38, event: { type: 'footstep', speed: 250, left: i % 2 === 0 } });
  }
  events.push({ time: 4, event: { type: 'jump', speed: 250, gain: 0, perfect: false, clean: false, chain: 1, sync: 0, crouched: false, coyote: false } });
  events.push(...hops(4.72, 12.2, 0.72, (t) => at(t).speed, 1));
  events.push(
    { time: 7, event: { type: 'speedMilestone', speed: 500 } },
    { time: 10, event: { type: 'speedMilestone', speed: 750 } },
    { time: 13, event: { type: 'surfStart' } },
    { time: 14, event: { type: 'speedMilestone', speed: 1000 } },
    { time: 17, event: { type: 'surfEnd' } },
    { time: 17.3, event: { type: 'land', impact: 900, speed: 300, airTime: 1.6, jumpQueued: false } },
    { time: 18.5, event: { type: 'checkpoint', index: 1, total: 3, time: 18, split: -0.4 } },
    { time: 20, event: { type: 'duck', down: true } },
    { time: 20.4, event: { type: 'duck', down: false } },
    { time: 21, event: { type: 'land', impact: 320, speed: 0, airTime: 0.7, jumpQueued: false } },
    { time: 22, event: { type: 'finish', time: 21.5, best: true, previousBest: 22.1 } },
    { time: 24.5, event: { type: 'respawn', reason: 'fall' } },
    { time: 25.3, event: { type: 'runStart' } },
  );
  return { seconds: 26.5, drive: at, events, settle: false, volumes: { master: 1, music: 0, sfx: 1 } };
}

/**
 * So kommt L4 ohne Surf: L3 im Bhop (eingeschwungen), dann schlagartig Flow
 * (Chain 12, Sync) — ein Energiesprung. Der Übergang braucht einen hörbaren
 * Anlauf und darf höchstens 2 Beats dauern.
 */
function flowEntry(): OfflineRenderOptions {
  const at = (t: number): MusicDrive =>
    t < FLOW_ENTRY_AT
      ? drive({ speed: 700, hopChain: 3, strafeSync: 0.6, onGround: false })
      : drive({ speed: 760, hopChain: 12, strafeSync: 0.85, onGround: false });
  return { seconds: 10, drive: at, settle: true };
}

/**
 * Surf als Breakdown: Bhop in L3, ab SURF_FROM Surf (Kick/Bass raus ab dem ersten
 * Beat nach ≥ 1 Beat Surf, Riser mit dem Surf-Tempo), bei SURF_TO Landung → Drop
 * auf dem nächsten Beat (L4-Ankunft mit Crash). 48 kHz für die Lautheitsmessung.
 */
function surf(): OfflineRenderOptions {
  const at = (t: number): MusicDrive => {
    if (t < SURF_FROM) return drive({ speed: 700, hopChain: 3, strafeSync: 0.6, onGround: false });
    // Surf bis 0.25 s vor der Landung, dann kurz Luft (Absprung von der Rampe), dann Boden.
    if (t < SURF_TO - 0.25) return drive({ speed: lerp(820, 1150, (t - SURF_FROM) / (SURF_TO - SURF_FROM)), surfing: true, strafeSync: 0.8, onGround: false });
    if (t < SURF_TO) return drive({ speed: 1150, strafeSync: 0.8, onGround: false });
    return drive({ speed: 950, hopChain: 12, strafeSync: 0.8, onGround: t < SURF_TO + 0.3 });
  };
  const events: OfflineEvent[] = [
    { time: SURF_FROM, event: { type: 'surfStart' } },
    { time: SURF_TO - 0.25, event: { type: 'surfEnd' } },
    { time: SURF_TO, event: { type: 'land', impact: 700, speed: 950, airTime: 0.25, jumpQueued: false } },
  ];
  return { seconds: 15, drive: at, events, settle: true, sampleRate: 48000 };
}

/** Langsamer Anstieg im L3 (Chain wächst, Bhop wird schneller): hier trägt der lange Riser. */
function gradual(): OfflineRenderOptions {
  const at = (t: number): MusicDrive => {
    const u = clamp01((t - 2) / 12);
    return drive({ speed: lerp(620, 780, u), hopChain: Math.round(lerp(3, 9, u)), strafeSync: 0.6, onGround: false });
  };
  return { seconds: 18, drive: at, settle: true };
}

/** Respawns: einer nach längerem Lauf (voller Tape-Stop), dann eine Übungs-Serie und ein Restart (leicht). */
function respawns(): OfflineRenderOptions {
  const at = (): MusicDrive => drive({ speed: 550, hopChain: 3, strafeSync: 0.6, onGround: false });
  const events: OfflineEvent[] = RESPAWN_TIMES.map((time, i) => ({
    time,
    event: { type: 'respawn', reason: i === RESPAWN_TIMES.length - 1 ? 'restart' : 'fall' },
  }));
  return { seconds: 22.5, drive: at, settle: true, events };
}

/** Flow in L4, dann Ziel; das Ergebnis-Menü (inaktiv) kommt 1.2 s später — wie im Spiel. */
function finishRun(best: boolean): OfflineRenderOptions {
  const at = (t: number): MusicDrive =>
    drive({ speed: t < FINISH_AT ? 900 : 700, hopChain: t < FINISH_AT ? 14 : 0, strafeSync: 0.8, onGround: t >= FINISH_AT, active: t < FINISH_AT + FINISH_MENU_AFTER });
  const events: OfflineEvent[] = [{ time: FINISH_AT, event: { type: 'finish', time: 30, best, previousBest: best ? 31 : 29 } }];
  return { seconds: 16, drive: at, events, settle: true, sampleRate: 48000, volumes: { master: 0.8, music: 0.8, sfx: 0.8 } };
}

/** Gleicher Flow, aber echte Pause (kein Ziel): muss dumpf werden (650 Hz). */
function pause(): OfflineRenderOptions {
  const at = (t: number): MusicDrive => drive({ speed: 900, hopChain: 14, strafeSync: 0.8, onGround: false, active: t < FINISH_AT });
  return { seconds: 14, drive: at, settle: true, sampleRate: 48000, volumes: { master: 0.8, music: 0.8, sfx: 0.8 } };
}

/** Stand (L0), dann der erste Schritt: Mini-Drop auf dem nächsten Downbeat. */
function idleStart(withRespawns: boolean): OfflineRenderOptions {
  const at = (t: number): MusicDrive => drive({ speed: t < WALK_AT ? 0 : 320, onGround: true });
  const events: OfflineEvent[] = withRespawns ? IDLE_RESPAWNS.map((time) => ({ time, event: { type: 'respawn', reason: 'restart' } })) : [];
  return { seconds: 16, drive: at, events, settle: true, sampleRate: 48000 };
}

/**
 * Flow in L4 an einer Wand links vorbei: nearL 64 → 160 u bei 800 u/s.
 * `withWall` false: derselbe Verlauf ohne Wand (Referenz für Differenzmessungen).
 */
function whoosh(withWall = true): OfflineRenderOptions {
  const at = (t: number): MusicDrive => {
    const inPass = withWall && t >= WHOOSH_FROM && t < WHOOSH_TO;
    const nearL = inPass ? lerp(64, 160, (t - WHOOSH_FROM) / (WHOOSH_TO - WHOOSH_FROM)) : Number.POSITIVE_INFINITY;
    return drive({ speed: 800, hopChain: 12, strafeSync: 0.8, onGround: false, nearL });
  };
  return { seconds: 7, drive: at, settle: true, sampleRate: 48000, volumes: { master: 0.8, music: 0.8, sfx: 0.8 } };
}

export function scenario(name: ScenarioName): OfflineRenderOptions {
  switch (name) {
    case 'buildup':
      return buildup();
    case 'sfx':
      return sfxDemo();
    case 'flowEntry':
      return flowEntry();
    case 'surf':
      return surf();
    case 'gradual':
      return gradual();
    case 'respawns':
      return respawns();
    case 'finish':
      return finishRun(false);
    case 'finishBest':
      return finishRun(true);
    case 'pause':
      return pause();
    case 'idleStart':
      return idleStart(false);
    case 'idleRespawns':
      return idleStart(true);
    case 'whooshRef':
      return whoosh(false);
    case 'whoosh':
      return whoosh();
  }
}
