import type { BrushDef, LevelFile, MaterialId } from '../../world/level/LevelFormat';

/**
 * Nur für die Render-Vorschau (?level=__materials): jedes Material als Block,
 * dazu Rampe, Surf-Prisma, getönte Accent-Varianten und alle Trigger-Arten.
 * So lassen sich Texturen/Trims prüfen, ohne ein echtes Level anzufassen.
 */
const MATS: MaterialId[] = ['floor', 'wall', 'metal', 'surf', 'accent', 'hazard', 'start', 'checkpoint', 'finish', 'dark'];

export function materialGallery(): LevelFile {
  const brushes: BrushDef[] = [
    { type: 'box', min: [-256, -128, -2200], max: [4096, -64, 512], mat: 'dark', tag: 'base', trim: false },
  ];
  MATS.forEach((mat, i) => {
    const x = i * 384;
    brushes.push({ type: 'box', min: [x, -64, -256], max: [x + 256, 32, 0], mat, tag: mat });
    // Zweite Reihe: gleiche Materialien als niedrige Plattform + Stufe davor.
    brushes.push({ type: 'box', min: [x, -64, -768], max: [x + 256, 0, -512], mat, tag: `${mat}-low` });
    brushes.push({ type: 'box', min: [x + 64, 0, -704], max: [x + 192, 18, -576], mat, tag: `${mat}-step` });
  });
  brushes.push(
    { type: 'box', min: [0, -64, -1400], max: [256, 64, -1144], mat: 'accent', tint: '#33f0ff', tag: 'accent-cyan' },
    { type: 'box', min: [384, -64, -1400], max: [640, 64, -1144], mat: 'accent', tint: '#ffb13d', tag: 'accent-amber' },
    { type: 'box', min: [768, -64, -1400], max: [1024, 64, -1144], mat: 'floor', tint: '#ff9ad8', tag: 'floor-pink' },
    { type: 'wedge', min: [1152, -64, -1400], max: [1664, 128, -1144], rise: '+x', lowY: 0, mat: 'metal', tag: 'ramp' },
    {
      type: 'prism',
      axis: 'z',
      from: -2000,
      to: -1500,
      profile: [
        [1900, -64],
        [2400, -64],
        [2150, 256],
      ],
      mat: 'surf',
      tag: 'surf',
    },
    { type: 'box', min: [2600, -64, -1400], max: [2856, 64, -1144], mat: 'hazard', rotY: 20, tag: 'hazard-rot' },
  );
  return {
    version: 1,
    id: '__materials',
    name: 'MATERIALS',
    spawn: { pos: [1700, 0, 600], yaw: 0 },
    killY: -2000,
    environment: {
      skyTop: '#0e0826',
      skyHorizon: '#ff5e7a',
      skyBottom: '#1a0b2e',
      fogColor: '#5a2250',
      fogNear: 900,
      fogFar: 4200,
      sunDir: [0.45, 0.55, -0.7],
      sunColor: '#ffd6a0',
      ambientSky: '#6a5aa8',
      ambientGround: '#2a1430',
      trimColor: '#33f0ff',
      trimColorAlt: '#ff3fd0',
      voidY: -2400,
    },
    brushes,
    triggers: [
      { kind: 'start', min: [2304, 32, -256], max: [2560, 160, 0] },
      { kind: 'checkpoint', order: 1, min: [2688, 32, -256], max: [2944, 160, 0] },
      { kind: 'finish', min: [3072, 32, -256], max: [3328, 160, 0] },
    ],
  };
}
