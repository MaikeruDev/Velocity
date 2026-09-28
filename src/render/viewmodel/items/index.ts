import type { ViewModelItem } from '../../types';
import type { ItemBuilder } from '../vmBuild';
import { buildCan } from './can';
import { buildCard } from './card';
import { buildCoin } from './coin';
import { buildKendama } from './kendama';
import { buildKnife } from './knife';
import { buildLighter } from './lighter';
import { buildPhone } from './phone';
import { buildSpinner } from './spinner';
import { buildYoyo } from './yoyo';

/**
 * Registry der Gegenstände (Plan 007): je Gegenstand ein Builder (lazy beim ersten Zeichnen bzw.
 * prewarm). Gegenstände ohne Eintrag zeichnet der Renderer nicht (= 'none', Vertrag render/types).
 * Vollständig seit Plan 007 Phase 2 (alle zehn HeldItemId außer 'none').
 */
export const ITEM_REGISTRY: { readonly [K in ViewModelItem]?: ItemBuilder } = {
  can: buildCan,
  card: buildCard,
  knife: buildKnife,
  spinner: buildSpinner,
  yoyo: buildYoyo,
  lighter: buildLighter,
  coin: buildCoin,
  kendama: buildKendama,
  phone: buildPhone,
};

export function hasItemView(i: ViewModelItem): boolean {
  return ITEM_REGISTRY[i] !== undefined;
}
