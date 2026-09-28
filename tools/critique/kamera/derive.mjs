/**
 * Kamera-Kritik: Rohdaten → abgeleitete Effekt-Anteile pro Frame.
 * VERALTET seit Plan 003: rechnet die Formeln des alten Rigs nach. Für den aktuellen Stand
 * analyze.mjs nehmen (liest rig.fxState direkt aus den record.mjs-Daten).
 */
import { readFileSync } from 'node:fs';

const RAD = 180 / Math.PI;
export const LOWRES_H = 270;

export function load(name) {
  const d = JSON.parse(readFileSync(`shots/critique/kamera/data/${name}.json`, 'utf8'));
  const ix = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  const t0 = d.frames.length ? d.frames[0][ix.t] : 0;
  const rows = d.frames.map((r) => {
    const g = (f) => r[ix[f]];
    const speed = g('speed');
    const ducked = g('ducked') === 1;
    const bobW = g('bobW');
    const sf = Math.min(Math.max(speed / 250, 0), 1.25);
    const amp = bobW * sf * (ducked ? 0.5 : 1);
    const ph = g('stride') * Math.PI * 2;
    const hb = g('sHb');
    const bobV = -0.6 * amp * Math.cos(2 * ph) * hb;
    const bobL = 0.25 * amp * Math.sin(ph) * hb;
    const bobPitch = 0.2 * amp * Math.cos(2 * ph) * hb;
    const dip = Math.max(-12, g('dipX')) * hb;
    const nodLand = Math.max(-12, g('dipX')) * (1.5 / 12) * hb;
    const nodJump = g('kickX') * hb;
    const shake = g('trauma') ** 2 * g('sSh');
    const dy = g('cy') - g('ey');
    const vfov = g('vfov');
    const pxPerDeg = (LOWRES_H / 2) / Math.tan((vfov / 2) / RAD) / RAD;
    const hfov169 = 2 * Math.atan(Math.tan(vfov / 2 / RAD) * g('aspect')) * RAD;
    return {
      t: (g('t') - t0) / 1000,
      dt: g('dt'),
      ex: g('ex'), ey: g('ey'), ez: g('ez'), eyeH: g('eyeH'),
      speed, vy: g('vy'), onGround: g('onGround') === 1, ducked, surfing: g('surfing') === 1, sprinting: g('sprinting') === 1,
      strafe: g('strafe'),
      bobV, bobL, bobPitch, dip, nodLand, nodJump, nod: nodLand + nodJump,
      stepOff: g('stepOff'),
      shakeEnv: shake * 0.8, // Winkel-Hüllkurve in Grad
      shakeY: dy - bobV - dip - g('stepOff'),
      dy,
      pitchOff: (g('rx') - g('pitch')) * RAD,
      yawOff: (g('ry') - g('yaw')) * RAD,
      roll: -g('rz') * RAD,
      fovKick: g('fovKick') * g('sFk'),
      hfov43: g('sFov') + g('fovKick') * g('sFk'),
      vfov, hfov169, pxPerDeg,
      camX: g('cx'), camY: g('cy'), camZ: g('cz'),
    };
  });
  const events = d.events.map((e) => ({ ...e, t: (e.t - t0) / 1000 }));
  return { name: d.name, rows, events, raw: d };
}

export function pp(xs) {
  if (!xs.length) return 0;
  return Math.max(...xs) - Math.min(...xs);
}
export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
export function pct(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
export function r(v, d = 2) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** Erwarteter FOV-Kick (Grad, horizontal 4:3) im Gleichgewicht — Formel aus CameraRig. */
export function fovKickTarget(speed, sprint = false, onGround = false) {
  const ss = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  let k = 12 * ss(300, 1000, speed) + 2 * ss(1000, 1800, speed);
  if (sprint && onGround && speed > 100) k += 2;
  return k;
}
