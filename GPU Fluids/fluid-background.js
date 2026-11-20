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
 *  - dye comes out around the round photo frame and from under the name
 *  - phones: touching does not add dye; scrolling adds dye at the sources and drops dyed swirls
 *  - the page scrolls through the fluid (fields are shifted with the content)
 * ------------------------------------------------------------------ */
(function () {
  'use strict';
  const CFG = {
    // walls the fluid flows around; anything not listed (name, intro text) floats on top of the fluid
    obstacles: '.main-nav button, .theme-button, ' +
               '.publication-entry, h3.year-header, .no-results-message, .contact-button, footer p',
    circleObstacles: '.profile-pic',   // round walls: the dye wraps around the photo frame
    maxCells: 40000, minCellPx: 6, canvasScale: 2,  // canvas pixels per grid cell
    fps: 30,
    emitMs: 12000,   // ambient sources run this long after the last interaction...
    fadeMs: 9000,    // ...then the dye fades and the simulation stops
    // sources rotating around the photo frame, pushing outward with a slight spin
    ring: {
      selector: '.profile-pic', count: 4, gap: 1.5, spin: 0.08, swirl: 0.4,
      force: 30, radius: 2.5, dyeRate: 0.7,
      colors: [[0.46, 0.89, 0.85], [0.62, 0.45, 0.95], [0.95, 0.45, 0.65], [0.40, 0.70, 1.00]],
    },
    // sources just under the name, at fractions of its width, angle in degrees (270 = down)
    name: {
      selector: '.name-link', gap: 1, force: 30, radius: 2.5, dyeRate: 0.8, sway: 25, swayFreq: 0.2,
      sources: [
        { at: 0.2, angle: 235, color: [0.46, 0.89, 0.85], phase: 0.0 },
        { at: 0.8, angle: 305, color: [0.95, 0.45, 0.65], phase: 2.0 },
      ],
    },
    mouseGain: 1.5, mouseRadius: 3, mouseDye: 0.6,
    // phones: scrolling (not the touch point) stirs the fluid.
    // fullSpeed = cells scrolled per step that count as a full-strength scroll
    scroll: { fullSpeed: 8, boost: 2.5, swirlRadius: 3, swirlGain: 1.5, maxSwirl: 25, dye: 0.8 },
    fluid: { dt: 0.1, pressureIters: 20, dissipation: 0.99, fade: 0.002, velDissipation: 0.995, gain: 1.3, opacity: 0.7 },
  };

  // phone / tablet: UA hint, UA string, or a touch-only device with no hover
  const isMobile = !!((navigator.userAgentData && navigator.userAgentData.mobile) ||
    /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches));

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
    for (const el of document.querySelectorAll(CFG.circleObstacles)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > vh) continue;
      const cx = (r.left + r.right) / 2 / cellPx, cy = (r.top + r.bottom) / 2 / cellPx, R = r.width / 2 / cellPx;
      const k0 = Math.max(0, Math.floor(cy - R)), k1 = Math.min(H - 1, Math.ceil(cy + R));
      const i0 = Math.max(0, Math.floor(cx - R)), i1 = Math.min(W - 1, Math.ceil(cx + R));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++)
        if ((i + 0.5 - cx) ** 2 + (k + 0.5 - cy) ** 2 <= R * R) mask[(H - 1 - k) * W + i] = 0;
    }
    fluid.setMask(mask);
  }

  /* ---- interaction ---- */
  // desktop: the mouse stirs the fluid. Phones: no dye at the touch point, scrolling stirs it instead (see frame()).
  const pointer = { x: 0, y: 0, dx: 0, dy: 0, has: false };
  if (!isMobile) {
    addEventListener('pointermove', e => {
      const x = e.clientX / cellPx, y = fluid.H - e.clientY / cellPx;
      if (pointer.has) { pointer.dx += x - pointer.x; pointer.dy += y - pointer.y; }
      pointer.x = x; pointer.y = y; pointer.has = true;
      wake();
    }, { passive: true });
    document.addEventListener('pointerleave', () => { pointer.has = false; });
  }
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

  const visible = r => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
  let scrollLevel = 0;   // phones: 0..1, recent scroll speed (decays smoothly)

  /* dye sources around the photo frame and under the name (only while they are on screen) */
  function emit(now) {
    const k = Math.min(1, Math.max(0, (CFG.emitMs - (now - lastActive)) / 2000));   // ramp down before sleeping
    const amount = k + CFG.scroll.boost * scrollLevel;
    if (amount <= 0) return;
    const push = Math.min(amount, 1.5), dt = fluid.params.dt, t = now / 1000, H = fluid.H;

    const pic = document.querySelector(CFG.ring.selector);
    const pr = pic && pic.getBoundingClientRect();
    if (pr && visible(pr)) {
      const c = CFG.ring, R = pr.width / 2 / cellPx + c.gap;
      const cx = (pr.left + pr.right) / 2 / cellPx, cy = H - (pr.top + pr.bottom) / 2 / cellPx;
      for (let i = 0; i < c.count; i++) {
        const a = 2 * Math.PI * (i / c.count + c.spin * t), nx = Math.cos(a), ny = Math.sin(a);  // outward normal
        const f = push * dt * c.force;
        fluid.splat(cx + R * nx, cy + R * ny, c.radius,
          f * (nx - c.swirl * ny), f * (ny + c.swirl * nx),           // outward + a bit of spin
          ...c.colors[i % c.colors.length].map(v => amount * v * dt * c.dyeRate));
      }
    }

    const name = document.querySelector(CFG.name.selector);
    const nr = name && name.getBoundingClientRect();
    if (nr && visible(nr)) {
      const c = CFG.name, y = H - nr.bottom / cellPx - c.gap;
      for (const src of c.sources) {
        const a = (src.angle + c.sway * Math.sin(2 * Math.PI * c.swayFreq * t + src.phase)) * Math.PI / 180;
        fluid.splat((nr.left + src.at * nr.width) / cellPx, y, c.radius,
          push * dt * c.force * Math.cos(a), push * dt * c.force * Math.sin(a),
          ...src.color.map(v => amount * v * dt * c.dyeRate));
      }
    }
  }

  /* phones: a scroll drops a small dyed vortex somewhere in the open fluid */
  function scrollSwirl(cells, now) {
    const s = CFG.scroll, W = fluid.W, H = fluid.H;
    const level = Math.min(1, cells / s.fullSpeed);
    let x = 0, y = 0, open = false;
    for (let tries = 0; tries < 12 && !open; tries++) {
      x = Math.random() * W; y = Math.random() * H;
      open = mask[Math.floor(y) * W + Math.floor(x)] > 0;
    }
    if (!open) return;
    const v = Math.min(s.maxSwirl, s.swirlGain * cells) * (Math.random() < 0.5 ? 1 : -1);
    const a = Math.random() * 2 * Math.PI, nx = Math.cos(a), ny = Math.sin(a), r = s.swirlRadius;
    const dye = hue(now / 20000 + Math.random() * 0.3).map(c => c * level * s.dye);
    // two opposite pushes side by side = a spinning blob
    fluid.splat(x + r * nx, y + r * ny, r, -v * ny, v * nx, ...dye);
    fluid.splat(x - r * nx, y - r * ny, r, v * ny, -v * nx, ...dye);
  }

  function frame(now) {
    if (now - lastActive > CFG.emitMs + CFG.fadeMs) { running = false; return; }   // sleep
    requestAnimationFrame(frame);
    if (now - lastStep < 1000 / CFG.fps - 2) return;
    lastStep = now;

    if (resized) { resized = false; layoutGrid(); maskDirty = true; }
    const sy = window.scrollY;
    const scrolled = (sy - lastScrollY) / cellPx;   // cells
    if (scrolled) { fluid.shift(0, scrolled); lastScrollY = sy; maskDirty = true; }
    if (maskDirty || now - lastMask > 1000) { updateMask(); maskDirty = false; lastMask = now; }

    if (isMobile) {
      scrollLevel = Math.max(Math.min(1, Math.abs(scrolled) / CFG.scroll.fullSpeed), scrollLevel * 0.9);
      if (Math.abs(scrolled) > 0.2) scrollSwirl(Math.abs(scrolled), now);
    }
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
