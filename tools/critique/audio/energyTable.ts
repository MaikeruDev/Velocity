/**
 * Kritik-Linse AUDIO: Ziel-Energie und Layer als Tabelle über Speed × Chain × Sync
 * (reine Funktion aus src/audio/energy.ts), plus Zeit bis zum Layer-Abstieg nach
 * einem Stopp (EnergyModel mit Release 2.5 s, Layer-Regeln aus Music.onBeat nachgestellt).
 *
 *   npx tsx tools/critique/audio/energyTable.ts
 */
import { targetEnergy, layerForEnergy, layerToHold, EnergyModel, LAYER_THRESHOLDS } from '../../../src/audio/energy';
import type { MusicDrive } from '../../../src/audio/types';

const d = (p: Partial<MusicDrive>): MusicDrive => ({
  speed: p.speed ?? 0,
  onGround: p.onGround ?? false,
  hopChain: p.hopChain ?? 0,
  strafeSync: p.strafeSync ?? 0,
  airTime: 0,
  surfing: p.surfing ?? false,
  active: true,
});

console.log('Schwellen', LAYER_THRESHOLDS.join(' '));
console.log('\nZiel-Energie / Layer (Speed × Profil)');
const profiles: [string, Partial<MusicDrive>][] = [
  ['Laufen/W', { hopChain: 0, strafeSync: 0 }],
  ['Chain 3, sync 0.6', { hopChain: 3, strafeSync: 0.6 }],
  ['Chain 3, sync 0.8', { hopChain: 3, strafeSync: 0.8 }],
  ['Chain 12, sync 0.6', { hopChain: 12, strafeSync: 0.6 }],
  ['Chain 12, sync 0.8', { hopChain: 12, strafeSync: 0.8 }],
  ['Surf', { surfing: true, strafeSync: 0.8 }],
];
const speeds = [250, 320, 400, 450, 500, 550, 600, 700, 800, 900, 1000, 1200];
console.log('Profil'.padEnd(22) + speeds.map((s) => String(s).padStart(9)).join(''));
for (const [name, p] of profiles) {
  let row = name.padEnd(22);
  for (const s of speeds) {
    const e = targetEnergy(d({ ...p, speed: s }));
    row += `${e.toFixed(2)}/L${layerForEnergy(e)}`.padStart(9);
  }
  console.log(row);
}

// Speed, ab der ein Layer erreicht wird, je Profil
console.log('\nMindest-Speed für Layer (u/s)');
for (const [name, p] of profiles) {
  const need: string[] = [];
  for (let L = 1; L <= 4; L++) {
    let v = -1;
    for (let s = 0; s <= 2000; s += 5) {
      if (layerForEnergy(targetEnergy(d({ ...p, speed: s }))) >= L) {
        v = s;
        break;
      }
    }
    need.push(`L${L} ${v < 0 ? '—' : v}`);
  }
  console.log(name.padEnd(22) + need.join('  '));
}

// Stopp nach Flow: Energie von eingeschwungenem Zustand, dann Stillstand am Boden.
// Layer-Abstieg nach Music.onBeat: ≥ 9 Beats unter der Halteschwelle, dann auf Taktgrenze eine Stufe, danach je Takt.
console.log('\nStopp nach Flow (eingeschwungen), dann Stillstand — Energie und Layer über die Zeit');
const beat = 60 / 132;
for (const [label, from, to] of [
  ['L4 (Bhop 800, Chain 12) → Stand', d({ speed: 800, hopChain: 12, strafeSync: 0.8 }), d({ speed: 0, onGround: true })],
  ['L4 → Laufen 250', d({ speed: 800, hopChain: 12, strafeSync: 0.8 }), d({ speed: 250, onGround: true })],
  ['L3 (Bhop 600, Chain 5) → Stand', d({ speed: 600, hopChain: 5, strafeSync: 0.8 }), d({ speed: 0, onGround: true })],
  ['L3 → Landung, 1 s Boden 320, weiter', d({ speed: 600, hopChain: 5, strafeSync: 0.8 }), d({ speed: 320, onGround: true })],
] as [string, MusicDrive, MusicDrive][]) {
  const em = new EnergyModel();
  em.settle(from);
  let layer = layerForEnergy(em.value);
  let below = 0;
  const marks: string[] = [];
  const onsets: Record<number, number> = {};
  for (let b = 1; b <= 64; b++) {
    for (let k = 0; k < 4; k++) em.step(to, beat / 4);
    const e = em.value;
    const stay = layerToHold(e);
    if (stay < layer) {
      below++;
      if (b % 4 === 0 && below > 8) {
        layer = Math.max(stay, layer - 1);
        below = 5;
        onsets[layer] = b * beat;
      }
    } else below = 0;
    if (b % 4 === 0 && b <= 40) marks.push(`${(b * beat).toFixed(1)}s:${e.toFixed(2)}/L${layer}`);
  }
  console.log(`${label}\n   ${marks.join(' ')}\n   Abstieg auf Layer: ${Object.entries(onsets).map(([l, t]) => `L${l} @ ${t.toFixed(1)} s`).join(', ')}`);
}

// Kurzer Stopp: 1/2/3 s Stand mitten im L4-Flow, dann sofort wieder 800 u/s — fällt ein Layer?
console.log('\nKurzer Stopp mitten im L4-Flow (Stand x s, dann wieder 800/Chain 12)');
for (const pause of [0.5, 1, 1.5, 2, 3, 4]) {
  const em = new EnergyModel();
  const flow = d({ speed: 800, hopChain: 12, strafeSync: 0.8 });
  em.settle(flow);
  let minE = 1;
  let t = 0;
  const dt = 1 / 60;
  while (t < pause) {
    em.step(d({ speed: 0, onGround: true }), dt);
    t += dt;
  }
  minE = em.value;
  // Wieder anlaufen (Chain beginnt neu: 0..3 in den ersten 2 s, Speed von 320 auf 500)
  let tt = 0;
  let back = -1;
  while (tt < 10) {
    const sp = Math.min(800, 320 + tt * 120);
    const ch = Math.floor(tt / 0.75);
    em.step(d({ speed: sp, hopChain: ch, strafeSync: 0.8 }), dt);
    tt += dt;
    if (back < 0 && em.value >= LAYER_THRESHOLDS[4]) back = tt;
  }
  console.log(`   Stand ${pause} s: Energie fällt auf ${minE.toFixed(2)} (Halteschwelle L4 ${(0.86 - 0.05).toFixed(2)}, L3 ${(0.58 - 0.05).toFixed(2)}), zurück über L4-Schwelle nach ${back.toFixed(1)} s`);
}
