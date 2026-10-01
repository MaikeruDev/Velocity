/**
 * Griff-Posen backen (Plan 008): Finger-Kontakt (ui/hand/fingerContact) schließt Finger und Daumen von einer
 * Start-Pose Richtung "zu" um den Gegenstand in seiner Ruhe-Lage (writeRest des Tricks), bis sie ihn
 * berühren. Ausgabe: Pose-Zeile in Grad (für poses.ts DEFS) und die Kontakt-Messung vorher/nachher gegen
 * das echte Mesh (tools/lib/handContact).
 *   npx tsx tools/hand-grips.ts <item> [--from pose] [--to pose] [--mask 31] [--squeeze -0.15] [--knifeOpen]
 */
import { VM_JOINT, VM_JOINT_COUNT } from '../src/render/types';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import type { HandPose } from '../src/ui/hand/poses';
import { GripSolver } from '../src/ui/hand/fingerContact';
import { propShapeFor } from '../src/ui/hand/propShapes';
import { socketMatrix } from '../src/ui/hand/propShape';
import { VIEW_AXES, mat3 } from '../src/ui/hand/rot';
import { HAND_PART_NAMES } from '../src/ui/hand/handShape';
import { itemPoints, measure } from './lib/handContact';
import { handFrame } from './lib/handLive';
import type { HeldItemId } from '../src/engine/settingsTypes';
import type { ViewModelFrame } from '../src/render/types';
import { knifeLinks } from '../src/ui/hand/knifeRig';

const args = process.argv.slice(2);
const item = args[0] as HeldItemId;
const opt = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const from = opt('--from', '');
const to = opt('--to', 'fist') as HandPose;
const openPose = opt('--open', 'open') as HandPose;
const mask = Number(opt('--mask', '31'));
const squeeze = Number(opt('--squeeze', '-0.15'));

const f = handFrame({ item, knifeOpen: args.includes('--knifeOpen'), opened: true });
if (from) f.joints.set(POSE_JOINTS[POSE[from as HandPose]]);
// Erkunden: Lage überschreiben (--pos x,y,z als Versatz, --rot x,y,z als zusätzliche Euler-Drehung vorn).
const dpos = opt('--pos', '');
if (dpos) dpos.split(',').map(Number).forEach((v, k) => (f.propPos[k] += v));
const dview = opt('--view', '');
if (dview) {
  const [r, u, c] = dview.split(',').map(Number);
  for (let k = 0; k < 3; k++) f.propPos[k] += VIEW_AXES.right[k] * r + VIEW_AXES.up[k] * u + VIEW_AXES.cam[k] * c;
}
report('vorher', f);

const shape = propShapeFor(item);
if (!shape) throw new Error(`kein PropShape für ${item}`);
setLinks(f);
const solver = new GripSolver();
const j = new Float32Array(f.joints);
const wg = opt('--wgap', '0.6,1,1').split(',').map(Number) as [number, number, number];
const touched = args.includes('--close') ? solver.close(j, POSE_JOINTS[POSE[openPose]], POSE_JOINTS[POSE[to]], shape, mask, squeeze) : solver.fit(j, POSE_JOINTS[POSE[openPose]], POSE_JOINTS[POSE[to]], shape, mask, squeeze, wg);
f.joints.set(j);
console.log(`Kontakt-Maske ${touched.toString(2)} (Daumen|klein|Ring|Mittel|Zeige), curl ${Array.from(solver.curl).map((c) => c.toFixed(2)).join(' ')}, gap ${Array.from(solver.gap).map((c) => c.toFixed(2)).join(' ')}`);
report('nachher', f);
console.log(poseLine(j));

function setLinks(fr: ViewModelFrame): void {
  const R = mat3();
  const tmp = mat3();
  socketMatrix(fr.propRot, fr.propSpin, R, tmp);
  shape!.setLink(0, R, fr.propPos[0], fr.propPos[1], fr.propPos[2], fr.propScale);
  if (item === 'knife') knifeLinks(shape!, R, fr.propPos, fr.propScale, fr.knifeBlade, fr.knifeBite);
  else {
    socketMatrix(fr.subRot, fr.subSpin, R, tmp);
    shape!.setLink(1, R, fr.subPos[0], fr.subPos[1], fr.subPos[2], 1);
    shape!.linkOn[1] = fr.subVisible > 0.001 ? 1 : 0;
  }
}

function report(tag: string, fr: ViewModelFrame): void {
  const r = measure(fr, itemPoints(fr));
  const parts = Array.from(r.perPart)
    .map((d, i) => [HAND_PART_NAMES[i], d] as const)
    .filter(([, d]) => d < 0.6)
    .map(([n, d]) => `${n} ${d.toFixed(2)}`);
  console.log(`${tag}: gap ${r.gap.toFixed(2)} | ${parts.join(', ')}`);
}

function poseLine(a: Float32Array): string {
  const D = 180 / Math.PI;
  const r = (x: number): number => Math.round(x * D);
  const J = VM_JOINT;
  const fg = [0, 1, 2, 3].map((k) => `[${[0, 1, 2, 3].map((i) => r(a[J.finger + k * 4 + i])).join(', ')}]`).join(', ');
  void VM_JOINT_COUNT;
  return `{ wrist: [${r(a[J.wristFlex])}, ${r(a[J.wristDev])}, ${r(a[J.wristTwist])}], thumb: [${r(a[J.thumbAbd])}, ${r(a[J.thumbOpp])}, ${r(a[J.thumbMcp])}, ${r(a[J.thumbIp])}], fingers: [${fg}] }`;
}
