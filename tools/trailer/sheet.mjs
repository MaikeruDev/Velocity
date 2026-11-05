// Kontaktblatt aus Frames eines Takes (Low-Res 480×270, 3 Spalten): node tools/trailer/sheet.mjs <take> <out.png> f1 f2 …
import { execFileSync } from 'node:child_process';
const [take, out, ...frames] = process.argv.slice(2);
const cols = 3;
const inputs = frames.flatMap((f) => ['-i', `media/footage/frames/${take}/${String(f).padStart(5, '0')}.png`]);
const layout = frames.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join('|');
const pads = frames.map((_, i) => `[${i}]`).join('');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', `${pads}xstack=inputs=${frames.length}:layout=${layout}:fill=black`, out]);
console.log(out);
