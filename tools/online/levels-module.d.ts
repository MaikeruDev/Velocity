/** Virtuelles Modul des Function-Bundles (tools/online/build-function.mjs): Level-ID → Level-Datei. */
declare module 'velocity:levels' {
  import type { LevelFile } from '../../src/world/level/LevelFormat';
  const levels: Readonly<Record<string, LevelFile>>;
  export default levels;
}
