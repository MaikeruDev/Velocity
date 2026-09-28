import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ViewModel } from '../src/render/viewmodel/ViewModel';
import { VM_JOINT_COUNT, VM_RIG, createViewModelFrame } from '../src/render/types';
import { fingerPoint, fingerTip, thumbPoint } from '../src/ui/hand/fk';
import { HAND_POSES, POSE_JOINTS } from '../src/ui/hand/poses';

/**
 * Vorwärtskinematik der UI (Plan 007, K1): ui/hand/fk.ts rechnet aus VM_RIG und Gelenkwinkeln
 * dieselben Punkte im Handgelenk-Raum wie die three-Hierarchie des echten ViewModel (Node, ohne
 * WebGL). Abnahme: ±1e-6.
 */

const vm = new ViewModel();
const f = createViewModelFrame();
f.visible = true;

/** Punkt (lokal im Glied) → Handgelenk-Raum über three (Weltmatrix, dann ins Handgelenk zurück). */
function viaThree(group: import('three').Object3D, lx: number, ly: number, lz: number): Vector3 {
  vm.scene.updateMatrixWorld(true);
  const w = group.localToWorld(new Vector3(lx, ly, lz));
  return vm.rig.wrist.worldToLocal(w);
}

function check(joints: Float32Array): number {
  f.joints.set(joints);
  vm.apply(f);
  const out = new Float64Array(3);
  let worst = 0;
  const pts: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [0.4, 1.3, -0.7],
    [-1.1, 2.2, 1.5],
  ];
  for (let fi = 0; fi < 4; fi++) {
    for (let seg = 0; seg < 3; seg++) {
      for (const [x, y, z] of pts) {
        const ref = viaThree(vm.rig.fingers[fi][seg], x, y, z);
        fingerPoint(f.joints, fi, seg, x, y, z, out);
        worst = Math.max(worst, Math.abs(out[0] - ref.x), Math.abs(out[1] - ref.y), Math.abs(out[2] - ref.z));
      }
    }
  }
  for (let seg = 0; seg < 3; seg++) {
    for (const [x, y, z] of pts) {
      const ref = viaThree(vm.rig.thumb[seg], x, y, z);
      thumbPoint(f.joints, seg, x, y, z, out);
      worst = Math.max(worst, Math.abs(out[0] - ref.x), Math.abs(out[1] - ref.y), Math.abs(out[2] - ref.z));
    }
  }
  return worst;
}

describe('UI-FK = three-Weltposition (Plan 007 K1)', () => {
  it('alle 11 Posen: Finger- und Daumenglieder ±1e-6', () => {
    for (let p = 0; p < HAND_POSES.length; p++) expect(check(POSE_JOINTS[p]), HAND_POSES[p]).toBeLessThan(1e-6);
  });

  it('200 zufällige Gelenkwinkel (auch jenseits der Posen) ±1e-6', () => {
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const j = new Float32Array(VM_JOINT_COUNT);
    for (let k = 0; k < 200; k++) {
      for (let i = 0; i < VM_JOINT_COUNT; i++) j[i] = (rnd() - 0.5) * 3;
      expect(check(j), `Satz ${k}`).toBeLessThan(1e-6);
    }
  });

  it('Fingerspitze liegt vor dem Endglied (Kuppe) und wandert mit der Beugung zur Handfläche', () => {
    const tip = new Float64Array(3);
    fingerTip(POSE_JOINTS[HAND_POSES.indexOf('open')], 0, tip);
    const f0 = VM_RIG.fingers[0];
    // Gestreckt: fast die ganze Fingerlänge über der Wurzel (+y).
    expect(tip[1] - f0.y).toBeGreaterThan(f0.len[0] + f0.len[1] + f0.len[2]);
    const fist = new Float64Array(3);
    fingerTip(POSE_JOINTS[HAND_POSES.indexOf('fist')], 0, fist);
    // Faust: Spitze eingerollt — deutlich näher an der Wurzel als gestreckt.
    expect(fist[1]).toBeLessThan(tip[1] - 4);
  });
});
