/**
 * Grafik-Ebene des Werbespots (läuft im Browser, von tools/trailer/edit.mjs per Playwright geladen).
 * Zeichnet pro Videoframe eine transparente Ebene: Supers, Logo-Slam, Flashes, Endkarte, Auf-/Abblende.
 * Pixel-Typo entsteht auf einem Low-Res-Raster (1 Pixel = PX Bildpixel) und wird Nearest hochskaliert —
 * so passt sie zum 4×-Raster des Spielbilds statt weich gerendert zu wirken.
 *
 *   window.ov.setup({ W, H, fps, fpb, layout, timeline, logo })  → Promise
 *   window.ov.frame(f) → PNG-DataURL oder null (Frame leer)
 */
(() => {
  const C = {
    cyan: '#33f0ff',
    magenta: '#ff3fd0',
    gold: '#ffd84a',
    text: '#f1edff',
    dim: '#9b93c4',
    ink: '#07040f',
    navy: '#0c071e',
  };
  const PX = 4;

  let cfg;
  let main;
  let ctx;
  let logo;
  const cache = new Map();

  /** Deterministisches Rauschen je Frame/Index, damit Glitches reproduzierbar sind. */
  function rnd(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /** Alpha hart schneiden: Canvas-Text ist antialiased, die Spiel-Typo nicht. */
  function hardAlpha(c) {
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height);
    const a = d.data;
    for (let i = 3; i < a.length; i += 4) a[i] = a[i] >= 110 ? 255 : 0;
    g.putImageData(d, 0, 0);
  }

  function tint(mask, color, dx = 0, dy = 0, pad = 0) {
    const c = canvas(mask.width + pad * 2, mask.height + pad * 2);
    const g = c.getContext('2d');
    g.drawImage(mask, pad + dx, pad + dy);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /** Maske um r Pixel dilatieren (harte Pixel-Kontur). */
  function dilate(mask, r) {
    const c = canvas(mask.width, mask.height);
    const g = c.getContext('2d');
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) g.drawImage(mask, x, y);
    return c;
  }

  /**
   * Eine Zeile Silkscreen in NATIVER Größe (8 px: 1 Font-Pixel = 1 Canvas-Pixel, em/8-Raster), hart
   * geschwellt und dann ×m Nearest auf das Low-Res-Raster gebracht. Nur so bleiben die Glyphen sauber —
   * große Font-Größen mit Schwellwert ergeben ungleichmäßige Striche (fallen: Trailer-Typo).
   * Zeilen-Bitmap: 8 Zeilen (Oberlänge 2 … Unterlänge 9), Breite = Advance.
   */
  function glyphLine(t, m) {
    // In 10facher Größe rendern und je Font-Pixel die Zellmitte abtasten: unabhängig von Hinting und
    // Kantenglättung bei 8 px (dort fallen dünne Pixel unter jeden Schwellwert).
    const S = 10;
    const g0 = canvas(8, 8).getContext('2d');
    g0.font = `400 ${8 * S}px Silkscreen`;
    const cols = Math.ceil(g0.measureText(t).width / S) + 1;
    const big = canvas(cols * S, 12 * S);
    const g = big.getContext('2d', { willReadFrequently: true });
    g.font = `400 ${8 * S}px Silkscreen`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#fff';
    g.fillText(t, 0, 8 * S);
    const d = g.getImageData(0, 0, big.width, big.height).data;
    const raw = canvas(cols, 8);
    const rg = raw.getContext('2d');
    const id = rg.createImageData(cols, 8);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < cols; x++) {
        const sx = x * S + (S >> 1);
        const sy = (y + 2) * S + (S >> 1);
        const a = d[(sy * big.width + sx) * 4 + 3];
        const o = (y * cols + x) * 4;
        id.data[o] = id.data[o + 1] = id.data[o + 2] = 255;
        id.data[o + 3] = a >= 128 ? 255 : 0;
      }
    rg.putImageData(id, 0, 0);
    const out = canvas(cols * m, 8 * m);
    const og = out.getContext('2d');
    og.imageSmoothingEnabled = false;
    og.drawImage(raw, 0, 0, cols * m, 8 * m);
    return out;
  }

  /**
   * Pixel-Text als Low-Res-Bitmap: Füllung, 1 Raster-Pixel Tinte als Kontur, harter Neon-Schatten.
   * lines: [{ t, m, color }] untereinander (m = Font-Pixel in Raster-Pixeln), links/mittig.
   */
  function pxText(key, lines, align = 'left', shadow = C.magenta) {
    if (cache.has(key)) return cache.get(key);
    const pad = 3;
    const rows = [];
    let w = 0;
    let h = 0;
    for (const l of lines) {
      const c = glyphLine(l.t, l.m);
      rows.push({ c, color: l.color, y: h });
      w = Math.max(w, c.width);
      h += c.height + (l.gap ?? l.m);
    }
    h -= lines[lines.length - 1].gap ?? lines[lines.length - 1].m;
    const W = w + pad * 2;
    const H = h + pad * 2;
    const fill = canvas(W, H);
    const fg = fill.getContext('2d');
    for (const r of rows) {
      const x = align === 'center' ? Math.round((W - r.c.width) / 2) : pad;
      fg.drawImage(tint(r.c, r.color), x, pad + r.y);
    }
    const out = canvas(W + 2, H + 2);
    const og = out.getContext('2d');
    og.drawImage(tint(dilate(fill, 1), shadow), 2, 2);
    og.drawImage(tint(dilate(fill, 1), C.ink), 0, 0);
    og.drawImage(fill, 0, 0);
    const res = { c: out, cyan: tint(out, C.cyan), mag: tint(out, C.magenta), w: out.width, h: out.height };
    cache.set(key, res);
    return res;
  }

  /**
   * Low-Res-Bitmap ganzzahlig skaliert zeichnen, optional mit Glitch: horizontale Streifen versetzt,
   * RGB-Split (Cyan/Magenta-Kopien) und Flackern. x/y = linke obere Ecke in Bildpixeln.
   */
  function blit(t, x, y, s, f, glitch, alpha = 1) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = alpha;
    if (glitch > 0) {
      const split = Math.round(glitch * 3) * s;
      ctx.globalAlpha = alpha * 0.75;
      ctx.drawImage(t.mag, x - split, y, t.w * s, t.h * s);
      ctx.drawImage(t.cyan, x + split, y, t.w * s, t.h * s);
      ctx.globalAlpha = alpha;
      const band = 3;
      for (let sy = 0; sy < t.h; sy += band) {
        const r = rnd(f, sy);
        const dx = r < 0.45 * glitch ? Math.round((rnd(sy, f) - 0.5) * 16 * glitch) * s : 0;
        const bh = Math.min(band, t.h - sy);
        ctx.drawImage(t.c, 0, sy, t.w, bh, x + dx, y + sy * s, t.w * s, bh * s);
      }
    } else {
      ctx.drawImage(t.c, x, y, t.w * s, t.h * s);
    }
    ctx.restore();
  }

  /** Scanlines über einem Bereich (jede zweite Raster-Zeile abdunkeln) — PS2-Röhrenflair. */
  function scanlines(x, y, w, h, a) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    for (let yy = Math.floor(y / PX) * PX; yy < y + h; yy += PX * 2) ctx.fillRect(x, yy, w, PX);
    ctx.restore();
  }

  function fill(color, a) {
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, cfg.W, cfg.H);
    ctx.restore();
  }

  /** Lesbarkeit der Supers: weicher Tinte-Verlauf von unten links, liegt über dem Spielbild. */
  function shade(region, a) {
    ctx.save();
    const { W, H } = cfg;
    let g;
    if (region === 'll') {
      g = ctx.createRadialGradient(W * 0.12, H * 0.92, 0, W * 0.12, H * 0.92, W * 0.55);
    } else {
      g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.5);
    }
    g.addColorStop(0, `rgba(7,4,15,${a})`);
    g.addColorStop(1, 'rgba(7,4,15,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------- Elemente ----------

  /** Ein-/Ausblend-Glitch eines Elements (Frames seit Start k, Frames bis Ende r). */
  function glitchAmt(k, r) {
    if (k < 0 || r < 0) return -1;
    if (k === 0) return 1;
    if (k === 1) return 0.7;
    if (k === 2) return 0.35;
    if (r <= 1) return 0.6;
    return 0;
  }

  function drawSuper(el, f) {
    const f0 = Math.round(el.b0 * cfg.fpb);
    const f1 = Math.round(el.b1 * cfg.fpb);
    if (f < f0 || f >= f1) return false;
    const k = f - f0;
    const r = f1 - 1 - f;
    const L = cfg.layout;
    const t = pxText(el.key, el.lines, el.pos === 'center' ? 'center' : 'left', el.shadow ?? C.magenta);
    // Punch-in: erster Frame eine Stufe größer (ganzzahlig, Raster bleibt hart).
    const s = (el.scale ?? PX) + (k === 0 ? 1 : 0);
    const g = el.noGlitch ? 0 : glitchAmt(k, r);
    let x;
    let y;
    if (el.pos === 'center') {
      x = Math.round((cfg.W - t.w * s) / 2);
      y = Math.round((el.cy ?? cfg.H / 2) - (t.h * s) / 2);
    } else {
      x = L.llx;
      y = (el.pos === 'abs' ? el.absLly : L.lly) - t.h * s;
    }
    x = Math.round(x / PX) * PX;
    y = Math.round(y / PX) * PX;
    // Flackern in den ersten Frames: Scanline-Einblendung statt weichem Fade.
    const flick = k === 3 ? 0.55 : k === 5 ? 0.8 : 1;
    blit(t, x, y, s, f, g, flick * (r === 0 ? 0.5 : 1));
    if (k < 6) scanlines(x - 32, y, t.w * s + 64, t.h * s, k < 3 ? 0.6 : 0.3);
    return true;
  }

  function logoAt(cx, cy, w, opts = {}) {
    const h = (w * logo.height) / logo.width;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (opts.split) {
      ctx.globalAlpha = 0.7 * (opts.alpha ?? 1);
      ctx.drawImage(logo.mag, x - opts.split, y, w, h);
      ctx.drawImage(logo.cyan, x + opts.split, y, w, h);
    }
    ctx.globalAlpha = opts.alpha ?? 1;
    if (opts.slices) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const sy = (logo.height / n) * i;
        const dx = rnd(opts.seed, i) < 0.4 ? (rnd(i, opts.seed) - 0.5) * opts.slices : 0;
        ctx.drawImage(logo.img, 0, sy, logo.width, logo.height / n, x + dx, y + (h / n) * i, w, h / n + 0.5);
      }
    } else {
      ctx.drawImage(logo.img, x, y, w, h);
    }
    ctx.restore();
  }

  /** Logo-Slam auf dem Drop: Abdunkeln, Logo fällt von groß auf Maß, Wackler + RGB-Split. */
  function drawSlam(el, f) {
    const f0 = Math.round(el.b0 * cfg.fpb);
    const f1 = Math.round(el.b1 * cfg.fpb);
    if (f < f0 || f >= f1) return false;
    const k = f - f0;
    const r = f1 - 1 - f;
    fill(C.ink, k < 2 ? 0.25 : 0.5);
    const L = cfg.layout;
    const scales = [1.55, 1.22, 1.06, 0.97, 1.01, 1.0];
    let sc = k < scales.length ? scales[k] : 1;
    // Kleiner Nachschlag auf dem zweiten Beat des Slams.
    const fb = Math.round((el.b0 + 1) * cfg.fpb);
    if (f >= fb && f < fb + 6) sc *= 1 + 0.035 * (1 - (f - fb) / 6);
    const shake = k < 12 ? (1 - k / 12) * 22 : 0;
    const sx = (rnd(f, 1) - 0.5) * 2 * shake;
    const sy = (rnd(f, 2) - 0.5) * 2 * shake;
    const split = k < 6 ? [26, 18, 12, 8, 5, 3][k] : r < 2 ? 14 : 0;
    logoAt(L.logoCx + sx, L.logoCy + sy, L.logoW * sc, {
      split,
      slices: k < 3 || r < 2 ? 60 : 0,
      seed: f,
    });
    return true;
  }

  /** Impact-Flash: Weiß → Magenta → Cyan, 6 Frames. */
  function drawFlash(el, f) {
    const f0 = Math.round(el.b * cfg.fpb) + (el.off ?? 0);
    const k = f - f0;
    if (k < 0 || k > 6) return false;
    const big = el.size === 'big';
    const seq = big
      ? [
          ['#ffffff', 0.95],
          ['#ffffff', 0.7],
          [C.magenta, 0.45],
          [C.cyan, 0.28],
          [C.magenta, 0.16],
          [C.cyan, 0.08],
          [C.magenta, 0.03],
        ]
      : [
          ['#ffffff', 0.4],
          [C.cyan, 0.2],
          [C.magenta, 0.1],
          [C.magenta, 0.0],
        ];
    if (k >= seq.length) return false;
    fill(seq[k][0], seq[k][1] * (el.gain ?? 1));
    return true;
  }

  function drawFade(el, f) {
    const t0 = el.t0 * cfg.fps;
    const t1 = el.t1 * cfg.fps;
    if (f < Math.min(t0, t1) - 1 || f > Math.max(t0, t1) + 1) {
      // Vor dem Anfang einer Abblende bzw. nach dem Ende einer Aufblende: nichts.
      if (el.dir === 'in' && f < t0) {
        fill('#000', 1);
        return true;
      }
      if (el.dir === 'out' && f > t1) {
        fill('#000', 1);
        return true;
      }
      return false;
    }
    let a = (f - t0) / (t1 - t0);
    a = Math.max(0, Math.min(1, a));
    if (el.dir === 'in') a = 1 - a;
    // Treppenstufen statt glattem Verlauf: passt zum Pixel-Look.
    a = Math.round(a * 8) / 8;
    fill('#000', a);
    return a > 0;
  }

  /** Pixel-Button: gestufte Ecken, Magenta-Füllung in Bändern, Cyan-Rand, Tinte außen, Glow-Stufen. */
  function buttonBitmap(label, glowLvl) {
    const key = `btn:${label}:${glowLvl}`;
    if (cache.has(key)) return cache.get(key);
    const label2 = glyphLine(label, 2);
    const tw = label2.width;
    const bw = tw + 22;
    const bh = 28;
    const G = 5; // Rand für Glow
    const c = canvas(bw + G * 2, bh + G * 2);
    const g = c.getContext('2d');
    const rect = (x, y, w, h, col) => {
      g.fillStyle = col;
      g.fillRect(x, y, w, h);
    };
    // Glow in harten Stufen (je 1 Raster-Pixel), Stärke pulst mit dem Beat.
    for (let i = G; i >= 1; i--) {
      const a = (0.06 + 0.05 * glowLvl) * (1 - (i - 1) / G);
      g.fillStyle = `rgba(255,63,208,${a})`;
      g.fillRect(G - i + 1, G - i, bw + 2 * i - 2, bh + 2 * i);
      g.fillRect(G - i, G - i + 1, bw + 2 * i, bh + 2 * i - 2);
    }
    const x0 = G;
    const y0 = G;
    // Tinte-Außenrand mit gestuften Ecken.
    rect(x0 + 2, y0, bw - 4, bh, C.ink);
    rect(x0, y0 + 2, bw, bh - 4, C.ink);
    rect(x0 + 1, y0 + 1, bw - 2, bh - 2, C.ink);
    // Cyan-Rand.
    rect(x0 + 3, y0 + 1, bw - 6, bh - 2, C.cyan);
    rect(x0 + 1, y0 + 3, bw - 2, bh - 6, C.cyan);
    rect(x0 + 2, y0 + 2, bw - 4, bh - 4, C.cyan);
    // Füllung in Bändern (heller oben → dunkler unten), wie die Menü-Buttons des Spiels.
    const bands = ['#ff7ae4', '#ff3fd0', '#e02cb8', '#b0209a', '#7d1a7a'];
    const inner = { x: x0 + 3, y: y0 + 3, w: bw - 6, h: bh - 6 };
    for (let i = 0; i < bands.length; i++) {
      const yy = inner.y + Math.floor((inner.h * i) / bands.length);
      const hh = inner.y + Math.floor((inner.h * (i + 1)) / bands.length) - yy;
      rect(inner.x, yy, inner.w, hh, bands[i]);
    }
    rect(inner.x, inner.y, inner.w, 1, '#ffd0f6');
    // Text: weiß mit Tinte-Schatten.
    const tm = canvas(c.width, c.height);
    tm.getContext('2d').drawImage(label2, x0 + Math.round((bw - tw) / 2) + 1, y0 + 6);
    g.drawImage(tint(tm, C.ink), 1, 1);
    g.drawImage(tm, 0, 0);
    const res = { c, cyan: tint(c, C.cyan), mag: tint(c, C.magenta), w: c.width, h: c.height };
    cache.set(key, res);
    return res;
  }

  /** Endkarte: Abdunkeln über dem Mosaik-Hintergrund, Logo, Tagline, CTA-Button, Puls auf den Beats. */
  function drawEnd(el, f) {
    const f0 = Math.round(el.b0 * cfg.fpb);
    if (f < f0) return false;
    const k = f - f0;
    const L = cfg.layout;
    const beat = f / cfg.fpb;
    const kb = Math.round((beat - Math.floor(beat + 1e-6)) * cfg.fpb); // Frames seit letztem Beat
    const pulseOn = beat < el.pulseUntil;
    const pulse = pulseOn ? Math.exp(-kb / 7) : 0;
    // Hintergrund abdunkeln + Neon-Verlauf (oben Magenta-Dunst, unten Tinte).
    fill(C.ink, 0.26);
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, 0, cfg.H);
    g.addColorStop(0, 'rgba(255,63,208,0.10)');
    g.addColorStop(0.55, 'rgba(12,7,30,0.0)');
    g.addColorStop(1, 'rgba(7,4,15,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cfg.W, cfg.H);
    ctx.restore();
    // Logo: Glitch-Einstieg, dann ruhig mit Beat-Puls.
    const lk = k;
    const lsc = lk < 4 ? [1.12, 1.05, 1.01, 1.0][lk] : 1 + 0.018 * pulse;
    logoAt(L.endLogoCx, L.endLogoCy + Math.sin(f / 40) * 3, L.endLogoW * lsc, {
      split: lk < 5 ? [18, 12, 8, 4, 2][lk] : pulse * 3,
      slices: lk < 3 ? 50 : 0,
      seed: f,
    });
    // Tagline klein unter dem Logo, einen halben Beat später.
    const tf = Math.round((el.b0 + 0.5) * cfg.fpb);
    if (f >= tf) {
      const t = pxText('tag', [{ t: el.tagline, m: 2, color: C.text }], 'center', C.magenta);
      const s = PX;
      const x = Math.round((cfg.W - t.w * s) / 2 / PX) * PX;
      blit(t, x, L.endTagY, s, f, glitchAmt(f - tf, 99));
    }
    // CTA-Button einen Beat nach der Karte.
    const bf = Math.round((el.b0 + 1) * cfg.fpb);
    if (f >= bf) {
      const bk = f - bf;
      const lvl = Math.min(4, Math.round(pulse * 4));
      const b = buttonBitmap(el.cta, lvl);
      const s = PX + (bk === 0 ? 1 : 0);
      const x = Math.round((cfg.W - b.w * s) / 2 / PX) * PX;
      const y = Math.round((L.endBtnCy - (b.h * s) / 2) / PX) * PX;
      blit(b, x, y, s, f, glitchAmt(bk, 99));
      if (bk < 6) scanlines(x, y, b.w * s, b.h * s, 0.5);
    }
    scanlines(0, 0, cfg.W, cfg.H, 0.06);
    return true;
  }

  /** Hochformat: kleines Logo im oberen Band während der Montage (Marke immer sichtbar). */
  function drawBand(el, f) {
    const f0 = Math.round(el.b0 * cfg.fpb);
    const f1 = Math.round(el.b1 * cfg.fpb);
    if (f < f0 || f >= f1) return false;
    const L = cfg.layout;
    const k = f - f0;
    const beat = f / cfg.fpb;
    const kb = Math.round((beat - Math.floor(beat + 1e-6)) * cfg.fpb);
    logoAt(L.logoCx, L.bandCy, L.bandW * (1 + 0.02 * Math.exp(-kb / 6)), { split: k < 4 ? 10 - k * 2 : 0, seed: f });
    return true;
  }

  const kinds = { super: drawSuper, slam: drawSlam, flash: drawFlash, fade: drawFade, end: drawEnd, shade: drawShade, band: drawBand };

  function drawShade(el, f) {
    const f0 = Math.round(el.b0 * cfg.fpb);
    const f1 = Math.round(el.b1 * cfg.fpb);
    if (f < f0 || f >= f1) return false;
    shade(el.region, el.a);
    return true;
  }

  async function setup(c) {
    cfg = c;
    main = canvas(cfg.W, cfg.H);
    ctx = main.getContext('2d');
    for (const [name, b64, weight] of c.fonts) {
      const ff = new FontFace(name, Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { weight });
      await ff.load();
      document.fonts.add(ff);
    }
    const img = new Image();
    img.src = c.logo;
    await img.decode();
    const lc = canvas(img.width, img.height);
    lc.getContext('2d').drawImage(img, 0, 0);
    logo = { img: lc, width: img.width, height: img.height, cyan: tint(lc, C.cyan), mag: tint(lc, C.magenta) };
    return true;
  }

  function frame(f) {
    ctx.clearRect(0, 0, cfg.W, cfg.H);
    let any = false;
    for (const el of cfg.timeline) {
      if (kinds[el.type](el, f)) any = true;
    }
    return any ? main.toDataURL('image/png') : null;
  }

  window.ov = { setup, frame };
})();
