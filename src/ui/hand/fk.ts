import { VM_JOINT, VM_RIG } from '../../render/types';

/**
 * Vorwärtskinematik der View-Hand in der UI (Plan 007): Punkt in einem Finger-/Daumenglied →
 * Handgelenk-Raum, aus VM_RIG und den Gelenkwinkeln — dieselbe Konvention wie ViewModel.apply
 * (siehe VM_RIG-Kommentar in render/types). Genutzt für Schnur-Anker, Knöchel und Fingerspitzen
 * (Spinner auf der Fingerspitze, Jo-Jo-Schlaufe). DOM-/three-frei, keine Allokation;
 * tests/fk.test.ts vergleicht mit den three-Weltpositionen des echten ViewModel (±1e-6).
 *
 * Rotationen: Glied-Wurzel Euler 'ZXY' (three: R = Rz·Rx·Ry), Mittel-/Endglied nur um x.
 * Kind mit Position P und Drehung R: x_eltern = P + R·x_kind.
 */

/** Ausgabe-Puffer: xyz im Handgelenk-Raum. */
export type Vec3Out = Float32Array | Float64Array | [number, number, number];

/**
 * Arbeits-Punkt (x, y, z) für thumbPoint (nur Ladezeit). Typed Array statt Modul-`let`: jede Zuweisung einer
 * Kommazahl an eine Modul-Variable legt in V8 eine neue HeapNumber an (alloc-probe mit Jo-Jo: 16 KiB/s).
 */
const P = new Float64Array(3);

/** P ← Rx(a)·P */
function rotX(a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const y = P[1] * c - P[2] * s;
  const z = P[1] * s + P[2] * c;
  P[1] = y;
  P[2] = z;
}

function rotY(a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = P[0] * c + P[2] * s;
  const z = -P[0] * s + P[2] * c;
  P[0] = x;
  P[2] = z;
}

function rotZ(a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = P[0] * c - P[1] * s;
  const y = P[0] * s + P[1] * c;
  P[0] = x;
  P[1] = y;
}

/**
 * Punkt (lx, ly, lz) im Glied `seg` (0 Grund-, 1 Mittel-, 2 Endglied) des Fingers `finger`
 * (0 Zeige- … 3 kleiner Finger) → Handgelenk-Raum in `out`.
 */
export function fingerPoint(joints: ArrayLike<number>, finger: number, seg: number, lx: number, ly: number, lz: number, out: Vec3Out): Vec3Out {
  const f = VM_RIG.fingers[finger];
  const b = VM_JOINT.finger + finger * 4;
  // Verzweigungsfrei (nicht benutzte Glieder = Drehung 0, Länge 0) und in lokalen Variablen: ein `if (seg …)`
  // um die Rechnung ließ TurboFan die Koordinaten am Zusammenfluss als HeapNumber boxen (3 je Aufruf,
  // alloc-probe Jo-Jo 8–16 KiB/s; Node-Probe: 469 → 1 Scavenge je 5·10⁶ Aufrufpaare).
  // Auswahl als Faktor 0/1 (ganzzahlig) statt `seg >= 2 ? Winkel : 0`: auch dieser Zusammenfluss aus
  // Kommazahl und Konstante wurde in Chrome geboxt.
  const g2 = seg >= 2 ? 1 : 0;
  const g1 = seg >= 1 ? 1 : 0;
  const a3 = -joints[b + 3] * g2;
  const l1 = f.len[1] * g2;
  const a2 = -joints[b + 2] * g1;
  const l0 = f.len[0] * g1;
  let c = Math.cos(a3);
  let s = Math.sin(a3);
  let y = ly * c - lz * s + l1;
  let z = ly * s + lz * c;
  c = Math.cos(a2);
  s = Math.sin(a2);
  let t = y * c - z * s + l0;
  z = y * s + z * c;
  y = t;
  // Wurzel: Euler ZXY (x = −Grundgelenk, y = 0, z = Spreizen + Ruhe-Spreizung).
  c = Math.cos(-joints[b + 1]);
  s = Math.sin(-joints[b + 1]);
  t = y * c - z * s;
  z = y * s + z * c;
  y = t;
  c = Math.cos(joints[b] + f.splay);
  s = Math.sin(joints[b] + f.splay);
  const x = lx * c - y * s;
  y = lx * s + y * c;
  out[0] = f.x + x;
  out[1] = f.y + y;
  out[2] = f.z + z;
  return out;
}

/** Punkt im Daumenglied `seg` (0 Sattel/Grund-, 1 Mittel-, 2 Endglied) → Handgelenk-Raum. */
export function thumbPoint(joints: ArrayLike<number>, seg: number, lx: number, ly: number, lz: number, out: Vec3Out): Vec3Out {
  const t = VM_RIG.thumb;
  P[0] = lx;
  P[1] = ly;
  P[2] = lz;
  if (seg >= 2) {
    rotX(-joints[VM_JOINT.thumbIp]);
    P[1] += t.len[1];
  }
  if (seg >= 1) {
    rotX(-joints[VM_JOINT.thumbMcp]);
    P[1] += t.len[0];
  }
  // Wurzel: Euler ZXY (x = baseX − Opposition, y = baseY, z = baseZ + Abspreizen) → Rz·Rx·Ry.
  rotY(t.baseY);
  rotX(t.baseX - joints[VM_JOINT.thumbOpp]);
  rotZ(t.baseZ + joints[VM_JOINT.thumbAbd]);
  out[0] = t.x + P[0];
  out[1] = t.y + P[1];
  out[2] = t.z + P[2];
  return out;
}

/** Fingerspitze (Kuppe des Endglieds, etwas über das Glied hinaus) im Handgelenk-Raum. */
export function fingerTip(joints: ArrayLike<number>, finger: number, out: Vec3Out, beyond = 0.9): Vec3Out {
  const f = VM_RIG.fingers[finger];
  return fingerPoint(joints, finger, 2, 0, f.len[2] + f.r * beyond, 0, out);
}
