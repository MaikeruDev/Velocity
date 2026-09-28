/** Kamera-Kritik: alle Plots als PNG → shots/critique/kamera/*.png */
import { launchBrowser } from '../../lib/devServer.mjs';
import { load, fovKickTarget } from './derive.mjs';
import { COLORS, renderFigures } from './plotlib.mjs';

const OUT = 'shots/critique/kamera';
const [C1, C2, C3, C4, C5] = COLORS;
const pts = (rows, f) => rows.map((x) => [x.t, f(x)]);

function timeline(name, title) {
  const { rows, events } = load(name);
  const lands = events.filter((e) => e.type === 'land').map((e) => ({ x: e.t }));
  const T = rows[rows.length - 1].t;
  return {
    path: `${OUT}/${name}-timeline.png`,
    fig: {
      title, subtitle: 'Pro gerendertem Frame (60 Hz, headless). Graue Linien = Landungen. Effekte skaliert mit Default-Einstellungen (alle 1).',
      width: 1500, panelHeight: 130, xRange: [0, T], xlabel: 'Zeit (s)',
      panels: [
        { ylabel: 'Speed u/s', series: [{ label: 'Horizontal-Speed', color: C1, pts: pts(rows, (x) => x.speed) }], marks: lands, hlines: [{ y: 1000, label: 'Kick voll (1000)' }, { y: 300, label: 'Kick-Start (300)' }] },
        { ylabel: 'hFOV 4:3 (°)', yRange: [88, 106], series: [{ label: 'FOV mit Kick', color: C2, pts: pts(rows, (x) => x.hfov43) }], marks: lands, hlines: [{ y: 90, label: 'Basis 90°' }] },
        { ylabel: 'Kamera-Y-Versatz (u)', series: [
          { label: 'Lande-Dip', color: C1, pts: pts(rows, (x) => x.dip) },
          { label: 'Head-Bob', color: C2, pts: pts(rows, (x) => x.bobV), width: 1.5 },
          { label: 'Stufen-Glättung', color: C3, pts: pts(rows, (x) => x.stepOff) },
          { label: 'Shake-Y', color: C4, pts: pts(rows, (x) => x.shakeY) },
        ], marks: lands },
        { ylabel: 'Pitch-Versatz (°)', series: [{ label: 'Nick (Dip+Kick+Bob+Shake)', color: C1, pts: pts(rows, (x) => x.pitchOff) }], marks: lands },
        { ylabel: 'Roll (°)', yRange: [-3, 3], series: [{ label: 'Roll (+ = rechts)', color: C5, pts: pts(rows, (x) => x.roll) }, { label: 'A/D-Taste ×1°', color: '#8a8984', width: 1, pts: pts(rows, (x) => x.strafe) }], marks: lands },
      ],
    },
  };
}

function walkBob() {
  const { rows } = load('walk');
  const win = (a, b) => rows.filter((x) => x.t >= a && x.t < b).map((x) => ({ ...x, t: x.t - a }));
  const w = win(1.5, 2.7);
  const s = win(4.5, 5.7);
  const d = win(7.0, 8.2);
  return {
    path: `${OUT}/walk-bob.png`,
    fig: {
      title: 'Head-Bob am Boden: Laufen 250, Sprint 320, geduckt 85 u/s', subtitle: 'Je 1.2 s Ausschnitt. Pitch in Low-Res-Pixeln (270 Zeilen, vFOV 73.7° → ~3.1 px/°).',
      width: 1200, panelHeight: 150, xRange: [0, 1.2], xlabel: 'Zeit im Ausschnitt (s)',
      panels: [
        { ylabel: 'Bob vertikal (u)', yRange: [-1, 1], series: [{ label: 'Laufen 250', color: C1, pts: pts(w, (x) => x.bobV) }, { label: 'Sprint 320', color: C2, pts: pts(s, (x) => x.bobV) }, { label: 'Geduckt 85', color: C3, pts: pts(d, (x) => x.bobV) }] },
        { ylabel: 'Bob seitlich (u)', yRange: [-0.5, 0.5], series: [{ label: 'Laufen 250', color: C1, pts: pts(w, (x) => x.bobL) }, { label: 'Sprint 320', color: C2, pts: pts(s, (x) => x.bobL) }, { label: 'Geduckt 85', color: C3, pts: pts(d, (x) => x.bobL) }] },
        { ylabel: 'Pitch-Bob (px)', yRange: [-1.2, 1.2], series: [{ label: 'Laufen 250', color: C1, pts: pts(w, (x) => x.pitchOff * x.pxPerDeg) }, { label: 'Sprint 320', color: C2, pts: pts(s, (x) => x.pitchOff * x.pxPerDeg) }, { label: 'Geduckt 85', color: C3, pts: pts(d, (x) => x.pitchOff * x.pxPerDeg) }], hlines: [{ y: 0.5, label: '±0.5 px' }, { y: -0.5, label: '' }] },
      ],
    },
  };
}

function landing() {
  const b = load('bhop');
  const dr = load('drops');
  // Bhop-Landung Nr. 20; schwere Landung = Drop mit Impact ~1000
  const bl = b.events.filter((e) => e.type === 'land')[20];
  const dl = dr.events.filter((e) => e.type === 'land');
  const heavy = dl.find((e) => e.impact > 950);
  const mid = dl.find((e) => e.impact > 550 && e.impact < 650);
  const around = (rows, t0, y0) => rows.filter((x) => x.t > t0 - 0.12 && x.t < t0 + 0.45).map((x) => ({ ...x, t: (x.t - t0) * 1000, eyeRel: x.ey - y0, camRel: x.camY - y0 }));
  const landY = (rows, t0) => { const r = rows.find((x) => x.t >= t0 && x.onGround) ?? rows.find((x) => x.t >= t0); return r.ey; };
  const B = around(b.rows, bl.t, landY(b.rows, bl.t));
  const H = around(dr.rows, heavy.t, landY(dr.rows, heavy.t));
  const M = around(dr.rows, mid.t, landY(dr.rows, mid.t));
  const l1 = load('level1');
  const hb = l1.events.filter((e) => e.type === 'land' && e.impact > 600)[0];
  const HB = around(l1.rows, hb.t, landY(l1.rows, hb.t));
  return {
    path: `${OUT}/landing.png`,
    fig: {
      title: 'Landungen: Auge (ohne Effekte) vs. Kamera', subtitle: `Bhop-Landung Hop 21 (Impact ${Math.round(bl.impact)} u/s, Sprung im Landetick) · Bhop nach Abstieg level1 · Drop ${Math.round(mid.impact)} u/s · Drop ${Math.round(heavy.impact)} u/s. y relativ zur Augenhöhe beim Aufsetzen.`,
      width: 1200, panelHeight: 170, xRange: [-120, 450], xlabel: 'ms relativ zur Landung',
      panels: [
        { ylabel: 'Bhop: y (u)', series: [{ label: 'Auge', color: '#8a8984', pts: B.map((x) => [x.t, x.eyeRel]) }, { label: 'Kamera', color: C1, pts: B.map((x) => [x.t, x.camRel]) }], marks: [{ x: 0 }] },
        { ylabel: `Bhop ${Math.round(hb.impact)} (level1): y`, series: [{ label: 'Auge', color: '#8a8984', pts: HB.map((x) => [x.t, x.eyeRel]) }, { label: 'Kamera', color: C4, pts: HB.map((x) => [x.t, x.camRel]) }], marks: [{ x: 0 }], note: `Bhop-Kette bergab, ${Math.round(hb.speed)} u/s, Sprung im Landetick` },
        { ylabel: `Drop ${Math.round(mid.impact)}: y (u)`, series: [{ label: 'Auge', color: '#8a8984', pts: M.map((x) => [x.t, x.eyeRel]) }, { label: 'Kamera', color: C2, pts: M.map((x) => [x.t, x.camRel]) }], marks: [{ x: 0 }] },
        { ylabel: `Drop ${Math.round(heavy.impact)}: y (u)`, series: [{ label: 'Auge', color: '#8a8984', pts: H.map((x) => [x.t, x.eyeRel]) }, { label: 'Kamera', color: C3, pts: H.map((x) => [x.t, x.camRel]) }], marks: [{ x: 0 }] },
        { ylabel: 'Pitch-Versatz (°)', series: [{ label: 'Bhop', color: C1, pts: B.map((x) => [x.t, x.pitchOff]) }, { label: `Bhop ${Math.round(hb.impact)}`, color: C4, pts: HB.map((x) => [x.t, x.pitchOff]) }, { label: `Drop ${Math.round(mid.impact)}`, color: C2, pts: M.map((x) => [x.t, x.pitchOff]) }, { label: `Drop ${Math.round(heavy.impact)}`, color: C3, pts: H.map((x) => [x.t, x.pitchOff]) }], marks: [{ x: 0 }] },
        { ylabel: 'Shake-Hüllk. (°)', series: [{ label: `Drop ${Math.round(heavy.impact)}`, color: C3, pts: H.map((x) => [x.t, x.shakeEnv]) }, { label: `Drop ${Math.round(mid.impact)}`, color: C2, pts: M.map((x) => [x.t, x.shakeEnv]) }], marks: [{ x: 0 }], hlines: [{ y: 0.32, label: '≈1 Low-Res-px' }] },
      ],
    },
  };
}

function fovCurve() {
  const curve = [];
  for (let v = 0; v <= 2000; v += 10) curve.push([v, fovKickTarget(v)]);
  const cdf = (name) => {
    const sp = load(name).rows.map((x) => x.speed).sort((a, b) => a - b);
    const out = [];
    for (let v = 0; v <= 2000; v += 20) { let k = 0; while (k < sp.length && sp[k] <= v) k++; out.push([v, (100 * k) / sp.length]); }
    return out;
  };
  const l1 = load('level1').rows.filter((_, i) => i % 6 === 0).map((x) => [x.speed, x.fovKick]);
  return {
    path: `${OUT}/fov-curve.png`,
    fig: {
      title: 'FOV-Kick über Speed — und wo Spieler tatsächlich fahren', subtitle: 'Oben: Gleichgewichts-Kick (Formel CameraRig.ts:306) + gemessene Frames level1 (Bot sync 1). Unten: Zeitanteil unter Speed v (Summenkurve).',
      width: 1200, panelHeight: 200, xRange: [0, 2000], xlabel: 'Horizontal-Speed (u/s)',
      panels: [
        { ylabel: 'FOV-Kick (° hFOV 4:3)', yRange: [-0.5, 15], series: [{ label: 'Formel', color: C1, pts: curve }, { label: 'level1 gemessen', color: C2, pts: l1, dots: true }], hlines: [{ y: 5, label: '≈ klar spürbar' }] },
        { ylabel: 'Zeit unter v (%)', yRange: [0, 100], series: [{ label: 'level1 sync 1', color: C1, pts: cdf('level1') }, { label: 'level1 sync 0.8', color: C2, pts: cdf('level1h') }, { label: 'Bhop Mensch (3°)', color: C3, pts: cdf('bhophuman') }, { label: 'Bhop perfekt', color: C4, pts: cdf('bhop') }], hlines: [{ y: 50, label: 'Median' }] },
      ],
    },
  };
}

function bhopChain() {
  const p = load('bhop');
  const h = load('bhophuman');
  const T = Math.max(p.rows[p.rows.length - 1].t, h.rows[h.rows.length - 1].t);
  const w0 = 20;
  const zoom = (d) => d.rows.filter((x) => x.t >= w0 && x.t < w0 + 3).map((x) => [x.t - w0, x.roll]);
  return {
    path: `${OUT}/bhop-chain.png`,
    fig: {
      title: '50 Hops auf freier Fläche: Speed, FOV, Dip, Roll', subtitle: 'StrafeBot zigzag (eine Strafe-Richtung pro Hop). Perfekt vs. Mensch-Modell (3° Zielfehler).',
      width: 1500, panelHeight: 140, xRange: [0, T], xlabel: 'Zeit (s)',
      panels: [
        { ylabel: 'Speed u/s', series: [{ label: 'perfekt', color: C1, pts: pts(p.rows, (x) => x.speed) }, { label: 'Mensch 3°', color: C2, pts: pts(h.rows, (x) => x.speed) }], hlines: [{ y: 1000, label: 'Kick-Sättigung' }] },
        { ylabel: 'hFOV 4:3 (°)', yRange: [88, 106], series: [{ label: 'perfekt', color: C1, pts: pts(p.rows, (x) => x.hfov43) }, { label: 'Mensch 3°', color: C2, pts: pts(h.rows, (x) => x.hfov43) }] },
        { ylabel: 'Lande-Dip (u)', series: [{ label: 'perfekt', color: C1, pts: pts(p.rows, (x) => x.dip) }] },
        { ylabel: 'Roll (°)', yRange: [-2, 2], series: [{ label: 'perfekt', color: C1, pts: pts(p.rows, (x) => x.roll) }, { label: 'Mensch 3°', color: C2, pts: pts(h.rows, (x) => x.roll), width: 1.5 }] },
      ],
    },
  };
}

function drops() {
  const d = load('drops');
  const lands = d.events.filter((e) => e.type === 'land');
  const per = lands.map((e) => {
    const w = d.rows.filter((x) => x.t >= e.t - 0.02 && x.t < e.t + 0.4);
    return { imp: e.impact, dip: Math.min(...w.map((x) => x.dip)), nod: Math.min(...w.map((x) => x.nod)), shake: Math.max(...w.map((x) => x.shakeEnv)) };
  });
  const theo = [];
  for (let v = 0; v <= 1500; v += 10) { const x = Math.max(0, (v - 120) / 480); theo.push([v, -Math.min(12, 8 * Math.pow(x, 1.3))]); }
  const shk = [];
  for (let v = 0; v <= 1500; v += 10) { const tr = v > 450 ? Math.min(1, Math.max(0.15, (v - 450) / 550)) : 0; shk.push([v, tr * tr * 0.8]); }
  return {
    path: `${OUT}/drops.png`,
    fig: {
      title: 'Landung: Dip, Nick, Shake über Aufprall-Speed', subtitle: 'Linien = Formel (CameraRig.ts:218–229), Punkte = gemessene Drops (57–1225 u Fallhöhe). Bhop-Landung ≈ 300 u/s.',
      width: 1200, panelHeight: 160, xRange: [0, 1500], xlabel: 'Aufprall vertikal (u/s)',
      panels: [
        { ylabel: 'Dip-Tiefe (u)', series: [{ label: 'Formel', color: C1, pts: theo }, { label: 'gemessen', color: C2, pts: per.map((p) => [p.imp, p.dip]), dots: true }], marks: [{ x: 302 }] },
        { ylabel: 'Nick (°)', series: [{ label: 'gemessen', color: C2, pts: per.map((p) => [p.imp, p.nod]), dots: true }], marks: [{ x: 302 }] },
        { ylabel: 'Shake-Spitze (°)', series: [{ label: 'Formel (trauma²·0.8)', color: C1, pts: shk }, { label: 'gemessen', color: C2, pts: per.map((p) => [p.imp, p.shake]), dots: true }], hlines: [{ y: 0.32, label: '≈1 Low-Res-px' }], marks: [{ x: 302 }] },
      ],
    },
  };
}

function duckStairs() {
  const du = load('duck');
  const st = load('stairs');
  return {
    path: `${OUT}/duck-stairs.png`,
    fig: {
      title: 'Übergänge: Ducken im Stand / Crouch-Jump, Treppe 16 u', subtitle: 'Oben: Augenhöhe und Kamera-y (relativ). Unten: Treppe — Füße vs. Kamera (Stufen-Glättung).',
      width: 1200, panelHeight: 160, xRange: [0, Math.max(du.rows[du.rows.length - 1].t, 1.6)], xlabel: 'Zeit (s)',
      panels: [
        { ylabel: 'Duck: y (u)', series: [{ label: 'Auge (Welt)', color: '#8a8984', pts: pts(du.rows, (x) => x.ey - du.rows[0].ey) }, { label: 'Kamera', color: C1, pts: pts(du.rows, (x) => x.camY - du.rows[0].ey) }, { label: 'Augenhöhe−64', color: C2, pts: pts(du.rows, (x) => x.eyeH - 64) }] },
        { ylabel: 'Treppe: y (u)', series: [{ label: 'Füße', color: '#8a8984', pts: pts(st.rows, (x) => x.ey - x.eyeH) }, { label: 'Kamera−64', color: C1, pts: pts(st.rows, (x) => x.camY - 64) }] },
      ],
    },
  };
}

const figs = [
  timeline('level1', 'level1 · Route-Bot sync 1 (perfekt)'),
  timeline('level1h', 'level1 · Route-Bot sync 0.8 (unsauber)'),
  timeline('level2', 'level2 · Route-Bot sync 1 (Surf-Anteil 20 %)'),
  walkBob(), landing(), fovCurve(), bhopChain(), drops(), duckStairs(),
];
const browser = await launchBrowser();
try {
  await renderFigures(browser, figs);
} finally {
  await browser.close();
}
