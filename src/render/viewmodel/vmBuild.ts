import type { BufferGeometry, Group, IUniform, Material, Mesh, Object3D, ShaderMaterial, Texture } from 'three';
import type { ViewModelFrame } from '../types';
import type { VmLightUniforms } from './vmMaterials';

/**
 * Bau-Kontext für Skins und Gegenstände des Viewmodels (Plan 007, Registries unter skins/ und
 * items/). Das ViewModel stellt ihn bereit: Licht- und Kontur-Uniforms, Ressourcen-Listen (für
 * dispose/prewarm) und die Rig-Gruppen. Registries bauen lazy beim ersten Gebrauch bzw. in
 * prewarm() — nie im Frame-Pfad. apply() läuft pro Frame und allokiert nichts.
 */

/** Lit-Mesh plus Kontur-Hülle (Inverted Hull). */
export interface Part {
  readonly lit: Mesh;
  readonly hull: Mesh;
}

/**
 * Gelenk-Gruppen der Hand (VM_RIG): Handgelenk (Handfläche, Sockel), 4 Finger à Grund-/Mittel-/
 * Endglied, Daumen à 3 Glieder, Unterarm (Stulpe). Skins hängen ihre Geometrie hier ein und folgen
 * dadurch allen Posen und Griffen ohne Änderung.
 */
export interface VmRig {
  readonly arm: Group;
  readonly wrist: Group;
  readonly fingers: readonly (readonly [Group, Group, Group])[];
  readonly thumb: readonly [Group, Group, Group];
}

export interface VmBuildCtx {
  readonly light: VmLightUniforms;
  /** Kontur in Low-Res-Pixeln: Hand, Gegenstände, dünne Gegenstände (Messer). */
  readonly handPx: IUniform<number>;
  readonly propPx: IUniform<number>;
  readonly thinPx: IUniform<number>;
  /** Punktgröße der Pixel-Partikel (Poof, Funkeln), skaliert mit der Auflösung. */
  readonly pointPx: IUniform<number>;
  track<T extends Material>(m: T): T;
  trackGeo(g: BufferGeometry): BufferGeometry;
  trackTex<T extends Texture>(t: T): T;
  /** Mesh + Kontur-Hülle aus derselben (oder einer eigenen Hüllen-)Geometrie an `parent`. */
  part(parent: Object3D, geo: BufferGeometry, mat: ShaderMaterial, outline: ShaderMaterial, list: Part[] | null, hullGeo?: BufferGeometry): Part;
}

/** Pro Frame vom Renderer (nicht aus dem ViewModelFrame): Musik. */
export interface SkinFrameFx {
  /** 0..1 Kick-Hüllkurve (RenderFx.kick; Vorschau: synthetisch oder 0). */
  kick: number;
}

/** Ein Hand-Skin mit eigener Geometrie (Plan 007): lazy gebaut, ein-/ausblendbar. */
export interface SkinView {
  setVisible(on: boolean): void;
  /** Skin-Effekte pro Frame (skinFx, Kick) — keine Allokation. */
  apply(f: ViewModelFrame, fx: SkinFrameFx): void;
}

export type SkinBuilder = (ctx: VmBuildCtx, rig: VmRig) => SkinView;

/** Ein Gegenstand (Plan 007, Registry items/): Gruppe im Sockel, optional zweiter Körper und Schnur. */
export interface ItemView {
  /** Wird in den Dreh-Sockel gehängt (propPos/propRot/propSpin/propScale). */
  readonly group: Group;
  /** Zweiter Körper (Jo-Jo, Kendama-Kugel) — folgt subPos/subRot/subSpin. */
  readonly sub?: Object3D;
  /** Farbe der Schnur (stringPts), undefined = keine Schnur. */
  readonly stringColor?: number;
  /** Eigene Partikel statt des gemeinsamen Zauber-Poofs (Feuerzeug: Funken/Rauch aus f.poof). */
  readonly ownPoof?: boolean;
  /** Zustand aus dem Frame übernehmen (Lasche, Klinge, Kanäle …) — keine Allokation. */
  apply(f: ViewModelFrame): void;
}

export type ItemBuilder = (ctx: VmBuildCtx) => ItemView;

/** Kontur der Gegenstände (dunkles Violett-Schwarz wie die Hand). */
export const PROP_OUTLINE = 0x0d0c14;
