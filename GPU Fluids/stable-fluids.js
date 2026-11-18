/* ------------------------------------------------------------------
 * Stable Fluids (Stam 1999) on WebGL2 — small, dependency-free core.
 *
 * One step():
 *   1. advect velocity (semi-Lagrangian) + impulses + buoyancy
 *   2. diffuse velocity (implicit, Jacobi)            — only if nu > 0
 *   3. project: divergence -> pressure (Jacobi) -> subtract gradient
 *   4. advect RGB dye + dye splats
 *
 * Grid units: dx = 1 cell, row 0 = bottom. Velocity in cells / time unit.
 * Storage is half-float (RG16F velocity, R16F pressure/divergence, RGBA16F dye)
 * to halve memory bandwidth; 16F is linearly filterable in core WebGL2, so
 * advection uses hardware bilinear sampling.
 *
 * Usage:
 *   const f = StableFluids.create(canvas, { W: 256, H: 160 });
 *   f.setMask(uint8Array)               // optional, W*H, 0 = wall, 255 = fluid
 *   f.splat(x, y, radius, du, dv, r, g, b) // queue a velocity impulse + dye (max 8 per step)
 *   f.shift(dx, dy)                     // translate the whole fluid (e.g. page scroll)
 *   f.step(); f.render(canvasW, canvasH);
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';
  const MAX_SPLATS = 8;

  const VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 uSize;
uniform sampler2D uMask;
out vec4 outColor;
bool inside(ivec2 p) { return all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, uSize)); }
vec4 fetch(sampler2D t, ivec2 p) { return inside(p) ? texelFetch(t, p, 0) : vec4(0); }
bool solid(ivec2 p) { return !inside(p) || texelFetch(uMask, p, 0).r < 0.5; }
// x in cell units (cell centers at i + 0.5); zero outside the grid
vec4 sampleLinear(sampler2D t, vec2 x) {
  if (any(lessThan(x, vec2(0))) || any(greaterThan(x, vec2(uSize)))) return vec4(0);
  return texture(t, x / vec2(uSize));
}
#define MAX_SPLATS ${MAX_SPLATS}
uniform int uSplatCount;
uniform vec3 uSplatPos[MAX_SPLATS];   // xy center (cells), z radius (cells)
float splatW(int i, vec2 x) { vec2 d = x - uSplatPos[i].xy; float r = uSplatPos[i].z; return exp(-dot(d, d) / (r * r)); }
`;

  const ADVECT_VEL = HEADER + `
uniform sampler2D uVel, uDye;
uniform float dt, uDissipation, uBuoyancy;
uniform vec2 uShift;
uniform vec2 uSplatVel[MAX_SPLATS];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { outColor = vec4(0); return; }
  vec2 x = gl_FragCoord.xy - uShift;
  vec2 u = sampleLinear(uVel, x - dt * sampleLinear(uVel, x).xy).xy * uDissipation;
  for (int i = 0; i < MAX_SPLATS; i++) { if (i >= uSplatCount) break; u += uSplatVel[i] * splatW(i, gl_FragCoord.xy); }
  float smoke = dot(sampleLinear(uDye, x).rgb, vec3(1.0 / 3.0));
  u.y += dt * uBuoyancy * smoke;
  outColor = vec4(u, 0, 0);
}`;

  const DIFFUSE = HEADER + `
uniform sampler2D uVel, uVel0;
uniform float uAlpha;   // nu * dt ; uAlpha = 0 copies uVel0
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { outColor = vec4(0); return; }
  vec2 s = fetch(uVel, p + ivec2(1, 0)).xy + fetch(uVel, p - ivec2(1, 0)).xy
         + fetch(uVel, p + ivec2(0, 1)).xy + fetch(uVel, p - ivec2(0, 1)).xy;
  outColor = vec4((fetch(uVel0, p).xy + uAlpha * s) / (1.0 + 4.0 * uAlpha), 0, 0);
}`;

  const DIVERGENCE = HEADER + `
uniform sampler2D uVel;
vec2 v(ivec2 q) { return solid(q) ? vec2(0) : fetch(uVel, q).xy; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = 0.5 * (v(p + ivec2(1, 0)).x - v(p - ivec2(1, 0)).x + v(p + ivec2(0, 1)).y - v(p - ivec2(0, 1)).y);
  outColor = vec4(solid(p) ? 0.0 : d, 0, 0, 0);
}`;

  const PRESSURE = HEADER + `
uniform sampler2D uPressure, uDiv;
float pr(ivec2 q, float pc) { return solid(q) ? pc : fetch(uPressure, q).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { outColor = vec4(0); return; }
  float pc = fetch(uPressure, p).x;
  float s = pr(p + ivec2(1, 0), pc) + pr(p - ivec2(1, 0), pc) + pr(p + ivec2(0, 1), pc) + pr(p - ivec2(0, 1), pc);
  outColor = vec4(0.25 * (s - fetch(uDiv, p).x), 0, 0, 0);
}`;

  const GRADIENT = HEADER + `
uniform sampler2D uVel, uPressure;
float pr(ivec2 q, float pc) { return solid(q) ? pc : fetch(uPressure, q).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { outColor = vec4(0); return; }
  float pc = fetch(uPressure, p).x;
  vec2 u = fetch(uVel, p).xy - 0.5 * vec2(pr(p + ivec2(1, 0), pc) - pr(p - ivec2(1, 0), pc),
                                          pr(p + ivec2(0, 1), pc) - pr(p - ivec2(0, 1), pc));
  if (solid(p + ivec2(1, 0)) || solid(p - ivec2(1, 0))) u.x = 0.0;
  if (solid(p + ivec2(0, 1)) || solid(p - ivec2(0, 1))) u.y = 0.0;
  outColor = vec4(u, 0, 0);
}`;

  const ADVECT_DYE = HEADER + `
uniform sampler2D uVel, uDye;
uniform float dt, uDissipation, uFade;
uniform vec2 uShift;
uniform vec3 uSplatDye[MAX_SPLATS];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { outColor = vec4(0); return; }
  vec2 x = gl_FragCoord.xy - uShift - dt * fetch(uVel, p).xy;
  vec3 d = max(sampleLinear(uDye, x).rgb * uDissipation - uFade, 0.0);
  for (int i = 0; i < MAX_SPLATS; i++) { if (i >= uSplatCount) break; d += uSplatDye[i] * splatW(i, gl_FragCoord.xy); }
  outColor = vec4(min(d, vec3(4.0)), 1.0);
}`;

  const SHOW = HEADER + `
uniform sampler2D uDye;
uniform vec2 uCanvas;
uniform float uGain, uOpacity;
void main() {
  vec3 d = sampleLinear(uDye, gl_FragCoord.xy / uCanvas * vec2(uSize)).rgb;
  vec3 c = 1.0 - exp(-uGain * d);
  outColor = vec4(c, max(c.r, max(c.g, c.b))) * uOpacity;   // premultiplied alpha
}`;

  function create(canvas, options) {
    const o = Object.assign({
      W: 128, H: 128,
      dt: 0.1,
      nu: 0, viscIters: 20,
      pressureIters: 20,
      dissipation: 0.995,     // dye fade per step (multiplicative)
      fade: 0,                // dye fade per step (linear) — clears faint haze to exactly zero
      velDissipation: 1.0,    // velocity fade per step
      buoyancy: 0,
      gain: 1.2,              // display: dye -> color saturation
      opacity: 1,
    }, options);

    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('Half-float render targets unavailable');

    /* programs */
    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VS);
    function program(fs) {
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
      }
      return { p, u };
    }
    const prog = {
      advectVel: program(ADVECT_VEL), diffuse: program(DIFFUSE), divergence: program(DIVERGENCE),
      pressure: program(PRESSURE), gradient: program(GRADIENT), advectDye: program(ADVECT_DYE), show: program(SHOW),
    };
    gl.bindVertexArray(gl.createVertexArray());

    /* textures */
    let T = null;
    function texture(internal, format, filter) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, o.W, o.H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (format === null) return { tex };   // sampled only (mask)
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer');
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo };
    }
    function pingPong(internal, filter) {
      const pp = { read: texture(internal, true, filter), write: texture(internal, true, filter) };
      pp.swap = () => { const t = pp.read; pp.read = pp.write; pp.write = t; };
      return pp;
    }
    function freeAll() {
      if (!T) return;
      const list = [T.vel.read, T.vel.write, T.dye.read, T.dye.write, T.pressure.read, T.pressure.write, T.vel0, T.div, T.mask];
      for (const t of list) { gl.deleteTexture(t.tex); if (t.fbo) gl.deleteFramebuffer(t.fbo); }
    }
    function alloc() {
      freeAll();
      T = {
        vel: pingPong(gl.RG16F, gl.LINEAR), dye: pingPong(gl.RGBA16F, gl.LINEAR),
        pressure: pingPong(gl.R16F, gl.NEAREST),
        vel0: texture(gl.RG16F, true, gl.NEAREST), div: texture(gl.R16F, true, gl.NEAREST),
        mask: texture(gl.R8, null, gl.NEAREST),
      };
      setMask(null);
    }
    function setMask(bytes) {
      if (!bytes) bytes = new Uint8Array(o.W * o.H).fill(255);
      gl.bindTexture(gl.TEXTURE_2D, T.mask.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, o.W, o.H, gl.RED, gl.UNSIGNED_BYTE, bytes);
    }

    /* pass runner: binds uniforms by name, textures to consecutive units */
    function run(pg, out, uniforms) {
      gl.useProgram(pg.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
      let unit = 0;
      const all = Object.assign({ uSize: [o.W, o.H], uMask: T.mask.tex }, uniforms);
      for (const name in pg.u) {
        const { loc, type } = pg.u[name], v = all[name];
        if (v === undefined) continue;
        switch (type) {
          case gl.SAMPLER_2D: gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v); gl.uniform1i(loc, unit++); break;
          case gl.FLOAT: gl.uniform1f(loc, v); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
          case gl.INT: gl.uniform1i(loc, v); break;
          case gl.INT_VEC2: gl.uniform2iv(loc, v); break;
        }
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* splats & shift */
    const sPos = new Float32Array(MAX_SPLATS * 3), sVel = new Float32Array(MAX_SPLATS * 2), sDye = new Float32Array(MAX_SPLATS * 3);
    let nSplats = 0;
    const shiftAcc = [0, 0];

    function step() {
      gl.viewport(0, 0, o.W, o.H);
      const splat = { uSplatCount: nSplats, uSplatPos: sPos, uSplatVel: sVel, uSplatDye: sDye };
      const shift = [shiftAcc[0], shiftAcc[1]];

      run(prog.advectVel, T.vel.write, Object.assign({
        uVel: T.vel.read.tex, uDye: T.dye.read.tex, dt: o.dt, uDissipation: o.velDissipation, uBuoyancy: o.buoyancy, uShift: shift,
      }, splat));
      T.vel.swap();

      if (o.nu > 0) {
        run(prog.diffuse, T.vel0, { uVel: T.vel.read.tex, uVel0: T.vel.read.tex, uAlpha: 0 });
        for (let i = 0; i < o.viscIters; i++) {
          run(prog.diffuse, T.vel.write, { uVel: T.vel.read.tex, uVel0: T.vel0.tex, uAlpha: o.nu * o.dt });
          T.vel.swap();
        }
      }

      run(prog.divergence, T.div, { uVel: T.vel.read.tex });
      for (let i = 0; i < o.pressureIters; i++) {   // warm-started from the previous step
        run(prog.pressure, T.pressure.write, { uPressure: T.pressure.read.tex, uDiv: T.div.tex });
        T.pressure.swap();
      }
      run(prog.gradient, T.vel.write, { uVel: T.vel.read.tex, uPressure: T.pressure.read.tex });
      T.vel.swap();

      run(prog.advectDye, T.dye.write, Object.assign({
        uVel: T.vel.read.tex, uDye: T.dye.read.tex, dt: o.dt, uDissipation: o.dissipation, uFade: o.fade, uShift: shift,
      }, splat));
      T.dye.swap();

      nSplats = 0; shiftAcc[0] = shiftAcc[1] = 0;
    }

    function render(w, h) {
      gl.viewport(0, 0, w, h);
      run(prog.show, null, { uDye: T.dye.read.tex, uCanvas: [w, h], uGain: o.gain, uOpacity: o.opacity });
    }

    alloc();
    return {
      params: o,
      gl,
      get W() { return o.W; },
      get H() { return o.H; },
      setSize(W, H) { if (W !== o.W || H !== o.H) { o.W = W; o.H = H; alloc(); } },
      setMask,
      splat(x, y, radius, du, dv, r, g, b) {
        if (nSplats >= MAX_SPLATS) return false;
        const i = nSplats++;
        sPos.set([x, y, radius], i * 3); sVel.set([du, dv], i * 2); sDye.set([r, g, b], i * 3);
        return true;
      },
      shift(dx, dy) { shiftAcc[0] += dx; shiftAcc[1] += dy; },
      step,
      render,
    };
  }

  global.StableFluids = { create, MAX_SPLATS };
})(window);
