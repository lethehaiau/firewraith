// FIREWRAITH · classic · VALLEYWARD's original fire as a Fire API v1 module (webgl2). Fills `ground` (the GPU grid
// fluid drawn as a ray-marched 2.5D volume, embers, steam, the fire columns, the light map, the gameplay grid) and
// `lance` (the Ember Lance's particle jet), together or either alone. How it works: FLUID.md "How it works".
//   import { info, create } from 'firewraith/modules/classic';
//   const m = await create(host);            // host: docs/API.md
//   each frame: m.events(list, wind); m.update(dt, { rain, time }); m.lance(state); m.render(renderer, { colorTex, depthTex, camera, target, width, height })
import * as THREE from 'three';
import { FIRE_OP } from '../../src/api/events.js';
import { createGridReadback, makeGpuTimer, sampleGrid } from '../../src/kit/webgl2/readback.js';
import { setWorld, W } from './world.js';
import { pickFloatTypes, Quad } from './gl.js';
import { FluidSolver, RES, KNOBS, DEPOSIT, LIGHT_COLS } from './solver.js';
import { VolumePass, makeNoiseTexture, LOOK } from './volume.js';
import { Embers } from './embers.js';
import { Jet, JET, jetLanding } from './jet.js';
import { Steam, STEAM } from './steam.js';
import { Columns, COLUMN_PRESETS, COLUMN_RAMPS, makeFireVortexMaterial } from './column.js';
import { info } from './info.js';

export { info, KNOBS, DEPOSIT, LOOK, JET, RES, STEAM, COLUMN_PRESETS, COLUMN_RAMPS, makeFireVortexMaterial, jetLanding };

export const TIER = {
  // march steps bound the worst case (thin smoke never terminates a ray early, so every ray may take them all)
  high: { steps: 40, stepScale: 1.0, embers: 16384 },
  medium: { steps: 38, stepScale: 1.25, embers: 8192 },
  low: { steps: 30, stepScale: 1.6, embers: 4096 },
};
const FIRE_LIGHT_COLOR = LIGHT_COLS[0];   // orange

/**
 * @param {import('../../src/api/index.js').Host} host
 * @returns {Promise<import('../../src/api/index.js').FireModule & Record<string, any>>}
 */
export async function create(host) {
  const renderer = host.renderer;
  const slots = host.slots?.length ? host.slots : info.slots;
  const G = slots.includes('ground'), L = slots.includes('lance');
  let quality = host.quality in TIER ? host.quality : 'high';
  let style = host.style === 'hybrid' ? 'hybrid' : 'smooth';
  const types = pickFloatTypes(renderer);
  if (!types) throw new Error('classic: this GPU cannot render into float targets (no EXT_color_buffer_float / EXT_color_buffer_half_float)');
  setWorld(host.world);
  JET.speed = W.lance.speed; JET.gravity = W.lance.gravity;   // the visual flies the game's arc

  const noise = makeNoiseTexture();
  const solver = G ? new FluidSolver(renderer, quality, noise) : null;
  const quad = solver ? solver.quad : new Quad();
  const volume = new VolumePass(renderer, { quad, noise });
  const embers = G ? new Embers(renderer, { quad, noise, type: types.particle, depthU: volume.depthU }) : null;
  const jetFx = L ? new Jet(renderer, { noise, depthU: volume.depthU }) : null;
  const steam = G ? new Steam(renderer, { noise, depthU: volume.depthU }) : null;
  const columns = G ? new Columns(renderer, { noise, depthU: volume.depthU }) : null;   // the ending's pillar and the demon's fire

  let timer = host.options?.gpuTiming ? makeGpuTimer(renderer) : null;
  const S = { hueT: -1e9, quality, style, simMs: 0, renderMs: 0, frame: 0, ready: false, disposed: false, enabled: true, time: 0, camFire: 0, camFireInit: false, camT: 0, preKey: '', colMs: 0, swirlOpT: -1e9 };
  // the read-back: the 64² summary (heat, fuel, fire, smoke) then the 64² hue fractions (nearLight's colour)
  const rb = G ? createGridReadback(renderer, { reads: [{ target: () => solver.summaryRT, w: 64, h: 64 }, { target: () => solver.hueRT, w: 64, h: 64 }] }) : null;
  const grid = rb ? rb.data.subarray(0, 64 * 64 * 4) : new Uint8Array(64 * 64 * 4), hueGrid = rb ? rb.data.subarray(64 * 64 * 4) : new Uint8Array(64 * 64 * 4);

  function applyTier(q) {
    const t = TIER[q];
    volume.setSteps(t.steps, t.stepScale);
    embers?.setCount(t.embers);
  }
  applyTier(quality);
  volume.setStyle(style); embers?.setStyle(style); steam?.setStyle(style); columns?.setStyle(style);

  /** The fire light at a point, from the read-back (the CPU twin of the light map). */
  function lightAt(x, y, z, out) {
    const f = W.area;
    const ci = Math.floor((x - f.x0) / f.size * 64), cj = Math.floor((z - f.z0) / f.size * 64);
    let Lw = 0, cr = 0, cg = 0, cb = 0;
    for (let j = cj - 6; j <= cj + 6; j++) {
      if (j < 0 || j > 63) continue;
      for (let i = ci - 6; i <= ci + 6; i++) {
        if (i < 0 || i > 63) continue;
        const k = (j * 64 + i) * 4;
        const v = grid[k + 2] * 1.15 + grid[k] * 0.35;
        if (!v) continue;
        const dx = (i + 0.5) - (x - f.x0) / f.size * 64, dz = (j + 0.5) - (z - f.z0) / f.size * 64;
        const w = v * Math.exp(-(dx * dx + dz * dz) / (2 * 2.2 * 2.2));
        Lw += w;
        // the cell's light colour from its hue fractions, like the light map's
        const h0 = hueGrid[k] / 255, h1 = hueGrid[k + 1] / 255, h2 = hueGrid[k + 2] / 255, h3 = hueGrid[k + 3] / 255, ho = Math.max(0, 1 - h0 - h1 - h2 - h3);
        for (let c = 0; c < 3; c++) {
          const col = LIGHT_COLS[0][c] * ho + LIGHT_COLS[1][c] * h0 + LIGHT_COLS[2][c] * h1 + LIGHT_COLS[3][c] * h2 + LIGHT_COLS[4][c] * h3;
          if (c === 0) cr += w * col; else if (c === 1) cg += w * col; else cb += w * col;
        }
      }
    }
    // the mean colour (orange alone: exactly the orange light colour)
    const cR = Lw > 0 ? cr / Lw : FIRE_LIGHT_COLOR[0], cG = Lw > 0 ? cg / Lw : FIRE_LIGHT_COLOR[1], cB = Lw > 0 ? cb / Lw : FIRE_LIGHT_COLOR[2];
    Lw = Lw / 255 / (2 * Math.PI * 2.2 * 2.2);   // normalised: a wide uniform fire gives the same value as the light map
    const above = Math.max(0, y - 1.2) / W.light.height;
    Lw *= W.light.gain * 1.5 * (1 - KNOBS.rainLight * solver.rain) / (1 + above * above);
    out.setRGB(cR * Lw, cG * Lw, cB * Lw);
  }

  const fire = G ? {
    /** Gameplay heat at (x, z), 0..1 (max of heat and 0.8 × fire over the 1 m cell, bilinear between cells). */
    heat: (x, z) => sampleGrid(grid, 64, W.area, 0, x, z),
    /** Oil on the ground at (x, z), 0..1 (cell mean). */
    fuel: (x, z) => sampleGrid(grid, 64, W.area, 1, x, z),
    /** Fire (the reaction) at (x, z), 0..1 (cell mean). */
    fire: (x, z) => sampleGrid(grid, 64, W.area, 2, x, z),
    ready: false,
    /** Frames since the read-back grid was issued (it holds its last state while the GPU queue is too deep to read). */
    get ageFrames() { return rb.landed < 0 ? -1 : S.frame - rb.landed; },
  } : undefined;

  const time = () => (solver ? solver.time : S.time);
  const camPos = new THREE.Vector3();
  const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

  /** Composite the fire + smoke volume, the jet, the embers, the steam and the columns over `colorTex` into `target`. */
  function render(r, { colorTex, depthTex, camera, target = null, width, height }) {
    if (S.disposed) return;
    const t0 = performance.now();
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    camera.updateMatrixWorld();
    if (G) {
      // is the eye standing in fire? From the read-back (fire, the max of the 1 m cells within ≈ 1.5 m) and the eye's
      // height above the ground (never on a wall walk); eased so the fade never pops
      camPos.setFromMatrixPosition(camera.matrixWorld);
      let f = 0;
      if (S.ready) for (let dz = -1.2; dz <= 1.21; dz += 1.2) for (let dx = -1.2; dx <= 1.21; dx += 1.2) f = Math.max(f, fire.fire(camPos.x + dx, camPos.z + dz) * (dx || dz ? 0.7 : 1));
      const want = smooth(0.03, 0.3, f) * (1 - smooth(2.4, 3.5, camPos.y - W.groundHeight(camPos.x, camPos.z)));
      const now = performance.now(), dtc = Math.min(0.1, (now - (S.camT || now)) / 1000); S.camT = now;
      S.camFire += (want - S.camFire) * Math.min(1, dtc * 6 + (S.camFireInit ? 0 : 1)); S.camFireInit = true;
      volume.setCamFire(S.camFire);
    }
    timer?.begin('render');
    volume.setCamera(camera, depthTex);
    if (S.preKey !== width + 'x' + height) { S.preKey = width + 'x' + height; volume.prealloc(width, height); }   // both styles' targets, once per size
    const sk = api.debug.skip;
    // hue reads only while coloured fire can be alive (≤ 40 s after the last hued op or a hued jet): orange-only nights pay nothing for the hues
    volume.setHue(time() - S.hueT < 40 || (jetFx && jetFx.alive > 0 && (jetFx.cmd.hue || jetFx.streamHue || 'orange') !== 'orange'));
    if (G && S.enabled && !sk.march) volume.march(solver, { width, height, time: solver.time });
    else volume.clear(width, height);
    if (jetFx && S.enabled && !sk.jet) jetFx.render(volume.rt, camera);
    volume.composite(colorTex, target, width, height);
    if (G && S.enabled && !sk.embers) embers.render(target, camera, width, height, volume.pixelSize(height));
    if (G && S.enabled) steam.render(target, camera, width, height, volume.pixelSize(height));
    if (G && S.enabled && (columns.count || columns.sp.n)) { const tc = performance.now(); columns.render(target, camera, width, height, volume.pixelSize(height)); S.colMs = performance.now() - tc; }
    timer?.end();
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
    S.renderMs = performance.now() - t0;
  }

  /**
   * Compiling is not enough on ANGLE/Metal: a program's pipeline is built at its first draw (the first switch to
   * Smooth cost a 66 ms frame with 0 new programs). So warm() also draws one small frame through every pass in both
   * styles and every march variant (hue / in-fire), plus the jet, the embers and the steam, into throwaway targets.
   */
  function warmDraws(r, camera) {
    if (S.disposed) return;
    const Wd = 192, Hd = 108, keep = S.style, prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    const sceneT = new THREE.WebGLRenderTarget(Wd, Hd, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: new THREE.DepthTexture(Wd, Hd) });
    const outT = new THREE.WebGLRenderTarget(Wd, Hd, { type: THREE.HalfFloatType, depthBuffer: false });
    const keepHue = volume.hueOn, keepFire = volume.camFire || 0, jetN = jetFx?.mesh.geometry.instanceCount ?? 0, steamN = steam?.mesh.geometry.instanceCount ?? 0;
    r.autoClear = false;
    try {
      camera.updateMatrixWorld();
      r.setRenderTarget(sceneT); r.clear(true, true, false);
      for (const st of ['smooth', 'hybrid']) {
        volume.setStyle(st); embers?.setStyle(st); steam?.setStyle(st);
        for (const [hue, inf] of [[false, false], [true, false], [false, true], [true, true]]) {
          volume.setHue(hue); volume.setCamFire(inf ? 0.5 : 0);
          volume.setCamera(camera, sceneT.depthTexture);
          if (G) volume.march(solver, { width: Wd, height: Hd, time: solver.time }); else volume.clear(Wd, Hd);
          if (jetFx && !hue && !inf) {
            jetFx.mesh.geometry.instanceCount = 1; r.setRenderTarget(volume.rt); r.render(jetFx.mesh, camera);   // a zero-size puff: the pipeline, no pixels
          }
          volume.composite(sceneT.texture, outT, Wd, Hd);
        }
        if (G) {
          embers.render(outT, camera, Wd, Hd, volume.pixelSize(Hd));
          steam.mesh.geometry.instanceCount = 1; r.setRenderTarget(outT); r.render(steam.mesh, camera);
          // the ending's fire columns and their sparks (first drawn at the 'lamp' and 'reveal' beats)
          columns.set('__warm', { preset: 'pillar', x: 0, y: 0, z: 0, intensity: 1 }); columns.setStyle(st);
          columns.sp.n = 1; columns.sparks.geometry.setDrawRange(0, 1);
          columns.render(outT, camera, Wd, Hd, volume.pixelSize(Hd));
          columns.set('__warm', null); columns.sp.n = 0; columns.sparks.geometry.setDrawRange(0, 0);
        }
      }
    } finally {
      if (jetFx) jetFx.mesh.geometry.instanceCount = jetN;
      if (steam) steam.mesh.geometry.instanceCount = steamN;
      volume.setStyle(keep); embers?.setStyle(keep); steam?.setStyle(keep); columns?.setStyle(keep); volume.setHue(keepHue); volume.setCamFire(keepFire);
      volume.dropSize(Wd, Hd);
      sceneT.depthTexture.dispose(); sceneT.dispose(); outT.dispose();
      r.autoClear = prevAuto; r.setRenderTarget(prevRT);
    }
  }

  function step(dt) {
    if (S.disposed) return;
    const t0 = performance.now();
    S.frame++;
    // the read first, before this frame's GL work is issued: the round trip then waits only for work already queued
    if (rb && !api.debug.skip.readback && rb.poll(S.frame)) { S.ready = true; fire.ready = true; }
    timer?.begin('sim');
    let n = 0;
    if (G) {
      solver.lightSplats = columns.count ? columns.lights() : [];   // the columns light the world (the light map)
      // debug.lockStep (perf tools): exactly one sub-step per rendered frame, so an uncapped frame holds one 60 Hz frame's work
      n = S.enabled ? solver.step(api.debug.lockStep ? 1 / solver.cfg.hz : dt) : 0;
    } else S.time += Math.max(0, dt);
    if (S.enabled) {
      if (G) {
        const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
        renderer.autoClear = false;
        embers.update(solver, Math.min(dt, 0.05));
        renderer.autoClear = prevAuto;
        renderer.setRenderTarget(prevRT);
      }
      jetFx?.update(dt);
      if (G) { steam.update(dt); columns.update(dt); }
    }
    timer?.end();
    if (rb && !api.debug.skip.readback && n) rb.kick(S.frame);   // (after the sim: the grid read is this frame's)
    if (timer) timer.poll();
    S.simMs = performance.now() - t0;
  }

  const api = {
    info,
    // ------------------------------------------------------------------ Fire API v1
    /** ground: the fire events of every sim tick since the last frame; the wind {x, z} m/s biases the flow. */
    events(ops, wind) {
      if (S.disposed || !G) return;
      solver.queue(ops);
      if (wind) solver.wind.set(wind.x || 0, wind.z || 0);
      if (ops) for (const op of ops) {
        if (op.kind === FIRE_OP.SWIRL) S.swirlOpT = solver.time;
        if (op.hue && op.hue !== 'orange') S.hueT = solver.time;   // coloured fire alive: the render reads the hue
        if (op.kind === FIRE_OP.STREAM) { if (jetFx) jetFx.streamHue = op.hue || 'orange'; }   // the jet follows the Lance's stream hue
        else if (op.kind === FIRE_OP.DOUSE && S.enabled) {
          // steam where fire was (the read-back grid); while the grid is stale (a deep GPU queue) a bucket-sized douse
          // still puffs a little, a big one (dawn) does not
          const r = op.r ?? 2, fresh = S.ready && S.frame - rb.landed <= 30;
          const seg = op.x0 != null ? { x0: op.x0, z0: op.z0, x1: op.x1 ?? op.x0, z1: op.z1 ?? op.z0 } : null;   // a tide line
          const cx = seg ? (seg.x0 + seg.x1) / 2 : op.x, cz = seg ? (seg.z0 + seg.z1) / 2 : op.z;
          if (fresh) steam.douse(cx, cz, r, fire.heat, wind, seg ? 4 : undefined, seg);   // a tide line comes every tick: a few puffs each
          else if (r <= 4 && !seg) steam.douse(cx, cz, r, () => 0.25, wind, 8);
        }
      }
    },
    /** lance: the Ember Lance this frame ({ on, origin, dir, range, t, hue }). */
    lance(s) { if (jetFx && s) jetFx.set(s); },
    /** Advance by game seconds; the solver sub-steps at its fixed rate (60 Hz; 30 Hz on low), ≤ 3 sub-steps a frame.
     *  ctx.rain 0..1: fire weaker (a quench on the reaction), flames lower, smoke paler, the fire light dimmer. */
    update(dt, ctx = {}) {
      if (G && ctx.rain != null) solver.rain = Math.max(0, Math.min(1, +ctx.rain || 0));
      step(dt);
    },
    render,
    fire,
    /** ground: the light map over the fire area (RGB = fire light colour × strength, linear). */
    get lightMap() { return G ? solver.lightRT.texture : null; },
    /** The fire light at a point (the first-person hands); false while no grid has landed. */
    nearLight(x, y, z, out) { if (!G || !S.ready) return false; lightAt(x, y, z, out); return true; },
    /** Extra: local fire columns outside the ground fluid. set(id, { preset: 'pillar'|'demon', x, y, z, intensity 0..1,
     *  …COLUMN_PRESETS overrides }) or set(id, null); clear() removes all. */
    columns: G ? { set: (id, cfg) => columns.set(id, cfg), clear: () => columns.reset(), get: (id) => columns.map.get(id)?.p ?? null } : undefined,
    setStyle(s) { S.style = s === 'hybrid' ? 'hybrid' : 'smooth'; volume.setStyle(S.style); embers?.setStyle(S.style); steam?.setStyle(S.style); columns?.setStyle(S.style); },
    setQuality(q) { if (!(q in TIER)) return; S.quality = q; solver?.setQuality(q); applyTier(q); },
    stats() {
      const c = solver?.cfg;
      return {
        module: info.id, slots: [...slots],
        simMs: +S.simMs.toFixed(3), renderMs: +S.renderMs.toFixed(3),
        res: { vel: c?.vel ?? 0, scalars: c?.sca ?? 0, volume: [volume.w, volume.h], embers: embers?.count ?? 0, jacobi: solver?.lastJacobi ?? 0, hz: c?.hz ?? 0 },
        steps: solver?.stepsLast ?? 0, readbackAgeFrames: rb && rb.landed >= 0 ? S.frame - rb.landed : -1,
        gpuSimMs: timer?.last.sim != null ? +timer.last.sim.toFixed(3) : null, gpuRenderMs: timer?.last.render != null ? +timer.last.render.toFixed(3) : null,
        style: S.style, quality: S.quality, camFire: +S.camFire.toFixed(2), jetParticles: jetFx?.alive ?? 0, steamPuffs: steam?.alive ?? 0, rain: solver?.rain ?? 0, columns: columns?.count ?? 0, sparks: columns?.sp.n ?? 0, columnMs: +S.colMs.toFixed(3),
        readbackMaxMs: rb ? rb.stats(S.frame) : null,
      };
    },
    /** Compile every program (both styles, so a style switch never hitches) and run one sub-step. */
    async warm(r = renderer, cam) {
      const sc = new THREE.Scene(), geo = new THREE.PlaneGeometry(2, 2);
      const add = (m, points = false) => { const o = points ? new THREE.Points(embers.points.geometry, m) : new THREE.Mesh(geo, m); o.frustumCulled = false; sc.add(o); };
      if (G) {
        for (const m of Object.values(solver.mats)) add(m);
        add(solver.splatSMat); add(solver.splatVMat); add(embers.updMat);
        for (const m of Object.values(steam.mats)) add(m);
        for (const m of columns.materials()) add(m, m === columns.sparkMats.smooth || m === columns.sparkMats.hybrid);
      }
      if (jetFx) add(jetFx.mesh.material);
      const keep = S.style;
      for (const st of ['smooth', 'hybrid']) { volume.setStyle(st); embers?.setStyle(st); for (const m of volume.variants()) if (m) add(m); if (G) add(embers.drawMat, true); }
      const camera = cam || new THREE.PerspectiveCamera();
      const prevRT = r.getRenderTarget();
      if (G) r.setRenderTarget(solver.lightTmp);   // compile for a render target (linear output), like the real passes
      try { if (r.compileAsync) await r.compileAsync(sc, camera); else r.compile(sc, camera); } finally { r.setRenderTarget(prevRT); }
      volume.setStyle(keep); embers?.setStyle(keep);
      geo.dispose();
      step(1 / 60);
      warmDraws(r, camera);
    },
    /** A fresh night: clear fuel, fire, smoke, heat, velocity and pressure, the embers, the jet, the read-back grid. */
    reset() {
      if (S.disposed) return;
      solver?.reset(); embers?.reset(); jetFx?.reset(); steam?.reset(); columns?.reset(); rb?.reset(); S.hueT = -1e9;
    },
    /** Debug (benches, perf tools): skips, the read-back grid, the parts. */
    debug: {
      skip: { march: false, jet: false, embers: false, readback: false }, lockStep: false,
      get rbMaxLag() { return rb ? rb.maxLag : 1; }, set rbMaxLag(v) { if (rb) rb.maxLag = v; },
      look: LOOK, rbReset() { rb?.resetStats(); }, grid, solver, volume, embers, jet: jetFx, steam, columns,
      reset: () => api.reset(), setEnabled(on) { S.enabled = !!on; }, setGpuTiming(on) { timer = on ? (timer || makeGpuTimer(renderer)) : null; return !!timer; },
    },
    dispose() {
      if (S.disposed) return;
      S.disposed = true;
      rb?.dispose();
      solver?.dispose(); volume.dispose(); embers?.dispose(); jetFx?.dispose(); steam?.dispose(); columns?.dispose(); noise.dispose();
      if (!solver) quad.dispose();
    },
  };
  // ?rbmode=off | lagN (perf experiments only): no read-back, or another lag gate
  { const m = typeof window !== 'undefined' && /[?&]rbmode=([a-z0-9,]+)/.exec(window.location?.search || ''); if (m) for (const k of m[1].split(',')) {
    if (k === 'off') api.debug.skip.readback = true; else if (/^lag\d$/.test(k)) api.debug.rbMaxLag = +k.slice(3); } }
  return api;
}
