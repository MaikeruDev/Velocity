import { ViewModelPreview } from '../viewmodel/ViewModelPreview';
import { createViewModelFrame } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { HAND_POSES, POSE, POSE_JOINTS } from '../../ui/hand/poses';
import type { HandPose } from '../../ui/hand/poses';
import { ViewHand } from '../../ui/hand/ViewHand';
import { makeHandInput } from '../../ui/hand/handMotion';
import type { HeldItemId } from '../../engine/settingsTypes';

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
}

/**
 * Dev-Seite für den Viewmodel-Look (Plan 006): rendert beliebige Frames in eine Kachel-
 * Übersicht (Kontaktblatt), gesteuert über window.__vm (tools/viewmodel-shots.mjs).
 * Ein WebGL-Kontext für alles; jede Kachel wird direkt nach dem Rendern kopiert.
 */

interface CellSpec {
  readonly label?: string;
  readonly pose?: HandPose;
  readonly glove?: ViewModelGlove;
  readonly item?: ViewModelItem;
  /** Frame-Felder überschreiben (x, y, z, pitch, yaw, roll, squash, canTab, …). */
  readonly frame?: Partial<Record<string, number | boolean>>;
  readonly joints?: readonly number[];
  /** Nur Daumen [abd, opp, mcp?, ip?] (rad) überschreiben. */
  readonly thumb?: readonly number[];
  readonly propPos?: readonly number[];
  readonly propRot?: readonly number[];
  readonly bg?: readonly [string, string, string, string, number];
  readonly time?: number;
  /** Arm-Grundhaltung [pitch, twist, roll] (rad). */
  readonly arm?: readonly [number, number, number];
  readonly live?: LiveSpec;
}

interface SheetOptions {
  readonly w: number;
  readonly h: number;
  readonly zoom: number;
  readonly depth?: number;
}

const sheet = document.getElementById('sheet') as HTMLDivElement;
let preview: ViewModelPreview | null = null;
let size = { w: 0, h: 0 };

const NUM_KEYS = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'squash', 'propSpin', 'propVisible', 'propScale', 'canTab', 'knifeBlade', 'knifeBite', 'poof'] as const;

function liveFrame(l: LiveSpec, glove: ViewModelGlove): ViewModelFrame {
  const h = new ViewHand();
  h.setAspect(l.aspect ?? 16 / 9);
  h.setGlove(glove === 'neon' ? 'neon' : 'classic');
  h.setItem(l.item);
  h.can.opened = l.opened ?? false;
  h.knife.isOpen = l.knifeOpen ?? false;
  h.card.flipped = l.flipped ?? false;
  // Crack/Idle nicht ungefragt auslösen: Tricks nur, wenn gewünscht.
  if (!l.trick) h.motionFx = 1;
  if (l.pose) h.force = POSE[l.pose];
  const inp = makeHandInput();
  inp.speed = l.speed ?? 0;
  inp.onGround = true;
  if (l.trick) h.forceTrick(l.trick, l.at ?? 0);
  // 1 s einschwingen (Posen-Überblendung, Federn), Trick bleibt bei `at` stehen.
  for (let i = 0; i < 60; i++) {
    if (!l.trick && l.item === 'can') h.can.debugPlay('none');
    h.update(1 / 60, inp);
    if (l.trick) h.forceTrick(l.trick, l.at ?? 0);
  }
  h.update(1 / 60, inp);
  const f = h.output(true);
  return f;
}

function frameFor(c: CellSpec): ViewModelFrame {
  if (c.live) return liveFrame(c.live, c.glove ?? 'classic');
  const f = createViewModelFrame();
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
  for (const k of NUM_KEYS) {
    const v = c.frame?.[k];
    if (typeof v === 'number') f[k] = v;
  }
  if (typeof c.frame?.canOpen === 'boolean') f.canOpen = c.frame.canOpen;
  return f;
}

function render(cells: readonly CellSpec[], o: SheetOptions): number {
  sheet.textContent = '';
  if (!preview || size.w !== o.w || size.h !== o.h) {
    preview?.dispose();
    const cv = document.createElement('canvas');
    preview = new ViewModelPreview(cv, o.w, o.h);
    size = { w: o.w, h: o.h };
  }
  const p = preview;
  p.vm.depth = o.depth ?? 30;
  for (const c of cells) {
    if (c.bg) p.setBackground(c.bg[0], c.bg[1], c.bg[2], c.bg[3], c.bg[4]);
    else p.setBackground('#141030', '#3a2458', '#1a2340', '#33f0ff', 0.28);
    if (c.arm) p.vm.setArmBase(c.arm[0], c.arm[1], c.arm[2]);
    const f = frameFor(c);
    p.prewarm(f.item, f.glove);
    p.render(f, c.time ?? 1);
    const out = document.createElement('canvas');
    out.width = o.w * o.zoom;
    out.height = o.h * o.zoom;
    const ctx = out.getContext('2d');
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(p.canvas, 0, 0, out.width, out.height);
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

declare global {
  interface Window {
    __vm?: { render: typeof render; poses: readonly string[] };
  }
}
window.__vm = { render, poses: HAND_POSES };
