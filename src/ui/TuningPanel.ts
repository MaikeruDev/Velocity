import GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { MOVEMENT_PRESETS, withMovement } from '../player/MovementConfig';
import type { MovementConfig, MovementPresetId, NumericMovementKey } from '../player/MovementConfig';
import type { SettingsStore } from '../engine/Settings';
import { PIXEL_HEIGHTS, movementConfigFor } from '../engine/Settings';
import type { GameSettings } from '../engine/settingsTypes';
import type { RenderSettings } from '../render/types';

/**
 * F1-Tuning-Panel (lil-gui): alle numerischen MovementConfig-Werte live,
 * Auto-Hop, Presets, "Als TS kopieren" und die Render-Einstellungen.
 * Auch im Build verfügbar — Tuning ist Teil des Spiels, nicht nur Dev-Werkzeug.
 *
 * Die Engine hört per onChange() zu und setzt die neue Config im Movement
 * (bei geänderter tickRate zusätzlich FixedLoop.setTickRate).
 */

interface RangeSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly label: string;
}

/** Vollständig: fehlt ein Key, meckert der Compiler — neue Movement-Werte landen automatisch hier. */
const RANGES: Record<NumericMovementKey, RangeSpec> = {
  tickRate: { min: 32, max: 256, step: 1, label: 'Tickrate (Hz)' },
  gravity: { min: 200, max: 1600, step: 10, label: 'Gravitation (sv_gravity)' },
  jumpImpulse: { min: 150, max: 500, step: 0.5, label: 'Sprung-Impuls (u/s)' },
  runSpeed: { min: 100, max: 450, step: 1, label: 'Laufen (u/s)' },
  sprintSpeed: { min: 100, max: 600, step: 1, label: 'Sprint (u/s)' },
  duckSpeedScale: { min: 0.1, max: 1, step: 0.01, label: 'Duck-Faktor' },
  accelerate: { min: 1, max: 20, step: 0.1, label: 'Boden-Accel (sv_accelerate)' },
  airAccelerate: { min: 1, max: 200, step: 1, label: 'Luft-Accel (sv_airaccelerate)' },
  airSpeedCap: { min: 5, max: 120, step: 1, label: 'Air-Cap (u/s)' },
  airSpeedCapLow: { min: 0, max: 60, step: 1, label: 'Air-Cap langsam (0 = aus)' },
  airSpeedCapFadeFrom: { min: 0, max: 1500, step: 10, label: 'Air-Cap Blende ab (u/s)' },
  airSpeedCapFadeTo: { min: 0, max: 2000, step: 10, label: 'Air-Cap Blende bis (u/s)' },
  friction: { min: 0, max: 12, step: 0.1, label: 'Reibung (sv_friction)' },
  stopSpeed: { min: 0, max: 250, step: 1, label: 'Stop-Speed (sv_stopspeed)' },
  maxVelocity: { min: 500, max: 10000, step: 50, label: 'Max-Velocity (pro Achse)' },
  stepSize: { min: 0, max: 36, step: 1, label: 'Stufenhöhe (u)' },
  nonJumpVelocity: { min: 50, max: 400, step: 1, label: 'Non-Jump-Velocity' },
  coyoteTime: { min: 0, max: 0.3, step: 0.005, label: 'Coyote-Time (s)' },
  jumpBufferTime: { min: 0, max: 0.3, step: 0.005, label: 'Sprungpuffer (s)' },
  autoHopSpeedShare: { min: 0, max: 1, step: 0.01, label: 'Smart-Hop Tempo-Anteil (0 = sofort)' },
  autoHopGroundTime: { min: 0, max: 1, step: 0.01, label: 'Smart-Hop Bodenzeit (s)' },
  autoHopLandShare: { min: 0, max: 1, step: 0.01, label: 'Smart-Hop Anteil nach Luft' },
  autoHopLandAirTime: { min: 0, max: 1, step: 0.01, label: 'Smart-Hop Mindest-Luftzeit (s)' },
  duckTime: { min: 0, max: 0.5, step: 0.01, label: 'Duck-Dauer (s)' },
};

/** Gruppen fürs Panel — Reihenfolge nach Wichtigkeit fürs Gefühl. */
const GROUPS: readonly { readonly title: string; readonly keys: readonly NumericMovementKey[] }[] = [
  { title: 'Luft (Strafe)', keys: ['airAccelerate', 'airSpeedCap', 'airSpeedCapLow', 'airSpeedCapFadeFrom', 'airSpeedCapFadeTo', 'gravity', 'jumpImpulse'] },
  { title: 'Boden', keys: ['runSpeed', 'sprintSpeed', 'accelerate', 'friction', 'stopSpeed', 'duckSpeedScale'] },
  { title: 'Verzeihen', keys: ['coyoteTime', 'jumpBufferTime', 'autoHopSpeedShare', 'autoHopGroundTime', 'autoHopLandShare', 'autoHopLandAirTime'] },
  { title: 'System', keys: ['tickRate', 'maxVelocity', 'stepSize', 'nonJumpVelocity', 'duckTime'] },
];

const NUMERIC_KEYS = Object.keys(RANGES).filter(isNumericKey);

function isNumericKey(k: string): k is NumericMovementKey {
  return Object.prototype.hasOwnProperty.call(RANGES, k);
}

function isPresetId(v: string): v is MovementPresetId {
  return Object.prototype.hasOwnProperty.call(MOVEMENT_PRESETS, v);
}

type MovementParams = Record<NumericMovementKey, number> & { autoHop: boolean; strafeAssist: boolean };

type RenderParams = { -readonly [K in keyof RenderSettings]: RenderSettings[K] };

type ChangeListener = (c: MovementConfig) => void;

export class TuningPanel {
  private readonly gui: GUI;
  private readonly settings: SettingsStore;
  private readonly listeners = new Set<ChangeListener>();
  private readonly params: MovementParams;
  private readonly renderParams: RenderParams;
  private readonly meta = { preset: 'velocity', status: '' };
  private readonly movementControllers: Controller[] = [];
  private readonly renderControllers: Controller[] = [];
  private readonly statusController: Controller;
  private base: MovementConfig;
  private config: MovementConfig;
  private readonly unsubscribe: () => void;
  private syncingRender = false;

  /**
   * @param container optional. Ohne Container platziert lil-gui das Panel selbst fix oben rechts
   *   (`lil-auto-place`) — mit `document.body` als Container fehlt diese Klasse und das Panel
   *   rutscht statisch unter absolut positionierte Canvases.
   */
  constructor(settings: SettingsStore, initial: MovementConfig, container?: HTMLElement) {
    this.settings = settings;
    const presetId = settings.get().movementPreset;
    this.meta.preset = presetId;
    this.base = MOVEMENT_PRESETS[presetId];
    this.config = initial;
    this.params = toParams(initial);
    this.renderParams = { ...settings.get().render };

    this.gui = container
      ? new GUI({ container, title: 'VELOCITY Tuning  [F1]', width: 340 })
      : new GUI({ title: 'VELOCITY Tuning  [F1]', width: 340 });
    this.gui.domElement.classList.add('vel-tuning');
    injectTheme();

    // --- Movement
    for (const group of GROUPS) {
      const f = this.gui.addFolder(group.title);
      for (const key of group.keys) {
        const r = RANGES[key];
        const c = f.add(this.params, key, r.min, r.max, r.step).name(r.label).onChange(() => this.commit());
        this.movementControllers.push(c);
      }
    }
    const hop = this.gui.add(this.params, 'autoHop').name('Auto-Hop').onChange(() => this.commit());
    this.movementControllers.push(hop);
    const assist = this.gui.add(this.params, 'strafeAssist').name('Strafe-Assist').onChange(() => this.commit());
    this.movementControllers.push(assist);

    // --- Presets & Export
    const tools = this.gui.addFolder('Preset & Export');
    tools
      .add(this.meta, 'preset', Object.keys(MOVEMENT_PRESETS))
      .name('Preset')
      .onChange(() => this.loadPreset(this.meta.preset));
    tools.add({ copy: () => void this.copyAsTs() }, 'copy').name('Als TS kopieren');
    tools.add({ reset: () => this.loadPreset(this.meta.preset) }, 'reset').name('Zurücksetzen');
    this.statusController = tools.add(this.meta, 'status').name('Status').disable();

    // --- Render
    const rf = this.gui.addFolder('Render (live)');
    this.renderControllers.push(
      rf.add(this.renderParams, 'pixelHeight', [...PIXEL_HEIGHTS]).name('Pixelhöhe'),
      rf.add(this.renderParams, 'dither').name('Dithering'),
      rf.add(this.renderParams, 'colorBits', 2, 8, 1).name('Bits/Kanal'),
      rf.add(this.renderParams, 'affine', 0, 1, 0.01).name('Affine'),
      rf.add(this.renderParams, 'vertexSnap', 0, 1, 0.01).name('Vertex-Snap'),
      rf.add(this.renderParams, 'chromatic', 0, 1, 0.01).name('Chrom. Aberration'),
      rf.add(this.renderParams, 'scanlines', 0, 1, 0.01).name('Scanlines'),
    );
    for (const c of this.renderControllers) c.onChange(() => this.commitRender());
    rf.close();

    this.unsubscribe = settings.subscribe((s, prev) => this.onSettings(s, prev));
    this.gui.hide();
  }

  get visible(): boolean {
    return !this.gui._hidden;
  }

  /** Aktuelle Movement-Config (inkl. Panel-Änderungen). */
  getConfig(): MovementConfig {
    return this.config;
  }

  show(): void {
    this.gui.show();
  }

  hide(): void {
    this.gui.hide();
  }

  toggle(): void {
    this.gui.show(!this.visible);
  }

  /** Config von außen setzen (z. B. Preset-Wechsel im Menü). Löst KEIN onChange aus. */
  setConfig(c: MovementConfig): void {
    this.config = c;
    Object.assign(this.params, toParams(c));
    for (const ctrl of this.movementControllers) ctrl.updateDisplay();
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.gui.destroy();
  }

  // ------------------------------------------------------------------ intern

  private commit(): void {
    const patch: Partial<Record<NumericMovementKey, number>> = {};
    for (const k of NUMERIC_KEYS) {
      const v = this.params[k];
      if (Number.isFinite(v)) patch[k] = v;
    }
    this.config = withMovement(this.config, { ...patch, autoHop: this.params.autoHop, strafeAssist: this.params.strafeAssist });
    // Auto-Hop und Strafe-Assist sind auch Spieler-Einstellungen — beide Wege synchron halten.
    const cur = this.settings.get();
    if (cur.autoHop !== this.params.autoHop || cur.strafeAssist !== this.params.strafeAssist) {
      this.settings.update({ autoHop: this.params.autoHop, strafeAssist: this.params.strafeAssist });
    }
    this.emit();
  }

  private loadPreset(id: string): void {
    if (!isPresetId(id)) return;
    this.base = MOVEMENT_PRESETS[id];
    // Auto-Hop folgt der Spieler-Einstellung, nicht dem Preset.
    const next = movementConfigFor({ ...this.settings.get(), movementPreset: id });
    this.setConfig(next);
    if (this.settings.get().movementPreset !== id) this.settings.update({ movementPreset: id });
    this.setStatus(`Preset ${id} geladen`);
    this.emit();
  }

  private commitRender(): void {
    if (this.syncingRender) return;
    this.settings.update({ render: { ...this.renderParams } });
  }

  private onSettings(s: GameSettings, prev: GameSettings): void {
    // Render-Werte aus dem Menü ins Panel spiegeln.
    this.syncingRender = true;
    Object.assign(this.renderParams, s.render);
    for (const c of this.renderControllers) c.updateDisplay();
    this.syncingRender = false;

    if (s.movementPreset !== prev.movementPreset && s.movementPreset !== this.meta.preset) {
      this.meta.preset = s.movementPreset;
      this.loadPreset(s.movementPreset);
      this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    } else if (s.autoHop !== this.params.autoHop || s.strafeAssist !== this.params.strafeAssist) {
      this.params.autoHop = s.autoHop;
      this.params.strafeAssist = s.strafeAssist;
      this.config = withMovement(this.config, { autoHop: s.autoHop, strafeAssist: s.strafeAssist });
      for (const c of this.movementControllers) c.updateDisplay();
      this.emit();
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.config);
  }

  private setStatus(text: string): void {
    this.meta.status = text;
    this.statusController.updateDisplay();
  }

  /** Nur die Abweichungen vom Preset als withMovement-Aufruf — direkt in MovementConfig.ts einfügbar. */
  toTs(): string {
    const presetName = this.meta.preset === 'cs2' ? 'CS2_CLASSIC' : 'VELOCITY_DEFAULT';
    const lines: string[] = [];
    for (const k of NUMERIC_KEYS) {
      const v = this.config[k];
      if (v !== this.base[k]) lines.push(`  ${k}: ${formatNumber(v)},`);
    }
    if (this.config.autoHop !== this.base.autoHop) lines.push(`  autoHop: ${this.config.autoHop},`);
    if (this.config.strafeAssist !== this.base.strafeAssist) lines.push(`  strafeAssist: ${this.config.strafeAssist},`);
    if (lines.length === 0) return `withMovement(${presetName}, {})`;
    return `withMovement(${presetName}, {\n${lines.join('\n')}\n})`;
  }

  private async copyAsTs(): Promise<void> {
    const code = this.toTs();
    try {
      await navigator.clipboard.writeText(code);
      this.setStatus('In Zwischenablage kopiert');
    } catch {
      // Clipboard verweigert (kein Fokus/keine Berechtigung) — Konsole ist der ehrliche Fallback.
      console.info(`[Tuning]\n${code}`);
      this.setStatus('Clipboard gesperrt → Konsole');
    }
  }
}

function toParams(c: MovementConfig): MovementParams {
  return {
    tickRate: c.tickRate,
    gravity: c.gravity,
    jumpImpulse: c.jumpImpulse,
    runSpeed: c.runSpeed,
    sprintSpeed: c.sprintSpeed,
    duckSpeedScale: c.duckSpeedScale,
    accelerate: c.accelerate,
    airAccelerate: c.airAccelerate,
    airSpeedCap: c.airSpeedCap,
    airSpeedCapLow: c.airSpeedCapLow,
    airSpeedCapFadeFrom: c.airSpeedCapFadeFrom,
    airSpeedCapFadeTo: c.airSpeedCapFadeTo,
    friction: c.friction,
    stopSpeed: c.stopSpeed,
    maxVelocity: c.maxVelocity,
    stepSize: c.stepSize,
    nonJumpVelocity: c.nonJumpVelocity,
    coyoteTime: c.coyoteTime,
    jumpBufferTime: c.jumpBufferTime,
    autoHopSpeedShare: c.autoHopSpeedShare,
    autoHopGroundTime: c.autoHopGroundTime,
    autoHopLandShare: c.autoHopLandShare,
    autoHopLandAirTime: c.autoHopLandAirTime,
    duckTime: c.duckTime,
    autoHop: c.autoHop,
    strafeAssist: c.strafeAssist,
  };
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
}

let themeInjected = false;

/** lil-gui an den Neon-Look anpassen (über seine CSS-Variablen, ohne Blur/Rundungen). */
function injectTheme(): void {
  if (themeInjected || typeof document === 'undefined') return;
  themeInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.lil-gui.vel-tuning {
  --background-color: rgba(10, 6, 26, 0.94);
  --widget-color: #25184a;
  --hover-color: #33265e;
  --focus-color: #3d2d70;
  --number-color: #33f0ff;
  --string-color: #5dff9a;
  --text-color: #f1edff;
  --title-background-color: #1a0f3a;
  --title-text-color: #33f0ff;
  --font-family: ui-monospace, Consolas, 'Cascadia Mono', monospace;
  --font-size: 12px;
  --widget-border-radius: 0;
  z-index: 40;
  border-left: 3px solid #33f0ff;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.6);
}
.lil-gui.vel-tuning .lil-title { letter-spacing: 1px; }
.lil-gui.vel-tuning .lil-controller.lil-number .lil-fill { background: #ff3fd0; }
`;
  document.head.appendChild(style);
}
