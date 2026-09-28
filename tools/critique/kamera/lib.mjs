/**
 * Kamera-Kritik: Recorder per Monkeypatch auf CameraRig.prototype (kein Projektcode geändert).
 * Pro gerendertem Frame: View-Eingang, Rig-Zustand (Bob, Dip, Kick, Trauma, FOV-Kick, Roll,
 * Stufen-Versatz) und die fertige Kamera. Events (land/jump/respawn) mit Zeitstempel.
 */

export const FIELDS = [
  't', 'dt', 'ex', 'ey', 'ez', 'eyeH', 'speed', 'vy', 'onGround', 'ducked', 'stride', 'surfing', 'sprinting', 'strafe',
  'yaw', 'pitch', 'bobW', 'dipX', 'kickX', 'trauma', 'fovKick', 'roll', 'stepOff',
  'cx', 'cy', 'cz', 'rx', 'ry', 'rz', 'vfov', 'sHb', 'sSh', 'sFk', 'sFov', 'aspect', 'fxKick', 'fxPop', 'fxSurge', 'fxFov', 'fxRoll', 'fxDip', 'fxShake', 'fxRumble',
];

export async function installRecorder(page) {
  await page.evaluate(async () => {
    const m = await import('/src/player/CameraRig.ts');
    const P = m.CameraRig.prototype;
    if (P.__critPatched) return;
    P.__critPatched = true;
    const origU = P.update;
    const origE = P.onEvent;
    window.__camrec = { on: false, frames: [], events: [] };
    P.update = function (frameDt, view, yaw, pitch) {
      origU.call(this, frameDt, view, yaw, pitch);
      window.__rig = this;
      const R = window.__camrec;
      if (!R.on) return;
      const c = this.camera;
      const s = this.settings;
      R.frames.push([
        performance.now(), frameDt, view.eyePos.x, view.eyePos.y, view.eyePos.z, view.eyeHeight, view.speed, view.vel.y,
        view.onGround ? 1 : 0, view.ducked ? 1 : 0, view.stridePhase, view.surfing ? 1 : 0, view.sprinting ? 1 : 0, view.strafeInput,
        yaw, pitch, this.bobWeight, this.dip.x, this.kick.x, this.trauma, this.fovKickCur, this.roll, this.stepOffset,
        c.position.x, c.position.y, c.position.z, c.rotation.x, c.rotation.y, c.rotation.z, c.fov, s.headBob, s.screenShake, s.fovKick, s.fov, this.aspect, this.fxState.speedKick, this.fxState.pop, this.fxState.surge, this.fxState.fovOffset, this.fxState.roll, this.fxState.dip, this.fxState.shake, this.fxState.rumble,
      ]);
    };
    P.onEvent = function (e) {
      origE.call(this, e);
      const R = window.__camrec;
      if (!R.on) return;
      if (e.type === 'land' || e.type === 'jump' || e.type === 'respawn' || e.type === 'checkpoint' || e.type === 'finish') {
        R.events.push({ t: performance.now(), type: e.type, impact: e.impact ?? null, speed: e.speed ?? null, reason: e.reason ?? null, chain: e.chain ?? null, airTime: e.airTime ?? null, perfect: e.perfect ?? null, sync: e.sync ?? null, jumpQueued: e.jumpQueued ?? null });
      }
    };
  });
}

export async function recStart(page) {
  await page.evaluate(() => {
    const R = window.__camrec;
    R.frames.length = 0;
    R.events.length = 0;
    R.on = true;
  });
}

export async function recStop(page) {
  return page.evaluate(() => {
    const R = window.__camrec;
    R.on = false;
    const out = { frames: R.frames.slice(), events: R.events.slice() };
    R.frames.length = 0;
    R.events.length = 0;
    return out;
  });
}

export async function openGame(page, url, level) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await installRecorder(page);
  const ok = await page.evaluate((lv) => window.__vel.start(lv, { lockless: true }), level);
  if (!ok) throw new Error(`start ${level} fehlgeschlagen`);
  await page.waitForTimeout(300);
}
