/**
 * Sichtprüfung der Kamera: echte Bewegung + Fixed-Step + lerpSnapshot +
 * CameraRig wie im Spiel.
 *   shots/movement/camera-steps.png — Stufen, Rampe und Ducken: Kamera- gegen Augenhöhe pro Frame
 *   shots/movement/camera-feel.png  — Bhop-Kette (perfekt vs. 3°-Hand): FOV-Anteile (Speed, Pop,
 *                                     Surge) und Carve-Roll, dazu ein Drop mit Dip und Shake
 * Gibt dazu Kennzahlen auf der Konsole aus.
 *
 *   npx tsx tools/sim/cameraPlot.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { chromium } from 'playwright';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { lerpSnapshot } from '../../src/player/interpolate';
import { StrafeBot } from '../../src/player/bots';
import { CameraRig, DEFAULT_CAMERA_SETTINGS, cameraViewFromSnapshot, makeCameraView, type CameraRigSettings } from '../../src/player/CameraRig';
import { NO_INPUT, type PlayerInput, type PlayerSnapshot } from '../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import type { BrushDef } from '../../src/world/level/LevelFormat';
import { box, flatLevel, makeLevel } from './levels';

const DEG = Math.PI / 180;

/** Ein Frame: Augen-/Kamerahöhe, FOV-Anteile (horizontal 4:3), Roll, Speed. */
interface Sample {
  readonly t: number;
  readonly eye: number;
  readonly cam: number;
  readonly fov: number;
  readonly speedKick: number;
  readonly pop: number;
  readonly surge: number;
  readonly roll: number;
  readonly speed: number;
  readonly air: boolean;
  readonly perfectJump: boolean;
}

type Driver = (s: PlayerSnapshot) => PlayerInput;

function play(level: CompiledLevel, start: Vector3, driver: Driver, hz: number, seconds: number, settings: CameraRigSettings, startVel?: Vector3): Sample[] {
  const cfg = VELOCITY_DEFAULT;
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(start);
  if (startVel) pm.state.vel.copy(startVel);
  const prev = PlayerMovement.createSnapshot();
  const curr = PlayerMovement.createSnapshot();
  const interp = PlayerMovement.createSnapshot();
  pm.copySnapshot(prev);
  pm.copySnapshot(curr);
  const cam = new PerspectiveCamera(70, 4 / 3);
  const rig = new CameraRig(cam);
  rig.setSettings(settings);
  rig.setAspect(4 / 3);
  rig.setMovement(cfg);
  const v = makeCameraView();
  const tickDt = 1 / cfg.tickRate;
  let acc = 0;
  let last: PlayerInput = NO_INPUT;
  const out: Sample[] = [];
  for (let f = 0; f < Math.round(hz * seconds); f++) {
    acc += 1 / hz;
    let perfectJump = false;
    while (acc >= tickDt) {
      pm.copySnapshot(prev);
      last = driver(pm.state);
      const ev = pm.tick(last);
      // Wie Game: Tick-Grenze vor den Events (Lip-Step-Versatz gegen die Interpolation).
      rig.onTick();
      for (const e of ev) {
        rig.onEvent(e);
        if (e.type === 'jump' && e.clean) perfectJump = true;
      }
      pm.copySnapshot(curr);
      acc -= tickDt;
    }
    const alpha = acc / tickDt;
    lerpSnapshot(prev, curr, alpha, interp);
    cameraViewFromSnapshot(interp, last.sprint, last.side, v, alpha);
    rig.update(1 / hz, v, last.yaw, 0);
    const fx = rig.fxState;
    out.push({
      t: f / hz,
      eye: v.eyePos.y,
      cam: cam.position.y,
      fov: (2 * Math.atan(Math.tan((cam.fov * DEG) / 2) / 0.75)) / DEG,
      speedKick: fx.speedKick,
      pop: fx.pop,
      surge: fx.surge,
      roll: fx.roll,
      speed: v.speed,
      air: !v.onGround,
      perfectJump,
    });
  }
  return out;
}

function stairs(rise: number, run: number): CompiledLevel {
  const b: BrushDef[] = [box([-512, -64, -4000], [512, 0, 512])];
  for (let k = 0; k < 8; k++) b.push(box([-256, 0, -100 - (k + 1) * run], [256, rise * (k + 1), -100 - k * run]));
  b.push(box([-256, 0, -3000], [256, rise * 8, -100 - 8 * run]));
  return compileLevel(makeLevel(b));
}

function ramp(deg: number): CompiledLevel {
  const h = Math.tan((deg * Math.PI) / 180) * 300;
  return compileLevel(makeLevel([
    box([-512, -64, -3000], [512, 0, 512]),
    { type: 'wedge', min: [-256, 0, -400], max: [256, h, -100], rise: '-z', mat: 'floor' },
    box([-256, 0, -1500], [256, h, -400]),
  ]));
}

// ------------------------------------------------------------------ SVG-Helfer

interface Series {
  readonly ys: readonly number[];
  readonly color: string;
  readonly width?: number;
  readonly dots?: boolean;
}

function panel(title: string, series: readonly Series[], x0: number, y0: number, w: number, h: number, marks: readonly number[] = []): string {
  const all = series.flatMap((s) => s.ys);
  const lo0 = Math.min(...all);
  const hi0 = Math.max(...all);
  const pad = Math.max(0.5, (hi0 - lo0) * 0.08);
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const n = Math.max(...series.map((s) => s.ys.length));
  const px = (i: number): number => x0 + (i / Math.max(1, n - 1)) * w;
  const py = (y: number): number => y0 + h - ((y - lo) / (hi - lo)) * h;
  const path = (ys: readonly number[]): string => ys.map((y, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(y).toFixed(1)}`).join('');
  const zero = lo < 0 && hi > 0 ? `<line x1="${x0}" x2="${x0 + w}" y1="${py(0).toFixed(1)}" y2="${py(0).toFixed(1)}" stroke="#2a3040"/>` : '';
  const m = marks.map((i) => `<line x1="${px(i).toFixed(1)}" x2="${px(i).toFixed(1)}" y1="${y0}" y2="${y0 + h}" stroke="#ffd23d" stroke-opacity="0.35"/>`).join('');
  const body = series
    .map((s) => {
      const dots = s.dots ? s.ys.map((y, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(y).toFixed(1)}" r="1.6" fill="${s.color}"/>`).join('') : '';
      return `<path d="${path(s.ys)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}"/>${dots}`;
    })
    .join('');
  return `
  <rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#10131c" stroke="#2a3040"/>${zero}${m}
  <text x="${x0 + 8}" y="${y0 + 18}" fill="#e8ecf4" font-size="14">${title}</text>
  <text x="${x0 + w - 8}" y="${y0 + 16}" fill="#7d8599" font-size="11" text-anchor="end">${hi0.toFixed(1)}</text>
  <text x="${x0 + w - 8}" y="${y0 + h - 6}" fill="#7d8599" font-size="11" text-anchor="end">${lo0.toFixed(1)}</text>${body}`;
}

async function render(svgs: readonly { file: string; svg: string; w: number; h: number }[]): Promise<void> {
  mkdirSync('shots/movement', { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const s of svgs) {
      writeFileSync(`shots/movement/${s.file}.svg`, s.svg);
      const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
      await page.setContent(`<html><body style="margin:0">${s.svg}</body></html>`);
      await page.screenshot({ path: `shots/movement/${s.file}.png` });
      await page.close();
      console.log(`shots/movement/${s.file}.png`);
    }
  } finally {
    await browser.close();
  }
}

/** Größter Sprung der Frame-Geschwindigkeit (u/s) — ein Knick in der Kurve. */
function maxKink(ys: readonly number[], hz: number): number {
  let m = 0;
  for (let i = 2; i < ys.length; i++) m = Math.max(m, Math.abs(ys[i] - 2 * ys[i - 1] + ys[i - 2]) * hz);
  return m;
}

// ------------------------------------------------------------------ Stufen, Rampe, Ducken

function stepsFigure(): { file: string; svg: string; w: number; h: number } {
  const noBob = { ...DEFAULT_CAMERA_SETTINGS, headBob: 0 };
  const walk: Driver = () => ({ ...NO_INPUT, forward: 1 });
  const sprint: Driver = () => ({ ...NO_INPUT, forward: 1, sprint: true });
  let tick = 0;
  // Im Stand: 0.3 s stehen, 0.6 s ducken, aufstehen, 0.3 s später nochmal kurz antippen.
  const duck: Driver = () => {
    const t = tick++ / VELOCITY_DEFAULT.tickRate;
    return { ...NO_INPUT, crouch: (t > 0.3 && t < 0.9) || (t > 1.2 && t < 1.28) };
  };
  const flat = compileLevel(flatLevel(4096));
  const traces: { title: string; s: Sample[]; hz: number }[] = [
    { title: 'Treppe 16/32, 60 Hz, Gehen', s: play(stairs(16, 32), new Vector3(0, 0, 40), walk, 60, 1.6, noBob), hz: 60 },
    { title: 'Treppe 8/16, 60 Hz, Sprint', s: play(stairs(8, 16), new Vector3(0, 0, 40), sprint, 60, 1.2, noBob), hz: 60 },
    { title: 'Treppe 16/32, 144 Hz, Sprint', s: play(stairs(16, 32), new Vector3(0, 0, 40), sprint, 144, 1.3, noBob), hz: 144 },
    { title: 'Rampe 40°, 60 Hz, Sprint (keine Glättung)', s: play(ramp(40), new Vector3(0, 0, 40), sprint, 60, 1.6, noBob), hz: 60 },
    { title: 'Ducken, 144 Hz: Kamera smoothstep, Auge linear', s: play(flat, new Vector3(0, 0, 0), duck, 144, 1.7, noBob), hz: 144 },
  ];
  const W = 1200;
  const PH = 200;
  const panels = traces.map((tr, i) => {
    const eye = tr.s.map((q) => q.eye);
    const cam = tr.s.map((q) => q.cam);
    let maxJump = 0;
    for (let k = 1; k < cam.length; k++) maxJump = Math.max(maxJump, Math.abs(cam[k] - cam[k - 1]));
    let extra = ` — max. Kamera-Sprung/Frame ${maxJump.toFixed(2)} u`;
    if (tr.title.startsWith('Ducken')) {
      // Voller Zyklus (bis 1.1 s) getrennt von der Umkehr beim Antippen: dort bleibt ein Knick (smoothstep-Steigung 1.5 bei f = 0.5).
      const cut = Math.round(1.1 * tr.hz);
      const full = `Knick voll: Auge ${maxKink(eye.slice(0, cut), tr.hz).toFixed(0)}, Kamera ${maxKink(cam.slice(0, cut), tr.hz).toFixed(0)} u/s`;
      const tap = `Umkehr: ${maxKink(eye.slice(cut), tr.hz).toFixed(0)} → ${maxKink(cam.slice(cut), tr.hz).toFixed(0)} u/s`;
      extra = ` — ${full}; ${tap}`;
      console.log(`Ducken (Geschwindigkeitssprung pro Frame): ${full}; ${tap}`);
    }
    return panel(tr.title + extra, [{ ys: eye, color: '#ff8a3d' }, { ys: cam, color: '#36e0ff', width: 1, dots: true }], 20, 40 + i * (PH + 20), W - 40, PH);
  });
  const H = traces.length * (PH + 20) + 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace">
  <rect width="100%" height="100%" fill="#07090e"/>
  <text x="20" y="26" fill="#e8ecf4" font-size="16">Augenhöhe (orange, ungeglättet) gegen Kamera (cyan, ein Punkt pro Frame)</text>
  ${panels.join('')}
</svg>`;
  return { file: 'camera-steps', svg, w: W, h: H };
}

// ------------------------------------------------------------------ Feel: Bhop-Kette + Drop

function feelFigure(): { file: string; svg: string; w: number; h: number } {
  const flat = compileLevel(flatLevel(16384));
  const chain = (aimNoiseDeg: number): Sample[] => {
    const bot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1, aimNoiseDeg, seed: 5 });
    return play(flat, new Vector3(0, 0, 0), (s) => bot.next(s), 60, 12, DEFAULT_CAMERA_SETTINGS, new Vector3(0, 0, -320));
  };
  const perfect = chain(0);
  const human = chain(3);
  let dropTick = 0;
  const drop = play(flat, new Vector3(0, 400, 0), () => ({ ...NO_INPUT, forward: dropTick++ > 200 ? 0 : 0 }), 60, 1.8, DEFAULT_CAMERA_SETTINGS);

  const W = 1200;
  const PH = 170;
  const rows: string[] = [];
  let y = 40;
  const add = (title: string, series: Series[], marks: number[] = []): void => {
    rows.push(panel(title, series, 20, y, W - 40, PH, marks));
    y += PH + 20;
  };
  for (const [name, s] of [['perfekt', perfect], ['3°-Hand', human]] as const) {
    const marks = s.flatMap((q, i) => (q.perfectJump ? [i] : []));
    const band = s.filter((q) => q.air && q.speed >= 250 && q.speed < 600);
    const surge = band.reduce((a, q) => a + q.surge, 0) / Math.max(1, band.length);
    const pops = s.map((q) => q.pop);
    console.log(`${name}: Endspeed ${s[s.length - 1].speed.toFixed(0)} u/s, FOV max ${Math.max(...s.map((q) => q.fov - 90)).toFixed(2)}°, Surge Ø (Luft 250–600 u/s) ${surge.toFixed(2)}°, Pop max ${Math.max(...pops).toFixed(2)}°`);
    add(`${name}: hFOV−90 gesamt (weiß), Speed-Kick (orange), Pop (gelb), Surge (grün) — gelbe Linien = perfekter Hop`, [
      { ys: s.map((q) => q.fov - 90), color: '#e8ecf4' },
      { ys: s.map((q) => q.speedKick), color: '#ff8a3d', width: 1 },
      { ys: pops, color: '#ffd23d', width: 1 },
      { ys: s.map((q) => q.surge), color: '#5cff8a', width: 1 },
    ], marks);
    add(`${name}: Carve-Roll (Grad, + = rechts), Speed/100 (grau)`, [
      { ys: s.map((q) => q.speed / 100), color: '#4a5266', width: 1 },
      { ys: s.map((q) => q.roll), color: '#36e0ff' },
    ]);
  }
  add('Drop 400 u (Aufprall 800 u/s): Kamera − Auge (Dip + Shake-Translation)', [{ ys: drop.map((q) => q.cam - q.eye), color: '#ff5c8a', dots: true }]);
  const H = y + 10;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace">
  <rect width="100%" height="100%" fill="#07090e"/>
  <text x="20" y="26" fill="#e8ecf4" font-size="16">Kamera-Vokabular: Tempo = FOV (log), Timing = Pop, Strafe-Qualität = Surge, Kurve = Roll (60 Hz)</text>
  ${rows.join('')}
</svg>`;
  return { file: 'camera-feel', svg, w: W, h: H };
}

async function main(): Promise<void> {
  await render([stepsFigure(), feelFigure()]);
}

void main();
