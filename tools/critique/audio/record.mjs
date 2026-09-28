/**
 * Kritik-Linse AUDIO: zeichnet im echten Spiel (Echtzeit, Chromium) pro Frame
 * Drive (Speed, Boden, Chain, Sync, Surf), Energie, Layer, Kick und alle
 * Spiel-Events auf. Ausgabe: shots/critique/audio/rec_<run>.json
 *
 *   node tools/critique/audio/record.mjs [run ...]
 *   Runs: l1, l1mid, l2, l2mid, beginner
 * Port: CRIT_AUDIO_PORT (Default 5206).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_AUDIO_PORT ?? 5206);
const OUT = 'shots/critique/audio';

/** Vorlauf im Stand vor dem Bot (wie ein Mensch, der sich erst umsieht). */
const IDLE_BEFORE = 4;

const RUNS = {
  l1: { level: 'level1', kind: 'route', sync: 1.0, after: 5 },
  l1mid: { level: 'level1', kind: 'route', sync: 0.7, after: 5 },
  l2: { level: 'level2', kind: 'route', sync: 1.0, after: 5 },
  l2mid: { level: 'level2', kind: 'route', sync: 0.8, after: 5 },
  beginner: { level: 'level1', kind: 'script', after: 0 },
};

const args = process.argv.slice(2);
const ids = args.length > 0 ? args : Object.keys(RUNS);

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  for (const id of ids) {
    const r = await record(page, id, RUNS[id]);
    writeFileSync(`${OUT}/rec_${id}.json`, JSON.stringify(r));
    const f = r.frames;
    const lay = firstLayerTimes(f);
    console.log(
      `${id}: ${r.result} ${f.length} Frames, ${r.duration.toFixed(1)} s, Events ${r.events.length}, ` +
        `max ${Math.max(...f.map((x) => x.sp)).toFixed(0)} u/s, Layer erstmals ${JSON.stringify(lay)}`,
    );
  }
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length > 0) console.error(errors.join('\n'));

function firstLayerTimes(frames) {
  const out = {};
  for (const fr of frames) if (out[fr.l] === undefined) out[fr.l] = Math.round(fr.t * 100) / 100;
  return out;
}

async function record(page, id, cfg) {
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  const ok = await page.evaluate((lv) => window.__vel.start(lv, { lockless: true }), cfg.level);
  if (!ok) throw new Error(`${id}: start fehlgeschlagen`);

  // In-Page-Recorder: rAF, ein Eintrag pro Frame; Events über Objekt-Identität (Log ist auf 512 gekappt).
  await page.evaluate(() => {
    const v = window.__vel;
    const seen = new WeakSet();
    const rec = { t0: performance.now(), frames: [], events: [], stop: false };
    window.__rec = rec;
    for (const e of v.events()) seen.add(e);
    const loop = () => {
      if (rec.stop) return;
      const now = performance.now();
      const s = v.state();
      const b = v.beat();
      rec.frames.push({
        t: (now - rec.t0) / 1000,
        sp: s.speed,
        g: s.onGround,
        ch: s.hopChain,
        sy: s.strafeSync,
        sf: s.surfing,
        e: b.energy,
        l: b.layer,
        k: b.kick,
        bt: b.beat,
        gs: s.gameState,
        m: s.menu,
        cp: s.checkpoint.index,
        y: s.pos.y,
      });
      for (const e of v.events()) {
        if (seen.has(e)) continue;
        seen.add(e);
        rec.events.push({ ...e, t: e.t - rec.t0 / 1000 });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  await page.waitForTimeout(IDLE_BEFORE * 1000);
  let result = 'done';
  if (cfg.kind === 'route') {
    await page.evaluate((sync) => window.__vel.useBot('route', { sync, seed: 11 }), cfg.sync);
    const t0 = Date.now();
    for (;;) {
      const s = await page.evaluate(() => window.__vel.state());
      if (s.finish || s.gameState === 'finished') {
        result = 'finish';
        break;
      }
      if (s.bot && s.bot.status === 'failed') {
        result = `fail:${s.bot.reason}`;
        break;
      }
      if (Date.now() - t0 > 120000) {
        result = 'timeout';
        break;
      }
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(cfg.after * 1000);
  } else {
    // Anfänger: steht, läuft mit W, bleibt stehen, W + Leertaste gehalten (Auto-Hop ohne Strafen),
    // Sprint, bleibt wieder stehen. Kein Strafen, keine Maus.
    await page.evaluate(() => {
      const start = performance.now();
      window.__vel.setInputOverride((st) => {
        const t = (performance.now() - start) / 1000;
        if (t < 5) return { forward: 1 };
        if (t < 8) return {};
        if (t < 16) return { forward: 1, jumpHeld: true, jumpPressed: st.onGround };
        if (t < 18) return {};
        if (t < 24) return { forward: 1, sprint: true, jumpHeld: t > 20, jumpPressed: t > 20 && st.onGround };
        return {};
      });
    });
    await page.waitForTimeout(24000 + 14000);
  }
  return page.evaluate(
    ([rid, res, lvl]) => {
      const r = window.__rec;
      r.stop = true;
      const last = r.frames[r.frames.length - 1];
      return { id: rid, level: lvl, result: res, duration: last.t, frames: r.frames, events: r.events };
    },
    [id, result, cfg.level],
  );
}
