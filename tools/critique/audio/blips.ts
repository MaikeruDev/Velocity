/**
 * Kritik-Linse AUDIO: Blip-Tonfolge über 100 Hops. npx tsx tools/critique/audio/blips.ts
 *
 * Seit Plan 003 sind die Blips Shepard-Töne (blipPitchClass + shepardPartials): die
 * Stufe wächst unbegrenzt, die spektrale Hüllkurve steht fest. Die alte Fassung
 * indizierte eine feste Tonleiter und lieferte NaN (Prüfung 27.09.). Gemessen wird
 * hier der gewichtete Tonschwerpunkt (log2 Hz) — ein "Oktav-Rücksprung" wäre ein
 * Abfall > 0.5 Oktaven zwischen zwei Hops. Das Timing (32tel-Raster) hängt am
 * Sequencer und wird nur gerendert sinnvoll gemessen (npm run audio:check).
 */
import { blipIndex, blipPitchClass, shepardPartials } from '../../../src/audio/Sfx';

const NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
const centroid = (step: number): number => {
  const { hz, w } = shepardPartials(step);
  let c = 0;
  for (let k = 0; k < hz.length; k++) c += w[k] * Math.log2(hz[k]);
  return c;
};

const seq: string[] = [];
for (let c = 2; c <= 24; c++) seq.push(NAMES[blipPitchClass(blipIndex(c))]);
console.log('Tonklassen Chain 2..24:', seq.join(' '));

let drops = 0;
let maxDrop = 0;
let bad = 0;
for (let c = 3; c <= 100; c++) {
  const a = centroid(blipIndex(c - 1));
  const b = centroid(blipIndex(c));
  if (!Number.isFinite(a) || !Number.isFinite(b)) bad++;
  const d = a - b;
  if (d > maxDrop) maxDrop = d;
  if (d > 0.5) drops++;
}
console.log(`Tonschwerpunkt Chain 3..100: Rücksprünge > 0.5 Okt ${drops}, größter Abfall ${maxDrop.toFixed(2)} Okt, nicht endlich ${bad}`);
