import type { BufferGeometry, IUniform, Object3D } from 'three';
import type { ViewModelFrame } from '../../types';
import { VM_RIG } from '../../types';
import { capsuleGeometry, markClaw, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import type { Ring } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import type { ClawUniforms } from '../vmMaterials';
import type { SkinFrameFx, SkinView, VmBuildCtx, VmRig } from '../vmBuild';

/**
 * Katzenpfote (Plan 007, KI3), Cartoon-Stil (Lead-Entscheid): orange getigert mit weißen Zehen
 * ("Söckchen"), runde dicke Endglieder als Zehenballen-Kugeln, rosa Ballen auf der Innenseite,
 * Fell-Büschel an Handkante und als cremeweiße Krause ums Handgelenk (Zacken-Hülle + Kegel),
 * getigertes Bein mit kräftigen Ringen statt Stulpe, rotes Halsband mit goldenem Glöckchen.
 * Silhouetten-Runde (Kontaktblatt): mit weißer Socke als Unterarm las sich die Pfote als "oranger
 * Handschuh mit Ärmel" — Bein und Krause machen das Tier; Krallen ragen in Ruhe sichtbar heraus.
 *
 * Krallen sind in die Endglied-Geometrie eingebacken (Vertex-Attribut aClaw) und fahren im Shader
 * aus (uClaw = skinFx: in Ruhe 0.3 = halb sichtbar, 1 = ganz draußen) — 0 zusätzliche Draw Calls.
 * Je Slot ein Mesh + eine Hülle → 36 Draw Calls wie der Handschuh (Budget Lead: ≤ 40 inkl. Effekt).
 */

const FUR = rgb(0xf09a3e);
const STRIPE = rgb(0x9a4210);
const TOE = rgb(0xfff3e0);
const PINK = rgb(0xf58fae);
const CREAM = rgb(0xfff4e2);
/** Helles Elfenbein: die Kralle liest sich vor dem dunklen Hintergrund, die Tinte gibt ihr den Rand. */
const CLAW = rgb(0xf2ead8);
const COLLAR = rgb(0xd8263a);
const BELL = rgb(0xf2c230);
const BELL_D = rgb(0x8a5a10);
/**
 * Krallen: ganz draußen ragen sie CLAW_OUT über den Zeh, Rückzug CLAW_LEN — in Ruhe (0.3) ragt die Spitze
 * 0.9 heraus ("halb sichtbar", Lead: ~2 Low-Res-Pixel; mit 0.4 war sie im Spielbild unsichtbar), ganz raus 1.8.
 */
const CLAW_OUT = 1.8;
const CLAW_LEN = 1.3;
const SEG = 12;
const RUFF = 10;
const LEG_STEP = 0.9;

type Rgb3 = [number, number, number];

function set(c: Rgb3, v: readonly [number, number, number]): void {
  c[0] = v[0];
  c[1] = v[1];
  c[2] = v[2];
}

/** Tigerstreifen quer zum Glied, auf Rücken und Seiten (Innenseite −z bleibt hell). */
function tabby(x: number, y: number, z: number, c: Rgb3): void {
  if (z > -0.9 && Math.sin(y * 2.4 + x * 0.6) > 0.3) set(c, STRIPE);
}

/** Bein: breite Ringe (leicht gewellt), über dem Halsband frei. */
function legStripes(x: number, y: number, z: number, c: Rgb3): void {
  if (y < -5.6 && Math.sin(y * 0.78 + 0.5 * Math.sin(Math.atan2(x, z) * 2)) > 0.25) set(c, STRIPE);
}

/** Büschel rundum (Krause): Kegel radial nach außen und etwas Richtung Pfote, Fuß auf der Ellipse rx/rz. */
function ruffTuft(phi: number, y: number, rx: number, rz: number, lift: number, len: number, r: number): BufferGeometry {
  // Flammenform: bauchiger Fuß, weiche Spitze — spitze Kegel lasen sich als Nieten, runde als Perlen.
  const g = tubeGeometry(
    [
      { y: 0, rx: r * 0.9, rz: r * 0.75 },
      { y: len * 0.3, rx: r, rz: r * 0.8 },
      { y: len * 0.65, rx: r * 0.55, rz: r * 0.45 },
    ],
    6,
    { poleStart: -0.1, poleEnd: len, color: CREAM },
  );
  g.rotateZ(-(Math.PI / 2 - lift));
  g.rotateY(phi);
  g.translate(Math.cos(phi) * rx * 0.92, y, -Math.sin(phi) * rz * 0.92);
  return g;
}

/** Fell-Büschel: kleiner Kegel mit Spitze nach `dir` (Einheitsvektor in der xy-Ebene des Slots). */
function tuft(x: number, y: number, z: number, angle: number, len: number, r: number, color: readonly [number, number, number]): BufferGeometry {
  const g = tubeGeometry(
    [
      { y: 0, rx: r, rz: r * 0.8 },
      { y: len * 0.6, rx: r * 0.45, rz: r * 0.4 },
    ],
    6,
    { poleStart: -0.1, poleEnd: len, color },
  );
  g.rotateZ(angle);
  g.translate(x, y, z);
  return g;
}

function palm(hull: boolean): BufferGeometry {
  const rings: Ring[] = [
    { y: -1.0, rx: 3.3, rz: 2.5 },
    { y: 0.8, rx: 4.1, rz: 2.7 },
    { y: 4.0, rx: 4.8, rz: 2.8 },
    { y: 7.1, rx: 4.9, rz: 2.6 },
    { y: 8.9, rx: 4.6, rz: 2.2 },
  ];
  const base = tubeGeometry(rings, 14, hull ? { poleStart: -1.8, poleEnd: 10.2, fur: 0.14 } : { poleStart: -1.8, poleEnd: 10.2, color: FUR, colorAt: tabby });
  const parts = [base];
  // Büschel an der Handkante (kleiner Finger, +x) und am Handgelenk.
  const tufts: readonly (readonly [number, number, number, number, number])[] = [
    [4.7, 5.2, 0.6, -1.25, 1.6],
    [4.5, 2.4, 0.5, -1.45, 1.5],
    [3.4, -0.6, 0.8, -2.0, 1.3],
  ];
  for (const [x, y, z, a, l] of tufts) parts.push(tuft(x, y, z, a, l, 0.75, FUR));
  if (!hull) {
    // Großer rosa Ballen auf der Innenseite (−z).
    const bean = tubeGeometry(
      [
        { y: 3.0, rx: 1.3, rz: 0.55 },
        { y: 4.3, rx: 2.4, rz: 0.8 },
        { y: 5.7, rx: 2.1, rz: 0.65 },
      ],
      10,
      { poleStart: 2.4, poleEnd: 6.3, color: PINK },
    );
    bean.translate(0, 0, -2.5);
    parts.push(bean);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

/** Grund- und Mittelglied: dicker als der Handschuh, getigert; Hülle mit Fell-Zacken. */
function segment(len: number, r0: number, r1: number, hull: boolean): BufferGeometry {
  return capsuleGeometry(len, r0, r1, SEG, 0.92, 2, hull ? { fur: 0.12 } : { color: FUR, colorAt: tabby });
}

/** Zeh (Endglied): runde, dicke Kugel, weiß, rosa Ballen innen, Kralle eingebacken (aClaw). */
function toe(len: number, r: number, hull: boolean): BufferGeometry {
  const R = r * 1.22;
  const ball = capsuleGeometry(len * 0.55, R, R * 1.02, SEG, 0.95, 3, hull ? {} : { color: TOE });
  const parts = [ball];
  if (!hull) {
    const bean = tubeGeometry(
      [
        { y: 0, rx: R * 0.42, rz: 0.3 },
        { y: len * 0.35, rx: R * 0.62, rz: 0.42 },
        { y: len * 0.75, rx: R * 0.45, rz: 0.3 },
      ],
      8,
      { poleStart: -0.3, poleEnd: len * 0.75 + 0.3, color: PINK },
    );
    bean.translate(0, len * 0.1, -R * 0.9);
    parts.push(bean);
  }
  // Kralle: aus dem Zeh nach vorn und zur Handfläche gebogen; ganz eingezogen steckt sie im Zeh.
  const tip = len * 0.55 + R;
  const claw = tubeGeometry(
    [
      { y: tip - 1.4, rx: 0.5, rz: 0.38, cz: 0.15 },
      { y: tip + 0.6, rx: 0.4, rz: 0.3, cz: -0.1 },
      { y: tip + CLAW_OUT * 0.85, rx: 0.14, rz: 0.12, cz: -0.6 },
    ],
    6,
    { poleEnd: tip + CLAW_OUT, color: CLAW },
  );
  markClaw(claw);
  parts.push(claw);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

/** Bein (statt Stulpe): getigert, am Handgelenk eine cremeweiße Fell-Krause aus Büscheln rundum. */
function leg(hull: boolean): BufferGeometry {
  const rings: Ring[] = [
    { y: 0.8, rx: 3.8, rz: 3.0 },
    { y: 0.1, rx: 4.3, rz: 3.5 },
    { y: -2.5, rx: 4.5, rz: 3.65 },
  ];
  // Dichte Ringe über dem sichtbaren Bein (nur die Fläche): die Streifen sind Vertex-Farbe, zwischen weit
  // entfernten Ringen verschwammen sie zu einer Fläche. Die Hülle braucht nur die Silhouette (Budget).
  if (!hull) for (let y = -3.2; y > -24; y -= LEG_STEP) rings.push({ y, rx: 4.5 + ((-2.5 - y) / 37.5) * 0.7, rz: 3.65 + ((-2.5 - y) / 37.5) * 0.65 });
  else rings.push({ y: -9, rx: 4.6, rz: 3.75 });
  rings.push({ y: -40, rx: 5.2, rz: 4.3 });
  const base = tubeGeometry(rings, 14, hull ? { poleStart: 1.0, fur: 0.12 } : { poleStart: 1.0, color: FUR, colorAt: legStripes });
  const parts = [base];
  // Krause: Büschel rundum am Handgelenk, abwechselnd lang/kurz, dick und stumpf (flauschig, keine
  // Stacheln — spitze Kegel lasen sich als Nietenarmband).
  for (let i = 0; i < RUFF; i++) {
    const phi = (i / RUFF) * Math.PI * 2 + 0.2;
    parts.push(ruffTuft(phi, 0.5, 4.2, 3.4, 0.9, i % 2 === 0 ? 1.9 : 1.35, 1.05));
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

function collar(): BufferGeometry {
  const band = tubeGeometry(
    [
      { y: -2.6, rx: 4.62, rz: 3.78 },
      { y: -3.0, rx: 4.75, rz: 3.9 },
      { y: -4.6, rx: 4.78, rz: 3.92 },
      { y: -5.0, rx: 4.64, rz: 3.8 },
    ],
    14,
    { color: COLLAR },
  );
  const bell = capsuleGeometry(0.2, 1.1, 1.1, 8, 1, 2, {
    color: BELL,
    colorAt: (_x, y, _z, c) => {
      if (y < -0.25 && y > -0.55) set(c, BELL_D);
    },
  });
  bell.translate(-4.9, -4.3, 1.4);
  const g = mergeGeometries([band, bell]);
  band.dispose();
  bell.dispose();
  return g;
}

export function buildCatSkin(ctx: VmBuildCtx, rig: VmRig): SkinView {
  const L = ctx.light;
  const clawOut: IUniform<number> = new ScalarUniform(0.3);
  const claws: ClawUniforms = { out: clawOut, len: new ScalarUniform(CLAW_LEN) };
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.35, wrap: 0.45, ink: 0.2, inkColor: 0x3a1c08, vertexColors: true, claws }));
  const outline = ctx.track(createOutlineMaterial(L, 0x2a1406, ctx.handPx, claws));
  const objects: Object3D[] = [];
  const add = (parent: Object3D, geo: BufferGeometry, hull?: BufferGeometry): void => {
    const p = ctx.part(parent, geo, lit, outline, null, hull);
    objects.push(p.lit, p.hull);
  };
  add(rig.wrist, palm(false), palm(true));
  VM_RIG.fingers.forEach((f, i) => {
    const [g0, g1, g2] = rig.fingers[i];
    const r0 = f.r * 1.06;
    const r1 = f.r * 1.04;
    add(g0, segment(f.len[0], r0, r1, false), segment(f.len[0], r0, r1, true));
    add(g1, segment(f.len[1], r1, r1 * 0.98, false), segment(f.len[1], r1, r1 * 0.98, true));
    add(g2, toe(f.len[2], f.r, false), toe(f.len[2], f.r, true));
  });
  const t = VM_RIG.thumb;
  for (let k = 0; k < 3; k++) {
    const r0 = t.r[k] * 0.98;
    if (k < 2) add(rig.thumb[k], segment(t.len[k], r0, r0 * 0.96, false), segment(t.len[k], r0, r0 * 0.96, true));
    else add(rig.thumb[k], toe(t.len[k], t.r[k] * 0.9, false), toe(t.len[k], t.r[k] * 0.9, true));
  }
  add(rig.arm, leg(false), leg(true));
  add(rig.arm, collar());
  for (const o of objects) o.visible = false;
  return {
    setVisible(on: boolean): void {
      for (const o of objects) o.visible = on;
    },
    apply(f: ViewModelFrame, _fx: SkinFrameFx): void {
      // Krallen = skinFx (UI: Ruhe 0.3, raus 1).
      const v = f.skinFx;
      clawOut.value = v > 0 ? (v < 1 ? v : 1) : 0;
    },
  };
}
