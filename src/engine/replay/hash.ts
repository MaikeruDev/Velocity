import type { MovementConfig } from '../../player/MovementConfig';
import type { CompiledLevel } from '../../world/level/compileLevel';

/**
 * Fingerabdrücke für Replays (Plan 009): Level-Hash über die KOMPILIERTEN Kollisionsdaten (Ebenen
 * als Float64-Bits, Trigger, Spawn, killY) und Config-Hash über alle MovementConfig-Felder. Über die
 * Bits statt über JSON: dieselbe Datei kann in einer anderen Engine andere Ebenen ergeben (früher
 * Math.cos in compileLevel) — dann soll der Hash es zeigen, nicht ein Desync mitten im Lauf.
 * 64 Bit (zwei FNV-1a-Ströme), Hex. DOM-frei.
 */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193 ^ 0x5bd1e995;

  word(w: number): void {
    const x = w >>> 0;
    for (let k = 0; k < 4; k++) {
      const byte = (x >>> (k * 8)) & 0xff;
      this.a = Math.imul(this.a ^ byte, 0x01000193) >>> 0;
      this.b = Math.imul(this.b ^ byte, 0x01000193) >>> 0;
      // Zweiter Strom mit eigener Mischung, damit die 64 Bit nicht zweimal dasselbe tragen.
      this.b = (this.b ^ (this.b >>> 13)) >>> 0;
    }
  }

  num(v: number): void {
    // −0 und 0 sind physikalisch gleich; NaN normieren.
    F64[0] = v === 0 ? 0 : v;
    this.word(U32[0]);
    this.word(U32[1]);
  }

  str(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  hex(): string {
    return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0');
  }
}

/** Hash der Physik-relevanten Level-Daten (kompiliert). Teuer-ish (alle Ebenen) — einmal je Level cachen. */
export function levelHash(level: CompiledLevel): string {
  const h = new Hasher();
  h.str(level.def.id);
  h.word(level.brushes.length);
  for (const b of level.brushes) {
    h.word(b.collide ? 1 : 0);
    if (!b.collide) continue;
    h.word(b.planes.length);
    for (const p of b.planes) {
      h.num(p.normal.x);
      h.num(p.normal.y);
      h.num(p.normal.z);
      h.num(p.dist);
    }
  }
  h.word(level.triggers.length);
  for (const t of level.triggers) {
    h.str(t.kind);
    h.num(t.order);
    h.num(t.bounds.min.x);
    h.num(t.bounds.min.y);
    h.num(t.bounds.min.z);
    h.num(t.bounds.max.x);
    h.num(t.bounds.max.y);
    h.num(t.bounds.max.z);
    h.num(t.spawnPos.x);
    h.num(t.spawnPos.y);
    h.num(t.spawnPos.z);
    h.num(t.spawnYaw);
  }
  h.num(level.spawnPos.x);
  h.num(level.spawnPos.y);
  h.num(level.spawnPos.z);
  h.num(level.spawnYaw);
  h.num(level.def.killY);
  h.word(level.gates.length);
  return h.hex();
}

/** Hash über alle Felder (sortiert, rekursiv) — neue MovementConfig-Felder zählen automatisch mit. */
export function configHash(cfg: MovementConfig): string {
  const h = new Hasher();
  feed(h, cfg);
  return h.hex();
}

function feed(h: Hasher, v: unknown): void {
  if (typeof v === 'number') h.num(v);
  else if (typeof v === 'boolean') h.word(v ? 1 : 0);
  else if (typeof v === 'string') h.str(v);
  else if (typeof v === 'object' && v !== null) {
    const o: Record<string, unknown> = { ...v };
    const keys = Object.keys(o).sort();
    h.word(keys.length);
    for (const k of keys) {
      h.str(k);
      feed(h, o[k]);
    }
  } else h.word(0xdeadbeef);
}
