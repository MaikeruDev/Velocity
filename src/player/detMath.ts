/**
 * Deterministische Winkel- und Längenfunktionen für die Physik (Plan 009, Replays).
 *
 * Warum: `Math.sin/cos/atan2` sind laut ECMAScript nur "implementation-approximated". Gemessen
 * (01.10., fallen.md #203): Node 22 (V8 12.4) und Chromium 153 liefern für sin, cos, atan2, tan,
 * exp UNTERSCHIEDLICHE Bits — "beides ist V8" reicht nicht. Ein Replay, das im Browser
 * aufgenommen und in Node (Cloud Function) nachgespielt wird, liefe sonst auseinander.
 *
 * Lösung: fdlibm (sin/cos/atan2, FreeBSD-msun-Fassung wie V8s base/ieee754.cc) und V8s Kahan-
 * hypot hier in JS — nur + − × ÷ und `Math.sqrt`. Diese Operationen rundet JS überall exakt nach
 * IEEE 754 (kein FMA-Zusammenziehen erlaubt), also rechnen Node, Chrome, Firefox und Safari
 * bitgleich. Die Port-Treue gegen Node (= fdlibm) prüft tests/detMath.test.ts: dort sind die
 * Ergebnisse bitgleich zu `Math.*`, die Physik in Node (Sim, Tests, Medaillen) ändert sich nicht.
 *
 * Keine Allokation: Wort-Zugriff über einen Modul-Puffer, keine Modul-`let` mit Kommazahlen
 * (fallen.md #107).
 */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const I32 = new Int32Array(F64.buffer);
/** Index des höherwertigen Wortes (Little Endian → 1). */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

function highWord(x: number): number {
  F64[0] = x;
  return I32[HI];
}

function lowWord(x: number): number {
  F64[0] = x;
  return U32[LO];
}

function fromWords(hi: number, lo: number): number {
  U32[HI] = hi >>> 0;
  U32[LO] = lo >>> 0;
  return F64[0];
}

/** x mit gesetztem High-Word (low = 0) — fdlibm `__HI(qx) = …; __LO(qx) = 0`. */
function withHigh(hi: number): number {
  return fromWords(hi, 0);
}

// --- Konstanten (Bitmuster wie in fdlibm, Dezimalwert als Kommentar) ---------------------------

const S1 = fromWords(0xbfc55555, 0x55555549); // -1.66666666666666324348e-01
const S2 = fromWords(0x3f811111, 0x1110f8a6); //  8.33333333332248946124e-03
const S3 = fromWords(0xbf2a01a0, 0x19c161d5); // -1.98412698298579493134e-04
const S4 = fromWords(0x3ec71de3, 0x57b1fe7d); //  2.75573137070700676789e-06
const S5 = fromWords(0xbe5ae5e6, 0x8a2b9ceb); // -2.50507602534068634195e-08
const S6 = fromWords(0x3de5d93a, 0x5acfd57c); //  1.58969099521155010221e-10

const C1 = fromWords(0x3fa55555, 0x5555554c); //  4.16666666666666019037e-02
const C2 = fromWords(0xbf56c16c, 0x16c15177); // -1.38888888888741095749e-03
const C3 = fromWords(0x3efa01a0, 0x19cb1590); //  2.48015872894767294178e-05
const C4 = fromWords(0xbe927e4f, 0x809c52ad); // -2.75573143513906633035e-07
const C5 = fromWords(0x3e21ee9e, 0xbdb4b1c4); //  2.08757232129817482790e-09
const C6 = fromWords(0xbda8fae9, 0xbe8838d4); // -1.13596475577881948265e-11

const INVPIO2 = fromWords(0x3fe45f30, 0x6dc9c883); // 6.36619772367581382433e-01
const PIO2_1 = fromWords(0x3ff921fb, 0x54400000); // 1.57079632673412561417e+00
const PIO2_1T = fromWords(0x3dd0b461, 0x1a626331); // 6.07710050650619224932e-11
const PIO2_2 = fromWords(0x3dd0b461, 0x1a600000); // 6.07710050630396597660e-11
const PIO2_2T = fromWords(0x3ba3198a, 0x2e037073); // 2.02226624879595063154e-21
const PIO2_3 = fromWords(0x3ba3198a, 0x2e000000); // 2.02226624871116645580e-21
const PIO2_3T = fromWords(0x397b839a, 0x252049c1); // 8.47842766036889956997e-32

/** High-Words von n·π/2 (n = 1..32), fdlibm `npio2_hw`. */
const NPIO2_HW = new Int32Array([
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c,
  0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c,
  0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
]);

const PI_O_4 = fromWords(0x3fe921fb, 0x54442d18);
const PI_O_2 = fromWords(0x3ff921fb, 0x54442d18);
const PI = fromWords(0x400921fb, 0x54442d18);
const PI_LO = fromWords(0x3ca1a626, 0x33145c07);
const TINY = 1.0e-300;

const ATANHI = new Float64Array([
  fromWords(0x3fddac67, 0x0561bb4f), // atan(0.5)
  fromWords(0x3fe921fb, 0x54442d18), // atan(1.0)
  fromWords(0x3fef730b, 0xd281f69b), // atan(1.5)
  fromWords(0x3ff921fb, 0x54442d18), // atan(inf)
]);
const ATANLO = new Float64Array([
  fromWords(0x3c7a2b7f, 0x222f65e2),
  fromWords(0x3c81a626, 0x33145c07),
  fromWords(0x3c700788, 0x7af0cbbd),
  fromWords(0x3c91a626, 0x33145c07),
]);
const AT0 = fromWords(0x3fd55555, 0x5555550d);
const AT1 = fromWords(0xbfc99999, 0x9998ebc4);
const AT2 = fromWords(0x3fc24924, 0x920083ff);
const AT3 = fromWords(0xbfbc71c6, 0xfe231671);
const AT4 = fromWords(0x3fb745cd, 0xc54c206e);
const AT5 = fromWords(0xbfb3b0f2, 0xaf749a6d);
const AT6 = fromWords(0x3fb10d66, 0xa0d03d51);
const AT7 = fromWords(0xbfadde2d, 0x52defd9a);
const AT8 = fromWords(0x3fa97b4b, 0x24760deb);
const AT9 = fromWords(0xbfa2b444, 0x2c6a6c2f);
const AT10 = fromWords(0x3f90ad3a, 0xe322da11);

/** Ergebnis der Argument-Reduktion (y0, y1) — Modul-Puffer statt Rückgabe-Objekt. */
const RED = new Float64Array(2);

// --- Kerne -----------------------------------------------------------------------------------

function kernelSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

function kernelCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : withHigh(ix - 0x00200000); // x/4
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

/**
 * fdlibm `__ieee754_rem_pio2` für |x| ≤ 2^19·π/2 (Cody-Waite, bis 151 Bit π). Schreibt y0/y1 nach
 * RED, liefert n. Größere Argumente (> 823 550 rad) kommen in der Physik nicht vor — dort -1e9
 * als Marke, der Aufrufer fällt auf Math.* zurück (nicht mehr deterministisch, aber endlich).
 */
function remPio2(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix < 0x4002d97c) {
    // |x| < 3π/4: n = ±1
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        RED[0] = z - PIO2_1T;
        RED[1] = z - RED[0] - PIO2_1T;
      } else {
        z -= PIO2_2;
        RED[0] = z - PIO2_2T;
        RED[1] = z - RED[0] - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      RED[0] = z + PIO2_1T;
      RED[1] = z - RED[0] + PIO2_1T;
    } else {
      z += PIO2_2;
      RED[0] = z + PIO2_2T;
      RED[1] = z - RED[0] + PIO2_2T;
    }
    return -1;
  }
  if (ix > 0x413921fb) return -1e9;
  let t = Math.abs(x);
  const n = Math.trunc(t * INVPIO2 + 0.5);
  const fn = n;
  let r = t - fn * PIO2_1;
  let w = fn * PIO2_1T;
  if (n < 32 && ix !== NPIO2_HW[n - 1]) {
    RED[0] = r - w;
  } else {
    const j = ix >> 20;
    RED[0] = r - w;
    let i = j - ((highWord(RED[0]) >> 20) & 0x7ff);
    if (i > 16) {
      t = r;
      w = fn * PIO2_2;
      r = t - w;
      w = fn * PIO2_2T - (t - r - w);
      RED[0] = r - w;
      i = j - ((highWord(RED[0]) >> 20) & 0x7ff);
      if (i > 49) {
        t = r;
        w = fn * PIO2_3;
        r = t - w;
        w = fn * PIO2_3T - (t - r - w);
        RED[0] = r - w;
      }
    }
  }
  RED[1] = r - RED[0] - w;
  if (hx < 0) {
    RED[0] = -RED[0];
    RED[1] = -RED[1];
    return -n;
  }
  return n;
}

// --- Öffentlich ------------------------------------------------------------------------------

/** sin(x), bitgleich in jeder JS-Engine (fdlibm). */
export function dsin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  if (n === -1e9) return Math.sin(x);
  switch (n & 3) {
    case 0:
      return kernelSin(RED[0], RED[1], 1);
    case 1:
      return kernelCos(RED[0], RED[1]);
    case 2:
      return -kernelSin(RED[0], RED[1], 1);
    default:
      return -kernelCos(RED[0], RED[1]);
  }
}

/** cos(x), bitgleich in jeder JS-Engine (fdlibm). */
export function dcos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  if (n === -1e9) return Math.cos(x);
  switch (n & 3) {
    case 0:
      return kernelCos(RED[0], RED[1]);
    case 1:
      return -kernelSin(RED[0], RED[1], 1);
    case 2:
      return -kernelCos(RED[0], RED[1]);
    default:
      return kernelSin(RED[0], RED[1], 1);
  }
}

/** atan(x) (fdlibm s_atan.c). */
export function datan(xIn: number): number {
  let x = xIn;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    // |x| ≥ 2^66
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lowWord(x) !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return hx < 0 ? -r : r;
}

/** atan2(y, x), bitgleich in jeder JS-Engine (fdlibm/FreeBSD e_atan2.c). */
export function datan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y; // NaN
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const lx = lowWord(x);
  const hy = highWord(y);
  const iy = hy & 0x7fffffff;
  const ly = lowWord(y);
  if (((hx - 0x3ff00000) | lx) === 0) return datan(y); // x = 1.0
  let m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2); // 2·sign(x) + sign(y)
  if ((iy | ly) === 0) {
    // y = ±0
    switch (m) {
      case 0:
      case 1:
        return y;
      case 2:
        return PI + TINY;
      default:
        return -PI - TINY;
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY; // x = ±0
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PI_O_4 + TINY;
        case 1:
          return -PI_O_4 - TINY;
        case 2:
          return 3 * PI_O_4 + TINY;
        default:
          return -3 * PI_O_4 - TINY;
      }
    }
    switch (m) {
      case 0:
        return 0;
      case 1:
        return -0;
      case 2:
        return PI + TINY;
      default:
        return -PI - TINY;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) {
    z = PI_O_2 + 0.5 * PI_LO;
    m &= 1;
  } else if (hx < 0 && k < -60) z = 0;
  else z = datan(Math.abs(y / x));
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

/**
 * hypot(x, z) wie V8s `Math.hypot` (math.tq: durch das Maximum teilen, Kahan-Summe, sqrt) —
 * bitgleich zu Node/Chrome, aber auch in Firefox/Safari (deren hypot rechnet anders).
 */
export function dhypot(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax === Infinity || az === Infinity) return Infinity;
  if (ax !== ax || az !== az) return Number.NaN;
  const max = ax > az ? ax : az;
  if (max === 0) return 0;
  const n0 = ax / max;
  const s0 = n0 * n0;
  // Kahan: compensation nach dem ersten Summanden = (s0 − 0) − s0 = 0.
  const n1 = az / max;
  const summand = n1 * n1;
  return Math.sqrt(s0 + summand) * max;
}
