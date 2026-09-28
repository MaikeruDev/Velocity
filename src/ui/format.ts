/** Zeit- und Zahlenformate für HUD und Menüs (DOM-frei). */

/**
 * mm:ss.cc — Hundertstel werden abgeschnitten, nicht gerundet (Speedrun-Konvention:
 * eine angezeigte Zeit ist nie besser als die echte).
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const totalCs = Math.floor(seconds * 100 + 1e-6);
  const cs = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60);
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/** Differenz mit Vorzeichen: "−0.42" schneller, "+1.03" langsamer. Echtes Minuszeichen (U+2212). */
export function formatDiff(seconds: number): string {
  const cs = Math.round(Math.abs(seconds) * 100);
  const sign = cs === 0 ? '+' : seconds < 0 ? '−' : '+';
  const whole = Math.floor(cs / 100);
  const frac = cs % 100;
  if (whole >= 60) {
    const m = Math.floor(whole / 60);
    return `${sign}${m}:${pad2(whole % 60)}.${pad2(frac)}`;
  }
  return `${sign}${whole}.${pad2(frac)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
