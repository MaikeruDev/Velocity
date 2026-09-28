/**
 * Level 4 — ASCII-Pläne aus der echten Geometrie (für den Entwurf):
 *  1) Höhenprofil entlang der Route (Weg → Höhe), mit Abschnittsmarken
 *  2) Draufsicht (Raster 200 u), Zeichen nach Brush-Tag
 *   npx tsx tools/critique/v2/level4/ascii.ts
 */
import { writeFileSync } from 'node:fs';
import { buildLevel4 } from './level4';

const def = buildLevel4({ measure: false });
const route = def.route ?? [];
const out: string[] = [];

// 1) Höhenprofil
{
  const W = 110;
  const H = 26;
  const pts: Array<[number, number, string | undefined]> = [];
  let s = 0;
  for (let i = 0; i < route.length; i++) {
    if (i > 0) s += Math.hypot(route[i].pos[0] - route[i - 1].pos[0], route[i].pos[2] - route[i - 1].pos[2]);
    pts.push([s, route[i].pos[1], route[i].note]);
  }
  const sMax = s;
  const yMin = Math.min(...pts.map((p) => p[1]));
  const yMax = Math.max(...pts.map((p) => p[1]));
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ' '));
  const col = (x: number): number => Math.min(W - 1, Math.round((x / sMax) * (W - 1)));
  const row = (y: number): number => Math.min(H - 1, Math.round(((yMax - y) / (yMax - yMin)) * (H - 1)));
  for (let i = 1; i < pts.length; i++) {
    const [s0, y0] = pts[i - 1];
    const [s1, y1] = pts[i];
    const n = Math.max(2, Math.ceil(((s1 - s0) / sMax) * W * 2));
    for (let k = 0; k <= n; k++) {
      const x = s0 + ((s1 - s0) * k) / n;
      const y = y0 + ((y1 - y0) * k) / n;
      grid[row(y)][col(x)] = route[i].surf ? '~' : route[i - 1].jump ? '^' : '▪';
    }
  }
  const labels: string[] = [];
  for (const [x, , note] of pts) {
    if (!note || !/Start|E1|CP|E2|Kante|E4|Steg|Krone|Absprung|Launch|Ziel/.test(note)) continue;
    labels.push(`${col(x).toString().padStart(3)}:${note}`);
  }
  out.push(`Höhenprofil (Weg ${Math.round(sMax)} u → ${W} Spalten, Höhe ${Math.round(yMin)}…${Math.round(yMax)} u → ${H} Zeilen; ▪ Boden, ^ Sprung, ~ Surf)`);
  grid.forEach((r, i) => {
    const y = yMax - ((yMax - yMin) * i) / (H - 1);
    out.push(`${Math.round(y).toString().padStart(6)} |${r.join('')}`);
  });
  out.push(`       +${'-'.repeat(W)}`);
  out.push(`Marken (Spalte:Notiz): ${labels.join('  ')}`);
}

// 2) Draufsicht
{
  const C = 200;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  const boxes: Array<{ min: number[]; max: number[]; tag: string; y: number }> = [];
  for (const b of def.brushes) {
    if (b.collide === false) continue;
    let pts: number[][] = [];
    if (b.type === 'hull') pts = b.points.map((p) => [...p]);
    else if (b.type === 'box' || b.type === 'wedge') pts = [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.max[2]]];
    else continue;
    const min = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.min(...pts.map((p) => p[2]))];
    const max = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[2]))];
    if (b.rotY) continue;
    boxes.push({ min, max, tag: b.tag ?? b.mat, y: max[1] });
    x0 = Math.min(x0, min[0]);
    x1 = Math.max(x1, max[0]);
    z0 = Math.min(z0, min[2]);
    z1 = Math.max(z1, max[2]);
  }
  const W = Math.ceil((x1 - x0) / C);
  const H = Math.ceil((z1 - z0) / C);
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', y: -Infinity })));
  const chOf = (tag: string): string => {
    if (tag.startsWith('core')) return '█';
    if (tag.startsWith('start')) return 'S';
    if (tag.startsWith('finish')) return 'Z';
    if (tag.startsWith('backstop')) return '▌';
    if (/^p[123]/.test(tag) || tag.startsWith('krone')) return 'C';
    if (tag.startsWith('trench')) return '=';
    if (tag.startsWith('terrace') || tag.startsWith('lip')) return 'K';
    if (tag.startsWith('w2in')) return 'i';
    if (tag.startsWith('w1')) return '1';
    if (tag.startsWith('w2out')) return '2';
    if (tag.startsWith('w3')) return '3';
    if (tag.startsWith('w4')) return '4';
    if (tag.startsWith('steg') && !tag.includes('Board')) return '»';
    if (tag.startsWith('absprung')) return '»';
    if (tag.startsWith('abf')) return '~';
    if (tag.startsWith('cp') && tag.includes('pad')) return 'C';
    if (tag.startsWith('run') || tag.startsWith('catch')) return '·';
    return '';
  };
  for (const b of boxes) {
    const ch = chOf(b.tag);
    if (!ch) continue;
    for (let gz = Math.floor((b.min[2] - z0) / C); gz <= Math.floor((b.max[2] - z0 - 1) / C); gz++) {
      for (let gx = Math.floor((b.min[0] - x0) / C); gx <= Math.floor((b.max[0] - x0 - 1) / C); gx++) {
        const cell = grid[gz]?.[gx];
        if (!cell) continue;
        // Höhere Fläche gewinnt (Draufsicht), der Kern immer.
        if (ch === '█' || (b.y > cell.y && cell.ch !== '█')) {
          cell.ch = ch;
          cell.y = b.y;
        }
      }
    }
  }
  out.push('');
  out.push(`Draufsicht (1 Zeichen = ${C} u; Norden = oben, Osten = rechts; x ${Math.round(x0)}…${Math.round(x1)}, z ${Math.round(z0)}…${Math.round(z1)})`);
  out.push('Legende: █ Kern · S Start · · Anlauf · 1 E1 · C Podest/Krone/CP-Pad · 2 E2 außen · i E2 innen · = Graben · 3/K E3 Rampe/Kante · 4 E4 · » Steg/Sprungbrett · ~ Abfahrt · Z Ziel');
  for (const r of grid) out.push(`  ${r.map((c) => c.ch).join('').replace(/\s+$/, '')}`);
}
writeFileSync('shots/v2/level4/ascii.txt', out.join('\n') + '\n');
console.log(out.join('\n'));
