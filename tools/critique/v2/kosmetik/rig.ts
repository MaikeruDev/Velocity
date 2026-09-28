/**
 * PROTOTYP-Hilfe (Kosmetik v2): findet die Rig-Gruppen der echten ViewModel-Szene über ihre
 * Struktur (die Felder sind privat). Läuft in Node (three ohne WebGL) und im Browser.
 * Entwurf: VM_RIG in render/types + ui/hand/fk.ts ersetzen das — hier nur zum Messen.
 */
import { Group, Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ViewModel } from '../../../../src/render/viewmodel/ViewModel';

export interface Rig {
  readonly arm: Group;
  readonly wrist: Group;
  /** [Finger][0 Grundglied, 1 Mittelglied, 2 Endglied] */
  readonly fingers: readonly (readonly [Group, Group, Group])[];
  readonly thumb: readonly [Group, Group, Group];
  readonly socket: Group;
  readonly spinner: Group;
}

function groups(o: Object3D): Group[] {
  return o.children.filter((c): c is Group => c instanceof Group);
}

export function findRig(vm: ViewModel): Rig {
  const anchor = groups(vm.scene)[0];
  const motion = groups(anchor)[0];
  const arm = groups(motion)[0];
  const wrist = groups(arm)[0];
  const wg = groups(wrist);
  // Reihenfolge in ViewModel.buildHand/Konstruktor: 4 Finger, Daumen, Sockel.
  const fingers = wg.slice(0, 4).map((root): [Group, Group, Group] => {
    const pip = groups(root)[0];
    const dip = groups(pip)[0];
    return [root, pip, dip];
  });
  const tr = wg[4];
  const tm = groups(tr)[0];
  const ti = groups(tm)[0];
  const socket = wg[5];
  const spinner = groups(socket)[0];
  return { arm, wrist, fingers, thumb: [tr, tm, ti], socket, spinner };
}

const inv = new Matrix4();

/** Punkt (lokal in `g`) im Handgelenk-Raum. */
export function inWrist(rig: Rig, g: Object3D, local: Vector3): Vector3 {
  rig.wrist.updateWorldMatrix(true, true);
  const w = g.localToWorld(local.clone());
  inv.copy(rig.wrist.matrixWorld).invert();
  return w.applyMatrix4(inv);
}
