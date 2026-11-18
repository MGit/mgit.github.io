/* ------------------------------------------------------------------
 * Fluid page background: a fixed, viewport-sized Stable Fluids layer
 * behind the content. Elements matching CFG.obstacles are walls, so the
 * dye flows in the gaps and margins between the boxes.
 *
 * Requires stable-fluids.js to be loaded first.
 *
 * Kept cheap for visitors:
 *  - coarse grid (<= ~40k cells, >= 6 CSS px per cell), half-float textures
 *  - canvas drawn at 1/3 to 1/5 of CSS resolution, upscaled by the browser
 *  - capped at 30 steps per second, 20 warm-started pressure iterations
 *  - sleeps completely (no GPU work, no rAF) once idle: ambient sources stop
 *    CFG.emitMs after the last interaction, the dye fades out, then the loop ends.
 *    Mouse movement, scrolling or resizing wakes it.
 *  - never starts with prefers-reduced-motion, Save-Data, or without WebGL2
 *  - the page scrolls through the fluid (fields are shifted with the content)
 * ------------------------------------------------------------------ */
(function () {
  'use strict';
  const CFG = {
    // walls the fluid flows around; anything not listed (photo, name, intro text) floats on top of the fluid
    obstacles: '.main-nav button, .theme-button, ' +
               '.publication-entry, h3.year-header, .no-results-message, .contact-button, footer p',
    maxCells: 40000, minCellPx: 6, canvasScale: 2,  // canvas pixels per grid cell
    fps: 30,
    emitMs: 12000,   // ambient sources run this long after the last interaction...
    fadeMs: 9000,    // ...then the dye fades and the simulation stops
    contentWidth: 960,
    emitters: [      // y = fraction of viewport height from the top; side = left / right margin
      { side: 'left',  y: 0.85, angle: 90,  color: [0.46, 0.89, 0.85], phase: 0.0 },
      { side: 'right', y: 0.15, angle: 270, color: [0.62, 0.45, 0.95], phase: 2.0 },
      { side: 'right', y: 0.85, angle: 90,  color: [0.95, 0.45, 0.65], phase: 4.0 },
    ],
    force: 40, radius: 2.5, dyeRate: 1.2, sway: 30, swayFreq: 0.2,
    mouseGain: 1.5, mouseRadius: 3, mouseDye: 0.6,
    fluid: { dt: 0.1, pressureIters: 20, dissipation: 0.99, fade: 0.002, velDissipation: 0.995, gain: 1.3, opacity: 0.7 },
  };

  if (!window.StableFluids) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (navigator.connection && navigator.connection.saveData) return;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;';
  document.body.prepend(canvas);

  let fluid;
  try { fluid = StableFluids.create(canvas, CFG.fluid); }
  catch (e) { canvas.remove(); return; }

  /* ---- grid sized to the viewport ---- */
  let cellPx = CFG.minCellPx, mask = null;
  function viewport() { return [document.documentElement.clientWidth, window.innerHeight]; }
  function layoutGrid() {
    const [vw, vh] = viewport();
    cellPx = Math.max(CFG.minCellPx, Math.ceil(Math.sqrt(vw * vh / CFG.maxCells)));
    const W = Math.ceil(vw / cellPx), H = Math.ceil(vh / cellPx);
    fluid.setSize(W, H);
    canvas.width = W * CFG.canvasScale; canvas.height = H * CFG.canvasScale;
    canvas.style.width = W * cellPx + 'px'; canvas.style.height = H * cellPx + 'px';
    mask = new Uint8Array(W * H);
  }

  /* ---- obstacle mask from element rectangles (cell is wall if its center is inside) ---- */
  function updateMask() {
    const W = fluid.W, H = fluid.H, vh = H * cellPx;
    mask.fill(255);
    for (const el of document.querySelectorAll(CFG.obstacles)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > vh) continue;
      const i0 = Math.max(0, Math.ceil(r.left / cellPx - 0.5)), i1 = Math.min(W - 1, Math.floor(r.right / cellPx - 0.5));
      const k0 = Math.max(0, Math.ceil(r.top / cellPx - 0.5)), k1 = Math.min(H - 1, Math.floor(r.bottom / cellPx - 0.5));
      if (i0 > i1) continue;
      for (let k = k0; k <= k1; k++) { const row = (H - 1 - k) * W; mask.fill(0, row + i0, row + i1 + 1); }
    }
    fluid.setMask(mask);
  }

  /* ---- interaction ---- */
  const pointer = { x: 0, y: 0, dx: 0, dy: 0, has: false };
  addEventListener('pointermove', e => {
    const x = e.clientX / cellPx, y = fluid.H - e.clientY / cellPx;
    if (pointer.has) { pointer.dx += x - pointer.x; pointer.dy += y - pointer.y; }
    pointer.x = x; pointer.y = y; pointer.has = true;
    wake();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.has = false; });
  addEventListener('scroll', wake, { passive: true });
  let resized = true, maskDirty = true;
  addEventListener('resize', () => { resized = true; wake(); });
  new ResizeObserver(() => { maskDirty = true; }).observe(document.body);
  new MutationObserver(() => { maskDirty = true; wake(); })
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  /* ---- loop with idle sleep ---- */
  const hue = h => [0, 8, 4].map(n => { const k = (n + h * 12) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
  let running = false, lastActive = performance.now(), lastStep = 0, lastMask = 0, lastScrollY = window.scrollY;

  function wake() {
    lastActive = performance.now();
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  function emit(now) {
    const k = Math.min(1, Math.max(0, (CFG.emitMs - (now - lastActive)) / 2000));   // ramp down before sleeping
    if (k <= 0) return;
    const [vw, vh] = viewport(), dt = fluid.params.dt, t = now / 1000;
    const sideX = Math.max(10, (vw - CFG.contentWidth) / 4);   // middle of the side margin (px)
    for (const em of CFG.emitters) {
      const xPx = em.side === 'left' ? sideX : vw - sideX;
      const a = (em.angle + CFG.sway * Math.sin(2 * Math.PI * CFG.swayFreq * t + em.phase)) * Math.PI / 180;
      fluid.splat(xPx / cellPx, fluid.H - em.y * vh / cellPx, CFG.radius,
        k * dt * CFG.force * Math.cos(a), k * dt * CFG.force * Math.sin(a),
        ...em.color.map(c => k * c * dt * CFG.dyeRate));
    }
  }

  function frame(now) {
    if (now - lastActive > CFG.emitMs + CFG.fadeMs) { running = false; return; }   // sleep
    requestAnimationFrame(frame);
    if (now - lastStep < 1000 / CFG.fps - 2) return;
    lastStep = now;

    if (resized) { resized = false; layoutGrid(); maskDirty = true; }
    const sy = window.scrollY;
    if (sy !== lastScrollY) { fluid.shift(0, (sy - lastScrollY) / cellPx); lastScrollY = sy; maskDirty = true; }
    if (maskDirty || now - lastMask > 1000) { updateMask(); maskDirty = false; lastMask = now; }

    emit(now);
    if (pointer.dx || pointer.dy) {
      const s = Math.min(1, Math.hypot(pointer.dx, pointer.dy) * 0.25) * CFG.mouseDye;
      fluid.splat(pointer.x, pointer.y, CFG.mouseRadius, pointer.dx * CFG.mouseGain, pointer.dy * CFG.mouseGain,
        ...hue(now / 20000).map(c => c * s));
      pointer.dx = pointer.dy = 0;
    }
    fluid.step();
    fluid.render(canvas.width, canvas.height);
  }

  wake();
})();
