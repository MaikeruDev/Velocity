/**
 * Ganze Takes als Schnitt-Quelle: media/footage/frames/<take>/ → media/footage/takes/<take>.mp4 (1080p60, Nearest 4×,
 * CRF 14) plus Kurzprotokoll der Telemetrie (alle 0.5 s: Tempo, Boden/Surf, Checkpoint, Ziel) für die Schnittliste.
 *
 *   node tools/trailer/takeclips.mjs <take …> [--summary]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const takes = args.filter((a) => !a.startsWith('--'));
mkdirSync('media/footage/takes', { recursive: true });
for (const t of takes) {
  const dir = `media/footage/frames/${t}`;
  const out = `media/footage/takes/${t}.mp4`;
  if (!summaryOnly) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '60', '-i', `${dir}/%05d.png`, '-vf', 'scale=1920:1080:flags=neighbor,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-r', '60', out]);
  }
  const tele = existsSync(`${dir}/telemetry.json`) ? JSON.parse(readFileSync(`${dir}/telemetry.json`, 'utf8')) : [];
  const fin = tele.findIndex((s) => s.fin);
  const rows = [];
  for (let i = 0; i < tele.length; i += 30) {
    const s = tele[i];
    rows.push(`${(i / 60).toFixed(1)}:${s.sp}${s.surf ? 'S' : s.g ? 'g' : ''}${s.cp ? `c${s.cp}` : ''}`);
  }
  const top = tele.reduce((a, s, i) => (s.sp > a.sp ? { sp: s.sp, i } : a), { sp: 0, i: 0 });
  console.log(`${t}: ${tele.length} Frames, Ziel ${fin >= 0 ? (fin / 60).toFixed(2) + ' s' : '—'}, Spitze ${top.sp} @ ${(top.i / 60).toFixed(2)} s`);
  console.log('  ' + rows.join(' '));
}
