// Logo als Vite-Asset-URL: eigene Datei im Build, geladen erst, wenn ein Stil sie als <img src> nutzt.
import logoUrl from '../../../media/velocity_font.png?url';
import type { FrontDoorAssets } from './types';

export const FRONT_DOOR_ASSETS: FrontDoorAssets = { logoUrl };
