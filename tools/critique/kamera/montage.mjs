/** Kamera-Kritik: Montage der Speed-Shots (Zeilen: Kick an/aus, Spalten: Speed). */
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../../lib/devServer.mjs';
import { fovKickTarget } from './derive.mjs';
const SPEEDS = [250, 500, 800, 1200];
const b64 = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const browser = await launchBrowser();
try {
  for (const level of ['level1', 'level2']) {
    const cells = [1, 0].map((k) => SPEEDS.map((v) => `<figure><img src="${b64(`shots/critique/kamera/speed/${level}-${v}-kick${k}.png`)}"><figcaption>${v} u/s · ${k ? `FOV-Kick +${fovKickTarget(v).toFixed(1)}° (hFOV 4:3 ${(90 + fovKickTarget(v)).toFixed(1)}°)` : 'FOV-Kick aus (90°)'}</figcaption></figure>`).join('')).map((row, i) => `<div class="row"><div class="lab">${i === 0 ? 'Kick an (Default)' : 'Kick aus'}</div>${row}</div>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fcfcfb;font-family:Segoe UI,Arial;color:#0b0b0b}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:#52514e;font-size:13px}.row{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}.lab{width:90px;font-weight:600;font-size:13px;padding-top:100px}figure{margin:0}img{width:420px;display:block;image-rendering:pixelated}figcaption{font-size:12px;color:#52514e;padding:3px 0}</style></head><body><h1>${level}: gleicher Frame, Speed gesetzt, FOV-Kick an/aus</h1><p>FOV-Kick = 12·smoothstep(300,1000,v) + 2·smoothstep(1000,1800,v) (CameraRig.ts:306). Post-Streifen/CA folgen speed01 = (v−250)/850.</p>${cells}</body></html>`;
    const page = await browser.newPage({ viewport: { width: 1860, height: 700 } });
    await page.setContent(html);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `shots/critique/kamera/speed-montage-${level}.png`, fullPage: true });
    await page.close();
    console.log('PNG', `shots/critique/kamera/speed-montage-${level}.png`);
  }
} finally {
  await browser.close();
}
