/**
 * Trailer-Takes, Runde 2 (60-s-Trailer): Verfolger-Drohne (FPV) entlang der Bot-Linie, neue Kameraflüge,
 * Ego-Shots mit reduziertem HUD. Gleiche Aufnahme wie takes.mjs (deterministisch, lib.mjs).
 *
 *   node tools/trailer/takes2.mjs [take …]        (Port TRAILER_PORT, Default 5601)
 */
import { BASE_SETTINGS, BPM, openGame, recordTake, startLevel } from './lib.mjs';

const PORT = Number(process.env.TRAILER_PORT ?? 5601);
const DEG = 180 / Math.PI;
const BOT = { sync: 1, seed: 11, band: 30, maxTurnRate: 360 };

/**
 * Verfolger-Kamera: hinter dem (unsichtbaren) Spieler entlang seiner Bewegungsrichtung, geglättet. Die Richtung
 * folgt der horizontalen Geschwindigkeit (ruhiger als der Blick, der beim Strafen pendelt), Höhe und Abstand weich,
 * Rollen proportional zur Kurvenrate (wie eine FPV-Drohne in der Kurve).
 *
 * cam: back (u hinter dem Spieler), up (u über den Füßen), look (u vor dem Spieler, Blickziel), lookUp, tau (s,
 * Richtungs-Glättung), roll (Grad je rad/s Kurvenrate), side (u seitlich, + = rechts), pitchAdd (Grad).
 */
function chaseTake(level, cosmetics, cam, maxSeconds, extra = {}) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...cosmetics, ghost: extra.ghost === true });
    await page.evaluate(
      ({ bpm, o }) => {
        window.__vel.film({ on: true, bpm, hud: false, avatar: true });
        window.__vel.useBot('route', o);
      },
      { bpm: BPM, o: { ...BOT, ...(extra.bot ?? {}) } },
    );
    let dir = null;
    let prevDir = null;
    let roll = 0;
    let camPos = null;
    let finAt = -1;
    let surfBlend = 0;
    let surfN = { x: 0, z: 0 };
    const ks = 1 - Math.exp(-1 / 60 / 0.35);
    const dt = 1 / 60;
    const k = 1 - Math.exp(-dt / cam.tau);
    const kp = 1 - Math.exp(-dt / (cam.posTau ?? 0.12));
    return recordTake(page, take, maxSeconds * 60, {
      perFrame: async () => {
        const s = await page.evaluate(() => {
          const st = window.__vel.state();
          return { x: st.pos.x, y: st.pos.y, z: st.pos.z, vx: st.vel.x, vz: st.vel.z, surf: st.surfing, nx: st.surfNormal.x, nz: st.surfNormal.z };
        });
        const sp = Math.hypot(s.vx, s.vz);
        const d = sp > 40 ? Math.atan2(-s.vx, -s.vz) : (dir ?? 0);
        if (dir === null) dir = d;
        let dd = d - dir;
        while (dd > Math.PI) dd -= 2 * Math.PI;
        while (dd < -Math.PI) dd += 2 * Math.PI;
        dir += dd * k;
        const rate = prevDir === null ? 0 : (dir - prevDir) / dt;
        prevDir = dir;
        roll += (Math.max(-cam.maxRoll, Math.min(cam.maxRoll, -rate * cam.roll)) - roll) * k;
        const fx = -Math.sin(dir);
        const fz = -Math.cos(dir);
        const rx = Math.cos(dir);
        const rz = -Math.sin(dir);
        // Auf der Surf-Rampe: weg von der Rampe (horizontale Normale) und höher — sonst füllt die Fläche das Bild.
        const nh = Math.hypot(s.nx, s.nz);
        if (s.surf && nh > 0.2) surfN = { x: s.nx / nh, z: s.nz / nh };
        surfBlend += ((s.surf ? 1 : 0) - surfBlend) * ks;
        const so = (cam.surfSide ?? 0) * surfBlend;
        const want = {
          x: s.x - fx * cam.back + rx * (cam.side ?? 0) + surfN.x * so,
          y: s.y + cam.up + (cam.surfUp ?? 0) * surfBlend,
          z: s.z - fz * cam.back + rz * (cam.side ?? 0) + surfN.z * so,
        };
        if (camPos === null) camPos = want;
        camPos = { x: camPos.x + (want.x - camPos.x) * kp, y: camPos.y + (want.y - camPos.y) * kp, z: camPos.z + (want.z - camPos.z) * kp };
        const tx = s.x + fx * cam.look;
        const ty = s.y + (cam.lookUp ?? 40);
        const tz = s.z + fz * cam.look;
        const dx = tx - camPos.x;
        const dy = ty - camPos.y;
        const dz = tz - camPos.z;
        const yawDeg = Math.atan2(-dx, -dz) * DEG;
        const pitchDeg = Math.atan2(dy, Math.hypot(dx, dz)) * DEG + (cam.pitchAdd ?? 0);
        await page.evaluate((c) => window.__vel.filmCamera(c), { ...camPos, yawDeg, pitchDeg, rollDeg: roll });
      },
      until: (s, i) => {
        if (s.fin && finAt < 0) finAt = i;
        if (s.bot === 'failed') return true;
        return finAt >= 0 && (i - finAt >= 40 || s.menu !== null);
      },
    });
  };
}

const CHASE = { back: 115, up: 52, look: 200, lookUp: 26, tau: 0.25, posTau: 0.03, roll: 9, maxRoll: 14, surfSide: 150, surfUp: 70 };

/** Ego-Lauf mit reduziertem HUD (nur Speedometer + Gain-Popups, Ziel-Banner) und Hand — die sauberen Hero-Shots. */
function fpRun(level, cosmetics, maxSeconds, extra = {}) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...cosmetics, ghost: extra.ghost === true });
    if (extra.before) await extra.before(page);
    await page.evaluate(
      ({ bpm, o, minimal }) => {
        window.__vel.film({ on: true, bpm, hud: true, yawTau: 0.07, minimalHud: minimal });
        window.__vel.useBot('route', o);
      },
      { bpm: BPM, o: { ...BOT, ...(extra.bot ?? {}) }, minimal: extra.minimal !== false },
    );
    let finAt = -1;
    return recordTake(page, take, maxSeconds * 60, {
      until: (s, i) => {
        if (s.fin && finAt < 0) finAt = i;
        if (s.bot === 'failed') return true;
        return finAt >= 0 && (i - finAt >= 63 || s.menu !== null);
      },
    });
  };
}

/** Bestzeit-Lauf ohne Aufnahme setzen (Ghost entsteht), danach läuft der eigentliche Take gegen ihn. */
async function setGhostRun(page, level, bot) {
  await page.evaluate(({ o }) => {
    window.__vel.film({ on: true, bpm: 132, hud: false });
    window.__vel.useBot('route', o);
  }, { o: bot });
  for (let i = 0; i < 60 * 40; i += 60) {
    const done = await page.evaluate(() => {
      for (let k = 0; k < 60; k++) window.__vel.advanceFrame(1 / 60);
      const s = window.__vel.state();
      return s.finish !== null || s.menu !== null || (s.bot && s.bot.status === 'failed');
    });
    if (done) break;
  }
  await page.evaluate(() => window.__vel.film({ on: false }));
  await page.waitForTimeout(1600);
}

/** Freier Kameraflug (Spieler eingefroren, ohne HUD/Hand), path(u) → [x, y, z, yaw, pitch, roll?]. */
function flyTake(level, seconds, path, settings = {}) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...settings });
    await page.evaluate((bpm) => {
      window.__vel.freeze(true);
      window.__vel.film({ on: true, bpm, hud: false });
    }, BPM);
    const n = seconds * 60;
    return recordTake(page, take, n, {
      perFrame: (i) => {
        const u = i / (n - 1);
        const [x, y, z, yawDeg, pitchDeg, rollDeg = 0] = path(u * u * (3 - 2 * u) * 0.35 + u * 0.65);
        return page.evaluate((c) => window.__vel.filmCamera(c), { x, y, z, yawDeg, pitchDeg, rollDeg });
      },
    });
  };
}

/**
 * Bullet-Time: Route-Lauf bis atSec (ohne Aufnahme), dann Spiel einfrieren und die Kamera um das Hologramm kreisen
 * (Winkel relativ zur Flugrichtung, 0 = dahinter), Radius/Höhe weich. Trims pulsen weiter (Film-Uhr läuft).
 */
function bulletTake(level, cosmetics, atSec, seconds, orb) {
  return async (page, take) => {
    await startLevel(page, level, { ...BASE_SETTINGS, ...cosmetics });
    await page.evaluate(
      ({ bpm, o }) => {
        window.__vel.film({ on: true, bpm, hud: false, avatar: true });
        window.__vel.useBot('route', o);
      },
      { bpm: BPM, o: BOT },
    );
    const pre = Math.round(atSec * 60);
    const st = await page.evaluate((n) => {
      for (let i = 0; i < n; i++) window.__vel.advanceFrame(1 / 60);
      window.__vel.freeze(true);
      const s = window.__vel.state();
      return { x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.vel.x, vz: s.vel.z };
    }, pre);
    const heading = Math.atan2(-st.vx, -st.vz);
    const n = seconds * 60;
    return recordTake(page, take, n, {
      perFrame: (i) => {
        const u0 = i / (n - 1);
        const u = u0 * u0 * (3 - 2 * u0);
        const a = heading + Math.PI + ((orb.a0 + (orb.a1 - orb.a0) * u) * Math.PI) / 180;
        const r = orb.r0 + (orb.r1 - orb.r0) * u;
        const cy = st.y + 36;
        const x = st.x - Math.sin(a) * r;
        const z = st.z - Math.cos(a) * r;
        const y = cy + orb.h0 + (orb.h1 - orb.h0) * u;
        const [yawDeg, pitchDeg] = aim(x, y, z, st.x, cy, st.z);
        return page.evaluate((c) => window.__vel.filmCamera(c), { x, y, z, yawDeg, pitchDeg, rollDeg: orb.roll ?? 0 });
      },
    });
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
/** Blick von (x,y,z) auf (tx,ty,tz) → [yaw, pitch] in Grad. */
function aim(x, y, z, tx, ty, tz) {
  const dx = tx - x;
  const dy = ty - y;
  const dz = tz - z;
  return [Math.atan2(-dx, -dz) * DEG, Math.atan2(dy, Math.hypot(dx, dz)) * DEG];
}
/** Kreisbogen um t (Winkel in Grad, 0 = +Z), Höhe h0 → h1, Blick auf t. */
function orbit(t, r0, r1, a0, a1, h0, h1, roll = 0) {
  return (u) => {
    const a = (lerp(a0, a1, u) * Math.PI) / 180;
    const r = lerp(r0, r1, u);
    const x = t[0] + Math.sin(a) * r;
    const z = t[2] + Math.cos(a) * r;
    const y = lerp(h0, h1, u);
    return [x, y, z, ...aim(x, y, z, t[0], t[1], t[2]), roll];
  };
}
/** Gerader Flug a → b, Blick wandert von ta nach tb. */
function dolly(a, b, ta, tb, roll = [0, 0]) {
  return (u) => {
    const p = [0, 1, 2].map((i) => lerp(a[i], b[i], u));
    const t = [0, 1, 2].map((i) => lerp(ta[i], tb[i], u));
    return [...p, ...aim(p[0], p[1], p[2], t[0], t[1], t[2]), lerp(roll[0], roll[1], u)];
  };
}

const TAKES = {
  chaseL1: chaseTake('level1', { glove: 'neon', heldItem: 'card' }, CHASE, 40),
  chaseL2: chaseTake('level2', { glove: 'gold', heldItem: 'knife' }, CHASE, 30),
  chaseL3: chaseTake('level3', { glove: 'classic', heldItem: 'can' }, CHASE, 30),
  chaseL4: chaseTake('level4', { glove: 'neon', heldItem: 'phone' }, CHASE, 40),
  fpL1: fpRun('level1', { glove: 'neon', heldItem: 'card' }, 40),
  fpL2: fpRun('level2', { glove: 'gold', heldItem: 'knife' }, 30),
  fpL3: fpRun('level3', { glove: 'classic', heldItem: 'can' }, 30),
  fpL4: fpRun('level4', { glove: 'neon', heldItem: 'phone' }, 40),
  // Ghost-Rennen: erst eine Bestzeit (Ghost), dann ein etwas langsamerer Lauf mit vollem HUD (GHOST −x.xx).
  ghostL1: fpRun('level1', { glove: 'gold', heldItem: 'knife' }, 40, {
    ghost: true,
    minimal: false,
    bot: { sync: 0.9, seed: 5 },
    before: async (page) => {
      await setGhostRun(page, 'level1', BOT);
      const ok = await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
      if (!ok) throw new Error('Neustart L1 fehlgeschlagen');
      await page.waitForTimeout(1500);
    },
  }),
  // Bullet-Time über den L1-Inseln (Hop-Scheitel bei 10.5 s, 936 u/s), 200° Bogen von hinten nach vorn.
  bulletL1: bulletTake('level1', { glove: 'neon', heldItem: 'card' }, 10.5, 3, { a0: -20, a1: 180, r0: 150, r1: 120, h0: 30, h1: -6 }),
  // Bullet-Time auf der L3-Mondrampe (13.5 s, 1280 u/s).
  bulletL3: bulletTake('level3', { glove: 'classic', heldItem: 'can' }, 13.5, 3, { a0: 20, a1: -160, r0: 150, r1: 120, h0: 40, h1: 0 }),
  // L4-Turm: weiter Bogen um die Wendel, steigt mit.
  flyL4: flyTake('level4', 8, orbit([-50, 800, 0], 3400, 2600, 210, 120, 600, 1900)),
  // L2: hoch über dem Ring, taucht Richtung Surf-Abfahrt.
  flyL2: flyTake('level2', 8, dolly([-1800, 1500, 3000], [900, 500, 600], [0, 120, 1000], [1350, -600, -2700])),
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
