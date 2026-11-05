/**
 * Trailer-Aufnahme (Werkzeug-Bibliothek): echtes Spiel in Chromium (ANGLE-GPU), Viewport 1920×1080 →
 * Low-Res-Canvas 480×270 (Pixelhöhe 270, ganzzahlig 4×). Aufgenommen wird DETERMINISTISCH im Film-Modus
 * des Debug-Handles: pro Videoframe genau 1/60 s Spielzeit (__vel.advanceFrame), danach liest der
 * selbe Task das Canvas (preserveDrawingBuffer ist aus — erst nach dem Compositing wäre es leer).
 * Hochskaliert wird erst in ffmpeg (Nearest), damit die PNGs klein bleiben.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../lib/devServer.mjs';

export const FPS = 60;
export const BPM = 132;
export const FRAMES_PER_BEAT = (FPS * 60) / BPM;
export const FRAMES_DIR = 'media/footage/frames';

/** Saubere Bild-Einstellungen für Werbematerial: HUD an, Showkeys/Hinweise/Ghost aus. */
export const BASE_SETTINGS = {
  showSpeedometer: true,
  showKeys: false,
  showHints: false,
  showHand: true,
  ghost: false,
  fullscreenOnStart: false,
  motionFx: 1,
  headBob: 1,
  fovKick: 1,
  render: { pixelHeight: 270, speedLines: 1 },
};

export async function openGame(port) {
  const srv = await startDevServer(port);
  const browser = await launchBrowser();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return {
    page,
    errors,
    close: async () => {
      await browser.close();
      await srv.close();
    },
  };
}

/** Level im Echtzeit-Modus starten (Laden braucht den Loop), danach Film-Modus. */
export async function startLevel(page, level, settings) {
  await page.evaluate(() => window.__vel.film({ on: false }));
  await page.evaluate((s) => {
    window.__vel.unlockAll();
    window.__vel.setSettings(s);
  }, settings);
  const ok = await page.evaluate((lv) => window.__vel.start(lv, { lockless: true }), level);
  if (!ok) throw new Error(`start ${level} fehlgeschlagen`);
  await page.waitForTimeout(400);
  const lowres = await page.evaluate(() => {
    const c = document.getElementById('vel-canvas');
    return [c.width, c.height];
  });
  if (lowres[0] !== 480 || lowres[1] !== 270) throw new Error(`Canvas ${lowres.join('×')} statt 480×270`);
}

/**
 * Frames aufnehmen: `n` Frames à 1/60 s, PNG nach media/footage/frames/<take>/NNNNN.png und Telemetrie je
 * Frame. `perFrame(i)` (optional, Node-Seite) darf vor jedem Frame etwas im Spiel setzen (Kamera, Trick).
 * `until(s, i)` beendet früher.
 */
export async function recordTake(page, take, n, opts = {}) {
  const dir = `${FRAMES_DIR}/${take}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tele = [];
  const t0 = Date.now();
  let i = 0;
  for (; i < n; i++) {
    if (opts.perFrame) await opts.perFrame(i);
    const r = await page.evaluate(({ dt, dry }) => {
      const v = window.__vel;
      v.advanceFrame(dt);
      const png = dry ? '' : document.getElementById('vel-canvas').toDataURL('image/png');
      const s = v.state();
      const h = v.hand();
      return {
        png,
        s: {
          gs: s.gameState,
          menu: s.menu,
          x: Math.round(s.pos.x),
          y: Math.round(s.pos.y),
          z: Math.round(s.pos.z),
          sp: Math.round(s.speed),
          vy: Math.round(s.vel.y),
          g: s.onGround,
          surf: s.surfing,
          duck: s.ducked,
          slide: h.sliding ?? false,
          hop: s.hopChain,
          cp: s.checkpoint.index,
          t: s.runTime,
          fin: s.finish ? { time: s.finish.time, isBest: s.finish.isBest } : null,
          yaw: Math.round(s.yawDeg * 10) / 10,
          pitch: Math.round(s.pitchDeg * 10) / 10,
          bot: s.bot ? s.bot.status : null,
          trick: h.trick ?? null,
        },
      };
    }, { dt: 1 / FPS, dry: opts.dry === true });
    if (!opts.dry) writeFileSync(`${dir}/${String(i).padStart(5, '0')}.png`, Buffer.from(r.png.slice(r.png.indexOf(',') + 1), 'base64'));
    tele.push(r.s);
    if (opts.until && opts.until(r.s, i)) {
      i++;
      break;
    }
  }
  writeFileSync(`${dir}/telemetry.json`, JSON.stringify(tele));
  console.log(`take ${take}: ${i} Frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return tele;
}

/** Ohne Aufnahme vorspulen (gleiche Frames wie beim Aufnehmen → gleicher Verlauf). */
export async function skipFrames(page, n) {
  await page.evaluate(
    ({ n, dt }) => {
      for (let i = 0; i < n; i++) window.__vel.advanceFrame(dt);
    },
    { n, dt: 1 / FPS },
  );
}
