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

/**
 * Punkt im Daumenglied `seg` (0 Sattel/Grund-, 1 Mittel-, 2 Endglied) → Handgelenk-Raum. Wie fingerPoint
 * verzweigungsfrei in lokalen Variablen: die Hilfsdrehungen rotX/Y/Z mit Kommazahl-Argumenten boxten im
 * Spiel (Chrome-Zwischenstufe) 3–4 KiB/s bei der Jo-Jo-Wiege.
 */
export function thumbPoint(joints: ArrayLike<number>, seg: number, lx: number, ly: number, lz: number, out: Vec3Out): Vec3Out {
  const t = VM_RIG.thumb;
  const g2 = seg >= 2 ? 1 : 0;
  const g1 = seg >= 1 ? 1 : 0;
  // Endglied: Rx(−ip), dann + len[1] entlang y (nur ab seg 2).
  let c = Math.cos(-joints[VM_JOINT.thumbIp] * g2);
  let s = Math.sin(-joints[VM_JOINT.thumbIp] * g2);
  let x = lx;
  let y = ly * c - lz * s + t.len[1] * g2;
  let z = ly * s + lz * c;
  // Mittelglied: Rx(−mcp), + len[0] (ab seg 1).
  c = Math.cos(-joints[VM_JOINT.thumbMcp] * g1);
  s = Math.sin(-joints[VM_JOINT.thumbMcp] * g1);
  let u = y * c - z * s + t.len[0] * g1;
  z = y * s + z * c;
  y = u;
  // Wurzel: Euler ZXY (x = baseX − Opposition, y = baseY, z = baseZ + Abspreizen) → Rz·Rx·Ry.
  c = Math.cos(t.baseY);
  s = Math.sin(t.baseY);
  u = x * c + z * s;
  z = -x * s + z * c;
  x = u;
  c = Math.cos(t.baseX - joints[VM_JOINT.thumbOpp]);
  s = Math.sin(t.baseX - joints[VM_JOINT.thumbOpp]);
  u = y * c - z * s;
  z = y * s + z * c;
  y = u;
  c = Math.cos(t.baseZ + joints[VM_JOINT.thumbAbd]);
  s = Math.sin(t.baseZ + joints[VM_JOINT.thumbAbd]);
  u = x * c - y * s;
  y = x * s + y * c;
  x = u;
  out[0] = t.x + x;
  out[1] = t.y + y;
  out[2] = t.z + z;
  return out;
}

/** Fingerspitze (Kuppe des Endglieds, etwas über das Glied hinaus) im Handgelenk-Raum. */
export function fingerTip(joints: ArrayLike<number>, finger: number, out: Vec3Out, beyond = 0.9): Vec3Out {
  const f = VM_RIG.fingers[finger];
  return fingerPoint(joints, finger, 2, 0, f.len[2] + f.r * beyond, 0, out);
}
