import { load, pp, r, mean } from './derive.mjs';
const { rows } = load('walk');
const win = (a, b, f = () => true) => rows.filter((x) => x.t >= a && x.t < b && f(x));
const phases = [['Laufen 250', 1.0, 2.9], ['Sprint 320', 4.0, 5.9], ['Duck-Laufen', 6.8, 7.9], ['Seitwärts A', 9.6, 10.9]];
for (const [n, a, b] of phases) {
  const w = win(a, b, (x) => x.onGround);
  if (!w.length) { console.log(n, 'keine Frames'); continue; }
  // Frequenz: Nulldurchgänge von bobV
  let zc = 0;
  for (let i = 1; i < w.length; i++) if (Math.sign(w[i].bobV) !== Math.sign(w[i - 1].bobV)) zc++;
  const dur = w[w.length - 1].t - w[0].t;
  const px = mean(w.map((x) => x.pxPerDeg));
  console.log(n.padEnd(12), 'speed', r(mean(w.map((x) => x.speed)), 0), '| bobV p-p', r(pp(w.map((x) => x.bobV))), 'u | bobL p-p', r(pp(w.map((x) => x.bobL))), 'u | pitch p-p', r(pp(w.map((x) => x.pitchOff)), 3), '° =', r(pp(w.map((x) => x.pitchOff)) * px, 2), 'px | Freq', r(zc / 2 / dur, 2), 'Hz | roll', r(mean(w.map((x) => x.roll)), 2), '° | hFOV43', r(mean(w.map((x) => x.hfov43)), 2), '| eyeH', r(mean(w.map((x)=>x.eyeH)),1));
}
