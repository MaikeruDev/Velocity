/** Kleine DOM-Helfer der PS2-Front-Door (nur in mount/update benutzt, nie im Frame-Pfad). */
import { MEDAL_COLORS, MEDAL_NAMES } from '../../medals';
import type { MedalId } from '../types';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}

export function button(cls: string, onClick: (e: MouseEvent) => void, ...kids: (Node | string | null)[]): HTMLButtonElement {
  const b = el('button', cls, ...kids);
  b.type = 'button';
  // Synchron im Klick — play() fängt die Maus nur innerhalb der Geste.
  b.addEventListener('click', onClick);
  return b;
}

/** Tastenkappe ("ENTER", "ESC", Pfeile) — eigene Prompt-Optik, keine Konsolen-Symbole. */
export function keycap(label: string, wide = false): HTMLElement {
  return el('span', `ps2-key${wide ? ' ps2-key--wide' : ''}`, label);
}

/** Zeit "mm:ss.cc" wie ctx bestText (formatTime im Menü). */
export function fmtTime(s: number): string {
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const r = cs - m * 6000;
  const sec = Math.floor(r / 100);
  const c = r % 100;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Medaillen-Chip: farbiges Kästchen + Name (VELOCITY schimmert per CSS). */
export function medalChip(id: MedalId | null, size: 'full' | 'small' | 'dot' | boolean = 'full'): HTMLElement {
  const sz = size === true ? 'small' : size === false ? 'full' : size;
  const small = sz !== 'full';
  if (id === null) return el('span', `ps2-medal ps2-medal--none${small ? ' ps2-medal--small' : ''}`, small ? '—' : 'Keine');
  const text = sz === 'full' ? MEDAL_NAMES[id] : sz === 'small' ? MEDAL_NAMES[id].slice(0, 1) : null;
  const c = el('span', `ps2-medal ps2-medal--${id}${small ? ' ps2-medal--small' : ''}`, el('i', 'ps2-medal-dot'), text);
  c.style.setProperty('--medal', MEDAL_COLORS[id]);
  return c;
}

/** Entwickler-Name: nutzt die globalen Klassen des Dev-Abzeichens (menu.css, Plan 009). */
export function accountName(name: string, dev: boolean, cls: string): HTMLElement {
  if (!dev) return el('span', cls, name);
  const n = el('span', 'vel-name-dev-text', name);
  n.dataset.text = name;
  const badge = el('small', 'vel-dev-badge', 'DEV');
  badge.title = 'Entwickler von VELOCITY';
  return el('span', `${cls} vel-name-dev`, n, badge);
}

/**
 * Avatar: Discord (16 px, ganzzahlig vergrößert, pixelated) oder ein eigenes 8×8-Identicon aus dem Namen —
 * symmetrisch wie ein Speicherstand-Symbol, damit auch ohne Login ein "Gesicht" im Steckplatz steckt.
 */
export function avatar(url: string | null, name: string, px: number): HTMLElement {
  const wrap = el('span', 'ps2-avatar');
  wrap.style.width = `${px}px`;
  wrap.style.height = `${px}px`;
  const ident = (): HTMLCanvasElement => identicon(name, px);
  if (url) {
    try {
      const u = new URL(url);
      u.searchParams.set('size', '16');
      const img = el('img', 'ps2-avatar-img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.draggable = false;
      img.addEventListener('error', () => img.replaceWith(ident()), { once: true });
      img.src = u.toString();
      wrap.append(img);
      return wrap;
    } catch {
      // kaputte URL → Identicon
    }
  }
  wrap.append(ident());
  return wrap;
}

function identicon(name: string, px: number): HTMLCanvasElement {
  const c = el('canvas', 'ps2-avatar-img');
  c.width = 8;
  c.height = 8;
  c.style.width = `${px}px`;
  c.style.height = `${px}px`;
  const g = c.getContext('2d');
  if (!g) return c;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const pal = ['#33f0ff', '#ff3fd0', '#ffd84a', '#5dff9a', '#a63bff'];
  const fg = pal[(h >>> 3) % pal.length];
  const fg2 = pal[(h >>> 7) % pal.length];
  g.fillStyle = '#0b0820';
  g.fillRect(0, 0, 8, 8);
  for (let y = 1; y < 7; y++) {
    for (let x = 1; x < 4; x++) {
      const bit = (h >>> ((y * 3 + x) % 31)) & 1;
      if (!bit) continue;
      g.fillStyle = y > 4 ? fg2 : fg;
      g.fillRect(x, y, 1, 1);
      g.fillRect(7 - x, y, 1, 1);
    }
  }
  return c;
}
