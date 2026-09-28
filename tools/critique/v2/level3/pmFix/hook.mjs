// Node-Loader: ersetzt src/player/PlayerMovement.ts durch die Prototyp-Kopie mit Knick-Fix,
// für ALLE Importeure (physics.ts, bots, validate-levels) — nur wenn PMFIX gesetzt ist.
//   PMFIX=1 node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs <skript>
import { register } from 'node:module';
register('./resolve.mjs', import.meta.url);
