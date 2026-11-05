/**
 * Replay-Verifier als CLI (Plan 009) — dieselbe Prüfung, die später die Cloud Function macht.
 *
 *   npx tsx tools/replay/verify.ts <replay.vrp | replay.b64>      Datei prüfen (Binär oder Base64)
 *   npx tsx tools/replay/verify.ts --bot <levelId> [--noise 1.5] [--seed 1] [--out f.vrp]
 *                                                                 Bot-Lauf aufnehmen, packen, prüfen
 *
 * Level kommen aus public/levels (index.json). Ausgabe: JSON {valid, time, reason, detail, bytes …};
 * Exit 1, wenn ungültig.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { base64ToBytes, encodeReplayBody, packReplay, unpackReplay } from '../../src/engine/replay/codec';
import { recordBotRun } from '../../src/engine/replay/botRun';
import { verifyReplay } from '../../src/engine/replay/verify';
import { loadLevelById } from './levels';

function readReplayFile(path: string): Uint8Array {
  const raw = readFileSync(path);
  // Base64-Text (aus localStorage/Tools) oder Binär.
  const text = raw.toString('latin1').trim();
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && !text.startsWith('VRP')) return base64ToBytes(text.replace(/\s+/g, ''));
  return new Uint8Array(raw);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const botLevel = opt('--bot');
  let bytes: Uint8Array;
  if (botLevel !== undefined) {
    const level = loadLevelById(botLevel);
    const t0 = performance.now();
    const rep = recordBotRun(level, { follower: { aimNoiseDeg: Number(opt('--noise') ?? 1), seed: Number(opt('--seed') ?? 1) } });
    if (!rep) {
      console.log(JSON.stringify({ valid: false, reason: 'bot', detail: `Bot kam in ${botLevel} nicht ins Ziel` }));
      process.exit(1);
    }
    bytes = await packReplay(rep);
    const raw = encodeReplayBody(rep).length;
    console.error(`Bot ${botLevel}: ${rep.header.ticks} Ticks, ${rep.header.time.toFixed(3)} s, Rumpf ${raw} B, gepackt ${bytes.length} B (${(performance.now() - t0).toFixed(0)} ms)`);
    const out = opt('--out');
    if (out) writeFileSync(out, bytes);
  } else {
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
      console.error('Aufruf: npx tsx tools/replay/verify.ts <replay> | --bot <levelId>');
      process.exit(2);
    }
    bytes = readReplayFile(file);
  }
  const rep = await unpackReplay(bytes);
  const level = loadLevelById(rep.header.levelId);
  const t0 = performance.now();
  const res = verifyReplay(rep, level);
  const ms = performance.now() - t0;
  console.log(
    JSON.stringify({
      ...res,
      levelId: rep.header.levelId,
      bytes: bytes.length,
      ticks: rep.header.ticks,
      claimedTime: rep.header.time,
      assisted: rep.header.assisted,
      settings: rep.header.settings,
      verifyMs: Math.round(ms),
    }),
  );
  if (!res.valid) process.exit(1);
}

await main();
