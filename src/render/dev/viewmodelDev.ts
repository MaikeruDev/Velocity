import { ViewModelPreview } from '../viewmodel/ViewModelPreview';
import { createViewModelFrame } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { HAND_POSES, POSE, POSE_JOINTS } from '../../ui/hand/poses';
import type { HandPose } from '../../ui/hand/poses';
import { ViewHand } from '../../ui/hand/ViewHand';
import { makeHandInput } from '../../ui/hand/handMotion';
import type { HeldItemId } from '../../engine/settingsTypes';
import type { GameEvent } from '../../engine/events';

/** Echter Controller: Gegenstand, Trick bei Zeit `at` festgehalten, Zustand vorbelegt. */
interface LiveSpec {
  readonly item: HeldItemId;
  readonly trick?: string;
  readonly at?: number;
  readonly opened?: boolean;
  readonly knifeOpen?: boolean;
  readonly flipped?: boolean;
  readonly aspect?: number;
  readonly speed?: number;
  readonly pose?: HandPose;
  /** Plan 007: Surf-Zustand (Spinner balanciert) und Seitenneigung. */
  readonly surfing?: boolean;
  readonly surfSide?: number;
  /** Events vor dem Einschwingen (z. B. perfekter Hop → Gold-Funkeln). */
  readonly events?: readonly GameEvent[];
  /** Einschwing-Frames (Standard 60). */
  readonly frames?: number;
  /**
   * Plan 008: Trick NICHT festhalten, sondern ab Trick-Zeit 0 mit dieser Framerate bis `at` laufen lassen
   * (Physik-Tricks hängen an ihrer Vorgeschichte; Zeitlupe = dichte `at`-Folge).
   */
  readonly play?: number;
}

/**
 * Dev-Seite für den Viewmodel-Look (Plan 006): rendert beliebige Frames in eine Kachel-
 * Übersicht (Kontaktblatt), gesteuert über window.__vm (tools/viewmodel-shots.mjs,
 * tools/viewmodel-sheet.mjs). Ein WebGL-Kontext für alles; jede Kachel wird direkt nach dem
 * Rendern kopiert. Plan 007: alle Skins/Gegenstände, Kick (Roboter-LED), skinFx/propParam im
 * Frame, und __vm.stats() misst Draw Calls/Dreiecke je Kachel (Budget ≤ 50 / ≤ 12 000).
 */

interface CellSpec {
  readonly label?: string;
  readonly pose?: HandPose;
  readonly glove?: ViewModelGlove;
  readonly item?: ViewModelItem;
  /** Frame-Felder überschreiben (x, y, z, pitch, yaw, roll, squash, canTab, skinFx, …). */
  readonly frame?: Partial<Record<string, number | boolean>>;
  readonly joints?: readonly number[];
  /** Nur Daumen [abd, opp, mcp?, ip?] (rad) überschreiben. */
  readonly thumb?: readonly number[];
  readonly propPos?: readonly number[];
  readonly propRot?: readonly number[];
  /** Gegenstands-Kanäle (VM_PARAM). */
  readonly param?: readonly number[];
  readonly bg?: readonly [string, string, string, string, number];
  readonly time?: number;
  /** Kick-Hüllkurve 0..1 (Roboter-LED). */
  readonly kick?: number;
  /** Arm-Grundhaltung [pitch, twist, roll] (rad). */
  readonly arm?: readonly [number, number, number];
  /** Plan 008: Kamera kreist um Gegenstand/Hand (Grad, Hand-Einheiten) — Seiten-/Unteransicht im Griff-Audit. */
  readonly view?: { readonly yaw: number; readonly pitch: number; readonly dist?: number; readonly target?: 'item' | 'hand' };
  readonly live?: LiveSpec;
}

interface SheetOptions {
  readonly w: number;
  readonly h: number;
  readonly zoom: number;
  readonly depth?: number;
  /** Nur diesen Ausschnitt zeigen (Anteile des Low-Res-Bildes: x0, y0, x1, y1) — Spielgröße mit Lupe. */
  readonly crop?: readonly [number, number, number, number];
}

interface CellStats {
  readonly label: string;
  readonly calls: number;
  readonly triangles: number;
}

const sheet = document.getElementById('sheet') as HTMLDivElement;
let preview: ViewModelPreview | null = null;
let size = { w: 0, h: 0 };

const NUM_KEYS = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'squash', 'propSpin', 'propVisible', 'propScale', 'canTab', 'knifeBlade', 'knifeBite', 'poof', 'skinFx', 'subVisible', 'subSpin', 'stringCount'] as const;

function liveFrame(l: LiveSpec, glove: ViewModelGlove): ViewModelFrame {
  const h = new ViewHand();
  h.setAspect(l.aspect ?? 16 / 9);
  h.setGlove(glove);
  h.setItem(l.item);
  if (l.item === 'can') h.can.opened = l.opened ?? false;
  if (l.item === 'knife') h.knife.isOpen = l.knifeOpen ?? false;
  if (l.item === 'card') h.card.flipped = l.flipped ?? false;
  // Crack/Idle nicht ungefragt auslösen: Tricks nur, wenn gewünscht.
  if (!l.trick) h.motionFx = 1;
  if (l.pose) h.force = POSE[l.pose];
  const inp = makeHandInput();
  inp.speed = l.speed ?? 0;
  inp.onGround = !(l.surfing ?? false);
  inp.surfing = l.surfing ?? false;
  inp.surfSide = l.surfSide ?? 0;
  for (const e of l.events ?? []) h.onEvent(e);
  if (l.trick && l.play) {
    // Einschwingen ohne Trick (kein Leerlauf-Trick: 1 s < erste Leerlauf-Pause), dann frei laufen bis `at`.
    for (let i = 0; i < 60; i++) h.update(1 / 60, inp);
    h.forceTrick(l.trick, -1);
    const steps = Math.round((l.at ?? 0) * l.play);
    for (let i = 0; i <= steps; i++) h.update(1 / l.play, inp);
    return h.output(true);
  }
  if (l.trick) h.forceTrick(l.trick, l.at ?? 0);
  // 1 s einschwingen (Posen-Überblendung, Federn), Trick bleibt bei `at` stehen.
  const n = l.frames ?? 60;
  for (let i = 0; i < n; i++) {
    if (!l.trick && l.item === 'can') h.can.debugPlay('none');
    h.update(1 / 60, inp);
    if (l.trick) h.forceTrick(l.trick, l.at ?? 0);
  }
  h.update(1 / 60, inp);
  const f = h.output(true);
  return f;
}

function frameFor(c: CellSpec): ViewModelFrame {
  const f = c.live ? liveFrame(c.live, c.glove ?? 'classic') : createViewModelFrame();
  if (!c.live) {
    f.visible = true;
    f.x = 0.52;
    f.y = 0.36;
    f.glove = c.glove ?? 'classic';
    f.item = c.item ?? 'none';
    const pose = POSE_JOINTS[POSE[c.pose ?? 'relaxed']];
    f.joints.set(pose);
    if (c.joints) for (let i = 0; i < c.joints.length; i++) f.joints[i] = c.joints[i];
    if (c.thumb) for (let i = 0; i < c.thumb.length; i++) f.joints[3 + i] = c.thumb[i];
    if (c.propPos) f.propPos.set(c.propPos);
    if (c.propRot) f.propRot.set(c.propRot);
  }
  if (c.param) f.propParam.set(c.param);
  for (const k of NUM_KEYS) {
    const v = c.frame?.[k];
    if (typeof v === 'number') f[k] = v;
  }
  if (typeof c.frame?.canOpen === 'boolean') f.canOpen = c.frame.canOpen;
  return f;
}

function ensurePreview(o: SheetOptions): ViewModelPreview {
  if (!preview || size.w !== o.w || size.h !== o.h) {
    preview?.dispose();
    const cv = document.createElement('canvas');
    preview = new ViewModelPreview(cv, o.w, o.h);
    size = { w: o.w, h: o.h };
  }
  preview.vm.depth = o.depth ?? 30;
  return preview;
}

function draw(p: ViewModelPreview, c: CellSpec): void {
  if (c.bg) p.setBackground(c.bg[0], c.bg[1], c.bg[2], c.bg[3], c.bg[4]);
  else p.setBackground('#141030', '#3a2458', '#1a2340', '#33f0ff', 0.28);
  if (c.arm) p.vm.setArmBase(c.arm[0], c.arm[1], c.arm[2]);
  const D = Math.PI / 180;
  p.vm.debugOrbit = c.view ? { yaw: c.view.yaw * D, pitch: c.view.pitch * D, dist: c.view.dist ?? 34, target: c.view.target ?? 'item' } : null;
  const f = frameFor(c);
  p.prewarm(f.item, f.glove);
  p.render(f, c.time ?? 1, c.kick ?? 0);
}

function render(cells: readonly CellSpec[], o: SheetOptions): number {
  sheet.textContent = '';
  const p = ensurePreview(o);
  for (const c of cells) {
    draw(p, c);
    const [cx0, cy0, cx1, cy1] = o.crop ?? [0, 0, 1, 1];
    const sx = Math.round(cx0 * o.w);
    const sy = Math.round(cy0 * o.h);
    const sw = Math.max(1, Math.round((cx1 - cx0) * o.w));
    const sh = Math.max(1, Math.round((cy1 - cy0) * o.h));
    const out = document.createElement('canvas');
    out.width = sw * o.zoom;
    out.height = sh * o.zoom;
    const ctx = out.getContext('2d');
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(p.canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.append(out);
    const lab = document.createElement('div');
    lab.textContent = c.label ?? c.pose ?? '';
    cell.append(lab);
    sheet.append(cell);
  }
  return cells.length;
}

/** Draw Calls und Dreiecke des Viewmodel-Passes je Kachel (ohne Bild). */
function stats(cells: readonly CellSpec[], o: SheetOptions): CellStats[] {
  const p = ensurePreview(o);
  return cells.map((c) => {
    draw(p, c);
    return { label: c.label ?? c.pose ?? '', calls: p.lastCalls, triangles: p.lastTriangles };
  });
}

declare global {
  interface Window {
    __vm?: { render: typeof render; stats: typeof stats; poses: readonly string[] };
  }
}
window.__vm = { render, stats, poses: HAND_POSES };

// ------------------------------------------------------------------ Live-Modus: Zeitlupe und Scrubbing (Plan 008)

/**
 * dev/viewmodel.html?live — ein Gegenstand live, Trick per Klick, Tempo 1× … 0.1× (alles in der Hand ist dt-
 * unabhängig, also zeigt die Zeitlupe dieselbe Bahn), Schieber = Trick-Zeit (rechnet frei ab 0 mit 240 Hz bis
 * dorthin, wie `play` in den Kontaktblättern), Kamera Spiel/Seite/unten/oben/hinten, Skin.
 */
function liveMode(): void {
  const q = new URLSearchParams(location.search);
  const W = 480;
  const H = 270;
  const items: HeldItemId[] = ['knife', 'card', 'can', 'yoyo', 'spinner', 'coin', 'lighter', 'kendama', 'phone', 'none'];
  const gloves: ViewModelGlove[] = ['classic', 'neon', 'gold', 'robot', 'skeleton', 'cat'];
  const views: Record<string, { yaw: number; pitch: number } | null> = { Spiel: null, vorn: { yaw: 0, pitch: 0 }, rechts: { yaw: 70, pitch: 10 }, links: { yaw: -70, pitch: 10 }, unten: { yaw: 0, pitch: -70 }, oben: { yaw: 0, pitch: 70 }, hinten: { yaw: 160, pitch: 10 } };
  const st = {
    item: (q.get('item') as HeldItemId) ?? 'knife',
    glove: (q.get('glove') as ViewModelGlove) ?? 'classic',
    trick: q.get('trick') ?? 'open',
    speed: Number(q.get('speed') ?? 0.25),
    view: q.get('view') ?? 'Spiel',
    playing: true,
    t: 0,
  };
  const cv = document.createElement('canvas');
  const p = new ViewModelPreview(cv, W, H);
  p.vm.depth = 40;
  const out = document.createElement('canvas');
  out.width = W * 2;
  out.height = H * 2;
  out.style.width = `${W * 2}px`;
  const ui = document.createElement('div');
  ui.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:6px';
  sheet.append(out, ui);
  const sel = (label: string, opts: readonly string[], value: string, on: (v: string) => void): void => {
    const s = document.createElement('select');
    for (const o of opts) s.append(new Option(o, o, false, o === value));
    s.onchange = (): void => on(s.value);
    const l = document.createElement('label');
    l.textContent = `${label} `;
    l.append(s);
    ui.append(l);
  };
  let hand = new ViewHand();
  const inp = makeHandInput();
  const reset = (): void => {
    hand = new ViewHand();
    hand.setAspect(16 / 9);
    hand.setGlove(st.glove);
    hand.setItem(st.item);
    for (let i = 0; i < 60; i++) hand.update(1 / 60, inp);
    hand.forceTrick(st.trick, -1);
    st.t = 0;
  };
  const trickSel = document.createElement('select');
  const fillTricks = (): void => {
    const h = new ViewHand();
    h.setItem(st.item);
    trickSel.textContent = '';
    for (const n of h.activeProp?.trickNames ?? []) trickSel.append(new Option(n, n, false, n === st.trick));
    if (!h.activeProp?.trickNames.includes(st.trick)) st.trick = h.activeProp?.trickNames[0] ?? 'none';
  };
  sel('Gegenstand', items, st.item, (v) => {
    st.item = v as HeldItemId;
    fillTricks();
    reset();
  });
  const tl = document.createElement('label');
  tl.textContent = 'Trick ';
  tl.append(trickSel);
  trickSel.onchange = (): void => {
    st.trick = trickSel.value;
    reset();
  };
  ui.append(tl);
  sel('Tempo', ['1', '0.5', '0.25', '0.1'], String(st.speed), (v) => (st.speed = Number(v)));
  sel('Kamera', Object.keys(views), st.view, (v) => (st.view = v));
  sel('Skin', gloves, st.glove, (v) => {
    st.glove = v as ViewModelGlove;
    reset();
  });
  const play = document.createElement('button');
  play.textContent = 'Pause';
  play.onclick = (): void => {
    st.playing = !st.playing;
    play.textContent = st.playing ? 'Pause' : 'Weiter';
  };
  ui.append(play);
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = '1.5';
  scrub.step = String(1 / 240);
  scrub.style.width = '320px';
  const tlab = document.createElement('span');
  scrub.oninput = (): void => {
    // Scrubben: frei ab Trick-Zeit 0 bis zum Schieber rechnen (240 Hz), angehalten.
    st.playing = false;
    play.textContent = 'Weiter';
    reset();
    const target = Number(scrub.value);
    for (let i = 0; i < Math.round(target * 240); i++) hand.update(1 / 240, inp);
    st.t = target;
  };
  ui.append(scrub, tlab);
  fillTricks();
  reset();
  let last = performance.now();
  let rest = 0;
  let warmed = '';
  const loop = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (st.playing) {
      const sdt = dt * st.speed;
      hand.update(sdt, inp);
      st.t += sdt;
      if (hand.activeProp?.trick === 'none' || st.item === 'none') {
        rest += dt;
        if (rest > 0.8) {
          rest = 0;
          reset();
        }
      }
      scrub.value = String(st.t);
    }
    tlab.textContent = `t ${st.t.toFixed(3)} s · ${hand.activeProp?.trick ?? '-'}`;
    const f = hand.output(true);
    const v = views[st.view];
    p.vm.debugOrbit = v ? { yaw: (v.yaw * Math.PI) / 180, pitch: (v.pitch * Math.PI) / 180, dist: 34, target: 'hand' } : null;
    const key = `${f.item}/${f.glove}`;
    if (key !== warmed) {
      warmed = key;
      p.prewarm(f.item, f.glove);
    }
    p.render(f, now / 1000, 0);
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(p.canvas, 0, 0, out.width, out.height);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if (new URLSearchParams(location.search).has('live')) liveMode();
