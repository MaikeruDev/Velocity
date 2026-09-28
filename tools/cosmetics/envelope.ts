/**
 * Abnahme-Werkzeug (Plan 007): Bild-Hülle der Tricks. Projiziert die sichtbaren Meshes des
 * gehaltenen Gegenstands durch das ECHTE ViewModel (Node, ohne WebGL) über jede Trick-Zeitleiste
 * (60 Hz, echte ViewHand) und misst, wie weit sie nach oben/links Richtung Bildmitte kommen.
 * Die abgenommenen Tricks (Dose/Karte/Messer, look.md "nie im Blickzentrum") definieren die
 * erlaubte Hülle (höchster Punkt −0.314, linkester 0.055 Bildhöhen); neue Gegenstände werden
 * dagegen geprüft, ebenso die Surf-Zustände der alten (KI8: 1.5 s Surf, dann Ende). Einheiten: Bildhöhen ab Bildmitte, x rechts, y unten (16:9, Anker wie im Spiel).
 *   npx tsx tools/cosmetics/envelope.ts        → shots/v2/kosmetik/envelope-core.json
 * Exit 1, wenn ein neuer Trick die Hülle verlässt. (Ursprung: tools/critique/v2/kosmetik/envelope.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Mesh, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ViewModel } from '../../src/render/viewmodel/ViewModel';
import { PROP_FACTORIES, ViewHand } from '../../src/ui/hand/ViewHand';
import { makeHandInput } from '../../src/ui/hand/handMotion';
import type { HeldItemId } from '../../src/engine/settingsTypes';

const vm = new ViewModel();
vm.setResolution(480, 270);
vm.camera.updateMatrixWorld(true);

interface Env {
  minX: number;
  minY: number;
  maxY: number;
  frames: number;
}

const box = new Box3();
const corner = new Vector3();

function addObject(e: Env, root: Object3D): void {
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          corner.set(x, y, z).project(vm.camera);
          const px = (corner.x * vm.camera.aspect) / 2;
          const py = -corner.y / 2;
          e.minX = Math.min(e.minX, px);
          e.minY = Math.min(e.minY, py);
          e.maxY = Math.max(e.maxY, py);
        }
      }
    }
  });
}

const APPROVED: readonly HeldItemId[] = ['can', 'card', 'knife'];
const items = (Object.keys(PROP_FACTORIES) as HeldItemId[]).filter((i) => PROP_FACTORIES[i] !== undefined);

/** Zustands-Trick (Surf-Zustand, KI8 & Co.)? Die abgenommene Hülle bilden nur die Plan-006-Tricks. */
function isStateTrick(item: HeldItemId, trick: string): boolean {
  const make = PROP_FACTORIES[item];
  if (!make) return false;
  const p = make();
  p.debugPlayName(trick, -1);
  return p.inState;
}

function measure(item: HeldItemId, trick: string): Env {
  const hand = new ViewHand();
  hand.setAspect(16 / 9);
  hand.setItem(item);
  if (item === 'can') hand.can.opened = trick === 'sip';
  const inp = makeHandInput();
  // Einschwingen in die Haltepose, dann Trick frei laufen lassen (60 Hz). Zustands-Tricks (Surf)
  // bekommen 1.5 s Surf, danach endet der Zustand von selbst.
  for (let i = 0; i < 60; i++) {
    if (item === 'can') hand.can.debugPlay('none');
    hand.update(1 / 60, inp);
  }
  hand.forceTrick(trick);
  const state = isStateTrick(item, trick);
  const e: Env = { minX: Infinity, minY: Infinity, maxY: -Infinity, frames: 0 };
  for (let i = 0; i < 60 * 4; i++) {
    const surf = state && i < 90;
    inp.surfing = surf;
    inp.onGround = !surf;
    inp.speed = surf ? 800 : 0;
    hand.update(1 / 60, inp);
    vm.apply(hand.output(true));
    addObject(e, vm.itemSocket);
    const sub = vm.subSocketGroup;
    if (sub) addObject(e, sub);
    e.frames++;
    if (hand.state().trick === 'none' && i > 5) break;
  }
  return e;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const result: Record<string, Record<string, unknown>> = {};
const hull = { up: Infinity, left: Infinity };
for (const item of APPROVED) {
  const res: Record<string, unknown> = {};
  const h = new ViewHand();
  h.setItem(item);
  for (const trick of h.state().tricks) {
    if (item === 'can' && trick === 'crack') continue;
    // Surf-Zustände (KI8) sind neu: sie werden unten gegen die Hülle geprüft, bilden sie nicht.
    if (isStateTrick(item, trick)) continue;
    const e = measure(item, trick);
    res[trick] = { up: r3(e.minY), left: r3(e.minX) };
    hull.up = Math.min(hull.up, e.minY);
    hull.left = Math.min(hull.left, e.minX);
  }
  result[item] = res;
}
result.approvedEnvelope = { up: r3(hull.up), left: r3(hull.left), note: 'höchster/linkester Punkt aller abgenommenen Tricks' };
let outside = 0;
for (const item of items) {
  const res: Record<string, unknown> = APPROVED.includes(item) ? (result[item] as Record<string, unknown>) : {};
  const h = new ViewHand();
  h.setItem(item);
  for (const trick of h.state().tricks) {
    if (APPROVED.includes(item) && !isStateTrick(item, trick)) continue;
    const e = measure(item, trick);
    const inside = e.minY >= hull.up - 0.005 && e.minX >= hull.left - 0.005;
    if (!inside) outside++;
    res[trick] = { up: r3(e.minY), left: r3(e.minX), down: r3(e.maxY), inside, seconds: r3(e.frames / 60) };
  }
  result[item] = res;
}
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/envelope-core.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (outside > 0) {
  console.error(`${outside} Tricks außerhalb der abgenommenen Hülle`);
  process.exit(1);
}
