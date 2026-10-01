/**
 * ViewModelFrame aus dem echten Controller (ViewHand) ohne Browser — wie liveFrame in
 * src/render/dev/viewmodelDev.ts: Gegenstand, Zustand, Trick festgehalten bei `at` oder frei bis `at`
 * gelaufen (`play` Hz). Für Werkzeuge und Tests (Plan 008).
 */
import { ViewHand } from '../../src/ui/hand/ViewHand';
import { makeHandInput } from '../../src/ui/hand/handMotion';
import type { GloveId, HeldItemId } from '../../src/engine/settingsTypes';
import type { ViewModelFrame } from '../../src/render/types';

export interface HandFrameSpec {
  readonly item: HeldItemId;
  readonly glove?: GloveId;
  readonly trick?: string;
  readonly at?: number;
  readonly play?: number;
  readonly opened?: boolean;
  readonly knifeOpen?: boolean;
}

export function handFrame(s: HandFrameSpec): ViewModelFrame {
  const h = new ViewHand();
  h.setAspect(16 / 9);
  h.setGlove(s.glove ?? 'classic');
  h.setItem(s.item);
  if (s.item === 'can') h.can.opened = s.opened ?? false;
  if (s.item === 'knife') h.knife.isOpen = s.knifeOpen ?? false;
  const inp = makeHandInput();
  if (s.trick && s.play) {
    for (let i = 0; i < 60; i++) h.update(1 / 60, inp);
    h.forceTrick(s.trick, -1);
    const steps = Math.round((s.at ?? 0) * s.play);
    for (let i = 0; i <= steps; i++) h.update(1 / s.play, inp);
    return h.output(true);
  }
  if (s.trick) h.forceTrick(s.trick, s.at ?? 0);
  for (let i = 0; i < 60; i++) {
    if (!s.trick && s.item === 'can') h.can.debugPlay('none');
    h.update(1 / 60, inp);
    if (s.trick) h.forceTrick(s.trick, s.at ?? 0);
  }
  h.update(1 / 60, inp);
  return h.output(true);
}
