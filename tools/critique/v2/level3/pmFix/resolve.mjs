import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const FIX = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'PlayerMovementFix.ts')).href;
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (process.env.PMFIX && process.env.PMFIX !== '0' && r.url.endsWith('/src/player/PlayerMovement.ts')) return { ...r, url: FIX };
  return r;
}
