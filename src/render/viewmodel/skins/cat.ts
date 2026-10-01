import type { BufferGeometry, IUniform, Object3D } from 'three';
import type { ViewModelFrame } from '../../types';
import { VM_RIG } from '../../types';
import { capsuleGeometry, markClaw, markTabby, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import type { Ring } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import type { ClawUniforms, RuffPattern } from '../vmMaterials';
import type { SkinFrameFx, SkinView, VmBuildCtx, VmRig } from '../vmBuild';

/**
 * Katzenpfote (Plan 007, KI3), Cartoon-Stil (Lead-Entscheid): orange getigert mit weißen Zehen
 * ("Söckchen"), runde dicke Endglieder als Zehenballen-Kugeln, rosa Ballen auf der Innenseite,
 * Fell-Saum (kurze stumpfe Zacken in Fellfarbe) an Handkante und ums Handgelenk, Zacken-Hülle,
 * getigertes Bein mit kräftigen Ringen statt Stulpe, rotes Halsband mit Glöckchen (Wulst + Schlitz).
 * Silhouetten-Runde (Kontaktblatt): mit weißer Socke als Unterarm las sich die Pfote als "oranger
 * Handschuh mit Ärmel" — Bein und Krause machen das Tier; Krallen ragen in Ruhe sichtbar heraus.
 * Zweite Runde (Phase 2): weiße Kegel-Krause las sich als Zahn-/Nietenkranz → Fell-Büschel in Fellfarbe
 * mit cremefarbener Spitze; Tigerstreifen je Pixel (Shader TABBY) statt Vertex-Farbe — die verschwamm.
 * Dritte Runde (Review): die Büschel (Länge 1.3–2.5, helle Spitze, radial) lasen sich im Spielbild als Dornen
 * bzw. Krallen am Handgelenk, drei- bis viermal so groß wie die echten Krallen → Fell-Saum: mehr, kurze, stumpfe
 * Zacken in Fellfarbe mit dunklerer Spitze, flach Richtung Unterarm; die Krallen an den Zehen kräftiger.
 * Vierte Runde (Review Phase 2): die 14 Saum-Zacken und 5 Handkanten-Zacken als Einzelkörper lasen sich als Reihe
 * runder Noppen/Perlen mit eigener Kontur → der Saum ist jetzt Teil der Bein-Silhouette: zwei gezackte Ringe
 * (Ring.fur) am Handgelenk, Spitzen nach außen und Richtung Unterarm, dunkler; die Handkante trägt nur noch die
 * Zacken-Hülle.
 * Fünfte Runde (Review Phase 3): der gezackte Ring las sich als glatter Ärmel-Kragen — Zacken rundum zeigen sich nur
 * am Rand der Silhouette, die Fläche zur Kamera blieb glatt. Jetzt zwei versetzte Büschel-Reihen, deren Spitzen
 * Richtung Unterarm hängen (Ring.furDrop, Silhouette sägt entlang des Beins), und auf jeder Reihen-Kante eine
 * Zickzack-Linie je Pixel im Shader (RuffPattern, Schatten unter den Büscheln) — liest sich als Fell-Stulpe.
 * Sechste Runde: die Zickzack-Linien in voller Streifenfarbe lasen sich mit der Tinte an den Zacken-Facetten als
 * Schuppen/Tannenzapfen → Schatten nur halb (RuffPattern.mix 0.45); gezackte Kontur bleibt, Linien werden Haar-Striche.
 *
 * Krallen sind in die Endglied-Geometrie eingebacken (Vertex-Attribut aClaw) und fahren im Shader
 * aus (uClaw = skinFx: in Ruhe 0.3 = halb sichtbar, 1 = ganz draußen) — 0 zusätzliche Draw Calls.
 * Je Slot ein Mesh + eine Hülle → 36 Draw Calls wie der Handschuh (Budget Lead: ≤ 40 inkl. Effekt).
 */

const FUR = rgb(0xf09a3e);
/** Streifen (Shader TABBY): kräftig dunkel, sonst gehen sie im Vertex-Licht unter. */
const STRIPE = 0x8a3a0c;
const TOE = rgb(0xfff3e0);
const PINK = rgb(0xf58fae);
/** Spitze der Fell-Zacken: etwas dunkler als das Fell (hell las sie sich als Dorn/Kralle). */
const FUR_TIP = rgb(0xc9701f);
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
/**
 * Fell-Saum am Handgelenk als gezackte Silhouette des Beins: Zacken je Ring (Ring.fur), Segmente des Beins (gerade,
 * je zwei ein Zacken — 11 rundum). Einzelne Büschel (14, dann 9 lange) lasen sich als Noppen bzw. Stachelkranz.
 */
const LEG_SEG = 22;
/**
 * Eine Büschel-Reihe: Grund-Ring `len` Richtung Pfote, dann der Spitzen-Ring bei y (Ellipse × out, jeder zweite
 * Vertex × (1 + jag) und um `drop` Richtung Unterarm), Reihen im Wechsel versetzt (phase). Die nächste Reihe beginnt
 * unterhalb der tiefsten Spitze — sonst kippen Dreiecke.
 */
interface RuffRow {
  readonly y: number;
  readonly len: number;
  readonly rx: number;
  readonly rz: number;
  readonly out: number;
  readonly jag: number;
  readonly drop: number;
  readonly phase: 0 | 1;
}
const RUFF_ROWS: readonly RuffRow[] = [
  { y: 0.1, len: 0.5, rx: 4.15, rz: 3.38, out: 1.08, jag: 0.26, drop: -0.75, phase: 1 },
  { y: -1.3, len: 0.55, rx: 4.35, rz: 3.55, out: 1.08, jag: 0.26, drop: -0.75, phase: 0 },
];

/** Zickzack-Kanten im Shader (je Pixel) genau auf den Zacken-Ringen der Geometrie. */
const RUFF_PATTERN: RuffPattern = {
  rows: RUFF_ROWS.map((r) => ({ y: r.y, drop: r.drop, phase: r.phase })),
  teeth: LEG_SEG / 2,
  aspect: RUFF_ROWS[0].rz / RUFF_ROWS[0].rx,
  band: 0.3,
  mix: 0.45,
};

/**
 * Farbe des Beins: Fell, im Saum zu den Zacken-Spitzen hin dunkler (FUR_TIP) — radial gemessen gegen die
 * Grund-Ellipse des Saums (nur die Spitzen-Vertices liegen so weit außen).
 */
function legColor(x: number, y: number, z: number, c: [number, number, number]): void {
  let k = 0;
  if (y < 0.5 && y > -2.2) {
    const q = Math.sqrt((x / 4.3) * (x / 4.3) + (z / 3.5) * (z / 3.5));
    k = Math.min(1, Math.max(0, (q - 1.12) / 0.15));
  }
  c[0] = FUR[0] + (FUR_TIP[0] - FUR[0]) * k;
  c[1] = FUR[1] + (FUR_TIP[1] - FUR[1]) * k;
  c[2] = FUR[2] + (FUR_TIP[2] - FUR[2]) * k;
}

function palm(hull: boolean): BufferGeometry {
  const rings: Ring[] = [
    { y: -1.0, rx: 3.3, rz: 2.5 },
    { y: 0.8, rx: 4.1, rz: 2.7 },
    { y: 4.0, rx: 4.8, rz: 2.8 },
    { y: 7.1, rx: 4.9, rz: 2.6 },
    { y: 8.9, rx: 4.6, rz: 2.2 },
  ];
  const base = tubeGeometry(rings, 14, hull ? { poleStart: -1.8, poleEnd: 10.2, fur: 0.14 } : { poleStart: -1.8, poleEnd: 10.2, color: FUR });
  if (!hull) markTabby(base, 1);
  // Fell an der Handkante zeichnet nur die Zacken-Hülle (fur): fünf Einzel-Zacken lasen sich als Noppen.
  const parts = [base];
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
  if (hull) return capsuleGeometry(len, r0, r1, SEG, 0.92, 2, { fur: 0.12 });
  return markTabby(capsuleGeometry(len, r0, r1, SEG, 0.92, 2, { color: FUR }), 1);
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
  // Kräftiger als in Runde 2 (Review: +0.2–0.3 u) — die Krallen sind das Merkmal, nicht die Büschel.
  const claw = tubeGeometry(
    [
      { y: tip - 1.4, rx: 0.72, rz: 0.56, cz: 0.15 },
      { y: tip + 0.6, rx: 0.6, rz: 0.46, cz: -0.1 },
      { y: tip + CLAW_OUT * 0.85, rx: 0.2, rz: 0.17, cz: -0.6 },
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

/**
 * Bein (statt Stulpe): getigert, am Handgelenk ein Fell-Saum aus zwei Büschel-Reihen (RUFF_ROWS) in der Bein-
 * Silhouette, zurück aufs Bein vor dem Halsband.
 */
function leg(hull: boolean): BufferGeometry {
  const rings: Ring[] = [{ y: 0.8, rx: 3.8, rz: 3.0 }];
  for (const r of RUFF_ROWS) {
    rings.push({ y: r.y + r.len, rx: r.rx, rz: r.rz });
    rings.push({ y: r.y, rx: r.rx * r.out, rz: r.rz * r.out, fur: r.jag, furPhase: r.phase, furDrop: r.drop });
  }
  rings.push({ y: -2.35, rx: 4.42, rz: 3.6 }, { y: -2.5, rx: 4.5, rz: 3.65 });
  // Streifen macht der Shader je Pixel (TABBY) — ein paar Ringe für Licht und Verjüngung reichen.
  rings.push({ y: -9, rx: 4.6, rz: 3.75 }, { y: -20, rx: 4.9, rz: 4.0 }, { y: -40, rx: 5.2, rz: 4.3 });
  const base = tubeGeometry(rings, LEG_SEG, hull ? { poleStart: 1.0, fur: 0.12 } : { poleStart: 1.0, colorAt: legColor });
  if (!hull) markTabby(base, 2);
  return base;
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
  const bell = capsuleGeometry(0.2, 1.25, 1.25, 8, 1, 2, { color: BELL });
  // Glöckchen-Merkmale als eigene Teile (Vertex-Farbe zwischen den wenigen Ringen verschwamm): dunkler
  // Wulst um die Mitte und der Schlitz außen — sonst liest es sich als gelbe Kugel.
  const rim = tubeGeometry(
    [
      { y: -0.15, rx: 1.3, rz: 1.3 },
      { y: 0.2, rx: 1.3, rz: 1.3 },
    ],
    8,
    { color: BELL_D },
  );
  const slot = capsuleGeometry(0.5, 0.28, 0.28, 6, 1, 2, { color: BELL_D });
  slot.rotateZ(Math.PI / 2);
  slot.translate(-1.05, -0.65, 0.2);
  const parts = [band, bell, rim, slot];
  for (const p of parts.slice(1)) p.translate(-5.05, -4.3, 1.4);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * Jedes Katzen-Teil trägt beide Shader-Masken (fehlend = 0). Ohne Array liest der Shader den generischen
 * Attribut-Wert — der ist WebGL-KONTEXT-Zustand, nicht VAO-Zustand, und three setzt ihn für jedes Material mit
 * Vorgaben (Vertex-Farbe 1,1,1) nur beim Aufbau eines VAO. Läge aClaw/aTabby auf derselben Location, zögen
 * Handfläche und Bein ihre "Krallen" um 0.9 u ein bzw. bekäme das Halsband Streifen (Review Phase 2: latent,
 * im Spiel 13 234 Draws ohne aClaw- und 3 054 ohne aTabby-Array in 8 s). Eigene Nullen machen es unabhängig davon.
 */
function withMasks(g: BufferGeometry): BufferGeometry {
  if (!g.hasAttribute('aClaw')) markClaw(g, 0);
  if (!g.hasAttribute('aTabby')) markTabby(g, 0);
  return g;
}

export function buildCatSkin(ctx: VmBuildCtx, rig: VmRig): SkinView {
  const L = ctx.light;
  const clawOut: IUniform<number> = new ScalarUniform(0.3);
  const claws: ClawUniforms = { out: clawOut, len: new ScalarUniform(CLAW_LEN) };
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.35, wrap: 0.45, ink: 0.2, inkColor: 0x3a1c08, vertexColors: true, claws, tabby: { stripe: STRIPE, ruff: RUFF_PATTERN } }));
  const outline = ctx.track(createOutlineMaterial(L, 0x2a1406, ctx.handPx, claws));
  const objects: Object3D[] = [];
  const add = (parent: Object3D, geo: BufferGeometry, hull?: BufferGeometry): void => {
    const p = ctx.part(parent, withMasks(geo), lit, outline, null, hull ? withMasks(hull) : undefined);
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
