/**
 * Führt die Hook-Liste aus electron/modules.ts aus (Review C6): ein Modul, das wirft, hängt oder nie fertig wird,
 * hält weder das Fenster noch andere Module auf. setups laufen nebeneinander unter EINEM Zeitlimit (vorher je Modul
 * nacheinander, im schlimmsten Fall N × Limit), windowReady und dispose genau einmal, alles in try/catch.
 * Ohne Electron-Laufzeitimport — Vitest prüft es mit Fake-Modulen (tests/desktopPolicy.test.ts).
 */
import type { DesktopStartInfo } from './modules.js';

/** Form eines Moduls, generisch über Fenster und Kontext (DesktopModule erfüllt RunnableModule<BrowserWindow, …>). */
export interface RunnableModule<W, C> {
  readonly name: string;
  readonly syncChannels?: readonly string[];
  beforeReady?(info: DesktopStartInfo): void;
  setup(ctx: C): void | Promise<void>;
  windowReady?(win: W): void;
  dispose?(): void;
}

/** err gesetzt = Fehler (console.error), sonst Warnung. */
export type ModuleLog = (msg: string, err?: unknown) => void;

export interface ModuleSetupReport {
  /** setup warf oder lehnte ab. */
  readonly failed: readonly string[];
  /** setup lief nach dem Zeitlimit noch (läuft im Hintergrund weiter). */
  readonly late: readonly string[];
}

export class ModuleRunner<W, C> {
  private windowReadyDone = false;
  private disposed = false;

  constructor(
    private readonly modules: readonly RunnableModule<W, C>[],
    private readonly log: ModuleLog,
  ) {}

  /** Kanäle, die der Preload synchron fragt (main.ts antwortet dort notfalls selbst). */
  get syncChannels(): readonly string[] {
    return this.modules.flatMap((m) => m.syncChannels ?? []);
  }

  beforeReady(info: DesktopStartInfo): void {
    for (const m of this.modules) {
      try {
        m.beforeReady?.(info);
      } catch (err) {
        this.log(`[velocity] Modul ${m.name} (vor dem Start) fehlgeschlagen`, err);
      }
    }
  }

  /**
   * Alle setups nebeneinander, höchstens `timeoutMs` gemeinsam. Ein synchron hängendes setup hält trotzdem alles an —
   * deshalb gehört Langsames (Steam-init) in windowReady.
   */
  async setup(ctx: C, timeoutMs: number): Promise<ModuleSetupReport> {
    const failed: string[] = [];
    const running = new Set<string>();
    const runs = this.modules.map((m) => {
      running.add(m.name);
      return Promise.resolve()
        .then(() => m.setup(ctx))
        .then(
          () => {
            running.delete(m.name);
          },
          (err: unknown) => {
            running.delete(m.name);
            failed.push(m.name);
            this.log(`[velocity] Modul ${m.name} nicht geladen`, err);
          },
        );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(runs), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    const late = [...running];
    for (const n of late) this.log(`[velocity] Modul ${n}: setup braucht länger als ${timeoutMs} ms — Fenster startet ohne es`);
    return { failed: [...failed], late };
  }

  /** Erstes Bild (oder Rückfall nach Zeitlimit): genau einmal. */
  windowReady(win: W): void {
    if (this.windowReadyDone) return;
    this.windowReadyDone = true;
    for (const m of this.modules) {
      try {
        m.windowReady?.(win);
      } catch (err) {
        this.log(`[velocity] Modul ${m.name}: windowReady fehlgeschlagen`, err);
      }
    }
  }

  /** Beim Beenden (will-quit, Fehler-Ende, Zweitinstanz ohne setup): genau einmal, nie werfend. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.modules) {
      try {
        m.dispose?.();
      } catch (err) {
        this.log(`[velocity] Modul ${m.name}: dispose fehlgeschlagen`, err);
      }
    }
  }
}
