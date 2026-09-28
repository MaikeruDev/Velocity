/**
 * Level-Vorschau für den Level-Strang (nicht das Spiel-Rendering): flach
 * beleuchtete Brushes, Trims, Trigger und Route. Dient nur dazu, Layouts per
 * Screenshot zu prüfen (tools/levels/shoot.mjs).
 *
 *   preview.html?level=level1&view=top        Draufsicht mit Route
 *   preview.html?level=level1&view=node:12    Ego-Sicht an Route-Knoten 12 Richtung 13
 *   preview.html?level=level1&view=iso        Schrägansicht
 *   preview.html?level=level1&view=cam:x,y,z,tx,ty,tz   freie Kamera
 */
import * as THREE from 'three';
import { compileLevel } from '../../src/world/level/compileLevel';
import type { EnvironmentDef, LevelFile, MaterialId } from '../../src/world/level/LevelFormat';

declare global {
  interface Window {
    __previewReady?: boolean;
    __previewError?: string;
  }
}

const MAT: Record<MaterialId, string> = {
  floor: '#9a9cb4',
  wall: '#5d6282',
  metal: '#7a8794',
  surf: '#48b8e0',
  accent: '#b27cff',
  hazard: '#ffc233',
  duck: '#33f0ff',
  marking: '#ffffff',
  light: '#ffffff',
  start: '#3dff9a',
  checkpoint: '#ffd166',
  finish: '#ff4fd8',
  dark: '#221a33',
};

function skyTexture(env: EnvironmentDef): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D-Kontext fehlt');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, env.skyTop);
  grad.addColorStop(0.5, env.skyHorizon);
  grad.addColorStop(1, env.skyBottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textSprite(text: string, color: string, size: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D-Kontext fehlt');
  g.font = 'bold 40px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = '#000';
  g.strokeText(text, 64, 32);
  g.fillStyle = color;
  g.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(size * 2, size, 1);
  s.renderOrder = 10;
  return s;
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const id = q.get('level') ?? 'level1';
  const view = q.get('view') ?? 'top';
  const res = await fetch(`/levels/${id}.json`);
  const def = (await res.json()) as LevelFile;
  const level = compileLevel(def);
  const env = def.environment;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = skyTexture(env);
  const top = view === 'top';
  if (!top) scene.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
  scene.add(new THREE.HemisphereLight(env.ambientSky, env.ambientGround, 1.6));
  const sun = new THREE.DirectionalLight(env.sunColor, 1.8);
  sun.position.set(env.sunDir[0], env.sunDir[1], env.sunDir[2]);
  scene.add(sun);

  const pos: number[] = [];
  const col: number[] = [];
  const trim: number[] = [];
  const c = new THREE.Color();
  for (const b of level.brushes) {
    // Unsichtbare Clips wie im Spiel weglassen.
    if (!b.visible) continue;
    c.set(MAT[b.mat]);
    if (b.tint) c.lerp(new THREE.Color(b.tint), 0.7);
    for (const f of b.faces) {
      const v = f.vertices;
      for (let i = 1; i + 1 < v.length; i++) {
        for (const p of [v[0], v[i], v[i + 1]]) {
          pos.push(p.x, p.y, p.z);
          col.push(c.r, c.g, c.b);
        }
      }
      if (f.walkable && b.trim) {
        for (let i = 0; i < v.length; i++) {
          const a = v[i];
          const n = v[(i + 1) % v.length];
          trim.push(a.x, a.y + 0.5, a.z, n.x, n.y + 0.5, n.z);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(trim, 3));
  scene.add(new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: env.trimColor, fog: !top })));

  const grid = new THREE.GridHelper(40000, 160, env.trimColor, env.trimColorAlt ?? env.trimColor);
  grid.position.y = env.voidY;
  scene.add(grid);

  // Route + Trigger (Debug-Overlay)
  const route = def.route ?? [];
  const showOverlay = top || q.has('overlay');
  if (showOverlay && route.length) {
    const pts = route.map((n) => new THREE.Vector3(n.pos[0], n.pos[1] + 24, n.pos[2]));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: !top })));
    route.forEach((n, i) => {
      const sp = n.minSpeed ?? 250;
      const t = Math.min(1, Math.max(0, (sp - 250) / 600));
      const nc = new THREE.Color().setHSL(0.6 - 0.6 * t, 1, 0.55);
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(n.jump ? 40 : 24, 24, n.jump ? 40 : 24),
        new THREE.MeshBasicMaterial({ color: n.crouch ? '#ff2020' : nc, depthTest: !top }),
      );
      m.position.set(n.pos[0], n.pos[1] + 24, n.pos[2]);
      scene.add(m);
      if (top) {
        const label = textSprite(String(i), '#ffffff', 90);
        label.position.set(n.pos[0] + 60, n.pos[1] + 60, n.pos[2] - 40);
        scene.add(label);
      }
    });
  }
  if (showOverlay) {
    const tc: Record<string, string> = { start: '#3dff9a', checkpoint: '#ffd166', finish: '#ff4fd8', kill: '#ff2020' };
    for (const t of level.triggers) scene.add(new THREE.Box3Helper(t.bounds, new THREE.Color(tc[t.kind])));
  }

  // Kamera
  const bounds = level.bounds;
  const center = bounds.getCenter(new THREE.Vector3());
  let camera: THREE.Camera;
  const aspect = innerWidth / innerHeight;
  const label: string[] = [`${def.name} — ${view}`];
  if (top) {
    // Nur Kollisions-Brushes bestimmen den Ausschnitt (Deko-Türme liegen weit draußen).
    const core = new THREE.Box3();
    for (const b of level.brushes) if (b.collide) core.union(b.bounds);
    const cc = core.getCenter(new THREE.Vector3());
    const size = core.getSize(new THREE.Vector3());
    const half = Math.max(size.x / aspect, size.z) / 2 + 300;
    const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 1, 50000);
    cam.position.set(cc.x, bounds.max.y + 5000, cc.z);
    cam.up.set(0, 0, -1);
    cam.lookAt(cc.x, 0, cc.z);
    camera = cam;
    label.push(`Norden (-Z) oben · Ausschnitt ${Math.round(size.x)} × ${Math.round(size.z)} u`);
  } else {
    // CS-Konvention: 90° horizontal bei 4:3, Breitbild Hor+ → vertikal fest 73.74°.
    const vfov = (2 * Math.atan(Math.tan(Math.PI / 4) * 0.75) * 180) / Math.PI;
    const cam = new THREE.PerspectiveCamera(vfov, aspect, 4, 60000);
    if (view.startsWith('node:')) {
      const i = Number(view.slice(5));
      const n = route[i];
      const next = route[Math.min(route.length - 1, i + 1)];
      cam.position.set(n.pos[0], n.pos[1] + 64, n.pos[2]);
      const dx = next.pos[0] - n.pos[0];
      const dz = next.pos[2] - n.pos[2];
      const d = Math.hypot(dx, dz) || 1;
      cam.lookAt(n.pos[0] + (dx / d) * 1000, n.pos[1] + 64 - 60, n.pos[2] + (dz / d) * 1000);
      const flags = (['jump', 'crouch', 'surf', 'air', 'precision'] as const).filter((k) => n[k] === true);
      label.push(`Knoten ${i}${n.note ? ` [${n.note}]` : ''}${flags.length ? ` (${flags.join(', ')})` : ''} → ${i + 1} · minSpeed ${n.minSpeed ?? '-'}`);
    } else if (view.startsWith('cam:')) {
      const v = view.slice(4).split(',').map(Number);
      cam.position.set(v[0], v[1], v[2]);
      cam.lookAt(v[3], v[4], v[5]);
    } else {
      const size = bounds.getSize(new THREE.Vector3());
      cam.position.set(center.x + size.x * 0.1, center.y + 3500, center.z + size.z * 0.55);
      cam.lookAt(center);
    }
    camera = cam;
  }
  const el = document.getElementById('label');
  if (el) el.textContent = label.join('\n');
  renderer.render(scene, camera);
  window.__previewReady = true;
}

main().catch((e: unknown) => {
  window.__previewError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(e);
});
