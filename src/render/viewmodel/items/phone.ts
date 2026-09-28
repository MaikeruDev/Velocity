import { ClampToEdgeWrapping, DataTexture, Group, Mesh, NearestFilter, NoColorSpace, PlaneGeometry, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';
import type { IUniform } from 'three';
import { VM_PARAM, VM_PHONE_MODE } from '../../types';
import type { ViewModelFrame } from '../../types';
import { mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Handy (Plan 007, KI7), generisch: dunkles Gehäuse (Superellipse n = 8) mit Kamera-Buckel hinten,
 * Bildschirm = selbstleuchtende DataTexture 24×48 (Pixelbild, KEINE echte App, kein Text — nur eigene
 * Pixel-Ziffern). Modi (VM_PHONE_MODE): Feed (Karten mit Avatar-Punkten, scrollt über ein UV-Uniform
 * ohne Upload), Tacho (echtes Tempo, Farbe nach Stufe), Split (±s grün/rot), Kamera (Sucher, quer) und
 * Foto (quer, weißer Rand). Neu gezeichnet wird nur bei Änderung und höchstens mit 10 Hz (Upload);
 * der Auslöser-Blitz ist ein Leucht-Uniform (kein Upload). Achse y = lange Seite, Bildschirm +z.
 * Quer (Kamera/Foto): die Hand dreht das Handy +90° um die Blickachse — gezeichnet wird entsprechend.
 */

const W = 24;
const H = 48;
const UPLOAD_EVERY = 0.1;

type C = number;
const BG = 0x121628;
const CARD = 0x232a48;
const BAR = 0xaab4d0;
const BAR_D = 0x6c7698;
const AVATARS: readonly C[] = [0xff4fd8, 0x33f0ff, 0xffd23c, 0x7cff6b];
const TIER: readonly C[] = [0xf1edff, 0x33f0ff, 0xff4fd8, 0xffd23c];
const GREEN = 0x30ff60;
const RED = 0xff3050;
const WHITE = 0xffffff;

/** 3×5-Ziffern (Zeilen von oben, Bits von links). */
const DIGITS: readonly (readonly number[])[] = [
  [7, 5, 5, 5, 7],
  [2, 6, 2, 2, 7],
  [7, 1, 7, 4, 7],
  [7, 1, 7, 1, 7],
  [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7],
  [7, 4, 7, 5, 7],
  [7, 1, 1, 2, 2],
  [7, 5, 7, 5, 7],
  [7, 5, 7, 1, 7],
];

class Screen {
  readonly data = new Uint8Array(W * H * 4);
  readonly tex: DataTexture;

  constructor() {
    this.tex = new DataTexture(this.data, W, H, RGBAFormat, UnsignedByteType);
    this.tex.magFilter = NearestFilter;
    this.tex.minFilter = NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.wrapS = ClampToEdgeWrapping;
    this.tex.wrapT = RepeatWrapping;
    this.tex.colorSpace = NoColorSpace;
    this.tex.flipY = false;
    this.drawFeed();
    this.tex.needsUpdate = true;
  }

  /** Hochformat: x 0..23 links→rechts, y 0..47 unten→oben. Alpha 128 = selbstleuchtend. */
  set(x: number, y: number, c: C): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    this.data[i] = (c >> 16) & 255;
    this.data[i + 1] = (c >> 8) & 255;
    this.data[i + 2] = c & 255;
    this.data[i + 3] = 128;
  }

  /** Querformat (Handy +90° gedreht): x 0..47 links→rechts, y 0..23 unten→oben im Bild. */
  setL(x: number, y: number, c: C): void {
    this.set(y, H - 1 - x, c);
  }

  rect(x: number, y: number, w: number, h: number, c: C, land = false): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (land) this.setL(x + i, y + j, c);
    else this.set(x + i, y + j, c);
  }

  fill(c: C): void {
    this.rect(0, 0, W, H, c);
  }

  /** Ziffer (3×5, Skalierung k bzw. kx × k) mit linker oberer Ecke (x, yTop). */
  digit(d: number, x: number, yTop: number, k: number, c: C, land = false, kx = k): void {
    const rows = DIGITS[d];
    for (let r = 0; r < 5; r++) {
      for (let b = 0; b < 3; b++) {
        if ((rows[r] >> (2 - b)) & 1) this.rect(x + b * kx, yTop - (r + 1) * k + 1, kx, k, c, land);
      }
    }
  }

  /** Feed: 4 Karten à 12 Zeilen — Periode 12, damit das Scrollen (RepeatWrapping) nahtlos läuft. */
  drawFeed(): void {
    this.fill(BG);
    for (let k = 0; k < 4; k++) {
      const y0 = k * 12;
      this.rect(1, y0 + 1, 22, 10, CARD);
      this.rect(2, y0 + 6, 3, 3, AVATARS[k]);
      this.rect(7, y0 + 8, 11 - k, 1, BAR);
      this.rect(7, y0 + 6, 13, 1, BAR_D);
      this.rect(2, y0 + 3, 18 - 2 * k, 1, BAR_D);
    }
  }

  drawSpeedo(speed: number): void {
    this.fill(BG);
    const v = Math.max(0, Math.min(9999, Math.round(speed)));
    // Stufen wie der Renderer (500/750/1000 u/s) — Gold erst ab echten 1000 u/s.
    const tier = v >= 1000 ? 3 : v >= 750 ? 2 : v >= 500 ? 1 : 0;
    const c = TIER[tier];
    this.rect(0, H - 3, W, 2, c);
    if (v >= 1000) {
      // Vier Ziffern, schmal (je 3×10): ab 1000 u/s stand hier sonst eine falsche 999.
      for (let i = 0; i < 4; i++) this.digit(Math.floor(v / 10 ** (3 - i)) % 10, 3 + i * 5, 34, 2, c, false, 1);
    } else {
      // Drei Ziffern ×2 (je 6×10), zentriert.
      this.digit(Math.floor(v / 100), 2, 34, 2, c);
      this.digit(Math.floor(v / 10) % 10, 9, 34, 2, c);
      this.digit(v % 10, 16, 34, 2, c);
    }
    // Tempo-Balken.
    const bar = Math.round((Math.min(1200, speed) / 1200) * 20);
    this.rect(2, 12, 20, 3, CARD);
    this.rect(2, 12, bar, 3, c);
    this.rect(2, 7, 4, 1, BAR_D);
  }

  drawSplit(split: number): void {
    const ahead = split < 0;
    const c = ahead ? GREEN : RED;
    this.fill(BG);
    this.rect(0, H - 6, W, 5, c);
    this.rect(0, 2, W, 2, c);
    const v = Math.min(9.99, Math.abs(split));
    const a = Math.floor(v);
    const b = Math.floor(v * 10) % 10;
    const e = Math.round(v * 100) % 10;
    // Vorzeichen, Ziffer, Punkt, zwei Ziffern (3×5 ×1): −0.42 / +0.31.
    const y = 27;
    this.rect(1, y - 2, 3, 1, c);
    if (!ahead) this.rect(2, y - 3, 1, 3, c);
    this.digit(a, 5, y, 1, c);
    this.set(9, y - 4, c);
    this.digit(b, 11, y, 1, c);
    this.digit(e, 15, y, 1, c);
    // Pfeil (vorn hoch, zurück runter).
    for (let i = 0; i < 4; i++) this.rect(12 - i, ahead ? 14 + i : 17 - i, 1 + 2 * i, 1, c);
  }

  /** Sucher (quer): Nacht-Verlauf, Trim-Horizont, Ecken, Mitte, REC blinkt. */
  drawCamera(rec: boolean, photo: boolean): void {
    for (let y = 0; y < 24; y++) {
      const k = y / 23;
      const col = y < 9 ? 0x1a2340 : (Math.round(0x20 + 0x30 * k) << 16) | (Math.round(0x12 + 0x16 * k) << 8) | Math.round(0x40 + 0x28 * k);
      this.rect(0, y, 48, 1, col, true);
    }
    this.rect(0, 9, 48, 1, 0x33f0ff, true);
    this.rect(30, 10, 3, 5, 0x7a5ab8, true);
    this.rect(36, 10, 5, 8, 0x5a4a98, true);
    if (photo) {
      this.rect(0, 0, 48, 2, WHITE, true);
      this.rect(0, 22, 48, 2, WHITE, true);
      this.rect(0, 0, 2, 24, WHITE, true);
      this.rect(46, 0, 2, 24, WHITE, true);
      return;
    }
    for (let i = 0; i < CORNERS.length; i++) {
      const c = CORNERS[i];
      for (let k = 0; k < 3; k++) {
        this.setL(c[0] + k * c[2], c[1], WHITE);
        this.setL(c[0], c[1] + k * c[3], WHITE);
      }
    }
    this.rect(23, 12, 3, 1, WHITE, true);
    this.rect(24, 11, 1, 3, WHITE, true);
    if (rec) this.rect(3, 18, 3, 3, RED, true);
  }
}

/** Sucher-Ecken (x, y, Richtung x, Richtung y) — Ladezeit-Konstante. */
const CORNERS: readonly (readonly [number, number, number, number])[] = [
  [2, 2, 1, 1],
  [45, 2, -1, 1],
  [2, 21, 1, -1],
  [45, 21, -1, -1],
];

export function buildPhone(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.35, wrap: 0.35, sheen: 0.2, sheenColor: 0xc8d8ff, vertexColors: true }));
  const screen = new Screen();
  ctx.trackTex(screen.tex);
  const scroll: IUniform<number> = new ScalarUniform(0);
  const flash: IUniform<number> = new ScalarUniform(0);
  const sm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: screen.tex, rim: 0, wrap: 0.5, emissive: 0xffffff, glow: flash, scroll }));
  const group = new Group();
  const shell = tubeGeometry(
    [
      { y: -4.3, rx: 2.15, rz: 0.26, n: 8 },
      { y: -4.1, rx: 2.3, rz: 0.3, n: 8 },
      { y: 4.1, rx: 2.3, rz: 0.3, n: 8 },
      { y: 4.3, rx: 2.15, rz: 0.26, n: 8 },
    ],
    20,
    { poleStart: -4.35, poleEnd: 4.35, color: rgb(0x2a2a38) },
  );
  const bump = tubeGeometry(
    [
      { y: 0, rx: 0.6, rz: 0.6 },
      { y: 0.25, rx: 0.52, rz: 0.52 },
    ],
    8,
    { poleEnd: 0.3, color: rgb(0x0e0e14) },
  );
  bump.rotateX(-Math.PI / 2);
  bump.translate(-1.2, 3.1, -0.3);
  const parts = [shell, bump];
  const geo = mergeGeometries(parts);
  for (const q of parts) q.dispose();
  ctx.part(group, geo, lit, outline, null);
  const glass = new Mesh(ctx.trackGeo(new PlaneGeometry(4.1, 8.0)), sm);
  glass.position.z = 0.32;
  glass.frustumCulled = false;
  group.add(glass);
  group.visible = false;

  const P = VM_PARAM.phone;
  const M = VM_PHONE_MODE;
  let lastKey = -1;
  let lastUpload = -1e9;
  return {
    group,
    apply(f: ViewModelFrame): void {
      const p = f.propParam;
      const mode = Math.round(p[P.mode]);
      const value = p[P.value];
      const now = L.uTime.value;
      scroll.value = mode === M.feed ? p[P.scroll] : 0;
      const fl = p[P.flash];
      flash.value = fl > 0 ? (fl < 1 ? fl * 1.3 : 1.3) : 0;
      const rec = Math.floor(now * 2.5) % 2 === 0;
      const key = mode === M.speedo ? 1e6 + Math.round(value) : mode === M.split ? 2e6 + Math.round(value * 100) : mode === M.camera ? 3e6 + (rec ? 1 : 0) : mode === M.photo ? 4e6 : 0;
      // Nur bei Änderung und höchstens 10 Hz hochladen (gleiche/zurückgesprungene Zeit = Tool/Vorschau → erlaubt).
      if (key === lastKey || (now - lastUpload < UPLOAD_EVERY && now > lastUpload)) return;
      lastKey = key;
      lastUpload = now;
      if (mode === M.speedo) screen.drawSpeedo(value);
      else if (mode === M.split) screen.drawSplit(value);
      else if (mode === M.camera) screen.drawCamera(rec, false);
      else if (mode === M.photo) screen.drawCamera(false, true);
      else screen.drawFeed();
      screen.tex.needsUpdate = true;
    },
  };
}
