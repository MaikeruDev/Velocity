import type { HeldItemId } from '../../engine/settingsTypes';
import { Prim, PropShape } from './propShape';
import type { PrimDef } from './propShape';
import { VM_KNIFE } from '../../render/types';

/**
 * Kontakt-Körper je Gegenstand (Plan 008) — Maße aus render/viewmodel/items/* (dort die Geometrie; Werte
 * hier gleich halten, tests/handFoundation prüft gegen das echte Mesh). Glied 0 = Sockel, 1 = zweiter Körper
 * (Jo-Jo, Kendama-Kugel) bzw. beim Messer 1 = Klinge, 2 = zweiter Griff (Bite Handle).
 */

const H = Math.PI / 2;
const K = VM_KNIFE;
/** Mitte des Griffs im Griff-Raum (Stift im Ursprung, Griff nach −y) und der Klinge im Klingen-Raum. */
const HANDLE_MID = K.pinInset - K.handleLen / 2;
const BLADE_MID = K.bladeFrom + K.bladeLen / 2;

export const PROP_PRIMS: { readonly [I in HeldItemId]?: readonly PrimDef[] } = {
  card: [{ kind: Prim.Box, at: [0, 0, 0], size: [3.2, 4.4, 0.06] }],
  can: [
    { kind: Prim.Cylinder, at: [0, 0, 0], size: [3.55, 6.75] },
    { kind: Prim.Cylinder, at: [0, 0, 0], size: [3.0, 7.8] },
  ],
  knife: [
    // Safe Handle (am Sockel), Klinge (Glied 1), Bite Handle (Glied 2) — siehe knifeRig.
    { kind: Prim.Box, link: 0, at: [0, HANDLE_MID, 0], size: [K.handleW / 2, K.handleLen / 2, K.handleD / 2] },
    { kind: Prim.Box, link: 1, at: [K.pinGap / 2, BLADE_MID, 0], size: [K.bladeW / 2, K.bladeLen / 2, K.bladeD / 2] },
    { kind: Prim.Box, link: 2, at: [0, HANDLE_MID, 0], size: [K.handleW / 2, K.handleLen / 2, K.handleD / 2] },
  ],
  yoyo: [{ kind: Prim.Cylinder, link: 1, at: [0, 0, 0], size: [2.6, 1.15] }],
  spinner: [
    { kind: Prim.Cylinder, at: [0, 0, 0], size: [1.0, 1.0], rot: [H, 0, 0] },
    { kind: Prim.Cylinder, at: [0, 0, 0], size: [3.4, 0.5], rot: [H, 0, 0] },
  ],
  coin: [{ kind: Prim.Cylinder, at: [0, 0, 0], size: [2.1, 0.21], rot: [H, 0, 0] }],
  lighter: [
    { kind: Prim.Box, at: [0, -1.3, 0], size: [1.85, 1.75, 0.78] },
    { kind: Prim.Box, at: [0, 1.32, 0], size: [1.85, 0.93, 0.78] },
  ],
  kendama: [
    { kind: Prim.Capsule, at: [0, -1.5, 0], size: [0.85, 2.5] },
    { kind: Prim.Cylinder, at: [0, -4.45, 0], size: [1.6, 0.45] },
    { kind: Prim.Capsule, at: [0, 0.3, 0], size: [0.95, 2.2], rot: [0, 0, H] },
    { kind: Prim.Cylinder, at: [2.8, 0.3, 0], size: [1.8, 0.55], rot: [0, 0, H] },
    { kind: Prim.Cylinder, at: [-2.55, 0.3, 0], size: [1.4, 0.45], rot: [0, 0, H] },
    { kind: Prim.Capsule, at: [0, 2.2, 0], size: [0.55, 1.2] },
    { kind: Prim.Sphere, link: 1, at: [0, 0, 0], size: [1.9] },
  ],
  phone: [{ kind: Prim.Box, at: [0, 0, 0], size: [2.3, 4.3, 0.3] }],
};

/** Neuer Kontakt-Körper für einen Gegenstand (null ohne Definition). */
export function propShapeFor(item: HeldItemId): PropShape | null {
  const d = PROP_PRIMS[item];
  return d ? new PropShape(d) : null;
}
