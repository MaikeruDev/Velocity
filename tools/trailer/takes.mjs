/**
 * Trailer-Takes aufnehmen (deterministisch, siehe lib.mjs). Jeder Take = ein ganzer Ablauf (Level-Lauf,
 * Rutsch-Strecke, Hand-Showcase, Kameraflug); geschnitten wird danach in cut.mjs aus den Frames.
 *
 *   node tools/trailer/takes.mjs [take …]        (Port TRAILER_PORT, Default 5600)
 */
import { BASE_SETTINGS, BPM, openGame, recordTake, startLevel } from './lib.mjs';

const PORT = Number(process.env.TRAILER_PORT ?? 5600);

/** Route-Bot über das ganze Level bis kurz nach dem Ziel (das Ergebnis-Menü kommt nach 1.1 s). */
function routeRun(level, cosmetics, botOpts, maxSeconds) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...cosmetics });
    await page.evaluate(
      ({ bpm, o }) => {
        window.__vel.film({ on: true, bpm, hud: true, yawTau: 0.07 });
        window.__vel.useBot('route', o);
      },
      { bpm: BPM, o: botOpts },
    );
    let finAt = -1;
    return recordTake(page, take, maxSeconds * 60, {
      until: (s, i) => {
        if (s.fin && finAt < 0) finAt = i;
        if (s.bot === 'failed') return true;
        // Ziel + 1.05 s: Blitz, Selfie, "NEUE BESTZEIT" — vor dem HTML-Ergebnis (canvas zeigt dann kein HUD).
        return finAt >= 0 && (i - finAt >= 63 || s.menu !== null);
      },
    });
  };
}

/**
 * Rutsch-Steuerung (läuft im Browser als Input-Override, je Physik-Tick): Anlauf, Rutschen, Slide-Hop,
 * in der Luft sauber strafen (Blick knapp neben der Flugrichtung → ruhige Kamera), geduckt landen
 * (Lande-Gnade → Rutsche ohne Reibung), wieder abspringen. Spur: x = laneX Richtung −Z.
 */
function slideController(p) {
  const DEG = Math.PI / 180;
  const dt = 1 / 128;
  let phase = 'run';
  let t = 0;
  let side = 1;
  let yaw = 0;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  return (s) => {
    t += dt;
    const vx = s.vel.x;
    const vz = s.vel.z;
    const sp = Math.hypot(vx, vz);
    const velH = sp > 1 ? Math.atan2(-vx, -vz) : 0;
    const desH = Math.atan2(s.pos.x - p.laneX, p.look);
    const pitch = p.pitch * DEG;
    if (t < p.wait && phase === 'run' && !p.started) return { yaw: 0, pitch };
    if (!p.started) {
      p.started = true;
      t = 0;
    }
    if (s.pos.z < p.stopZ) return { forward: 1, sprint: true, yaw: (yaw = desH), pitch };
    if (phase === 'run') {
      yaw = desH;
      if (t > p.runTime && sp > 300) {
        phase = 'slide';
        t = 0;
      }
      return { forward: 1, sprint: true, yaw, pitch };
    }
    if (phase === 'slide') {
      if (!s.onGround) {
        phase = 'air';
        t = 0;
      } else {
        // Rutschen lenkt nur sanft (slideSteerRate) — Blick langsam in die Spur.
        yaw = yaw + wrap(desH - yaw) * 0.04;
        if (t >= p.slideTime || sp < 300) {
          phase = 'air';
          t = 0;
          const err = wrap(desH - velH);
          side = err > 0 ? -1 : 1;
          return { jumpPressed: true, jumpHeld: true, yaw, pitch };
        }
        return { crouch: true, sprint: true, yaw, pitch };
      }
    }
    // Luft: A/D mit Blick δ neben der Flugrichtung (δ aus dem Gewinnfenster, cap 40 → 24 ab 350…700 u/s).
    if (s.onGround && t > 0.05) {
      phase = 'slide';
      t = 0;
      return { crouch: true, yaw, pitch };
    }
    // Kurs mit Hysterese (Wende erst außerhalb ±band) — sonst dreht A/D bei 400 u/s mit > 500 °/s im Kreis.
    const err = wrap(desH - velH);
    if (err > p.band * DEG) side = -1;
    else if (err < -p.band * DEG) side = 1;
    const cap = sp <= 350 ? 40 : sp >= 700 ? 30 : 40 - (10 * (sp - 350)) / 350;
    const a = Math.min(12 * 320 * dt, cap);
    const delta = Math.asin(Math.min(1, Math.max(0, (cap - a) / Math.max(sp, 1)))) + p.leadDeg * DEG;
    const step = p.turnRate * DEG * dt;
    yaw += Math.max(-step, Math.min(step, wrap(velH + side * delta - yaw)));
    return { side, crouch: s.vel.y < p.duckVy, yaw, pitch };
  };
}

/**
 * Hand-Showcase: Stand am Start, Blick schwenkt langsam (pan in Grad über die ganze Dauer), Tricks
 * nacheinander — der nächste startet, wenn der vorige fertig ist (+ Pause), damit man jeden sieht.
 */
function handTake(level, cosmetics, tricks, seconds, pan, pitch) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...cosmetics });
    const n = seconds * 60;
    await page.evaluate(
      ({ bpm, pan, pitch, n }) => {
        const v = window.__vel;
        v.film({ on: true, bpm, hud: true });
        // Vorlauf: Level-Titel ausblenden lassen, bevor die Aufnahme beginnt.
        for (let i = 0; i < 130; i++) v.advanceFrame(1 / 60);
        const base = v.levelInfo().spawnYaw;
        let k = 0;
        const DEG = Math.PI / 180;
        // Je Tick: Blick weich (Smoothstep) von pan[0] nach pan[1], Ticks = Dauer × 128.
        v.setInputOverride(() => {
          const u = Math.min(1, k++ / (n * (128 / 60)));
          const e = u * u * (3 - 2 * u);
          return { yaw: (base + pan[0] + (pan[1] - pan[0]) * e) * DEG, pitch: pitch * DEG };
        });
      },
      { bpm: BPM, pan, pitch, n },
    );
    let next = 0;
    let waitUntil = 30;
    let started = false;
    return recordTake(page, take, n, {
      perFrame: async (i) => {
        if (next >= tricks.length || i < waitUntil) return;
        const cur = await page.evaluate(() => window.__vel.hand().trick);
        if (started && cur !== 'none') return;
        if (started) {
          started = false;
          waitUntil = i + 24;
          return;
        }
        const ok = await page.evaluate((t) => window.__vel.forceTrick(t), tricks[next]);
        if (!ok) console.warn(`Trick ${tricks[next]} passt nicht`);
        console.log(`  ${take}: ${tricks[next]} ab Frame ${i}`);
        next++;
        started = true;
        waitUntil = i + 6;
      },
    });
  };
}

/**
 * Establishing-Shot: freie Kamera (Film-Modus), Spieler eingefroren, ohne HUD/Hand. path(u) → [x, y, z,
 * yawDeg, pitchDeg] für u ∈ [0, 1] (bereits geglättet). Die Trims pulsen weiter mit der Film-Kick.
 */
function flyTake(level, seconds, path) {
  return async (page, take) => {
    await startLevel(page, level, BASE_SETTINGS);
    await page.evaluate((bpm) => {
      window.__vel.freeze(true);
      window.__vel.film({ on: true, bpm, hud: false });
    }, BPM);
    const n = seconds * 60;
    return recordTake(page, take, n, {
      perFrame: (i) => {
        const u = i / (n - 1);
        const [x, y, z, yawDeg, pitchDeg] = path(u * u * (3 - 2 * u) * 0.35 + u * 0.65);
        return page.evaluate((c) => window.__vel.filmCamera(c), { x, y, z, yawDeg, pitchDeg });
      },
    });
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
/** Kamera auf einem Kreisbogen um t (Winkel in Grad, 0 = +Z-Seite), Blick auf t. */
function orbit(t, r, a0, a1, h0, h1) {
  return (u) => {
    const a = (lerp(a0, a1, u) * Math.PI) / 180;
    const x = t[0] + Math.sin(a) * r;
    const z = t[2] + Math.cos(a) * r;
    const y = lerp(h0, h1, u);
    const dx = t[0] - x;
    const dy = t[1] - y;
    const dz = t[2] - z;
    return [x, y, z, (Math.atan2(-dx, -dz) * 180) / Math.PI, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI];
  };
}

const TAKES = {
  l1: routeRun('level1', { glove: 'neon', heldItem: 'card' }, { sync: 1, seed: 11, band: 30, maxTurnRate: 360 }, 40),
  l2: routeRun('level2', { glove: 'gold', heldItem: 'knife' }, { sync: 1, seed: 11, band: 30, maxTurnRate: 360 }, 30),
  l3: routeRun('level3', { glove: 'classic', heldItem: 'can' }, { sync: 1, seed: 11, band: 30, maxTurnRate: 360 }, 30),
  l4: routeRun('level4', { glove: 'neon', heldItem: 'phone' }, { sync: 1, seed: 11, band: 30, maxTurnRate: 360 }, 40),
  handCard: handTake('level1', { glove: 'neon', heldItem: 'card' }, ['spin', 'vanish', 'tossSpin', 'fan'], 9, [-8, 8], -4),
  handKnife: handTake('level2', { glove: 'gold', heldItem: 'knife' }, ['open', 'rollover', 'aerial', 'doubleAerial', 'close'], 9, [8, -8], -4),
  handCan: handTake('level3', { glove: 'classic', heldItem: 'can' }, ['crack', 'sip', 'flip', 'twirl'], 9, [-6, 10], -2),
  // L1 im Sonnenuntergang: hoch über dem Start nach −Z in die Sonne, sinkt über die Startgerade.
  flyL1: flyTake('level1', 9, (u) => [lerp(-60, 40, u), lerp(1150, 380, u), lerp(1900, -700, u), lerp(-4, 3, u), lerp(-20, -8, u)]),
  // L3 Brandung: Bogen um den Kehren-Leuchtturm, Mond im Rücken der Kurve.
  flyL3: flyTake('level3', 9, orbit([-1870, -900, -2000], 4300, 200, 160, 1300, 500)),
  slide: async (page, take) => {
    await startLevel(page, 'level1', { ...BASE_SETTINGS, glove: 'gold', heldItem: 'can' });
    await page.evaluate(
      ({ bpm, src, p }) => {
        window.__vel.film({ on: true, bpm, hud: true, yawTau: 0.07 });
        // eslint-disable-next-line no-new-func
        const make = new Function(`return (${src})`)();
        window.__vel.setInputOverride(make(p));
      },
      { bpm: BPM, src: slideController.toString(), p: { laneX: 0, look: 700, pitch: -4, runTime: 0.7, slideTime: 0.32, leadDeg: 0, duckVy: -40, stopZ: -2300, band: 6, turnRate: 400, wait: 1.6, started: false } },
    );
    return recordTake(page, take, 12 * 60, { until: (s) => s.z < -2350 || s.y < -100 });
  },
};

const want = process.argv.slice(2);
const names = want.length > 0 ? want : Object.keys(TAKES);
const g = await openGame(PORT);
try {
  for (const n of names) {
    const fn = TAKES[n];
    if (!fn) throw new Error(`unbekannter Take ${n}`);
    await fn(g.page, n);
  }
} finally {
  await g.close();
}
if (g.errors.length > 0) {
  console.error(g.errors.join('\n'));
  process.exit(1);
}
