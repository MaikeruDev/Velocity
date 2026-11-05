// Blick-Ruck je Frame (Grad/Frame) eines Takes: große Sprünge = Bot zuckt.
import { readFileSync } from 'node:fs';
const t = JSON.parse(readFileSync(`media/footage/frames/${process.argv[2]}/telemetry.json`, 'utf8'));
const d = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const rows = [];
for (let i = 1; i < t.length; i++) rows.push([i, d(t[i - 1].yaw, t[i].yaw), i >= 2 ? d(t[i - 1].yaw, t[i].yaw) - d(t[i - 2].yaw, t[i - 1].yaw) : 0]);
const big = rows.filter((r) => Math.abs(r[1]) > 4 || Math.abs(r[2]) > 3);
console.log('Frames', t.length, 'max |dyaw|', Math.max(...rows.map((r) => Math.abs(r[1]))).toFixed(1), 'max |ddyaw|', Math.max(...rows.map((r) => Math.abs(r[2]))).toFixed(1));
const sec = {};
for (const r of big) sec[(r[0] / 60) | 0] = (sec[(r[0] / 60) | 0] ?? 0) + 1;
console.log('Ruck-Frames je Sekunde', JSON.stringify(sec));
if (process.argv[3]) for (let i = +process.argv[3]; i < +process.argv[4]; i++) console.log(i, t[i].yaw, rows[i - 1]?.[1].toFixed(2), t[i].sp, t[i].g ? 'G' : '', t[i].surf ? 'S' : '');
