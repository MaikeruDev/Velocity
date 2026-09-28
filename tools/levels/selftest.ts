/**
 * Selbsttest des Level-Validators — läuft am Ende von `npm run levels:check`
 * mit, einzeln: `npx tsx tools/levels/selftest.ts`.
 *
 * Nimmt level1.json/level2.json, baut gezielt Fehler ein und prüft, dass
 * `validateLevel` jeden davon meldet — ein Validator, der nie rot wird, ist
 * wertlos. Statische Fälle laufen ohne Physik-Stufe (schnell), die
 * Physik-Fälle mit. Exit-Code 1, wenn ein Fall durchrutscht.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateLevel } from '../validate-levels';
import type { BrushDef, LevelFile, RouteNode, TriggerDef, Vec3Tuple } from '../../src/world/level/LevelFormat';

type Mutable = { -readonly [K in keyof LevelFile]: LevelFile[K] };

const shiftZ = (p: Vec3Tuple, dz: number): Vec3Tuple => [p[0], p[1], p[2] + dz];
const shiftY = (p: Vec3Tuple, dy: number): Vec3Tuple => [p[0], p[1] + dy, p[2]];

interface Case {
  readonly name: string;
  readonly file: 'level1' | 'level2';
  readonly expect: RegExp;
  readonly physics?: boolean;
  readonly mutate: (l: Mutable) => void;
}

const cases: Case[] = [
  {
    // Level 2: das Ziel liegt nach Norden (−z) hinter einer echten Lücke (Level 1 endet über einer Auffangfläche).
    name: 'Ziel 200 u weiter weg',
    file: 'level2',
    expect: /Reichweite/,
    mutate: (l) => {
      const far = (tag: string | undefined): boolean => tag === 'finish' || tag === 'backstop' || tag === 'finishArch-post' || tag === 'finishArch-lintel';
      l.brushes = l.brushes.map((b: BrushDef) => (far(b.tag) && b.type === 'box' ? { ...b, min: shiftZ(b.min, -200), max: shiftZ(b.max, -200) } : b));
      l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'finish' ? { ...t, min: shiftZ(t.min, -200), max: shiftZ(t.max, -200) } : t));
      const r = l.route ?? [];
      const last = r[r.length - 1];
      l.route = [...r.slice(0, -1), { ...last, pos: shiftZ(last.pos, -200) }];
    },
  },
  { name: 'Spawn im Boden', file: 'level1', expect: /Spawn .*Solid/, mutate: (l) => (l.spawn = { pos: [l.spawn.pos[0], -10, l.spawn.pos[2]], yaw: 0 }) },
  {
    name: 'Koplanare Kopie (Z-Fighting)',
    file: 'level1',
    expect: /Z-Fighting/,
    mutate: (l) => {
      const s = l.brushes.find((b: BrushDef) => b.tag === 'start');
      if (s && s.type === 'box') l.brushes = [...l.brushes, { ...s, min: [s.min[0] + 32, s.min[1] - 10, s.min[2] + 32], tag: 'dup' }];
    },
  },
  {
    name: 'Crouch-Flag fehlt',
    file: 'level1',
    expect: /nicht erreichbar|stößt/,
    mutate: (l) => (l.route = (l.route ?? []).map((n: RouteNode) => (n.crouch ? { ...n, crouch: false } : n))),
  },
  {
    name: 'Decke über der Hop-Reihe',
    file: 'level1',
    expect: /stößt/,
    mutate: (l) => {
      const h = l.brushes.find((b: BrushDef) => b.tag === 'hop3');
      if (h && h.type === 'box')
        l.brushes = [...l.brushes, { type: 'box', min: [h.min[0], h.max[1] + 90, h.min[2] - 200], max: [h.max[0], h.max[1] + 110, h.max[2] + 200], mat: 'wall', tag: 'ceiling' }];
    },
  },
  {
    name: 'Checkpoint-Reihenfolge',
    file: 'level1',
    expect: /Checkpoint-Reihenfolge|vor dem vorherigen/,
    mutate: (l) => (l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'checkpoint' && t.order === 1 ? { ...t, order: 5 } : t))),
  },
  { name: 'killY über dem Ziel', file: 'level1', expect: /killY/, mutate: (l) => (l.killY = 0) },
  {
    name: 'Medaillen vertauscht (Gold langsamer als Silber)',
    file: 'level2',
    expect: /Medaillen nicht streng fallend/,
    mutate: (l) => (l.medals = l.medals ? { ...l.medals, gold: l.medals.silver + 1 } : { bronze: 30, silver: 20, gold: 25, velocity: 12, author: 10 }),
  },
  {
    name: 'VELOCITY-Medaille schneller als der Autor',
    file: 'level1',
    expect: /Medaillen nicht streng fallend/,
    mutate: (l) => (l.medals = l.medals ? { ...l.medals, velocity: l.medals.author - 0.5 } : { bronze: 30, silver: 20, gold: 15, velocity: 9, author: 10 }),
  },
  {
    // Slalom statt Lauf-Lücke 1: unter den Erstkontakt-Lücken liegen Auffangmulden — dort ist Laufen erlaubt.
    name: 'Lücke ohne jump-Flag',
    file: 'level1',
    expect: /Laufstrecke ohne Boden/,
    mutate: (l) => (l.route = (l.route ?? []).map((n: RouteNode) => (n.note === 'Slalom' ? { ...n, jump: false } : n))),
  },
  {
    name: 'Deko im Weg',
    file: 'level1',
    expect: /Deko .*schneidet/,
    mutate: (l) => {
      l.brushes = [...l.brushes, { type: 'box', min: [-40, -32, 0], max: [40, 200, 80], mat: 'dark', collide: false, tag: 'decoInStart' }];
    },
  },
  {
    name: 'Checkpoint-Spawn an der Plateaukante',
    file: 'level1',
    expect: /steht an einer Kante|über der Kante/,
    mutate: (l) =>
      (l.triggers = l.triggers.map((t: TriggerDef) =>
        t.kind === 'checkpoint' && t.order === 1 && t.spawn ? { ...t, spawn: { ...t.spawn, pos: [256, t.spawn.pos[1], t.spawn.pos[2]] } } : t,
      )),
  },
  {
    name: 'Kill-Zone direkt unter der Hop-Reihe',
    file: 'level1',
    expect: /Kill-Zone .*(Oberkante|Route-Knoten)/,
    mutate: (l) => (l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'kill' && t.tag === 'kill-row' ? { ...t, max: [t.max[0], 40, t.max[2]] } : t))),
  },
  // ── Physik-Fälle ────────────────────────────────────────────────────────
  {
    name: 'Slalom-Insel fehlt (Bot-Durchlauf)',
    file: 'level1',
    physics: true,
    expect: /Bot-Durchlauf sync 1\.0 scheitert|Respawn CP3/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => !(b.tag ?? '').startsWith('slalom3'))),
  },
  {
    // Ohne Auffangfläche unter der Rutsche stirbt jeder, der nicht surfen kann.
    name: 'Auffangfläche der Rutsche fehlt',
    file: 'level1',
    physics: true,
    expect: /Surf-Rutsche fängt nicht jeden/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'chuteCatch')),
  },
  {
    // Ohne Bande fliegt, wer von der Flanke rutscht, mit Auto-Hop seitlich von der Auffangfläche.
    name: 'Bande an der Rutsche fehlt',
    file: 'level1',
    physics: true,
    expect: /Surf-Rutsche fängt nicht jeden/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'chuteRail')),
  },
  {
    // Ohne Mulde unter Lauf-Lücke 2 stirbt mit gehaltener Leertaste wieder jede zweite Hop-Phase.
    name: 'Auffangmulde fehlt (Erstkontakt)',
    file: 'level1',
    physics: true,
    expect: /Erstkontakt tödlich/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'catch-run2')),
  },
  {
    // Ein vergessener Graben in der Hop-Reihe: der Fehlsprung dort endet wieder im Respawn.
    name: 'Graben in der Hop-Reihe fehlt (Grundkurs-Ausstieg)',
    file: 'level1',
    physics: true,
    expect: /Grundkurs-Fehlsprung ohne Ausstieg/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'catch-row3')),
  },
  {
    // Der alte Ziel-Torbalken (fin.u0 + 96, 560 u hoch) lag im Launch-Flug: die Kamera flog hindurch.
    name: 'Torbalken im Finale-Flug (Deko auf der Flugbahn)',
    file: 'level2',
    physics: true,
    expect: /Deko auf der Flugbahn/,
    mutate: (l) => {
      const f = l.brushes.find((b: BrushDef) => b.tag === 'finish');
      if (f && f.type === 'box')
        l.brushes = [
          ...l.brushes,
          { type: 'box', min: [f.min[0], f.max[1] + 560, f.max[2] - 124], max: [f.max[0], f.max[1] + 616, f.max[2] - 68], mat: 'accent', collide: false, tag: 'oldLintel' },
        ];
    },
  },
  {
    // Ohne Vorfeld liegt zwischen Ring und E1 wieder eine Lücke vor der 131 u hohen E1-Stirn.
    name: 'Vorfeld fehlt (Todesband an der Ausfahrt)',
    file: 'level2',
    physics: true,
    expect: /Ausfahrt hat Todesstreifen mit Auto-Hop/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'apron')),
  },
  {
    // Auffangfläche unter S0 abgesenkt: wer von E1 auf S0 fällt und nicht surft, stirbt wieder.
    name: 'S0-Auffangfläche fehlt (erste Surf-Berührung tödlich)',
    file: 'level2',
    physics: true,
    expect: /S0 fängt Nicht-Surfer nicht/,
    mutate: (l) => (l.brushes = l.brushes.map((b: BrushDef) => (b.tag === 's0Catch' && b.type === 'wedge' ? { ...b, min: shiftY(b.min, -2000), max: shiftY(b.max, -2000) } : b))),
  },
  {
    name: 'Rückweg aus der S0-Grube fehlt',
    file: 'level2',
    physics: true,
    expect: /Rückweg von der S0-Fläche nicht begehbar/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 's0Back')),
  },
  {
    name: 'Folgerampe S2 zu hoch (Stirnfläche im Übergang)',
    file: 'level2',
    physics: true,
    expect: /Surf .*scheitert|Nahtstopp|Respawn CP2|Bot-Durchlauf/,
    mutate: (l) => (l.brushes = l.brushes.map((b: BrushDef) => (b.tag === 'surf2' && b.type === 'hull' ? { ...b, points: b.points.map((p) => shiftY(p, 200)) } : b))),
  },
];

export interface SelftestResult {
  readonly cases: number;
  readonly failed: number;
  readonly lines: string[];
}

export function runSelftest(): SelftestResult {
  const base = {
    level1: JSON.parse(readFileSync('public/levels/level1.json', 'utf8')) as LevelFile,
    level2: JSON.parse(readFileSync('public/levels/level2.json', 'utf8')) as LevelFile,
  };
  const clone = (f: 'level1' | 'level2'): Mutable => JSON.parse(JSON.stringify(base[f])) as Mutable;
  const lines: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const l = clone(c.file);
    c.mutate(l);
    const r = validateLevel(c.name, l, { physics: c.physics === true });
    const hit = [...r.errors, ...r.warnings].find((e) => c.expect.test(e));
    if (!hit) failed++;
    lines.push(`${hit ? '✓' : '✗'} ${c.name}: ${hit ?? `nicht erkannt (${r.errors.length} Fehler: ${r.errors.slice(0, 2).join(' | ')})`}`);
  }
  for (const f of ['level1', 'level2'] as const) {
    const clean = validateLevel(f, clone(f), { physics: false });
    if (clean.errors.length) failed++;
    lines.push(`${clean.errors.length ? '✗' : '✓'} ${f} unverändert (statisch): ${clean.errors.length} Fehler`);
  }
  return { cases: cases.length + 2, failed, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runSelftest();
  for (const l of r.lines) console.log(l);
  console.log(r.failed ? `✗ ${r.failed} Fälle durchgerutscht` : `✓ alle ${r.cases} Fälle erkannt`);
  if (r.failed) process.exitCode = 1;
}
