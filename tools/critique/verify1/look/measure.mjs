/**
 * Kritik-Linse LOOK: Messungen im echten Spiel (Port 5209).
 *   node tools/critique/look/measure.mjs [hud] [lintel] [post] [pulse] [dark] [surf]
 * Ausgabe: shots/critique/look/measure-*.json + Konsole.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.LOOK_PORT ?? 5236);
const OUT = 'shots/verify1/look';
const which = process.argv.slice(2);
const want = (k) => which.length === 0 || which.includes(k);
mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const results = {};
try {
  if (want('hud')) results.hud = await hudVsLanding();
  if (want('lintel')) results.lintel = await lintel();
  if (want('post')) results.post = await postFx();
  if (want('pulse')) results.pulse = await pulse();
  if (want('dark')) results.dark = await darkness();
  if (want('surf')) results.surf = await surfNoise();
} finally {
  await browser.close();
  await srv.close();
}
for (const [k, v] of Object.entries(results)) writeFileSync(`${OUT}/measure-${k}.json`, JSON.stringify(v, null, 1));
if (errors.length) console.error(errors.slice(0, 10).join('\n'));

// ------------------------------------------------------------ Helfer
async function page(vp = { width: 1920, height: 1080 }, px = 270) {
  const p = await browser.newPage({ viewport: vp });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await p.goto(srv.url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__vel?.ready === true);
  await p.evaluate(async () => {
    await document.fonts.ready;
  });
  await p.evaluate((h) => window.__vel.setRenderSettings({ pixelHeight: h }), px);
  await p.evaluate(() => {
    // Low-Res-Frame direkt nach dem Spiel-Render lesen (rAF-Reihenfolge wie sampleFrames).
    window.__grab = () =>
      new Promise((res) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.getElementById('vel-canvas');
            const cv = window.__gcv ?? (window.__gcv = document.createElement('canvas'));
            cv.width = c.width;
            cv.height = c.height;
            const x = cv.getContext('2d', { willReadFrequently: true });
            x.drawImage(c, 0, 0);
            res(x.getImageData(0, 0, c.width, c.height));
          }),
        );
      });
    window.__luma = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  });
  return p;
}
function st(p) { return p.evaluate(() => window.__vel.state()); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------ E1: HUD-Speedometer vs. Landepunkt
async function hudVsLanding() {
  const out = {};
  const runs = [
    ['level1', 270, { width: 1920, height: 1080 }],
    ['level2', 270, { width: 1920, height: 1080 }],
    ['level1', 240, { width: 1280, height: 720 }],
  ];
  for (const [level, px, vp] of runs) {
    const p = await page(vp, px);
    await p.evaluate((lv) => window.__vel.start(lv, { lockless: true }), level);
    const [W, H] = await p.evaluate(() => {
      const c = document.getElementById('vel-canvas');
      return [c.width, c.height];
    });
    await p.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    const frames = [];
    for (;;) {
      const f = await p.evaluate(() => window.__vel.sampleFrames(120));
      frames.push(...f);
      const s = await st(p);
      if (s.finish || s.gameState === 'finished' || (s.bot && s.bot.status === 'failed') || frames.length > 60 * 60) break;
    }
    // HUD-Box (Low-Res-Pixel) wie Hud.drawSpeedometer: y = round(0.7h), Ziffern 7*big hoch, Zeile darunter +5, 7 hoch.
    const big = H >= 330 ? 3 : 2;
    const HL = await p.evaluate(() => window.__vel.hudLayout());
    const ks = H / HL.height;
    const y0 = HL.speedRows[0] * ks;
    const y1 = HL.speedRows[1] * ks;
    const halfW = HL.speedHalfWidth * (W / HL.width);
    let inBoxDec = 0, totDec = 0; // Sync-Zeile "×12 SYNC 100%" ~90 px breit bei s=1, Gain-Popup rechts
    // FOV-Kick nachbilden (CameraRig): horizontal @4:3 = 90 + kick, Hor+.
    let kick = 0;
    const aspect = W / H;
    const land = [];
    for (let i = 1; i < frames.length; i++) if (frames[i].onGround && !frames[i - 1].onGround) land.push(i);
    const fovAt = [];
    for (let i = 0; i < frames.length; i++) {
      const dt = i > 0 ? Math.max(0, Math.min(0.1, (frames[i].t - frames[i - 1].t) / 1000)) : 0;
      const target = 12 * smoothstep(300, 1000, frames[i].speed) + 2 * smoothstep(1000, 1800, frames[i].speed);
      const tau = target > kick ? 0.2 : 0.6;
      kick += (target - kick) * (1 - Math.exp(-dt / tau));
      fovAt.push(kick);
    }
    let inBox = 0;
    let total = 0;
    const CANDS = [[0.7, 0.8], [0.84, 0.94], [0.88, 0.98], [0.3, 0.4]].map((y) => ({ y, n: 0, hit: 0 }));
    const samplesAt = { '0.5': [], '0.4': [], '0.3': [], '0.2': [] };
    let landingsCounted = 0;
    let landingsCovered = 0;
    for (const li of land) {
      let a = li - 1;
      while (a > 0 && !frames[a].onGround) a--;
      if ((frames[li].t - frames[a].t) / 1000 < 0.35) continue;
      const P = { x: frames[li].x, y: frames[li].y - 64, z: frames[li].z };
      let covered = 0;
      let cnt = 0;
      for (let j = li - 1; j > a; j--) {
        const age = (frames[li].t - frames[j].t) / 1000;
        if (age > 0.6) break;
        if (age < 0.1) continue;
        const f = frames[j];
        const yaw = (f.yawDeg * Math.PI) / 180;
        const dx = P.x - f.x;
        const dy = P.y - f.y;
        const dz = P.z - f.z;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        const zc = dx * fx + dz * fz;
        if (zc < 1) continue;
        const xc = dx * rx + dz * rz;
        const tanV = Math.tan((f.fovDeg * Math.PI) / 360);
        const tanHx = tanV * (f.aspect || aspect);
        const sx = 0.5 + (0.5 * (xc / zc)) / tanHx;
        const sy = 0.5 - (0.5 * (dy / zc)) / tanV;
        const pxx = sx * W;
        const pyy = sy * H;
        const hit = Math.abs(pxx - W / 2) <= halfW && pyy >= y0 && pyy <= y1;
        total++;
        cnt++;
        if (age >= 0.3) { totDec++; if (hit) inBoxDec++; }
        if (hit) {
          inBox++;
          covered++;
        }
        for (const k of Object.keys(samplesAt)) if (Math.abs(age - Number(k)) < 0.009) samplesAt[k].push(+sy.toFixed(3));
        if (age >= 0.3) {
          for (const c of CANDS) {
            c.n++;
            if (Math.abs(pxx - W / 2) <= halfW && sy >= c.y[0] && sy <= c.y[1]) c.hit++;
          }
        }
      }
      if (cnt > 0) {
        landingsCounted++;
        if (covered > 0) landingsCovered++;
      }
    }
    const med = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : null;
    };
    const r = {
      level,
      lowRes: [W, H],
      hudBoxRows: [y0, y1],
      hudBoxRowsFrac: [+(y0 / H).toFixed(3), +(y1 / H).toFixed(3)],
      hudHalfWidthPx: halfW,
      frames: frames.length,
      decisionWindow_0p3to0p6s_insideRealHudBox: +(inBoxDec / Math.max(1, totDec)).toFixed(3),
      landings: landingsCounted,
      landingsWhereTouchdownPassesUnderHud: landingsCovered,
      shareOfPreLandingFrames_0p1to0p6s_insideHudBox: +(inBox / Math.max(1, total)).toFixed(3),
      decisionWindow_0p3to0p6s_shareInBoxByCandidateRows: CANDS.map((c) => ({ rows: c.y, share: +(c.hit / Math.max(1, c.n)).toFixed(3) })),
      medianScreenYofTouchdown: Object.fromEntries(Object.entries(samplesAt).map(([k, v]) => [`${k}s_before`, med(v)])),
    };
    console.log('HUD', JSON.stringify(r));
    out[`${level}-${px}`] = r;
    await p.close();
  }
  return out;
}

// ------------------------------------------------------------ E2: Ziel-Tor-Sturz in Level 2
async function lintel() {
  const p = await page();
  await p.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await p.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  const frames = [];
  for (;;) {
    const f = await p.evaluate(() => window.__vel.sampleFrames(120));
    frames.push(...f);
    const s = await st(p);
    if (s.finish || s.gameState === 'finished' || frames.length > 60 * 60) break;
  }
  // Tor: dark-Pfosten x 692..748 / 1588..1644, Sturz (accent, nocollide) y -1990..-1934, z -7344..-7288
  const near = frames.filter((f) => f.z < -6700 && f.z > -7700).map((f) => ({ z: Math.round(f.z), camY: Math.round(f.y), x: Math.round(f.x), spd: Math.round(f.speed) }));
  const crossing = near.filter((f) => f.z <= -7288 + 60 && f.z >= -7344 - 60);
  const r = { lintel: { y: [-1990, -1934], z: [-7344, -7288] }, framesNearGate: near.length, crossing, path: near.filter((_, i) => i % 3 === 0) };
  console.log('LINTEL', JSON.stringify({ crossing }));
  await p.close();
  return r;
}

// ------------------------------------------------------------ E3: CA + Speed-Streifen sichtbar?
async function postFx() {
  const p = await page();
  await p.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await sleep(2600); // Intro weg
  const info = await p.evaluate(() => window.__vel.levelInfo());
  const n = info.route[9].pos; // Hop-Reihe (Plateau)
  await p.evaluate(({ x, y, z }) => {
    window.__vel.freeze(true);
    window.__vel.teleport(x, y, z + 60, 0);
    window.__vel.setView(0, 0);
  }, n);
  const res = {};
  for (const chromatic of [0.5, 0]) {
    await p.evaluate((c) => window.__vel.setRenderSettings({ chromatic: c }), chromatic);
    await p.evaluate(() => window.__vel.setVelocity(0, 0, 0));
    await sleep(150);
    await p.evaluate(async () => {
      window.__base = await window.__grab();
    });
    for (const v of [250, 500, 800, 1100, 1500]) {
      await p.evaluate((vv) => window.__vel.setVelocity(0, 0, -vv), v);
      await sleep(120);
      const m = await p.evaluate(async () => {
        let changed = 0;
        let sum = 0;
        let maxd = 0;
        let n = 0;
        let strong = 0;
        for (let k = 0; k < 8; k++) {
          const d = await window.__grab();
          const a = window.__base.data;
          const b = d.data;
          for (let i = 0; i < a.length; i += 4) {
            const dd = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            if (dd > 0) changed++;
            if (dd > 24) strong++;
            sum += dd;
            if (dd > maxd) maxd = dd;
            n++;
          }
        }
        return { changedFrac: +(changed / n).toFixed(4), strongFrac: +(strong / n).toFixed(4), meanAbsDiff: +(sum / n / 3).toFixed(3), maxSumDiff: maxd };
      });
      res[`ca${chromatic}-v${v}`] = m;
      if (chromatic === 0.5 && (v === 800 || v === 1500)) await p.screenshot({ path: `${OUT}/E3-post-v${v}.png` });
    }
  }
  await p.evaluate(() => window.__vel.setRenderSettings({ chromatic: 0.5 }));
  await p.evaluate(() => window.__vel.setVelocity(0, 0, 0));
  await sleep(150);
  await p.screenshot({ path: `${OUT}/E3-post-v0.png` });
  console.log('POST', JSON.stringify(res));
  await p.close();
  return res;
}

// ------------------------------------------------------------ E4: Beat-Puls der Trims sichtbar?
async function pulse() {
  const p = await page();
  await p.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await p.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  // bis in die Kehre fahren (hohe Energie), dann einfrieren und Puls messen
  for (;;) {
    const s = await st(p);
    if ((s.bot?.nextIndex ?? 0) >= 19) break;
    await sleep(50);
  }
  await p.evaluate(() => window.__vel.freeze(true));
  const samples = await p.evaluate(async () => {
    const out = [];
    for (let k = 0; k < 150; k++) {
      const d = await window.__grab();
      const a = d.data;
      let tn = 0;
      let tl = 0;
      let gn = 0;
      let gl = 0;
      let all = 0;
      for (let i = 0; i < a.length; i += 4) {
        const r = a[i] / 255;
        const g = a[i + 1] / 255;
        const b = a[i + 2] / 255;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        all += L;
        if (b > 0.55 && g > 0.5 && r < 0.6 && b - r > 0.3) {
          tn++;
          tl += L;
        } else if (r > 0.45 && b > 0.45 && g < 0.35) {
          gn++;
          gl += L;
        }
      }
      const bt = window.__vel.beat();
      out.push({ kick: +bt.kick.toFixed(3), energy: +bt.energy.toFixed(3), trimN: tn, trimL: tn ? +(tl / tn).toFixed(4) : null, gridN: gn, gridL: gn ? +(gl / gn).toFixed(4) : null, frameL: +(all / (a.length / 4)).toFixed(4) });
    }
    return out;
  });
  const q = (xs, f) => {
    const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * f)];
  };
  const corr = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    return +(sxy / Math.sqrt(sxx * syy)).toFixed(3);
  };
  const kicks = samples.map((s) => s.kick);
  const tl = samples.map((s) => s.trimL ?? 0);
  const gl = samples.map((s) => s.gridL ?? 0);
  const fl = samples.map((s) => s.frameL);
  const sw = (xs) => +((q(xs, 0.95) - q(xs, 0.05)) / q(xs, 0.5)).toFixed(3);
  const r = {
    frames: samples.length,
    energyMean: +(samples.reduce((a, s) => a + s.energy, 0) / samples.length).toFixed(3),
    kick: { p5: q(kicks, 0.05), p95: q(kicks, 0.95) },
    trimLuma: { p5: q(tl, 0.05), p95: q(tl, 0.95), relSwing: sw(tl), corrWithKick: corr(kicks, tl), meanPixels: Math.round(samples.reduce((a, s) => a + s.trimN, 0) / samples.length) },
    gridLuma: { p5: q(gl, 0.05), p95: q(gl, 0.95), relSwing: sw(gl), corrWithKick: corr(kicks, gl), meanPixels: Math.round(samples.reduce((a, s) => a + s.gridN, 0) / samples.length) },
    frameLuma: { p5: q(fl, 0.05), p95: q(fl, 0.95), relSwing: sw(fl), corrWithKick: corr(kicks, fl) },
    raw: samples.slice(0, 40),
  };
  await p.screenshot({ path: `${OUT}/E4-pulse-frozen.png` });
  console.log('PULSE', JSON.stringify({ ...r, raw: undefined }));
  await p.close();
  return r;
}

// ------------------------------------------------------------ E5: Helligkeit Spawn L1 vs L2
async function darkness() {
  const r = {};
  for (const lv of ['level1', 'level2']) {
    const p = await page();
    await p.evaluate((l) => window.__vel.start(l, { lockless: true }), lv);
    await sleep(2800);
    const m = await p.evaluate(async () => {
      const d = await window.__grab();
      const a = d.data;
      const W = d.width;
      const H = d.height;
      let sum = 0;
      let dark = 0;
      let n = 0;
      let bot = 0;
      let bn = 0;
      const hist = new Array(10).fill(0);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const L = window.__luma(a, i);
          sum += L;
          n++;
          if (L < 0.1) dark++;
          hist[Math.min(9, Math.floor(L * 10))]++;
          if (y > H * 0.7) {
            bot += L;
            bn++;
          }
        }
      return { meanLuma: +(sum / n).toFixed(3), shareBelow0p1: +(dark / n).toFixed(3), bottom30pctLuma: +(bot / bn).toFixed(3), hist: hist.map((h) => +(h / n).toFixed(3)) };
    });
    await p.screenshot({ path: `${OUT}/E5-${lv}-spawn.png` });
    r[lv] = m;
    console.log('DARK', lv, JSON.stringify(m));
    await p.close();
  }
  return r;
}

// ------------------------------------------------------------ E6: Surf-Textur Unruhe (Frame-zu-Frame bei 1 Frame Bewegung)
async function surfNoise() {
  const r = {};
  const cases = [
    { lv: 'level2', node: 19, yaw: 20, pitch: -10, label: 'surf1-flanke' },
    { lv: 'level2', node: 22, yaw: 20, pitch: -10, label: 'surf2-flanke' },
    { lv: 'level1', node: 9, yaw: 0, pitch: -25, label: 'l1-boden' },
    { lv: 'level2', node: 8, yaw: -93, pitch: -25, label: 'l2-ring-boden' },
  ];
  for (const c of cases) {
    const p = await page();
    await p.evaluate((l) => window.__vel.start(l, { lockless: true }), c.lv);
    await sleep(2600);
    const info = await p.evaluate(() => window.__vel.levelInfo());
    const n = info.route[c.node].pos;
    const yawR = (c.yaw * Math.PI) / 180;
    const step = 900 / 60; // ein 60-Hz-Frame bei 900 u/s
    const fx = -Math.sin(yawR) * step;
    const fz = -Math.cos(yawR) * step;
    await p.evaluate(({ n, c }) => {
      window.__vel.freeze(true);
      window.__vel.teleport(n.x, n.y, n.z, c.yaw);
      window.__vel.setView(c.yaw, c.pitch);
    }, { n, c });
    await sleep(200);
    await p.evaluate(async () => {
      window.__A = await window.__grab();
    });
    await p.screenshot({ path: `${OUT}/E6-${c.label}.png` });
    await p.evaluate(({ n, fx, fz, c }) => {
      window.__vel.teleport(n.x + fx, n.y, n.z + fz, c.yaw);
      window.__vel.setView(c.yaw, c.pitch);
    }, { n, fx, fz, c });
    await sleep(200);
    const m = await p.evaluate(async (label) => {
      const B = await window.__grab();
      const a = window.__A.data;
      const b = B.data;
      const W = B.width;
      const H = B.height;
      let n = 0;
      let diff = 0;
      let edges = 0;
      const isSurfCase = label.includes('surf');
      for (let y = Math.floor(H * 0.35); y < H; y++)
        for (let x = 0; x < W - 1; x++) {
          const i = (y * W + x) * 4;
          const r = a[i] / 255;
          const g = a[i + 1] / 255;
          const bl = a[i + 2] / 255;
          const surf = bl > 0.3 && bl > r * 1.8 && bl > g * 1.25;
          if (isSurfCase ? !surf : y < H * 0.75 || x < W * 0.3 || x > W * 0.7) continue;
          const La = window.__luma(a, i);
          const Lb = window.__luma(b, i);
          const La2 = window.__luma(a, i + 4);
          diff += Math.abs(La - Lb);
          n++;
          if (Math.abs(La - La2) > 0.05) edges++;
        }
      return { pixels: n, meanAbsLumaDiffPerFrame: +(diff / Math.max(1, n)).toFixed(4), edgeDensity: +(edges / Math.max(1, n)).toFixed(3) };
    }, c.label);
    r[c.label] = m;
    console.log('SURF', c.label, JSON.stringify(m));
    await p.close();
  }
  return r;
}
