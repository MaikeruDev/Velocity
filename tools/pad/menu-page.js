// Seitenseitige Helfer für tools/pad/menu-check.ts (als Text injiziert — tsx/esbuild würde in Pfeilfunktionen
// __name(...) einbauen, das im Browser fehlt, fallen.md #238).
//
// Fake-Gamepad: navigator.getGamepads wird ersetzt; Zustand über window.__padTest steuerbar (Standard-Mapping).
(() => {
  const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home'];
  const pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    buttons: NAMES.map(() => ({ pressed: false, touched: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
  window.__fakePad = pad;
  Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  const frames = (n) =>
    new Promise((res) => {
      let k = 0;
      const step = () => (++k >= n ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  const set = (name, on) => {
    const i = NAMES.indexOf(name);
    if (i < 0) throw new Error('Knopf unbekannt: ' + name);
    pad.buttons[i].pressed = on;
    pad.buttons[i].value = on ? 1 : 0;
    pad.timestamp = performance.now();
  };
  window.__padTest = {
    connect() {
      window.dispatchEvent(new Event('gamepadconnected'));
    },
    kind(id) {
      pad.id = id;
    },
    async press(name, holdFrames) {
      set(name, true);
      await frames(holdFrames || 3);
      set(name, false);
      await frames(3);
    },
    async stick(x, y, holdFrames) {
      pad.axes[0] = x;
      pad.axes[1] = y;
      await frames(holdFrames || 3);
      pad.axes[0] = 0;
      pad.axes[1] = 0;
      await frames(3);
    },
    frames,
  };
})();
