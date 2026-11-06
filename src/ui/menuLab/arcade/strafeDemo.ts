/**
 * "HOW TO PLAY"-Vorführung: Draufsicht auf einen Bhop-Lauf mit Air-Strafe (Schlangenlinie). Winziges Canvas
 * (64×48), pixelig hochskaliert. Pro Frame nur fillRect mit festen Farb-Strings — keine Allokation.
 * Die Seite (A/D) liefert side(); das DOM schaltet damit die Tasten-Kappen um.
 */
export const DEMO_W = 64;
export const DEMO_H = 48;

const PERIOD = 1.5; // s je Strafe-Paar (links + rechts)
const AMP = 11;
const PLAYER_Y = 38;
/** Zeilen pro Sekunde, die der Boden nach unten läuft (= Vorwärtstempo der Figur). */
const SCROLL = 22;

export class StrafeDemo {
  private readonly g: CanvasRenderingContext2D | null;
  private lastSide = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = DEMO_W;
    canvas.height = DEMO_H;
    this.g = canvas.getContext('2d');
  }

  /** -1 = A (links), 1 = D (rechts) — Vorzeichen der seitlichen Bewegung beim letzten draw(). */
  side(): number {
    return this.lastSide;
  }

  draw(tSec: number): void {
    const g = this.g;
    if (!g) return;
    const w = (Math.PI * 2) / PERIOD;
    g.fillStyle = '#080414';
    g.fillRect(0, 0, DEMO_W, DEMO_H);
    // Boden-Raster läuft nach unten: die Figur fährt "nach oben".
    const scroll = (tSec * SCROLL) % 8;
    g.fillStyle = '#1a1238';
    for (let y = Math.floor(scroll) - 8; y < DEMO_H; y += 8) {
      if (y < 0) continue;
      for (let x = 4; x < DEMO_W; x += 8) g.fillRect(x, y, 1, 1);
    }
    const cx = DEMO_W / 2;
    // Spur: Zeile y zeigt die Position von vor (PLAYER_Y - y)/SCROLL Sekunden.
    for (let y = 2; y < PLAYER_Y; y++) {
      const back = (PLAYER_Y - y) / SCROLL;
      const x = Math.round(cx + AMP * Math.sin(w * (tSec - back)));
      g.fillStyle = y < 14 ? '#124a56' : y < 26 ? '#1d8a99' : '#33f0ff';
      g.fillRect(x, y, 1, 1);
    }
    const px = Math.round(cx + AMP * Math.sin(w * tSec));
    const vx = Math.cos(w * tSec);
    this.lastSide = vx < 0 ? -1 : 1;
    // Figur 3×3, Blickrichtung: 2 px in Bewegungsrichtung (Maus folgt der Kurve).
    g.fillStyle = '#ffffff';
    g.fillRect(px - 1, PLAYER_Y - 1, 3, 3);
    g.fillStyle = '#ffd84a';
    const lx = vx < -0.35 ? -1 : vx > 0.35 ? 1 : 0;
    g.fillRect(px + lx * 2, PLAYER_Y - 3, 1, 1);
    g.fillRect(px + lx * 3, PLAYER_Y - 4, 1, 1);
    // Bodenkontakt-Puls an den Wendepunkten (dort landet der Hop): kurzer grüner Ring.
    const near = Math.abs(vx);
    if (near < 0.18) {
      g.fillStyle = '#5dff9a';
      g.fillRect(px - 3, PLAYER_Y + 3, 7, 1);
    }
    // Tempo-Balken unten: wächst über die Vorführung, fällt am Ende zurück (Schleife 12 s).
    const ramp = (tSec % 12) / 12;
    g.fillStyle = '#1a1238';
    g.fillRect(4, DEMO_H - 3, DEMO_W - 8, 1);
    g.fillStyle = ramp > 0.75 ? '#ffd84a' : '#ff3fd0';
    g.fillRect(4, DEMO_H - 3, Math.max(1, Math.floor((DEMO_W - 8) * (0.25 + 0.75 * ramp))), 1);
  }
}
