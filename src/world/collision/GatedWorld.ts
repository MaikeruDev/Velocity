import { Vector3 } from 'three';
import type { CompiledGate } from '../level/compileLevel';
import { clipBoxToBrush } from './BrushWorld';
import type { CollisionWorld, TraceResult } from './types';
import { makeTraceResult } from './types';

/**
 * Kollisionswelt einer Lektion (Plan 007, TC2): die statische Welt plus die Tore der Lektion
 * (CompiledLevel.gates, liegen NICHT in der BrushWorld). Ein geschlossenes Tor kollidiert wie eine
 * Wand; offen ist es Luft. Die Lektion (engine/Training) öffnet Tore sofort bei Stufenabschluss —
 * das Auflösen der Optik (gateOpen 0..1) läuft getrennt davon im Renderer.
 *
 * Ohne geschlossenes Tor gibt traceBox exakt das Ergebnis der Basiswelt zurück (bitgleich, Test
 * tests/gatedWorld.test.ts über L1/L2-Bot-Läufe). Sonst: erst die Basiswelt, dann jedes geschlossene
 * Tor mit AABB-Vorprüfung per clipBoxToBrush (Quake-Semantik: nur ein früherer Treffer ersetzt).
 * Tick-Pfad ohne Allokation.
 */
export class GatedWorld implements CollisionWorld {
  private readonly open: Uint8Array;
  private closedCount: number;
  private readonly tmp = makeTraceResult();
  private readonly bmin = new Vector3();
  private readonly bmax = new Vector3();

  constructor(
    readonly base: CollisionWorld,
    readonly gates: readonly CompiledGate[],
  ) {
    this.open = new Uint8Array(gates.length);
    this.closedCount = gates.length;
  }

  /** Tor i (Reihenfolge von CompiledLevel.gates) öffnen oder schließen. */
  setOpen(i: number, open: boolean): void {
    if (i < 0 || i >= this.open.length) return;
    const v = open ? 1 : 0;
    if (this.open[i] === v) return;
    this.open[i] = v;
    this.closedCount += open ? -1 : 1;
  }

  isOpen(i: number): boolean {
    return this.open[i] === 1;
  }

  /** Alle Tore zu (Lektion neu). */
  closeAll(): void {
    this.open.fill(0);
    this.closedCount = this.open.length;
  }

  /** Index eines Tors nach GateDef.id, −1 = unbekannt. */
  indexOf(id: string): number {
    for (let i = 0; i < this.gates.length; i++) if (this.gates[i].id === id) return i;
    return -1;
  }

  traceBox(start: Vector3, end: Vector3, mins: Vector3, maxs: Vector3, out: TraceResult = makeTraceResult()): TraceResult {
    this.base.traceBox(start, end, mins, maxs, out);
    if (this.closedCount === 0 || out.allSolid) return out;
    const bmin = this.bmin.set(
      Math.min(start.x, end.x) + mins.x - 1,
      Math.min(start.y, end.y) + mins.y - 1,
      Math.min(start.z, end.z) + mins.z - 1,
    );
    const bmax = this.bmax.set(
      Math.max(start.x, end.x) + maxs.x + 1,
      Math.max(start.y, end.y) + maxs.y + 1,
      Math.max(start.z, end.z) + maxs.z + 1,
    );
    const before = out.fraction;
    for (let i = 0; i < this.gates.length; i++) {
      if (this.open[i] === 1) continue;
      const bb = this.gates[i].bounds;
      if (bb.min.x > bmax.x || bb.max.x < bmin.x) continue;
      if (bb.min.y > bmax.y || bb.max.y < bmin.y) continue;
      if (bb.min.z > bmax.z || bb.max.z < bmin.z) continue;
      clipBoxToBrush(this.gates[i].brush, start, end, mins, maxs, out);
      if (out.allSolid) break;
    }
    if (out.fraction !== before) out.endPos.copy(start).lerp(end, out.fraction);
    return out;
  }

  testBox(pos: Vector3, mins: Vector3, maxs: Vector3): boolean {
    return this.traceBox(pos, pos, mins, maxs, this.tmp).startSolid;
  }
}
