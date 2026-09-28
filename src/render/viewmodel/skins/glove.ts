import { BufferAttribute, BufferGeometry, GLSL3, Points, ShaderMaterial, Vector3 } from 'three';
import type { IUniform } from 'three';
import type { ViewModelFrame } from '../../types';
import { VM_RIG } from '../../types';
import { capsuleGeometry, tubeGeometry } from '../vmGeometry';
import type { Ring } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import type { Part, SkinFrameFx, SkinView, VmBuildCtx, VmRig } from '../vmBuild';

/**
 * Handschuh-Geometrie (Plan 006) mit Material-Varianten (look.md: "neue Varianten als Material,
 * nicht als neue Formen"): Standard (weiß), Neon (dunkel, Cyan-Kontur, Magenta-Band) und seit
 * Plan 007 Gold (gestuftes Glanzband, Funkeln an den Knöcheln bei perfektem Hop).
 *
 * Aufbau-Reihenfolge wie vor Plan 007 in ViewModel.ts (Materialien classic/neon zuerst, dann
 * Stulpe, Band, Handfläche, Finger, Daumen) — die Material-Reihenfolge bestimmt die Sortierung und
 * damit das pixelgleiche Bild. Gold baut lazy beim ersten Gebrauch (danach sortiert).
 */

export type GloveMaterialId = 'classic' | 'neon' | 'gold';

const SEG_FINGER = 7;
const SEG_PALM = 10;
const SEG_CUFF = 12;

interface GloveColors {
  readonly glove: number;
  readonly cuff: number;
  readonly band: number;
  readonly outline: number;
  readonly bandEmis: number;
  readonly rim: number;
}

const COLORS: { readonly classic: GloveColors; readonly neon: GloveColors } = {
  classic: { glove: 0xeeeef2, cuff: 0xf7f7f7, band: 0x17161c, outline: 0x0d0c14, bandEmis: 0x000000, rim: 0.3 },
  neon: { glove: 0x2c2d48, cuff: 0x23243a, band: 0x3a0f36, outline: 0x33f0ff, bandEmis: 0xc43aa8, rim: 0.7 },
};

interface GloveMats {
  readonly glove: ShaderMaterial;
  readonly cuff: ShaderMaterial;
  readonly band: ShaderMaterial;
  readonly outline: ShaderMaterial;
}

// ------------------------------------------------------------------ Gold-Funkeln

/** Funkeln: je Knöchel ein Pixel-"+" (Zeige-, Mittel-, Ringfinger), nacheinander aufblitzend. */
const SPARK_VERT = /* glsl */ `
uniform float uT;
uniform float uSize;
in float aDelay;
out float vK;
void main() {
  float u = clamp((uT - aDelay) / 0.6, 0.0, 1.0);
  float s = sin(3.14159265 * u);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (u <= 0.0 || u >= 1.0) ? 0.0 : max(1.0, floor(uSize * (0.8 + 1.6 * s) + 0.5));
  vK = s;
}
`;
const SPARK_FRAG = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
in float vK;
out vec4 fragColor;
void main() {
  // Pixel-Kreuz statt Quadrat (Funkeln), Mitte weiß, Arme gold.
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  if (abs(p.x) > 0.34 && abs(p.y) > 0.34) discard;
  fragColor = vec4(max(abs(p.x), abs(p.y)) < 0.34 || vK > 0.8 ? uA : uB, 1.0);
}
`;

export class GloveSkin implements SkinView {
  private readonly ctx: VmBuildCtx;
  private readonly rig: VmRig;
  private readonly mats: { classic: GloveMats; neon: GloveMats; gold: GloveMats | null };
  private readonly gloveParts: Part[] = [];
  private readonly cuffParts: Part[] = [];
  private readonly bandParts: Part[] = [];
  private current: GloveMaterialId = 'classic';
  private visible = true;
  private spark: { points: Points; t: IUniform<number> } | null = null;

  constructor(ctx: VmBuildCtx, rig: VmRig) {
    this.ctx = ctx;
    this.rig = rig;
    this.mats = { classic: this.mk(COLORS.classic), neon: this.mk(COLORS.neon), gold: null };
    this.buildSleeve();
    this.buildHand();
  }

  private mk(c: GloveColors): GloveMats {
    const L = this.ctx.light;
    const t = this.ctx;
    return {
      glove: t.track(createLitMaterial(L, { color: c.glove, rim: c.rim, wrap: 0.3, ink: 0.22, inkColor: c.outline })),
      cuff: t.track(createLitMaterial(L, { color: c.cuff, rim: c.rim * 0.8, wrap: 0.3 })),
      band: t.track(createLitMaterial(L, { color: c.band, rim: 0.15, wrap: 0.5, emissive: c.bandEmis })),
      outline: t.track(createOutlineMaterial(L, c.outline, t.handPx)),
    };
  }

  /**
   * Gold (Plan 007): warmes Gelb mit hartem Licht (Wrap 0.1 → metallische Licht-Schatten-Grenze),
   * gestuftes Glanzband, Tinte und Kontur dunkelbraun, Stulpe hellgold, Band dunkelbraun.
   */
  private mkGold(): GloveMats {
    const L = this.ctx.light;
    const t = this.ctx;
    return {
      glove: t.track(createLitMaterial(L, { color: 0xe0aa2a, rim: 0.6, wrap: 0.1, ink: 0.24, inkColor: 0x4a2a06, sheen: 0.55 })),
      cuff: t.track(createLitMaterial(L, { color: 0xe8b83c, rim: 0.5, wrap: 0.12, sheen: 0.4 })),
      band: t.track(createLitMaterial(L, { color: 0x3a220a, rim: 0.2, wrap: 0.5 })),
      outline: t.track(createOutlineMaterial(L, 0x2a1604, t.handPx)),
    };
  }

  private buildSleeve(): void {
    const m = this.mats.classic;
    // Stulpe: etwas weiter als das Handgelenk, läuft aus dem Bild (Unterarm angeschnitten).
    const cuff: Ring[] = [
      { y: 0.6, rx: 3.55, rz: 2.9 },
      { y: 0.1, rx: 4.05, rz: 3.3 },
      { y: -2.5, rx: 4.2, rz: 3.45 },
      { y: -9, rx: 4.3, rz: 3.55 },
      { y: -40, rx: 4.9, rz: 4.1 },
    ];
    this.ctx.part(this.rig.arm, tubeGeometry(cuff, SEG_CUFF, { poleStart: 0.75 }), m.cuff, m.outline, this.cuffParts);
    // Schwarzes Band direkt am Handgelenk (macht den Handschuh lesbar wie in den Referenzen).
    const band: Ring[] = [
      { y: 0.35, rx: 4.18, rz: 3.44 },
      { y: -0.2, rx: 4.3, rz: 3.55 },
      { y: -2.4, rx: 4.36, rz: 3.62 },
      { y: -2.8, rx: 4.26, rz: 3.52 },
    ];
    this.ctx.part(this.rig.arm, tubeGeometry(band, SEG_CUFF, { poleStart: 0.5, poleEnd: -2.9 }), m.band, m.outline, this.bandParts);
  }

  private buildHand(): void {
    const m = this.mats.classic;
    const rig = this.rig;
    // Handfläche: flacher, weicher Block von der Wurzel bis zu den Knöcheln.
    const palm: Ring[] = [
      { y: -0.9, rx: 3.0, rz: 2.2, cz: 0.1 },
      { y: 0.8, rx: 3.75, rz: 2.35, cz: 0.05 },
      { y: 3.8, rx: 4.45, rz: 2.4, cx: -0.1, cz: -0.1 },
      { y: 7.0, rx: 4.6, rz: 2.25, cz: -0.05 },
      { y: 8.9, rx: 4.4, rz: 1.95, cz: 0.05 },
    ];
    this.ctx.part(rig.wrist, tubeGeometry(palm, SEG_PALM, { poleStart: -1.5, poleEnd: 10.1 }), m.glove, m.outline, this.gloveParts);

    VM_RIG.fingers.forEach((f, i) => {
      const [root, pip, dip] = rig.fingers[i];
      const r0 = f.r;
      const r1 = f.r * 0.95;
      const r2 = f.r * 0.9;
      this.ctx.part(root, capsuleGeometry(f.len[0], r0, r1, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
      this.ctx.part(pip, capsuleGeometry(f.len[1], r1, r2, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
      this.ctx.part(dip, capsuleGeometry(f.len[2], r2, r2 * 0.97, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
    });

    const t = VM_RIG.thumb;
    const [tr, tm, ti] = rig.thumb;
    this.ctx.part(tr, capsuleGeometry(t.len[0], t.r[0], t.r[1], SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
    this.ctx.part(tm, capsuleGeometry(t.len[1], t.r[1], t.r[2], SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
    this.ctx.part(ti, capsuleGeometry(t.len[2], t.r[2], t.r[2] * 0.92, SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
  }

  private buildSpark(): { points: Points; t: IUniform<number> } {
    const t: IUniform<number> = new ScalarUniform(1);
    const mat = this.ctx.track(
      new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: SPARK_VERT,
        fragmentShader: SPARK_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: { uT: t, uSize: this.ctx.pointPx, uA: { value: new Vector3(1, 0.98, 0.86) }, uB: { value: new Vector3(1, 0.78, 0.2) } },
      }),
    );
    // Knöchel von Zeige-, Mittel- und Ringfinger, etwas über dem Handrücken (+z).
    const pos = new Float32Array(9);
    const delay = new Float32Array([0, 0.18, 0.36]);
    for (let i = 0; i < 3; i++) {
      const f = VM_RIG.fingers[i];
      pos[i * 3] = f.x;
      pos[i * 3 + 1] = f.y + 0.3;
      pos[i * 3 + 2] = f.z + f.r + 0.4;
    }
    const g = this.ctx.trackGeo(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aDelay', new BufferAttribute(delay, 1));
    const points = new Points(g, mat);
    points.frustumCulled = false;
    points.visible = false;
    points.renderOrder = 11;
    this.rig.wrist.add(points);
    return { points, t };
  }

  /** Material-Variante wählen (baut Gold beim ersten Gebrauch). */
  setMaterial(id: GloveMaterialId): void {
    this.current = id;
    let m: GloveMats;
    if (id === 'gold') {
      if (!this.mats.gold) this.mats.gold = this.mkGold();
      m = this.mats.gold;
      if (!this.spark) this.spark = this.buildSpark();
    } else m = this.mats[id];
    for (const p of this.gloveParts) {
      p.lit.material = m.glove;
      p.hull.material = m.outline;
    }
    for (const p of this.cuffParts) {
      p.lit.material = m.cuff;
      p.hull.material = m.outline;
    }
    for (const p of this.bandParts) {
      p.lit.material = m.band;
      p.hull.material = m.outline;
    }
    if (this.spark && id !== 'gold') this.spark.points.visible = false;
  }

  get material(): GloveMaterialId {
    return this.current;
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    for (const list of [this.gloveParts, this.cuffParts, this.bandParts]) {
      for (const p of list) {
        p.lit.visible = on;
        p.hull.visible = on;
      }
    }
    if (!on && this.spark) this.spark.points.visible = false;
  }

  /** Gold: skinFx 1 → 0 = Funkel-Phase (ViewHand setzt 1 beim perfekten Hop, klingt in 0.25 s ab). */
  apply(f: ViewModelFrame, _fx: SkinFrameFx): void {
    const s = this.spark;
    if (!s) return;
    const on = this.visible && this.current === 'gold' && f.skinFx > 0.001;
    s.points.visible = on;
    if (on) s.t.value = 1 - f.skinFx;
  }
}
