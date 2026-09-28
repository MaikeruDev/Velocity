/**
 * PROTOTYP-Messung (Kosmetik v2): Bild-Hülle der Tricks. Projiziert die sichtbaren Meshes der
 * Gegenstände durch die ECHTE ViewModel-Hierarchie (Node, ohne WebGL) über jede Trick-Zeitleiste
 * und misst, wie weit sie nach oben/links (Richtung Bildmitte) kommen. Die abgenommenen Tricks
 * (Dose/Karte/Messer, look.md "nie im Blickzentrum") definieren die erlaubte Hülle; der Jo-Jo-
 * Prototyp wird dagegen geprüft.
 *   npx tsx tools/critique/v2/kosmetik/envelope.ts
 * Ausgabe: shots/v2/kosmetik/envelope.json. Einheiten: Bildhöhen ab Bildmitte, x rechts, y unten
 * (16:9, Hand-Anker wie im Spiel). Bildrand rechts = 0.889, unten = 0.5.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Mesh, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ViewModel } from '../../../../src/render/viewmodel/ViewModel';
import { ViewHand } from '../../../../src/ui/hand/ViewHand';
import { makeHandInput } from '../../../../src/ui/hand/handMotion';
import { POSE, POSE_JOINTS } from '../../../../src/ui/hand/poses';
import type { HeldItemId } from '../../../../src/engine/settingsTypes';
import { createViewModelFrame } from '../../../../src/render/types';
import { findRig, inWrist } from './rig';
import { YoyoTricks } from './yoyoTricks';
import type { YoyoTrick } from './yoyoTricks';

const vm = new ViewModel();
vm.setResolution(480, 270);
vm.camera.updateMatrixWorld(true);
const rig = findRig(vm);

interface Env {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Anteil der Frames mit Pixeln im Bild (Rest aus dem Bild gefallen). */
  offscreen: number;
  frames: number;
}

const newEnv = (): Env => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, offscreen: 0, frames: 0 });
const box = new Box3();
const corners = Array.from({ length: 8 }, () => new Vector3());

function project(p: Vector3): [number, number] {
  const v = p.clone().project(vm.camera);
  return [(v.x * vm.camera.aspect) / 2, -v.y / 2];
}

function addPoint(e: Env, x: number, y: number): void {
  e.minX = Math.min(e.minX, x);
  e.minY = Math.min(e.minY, y);
  e.maxX = Math.max(e.maxX, x);
  e.maxY = Math.max(e.maxY, y);
}

function addObject(e: Env, root: Object3D): void {
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible) return;
    let vis = true;
    for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) vis = false;
    if (!vis) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    let i = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners[i++].set(x, y, z);
    for (const c of corners) {
      const [px, py] = project(c);
      addPoint(e, px, py);
    }
  });
}

const HALF_W = 16 / 9 / 2;

function inScreen(e: Env): boolean {
  return e.minX < HALF_W && e.minY < 0.5;
}

// ---------------------------------------------------------------- abgenommene Gegenstände
const TRICKS: Record<string, readonly string[]> = {
  can: ['tilt', 'sip', 'flip', 'highFlip', 'twirl', 'doubleFlip', 'behindThrow'],
  card: ['spin', 'turn', 'tossSpin', 'vanish'],
  knife: ['open', 'close', 'rollover', 'aerial', 'doubleAerial'],
};

const result: Record<string, Record<string, unknown>> = {};
const approved = newEnv();
for (const [item, tricks] of Object.entries(TRICKS)) {
  const res: Record<string, unknown> = {};
  for (const trick of tricks) {
    const hand = new ViewHand();
    hand.setAspect(16 / 9);
    hand.setItem(item as HeldItemId);
    hand.can.opened = trick === 'sip';
    const inp = makeHandInput();
    // Einschwingen in die Haltepose, dann Trick frei laufen lassen (60 Hz).
    for (let i = 0; i < 60; i++) {
      if (item === 'can') hand.can.debugPlay('none');
      hand.update(1 / 60, inp);
    }
    hand.forceTrick(trick);
    const e = newEnv();
    for (let i = 0; i < 60 * 3; i++) {
      hand.update(1 / 60, inp);
      const f = hand.output(true);
      vm.apply(f);
      const before = { ...e };
      addObject(e, rig.socket);
      e.frames++;
      if (!(e.minX < before.minX || e.minY < before.minY) && !inScreen(e)) e.offscreen++;
      if (hand.state().trick === 'none' && i > 5) break;
    }
    res[trick] = { up: +e.minY.toFixed(3), left: +e.minX.toFixed(3) };
    approved.minX = Math.min(approved.minX, e.minX);
    approved.minY = Math.min(approved.minY, e.minY);
  }
  result[item] = res;
}
result.approvedEnvelope = { up: +approved.minY.toFixed(3), left: +approved.minX.toFixed(3), note: 'höchster/linkester Punkt aller abgenommenen Tricks' };

// ---------------------------------------------------------------- Jo-Jo-Prototyp
// Haltepose "run" (lockere Faust), Anker = Mitte des Mittelglieds des Mittelfingers, Handfläche per FK.
const f = createViewModelFrame();
f.visible = true;
f.x = HALF_W - 0.3;
f.y = 0.5 - 0.17;
f.joints.set(POSE_JOINTS[POSE.run]);
vm.apply(f);
vm.scene.updateMatrixWorld(true);
const mid = rig.fingers[1];
const anchor = inWrist(rig, mid[1], new Vector3(0, 1.2, 0));
const tipI = inWrist(rig, rig.fingers[0][2], new Vector3(0, 1.9, 0));
const tipM = inWrist(rig, mid[2], new Vector3(0, 2.0, 0));
const palmIn = new Vector3(0, 6.5, -2.4);
const hold = palmIn.clone().add(tipI).add(tipM).multiplyScalar(1 / 3);
const yoyo = new YoyoTricks([anchor.x, anchor.y, anchor.z], [hold.x, hold.y, hold.z]);
const yoyoRes: Record<string, unknown> = { anchorWrist: anchor.toArray().map((v) => +v.toFixed(2)), holdWrist: hold.toArray().map((v) => +v.toFixed(2)) };
const R_YOYO = 2.6;
const tricksY: readonly YoyoTrick[] = ['sleeper', 'pass', 'snap', 'breakaway', 'around', 'aroundDouble', 'cradle'];
const yoyoEnv = newEnv();
for (const trick of tricksY) {
  yoyo.reset();
  yoyo.debugPlay(trick);
  const e = newEnv();
  let lowest = -Infinity;
  const wm = rig.wrist.matrixWorld;
  for (let i = 0; i < 60 * 4; i++) {
    yoyo.update(1 / 60, { speed: 0, onGround: true, surfing: false });
    const c = new Vector3(yoyo.sub[0], yoyo.sub[1], yoyo.sub[2]).applyMatrix4(wm);
    // Kugel r = R_YOYO: Mitte ± Radius in Kamera-Ebene (x, y).
    for (const [dx, dy] of [
      [R_YOYO, 0],
      [-R_YOYO, 0],
      [0, R_YOYO],
      [0, -R_YOYO],
    ]) {
      const [px, py] = project(c.clone().add(new Vector3(dx, dy, 0)));
      addPoint(e, px, py);
      lowest = Math.max(lowest, py);
    }
    if (yoyo.stringOn) {
      for (let k = 0; k < yoyo.rope.n; k++) {
        const p = new Vector3(yoyo.rope.out[k * 3], yoyo.rope.out[k * 3 + 1], yoyo.rope.out[k * 3 + 2]).applyMatrix4(wm);
        const [px, py] = project(p);
        addPoint(e, px, py);
      }
    }
    e.frames++;
    if (yoyo.trick === 'none' && i > 5) break;
  }
  const inside = e.minY >= approved.minY - 0.005 && e.minX >= approved.minX - 0.005;
  yoyoRes[trick] = { up: +e.minY.toFixed(3), left: +e.minX.toFixed(3), down: +lowest.toFixed(3), insideApproved: inside, duration: +(e.frames / 60).toFixed(2) };
  yoyoEnv.minX = Math.min(yoyoEnv.minX, e.minX);
  yoyoEnv.minY = Math.min(yoyoEnv.minY, e.minY);
}
result.yoyoPrototype = yoyoRes;

mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/envelope.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
