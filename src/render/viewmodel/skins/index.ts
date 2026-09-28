import type { ViewModelGlove } from '../../types';
import type { SkinBuilder } from '../vmBuild';
import type { GloveMaterialId } from './glove';
import { buildCatSkin } from './cat';
import { buildRobotSkin } from './robot';
import { buildSkeletonSkin } from './skeleton';

/**
 * Registry der Hand-Skins (Plan 007): Material-Varianten der Handschuh-Geometrie (classic, neon,
 * gold) oder eigene Geometrie je Rig-Slot (robot, skeleton, cat). Skins ohne
 * Eintrag zeichnet der Renderer als 'classic' (Vertrag render/types).
 */
export type SkinDef = { readonly material: GloveMaterialId } | { readonly build: SkinBuilder };

export const SKIN_REGISTRY: { readonly [K in ViewModelGlove]?: SkinDef } = {
  classic: { material: 'classic' },
  neon: { material: 'neon' },
  gold: { material: 'gold' },
  robot: { build: buildRobotSkin },
  skeleton: { build: buildSkeletonSkin },
  cat: { build: buildCatSkin },
};

/** Hat der Renderer diesen Skin (sonst Rückfall auf 'classic')? */
export function hasSkin(g: ViewModelGlove): boolean {
  return SKIN_REGISTRY[g] !== undefined;
}
