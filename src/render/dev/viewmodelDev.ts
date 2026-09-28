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
