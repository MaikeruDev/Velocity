import { keyShortLabel } from '../InputState';
import type { KeyBinds } from '../settingsTypes';
import type { InputDevice, PadBinds, PadButtonCode, PromptAction } from './types';

/**
 * Tasten-Hinweise als Text (Plan 011 §1.3, Grundlage für die Glyphen aus §1.6). Kurz (≤ 5 Zeichen),
 * damit sie in "[X] ZEIGEN" und die Showkeys passen. PlayStation: Bestätigen = Kreuz (westlich).
 */

const XBOX: { readonly [K in PadButtonCode]: string } = {
  PadA: 'A',
  PadB: 'B',
  PadX: 'X',
  PadY: 'Y',
  PadLB: 'LB',
  PadRB: 'RB',
  PadLT: 'LT',
  PadRT: 'RT',
  PadView: 'VIEW',
  PadMenu: 'MENU',
  PadL3: 'L3',
  PadR3: 'R3',
  PadUp: '↑',
  PadDown: '↓',
  PadLeft: '←',
  PadRight: '→',
  PadHome: 'HOME',
};

const PLAYSTATION: { readonly [K in PadButtonCode]: string } = {
  PadA: '×',
  PadB: '○',
  PadX: '□',
  PadY: '△',
  PadLB: 'L1',
  PadRB: 'R1',
  PadLT: 'L2',
  PadRT: 'R2',
  PadView: 'SHARE',
  PadMenu: 'OPT',
  PadL3: 'L3',
  PadR3: 'R3',
  PadUp: '↑',
  PadDown: '↓',
  PadLeft: '←',
  PadRight: '→',
  PadHome: 'PS',
};

/** Beschriftung eines Pad-Knopfs auf diesem Gerät ('keyboard' fällt auf Xbox zurück). */
export function padButtonLabel(code: PadButtonCode, device: InputDevice): string {
  return device === 'playstation' ? PLAYSTATION[code] : XBOX[code];
}

/** Erster Knopf der Liste oder '—', wenn die Aktion keine Belegung hat. */
function first(list: readonly string[], label: (c: string) => string): string {
  const c = list[0];
  return c !== undefined ? label(c) : '—';
}

function keyboardPrompt(a: PromptAction, binds: KeyBinds): string {
  switch (a) {
    case 'jump':
      // Ohne Taste bleibt das Mausrad (immer Sprung).
      return binds.jump[0] !== undefined ? keyShortLabel(binds.jump[0]) : 'RAD';
    case 'crouch':
      return first(binds.crouch, keyShortLabel);
    case 'sprint':
      return first(binds.sprint, keyShortLabel);
    case 'demo':
      return first(binds.demo, keyShortLabel);
    case 'respawn':
      return 'F';
    case 'restart':
      return 'R';
    case 'pause':
    case 'back':
      return 'ESC';
    case 'confirm':
      return 'ENTER';
    case 'tabPrev':
      return '←';
    case 'tabNext':
      return '→';
  }
}

function padPrompt(a: PromptAction, binds: PadBinds, device: InputDevice): string {
  const label = (c: PadButtonCode): string => padButtonLabel(c, device);
  switch (a) {
    case 'jump':
    case 'crouch':
    case 'sprint':
    case 'demo':
    case 'respawn':
    case 'restart':
    case 'pause': {
      const c = binds[a][0];
      return c !== undefined ? label(c) : '—';
    }
    // Menü-Knöpfe sind fest (Plan 011 §2.2.8).
    case 'confirm':
      return label('PadA');
    case 'back':
      return label('PadB');
    case 'tabPrev':
      return label('PadLB');
    case 'tabNext':
      return label('PadRB');
  }
}

export function promptLabelFor(a: PromptAction, device: InputDevice, keys: KeyBinds, pad: PadBinds): string {
  return device === 'keyboard' ? keyboardPrompt(a, keys) : padPrompt(a, pad, device);
}

/**
 * Pad-Typ aus `Gamepad.id`: Chrome "… (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)" bzw. XInput
 * "Xbox 360 Controller (XInput STANDARD GAMEPAD)", Firefox "054c-0ce6-…". 054c = Sony, 045e = Microsoft.
 */
export function padKindFromId(id: string): InputDevice {
  const m = /vendor:\s*([0-9a-f]{4})/i.exec(id) ?? /^([0-9a-f]{1,4})-[0-9a-f]{1,4}-/i.exec(id);
  const vendor = m ? m[1].toLowerCase().padStart(4, '0') : '';
  if (vendor === '054c' || /dualsense|dualshock|playstation/i.test(id)) return 'playstation';
  if (vendor === '045e' || /xbox|xinput/i.test(id)) return 'xbox';
  return 'generic';
}
