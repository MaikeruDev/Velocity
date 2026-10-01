/**
 * Griff-Audit als Zahlen (Plan 008): je Gegenstand (Ruhe + wichtige Trick-Posen) Kontakt der Hand-Teile mit
 * dem Gegenstand — Durchdringung (< 0), Kontakt (≤ 0.35 Einheiten ≈ 3.5 mm) oder Luft.
 *   npx tsx tools/hand-contact.ts [item …] [--glove cat]
 * Spalten: kleinster Abstand je Handteil (Einheiten ~1 cm); "pen" tiefste Durchdringung, "touch" Teile in Kontakt.
 */
import { HAND_PART_NAMES } from '../src/ui/hand/handShape';
import { itemPoints, measure } from './lib/handContact';
import { handFrame } from './lib/handLive';
import type { HeldItemId } from '../src/engine/settingsTypes';

const args = process.argv.slice(2);
const gi = args.indexOf('--glove');
const glove = gi >= 0 ? args[gi + 1] : 'classic';
const only = args.filter((a, i) => !a.startsWith('--') && (gi < 0 || i !== gi + 1));

const CASES: readonly (readonly [HeldItemId, string, number, Record<string, unknown>?])[] = [
  ['card', 'none', 0],
  ['can', 'none', 0],
  ['can', 'none', 0, { opened: true }],
  ['knife', 'none', 0],
  ['knife', 'none', 0, { knifeOpen: true }],
  ['yoyo', 'none', 0],
  ['spinner', 'none', 0],
  ['coin', 'none', 0],
  ['lighter', 'none', 0],
  ['kendama', 'none', 0],
  ['phone', 'none', 0],
];

const TOUCH = 0.35;
for (const [item, trick, at, extra] of CASES) {
  if (only.length && !only.includes(item)) continue;
  const f = handFrame({ item, trick: trick === 'none' ? undefined : trick, at, glove: glove as never, ...(extra ?? {}) });
  const pts = itemPoints(f);
  const r = measure(f, pts);
  const touch: string[] = [];
  const pen: string[] = [];
  r.perPart.forEach((d, i) => {
    if (d < -0.15) pen.push(`${HAND_PART_NAMES[i]} ${d.toFixed(2)}`);
    else if (d <= TOUCH) touch.push(`${HAND_PART_NAMES[i]} ${d.toFixed(2)}`);
  });
  const tag = `${item}${extra ? ' ' + JSON.stringify(extra) : ''}${trick !== 'none' ? ` ${trick}@${at}` : ''}`;
  console.log(`${tag.padEnd(34)} gap ${r.gap.toFixed(2).padStart(6)}  | DURCH: ${pen.join(', ') || '-'}  | KONTAKT: ${touch.join(', ') || '-'}`);
}
