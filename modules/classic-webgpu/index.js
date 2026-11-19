// FIREWRAITH · classic-webgpu · the classic fire as a Fire API v1 module for the `webgpu` backend (three.js
// WebGPURenderer, TSL): a port of modules/classic, part for part, with the same knobs (imported from classic, never
// copied) and the same CPU code where the work is on the CPU (the jet's and the steam's particles, the columns' sparks,
// the op → splat mapping are classic's own classes and functions). Fills `ground`, `lance`, or both, like classic.
//   import { info, create } from 'firewraith/modules/classic-webgpu';
//   const m = await create(host);            // host: docs/API.md (host.world.groundTSL: the terrain in TSL)
//   each frame: m.events(list, wind); m.update(dt, { rain, time }); m.lance(state); m.render(renderer, { colorTex, depthTex, camera, target, width, height })
// What differs from classic: README.md here.
import { Vector3, RenderTarget, DepthTexture, HalfFloatType, UnsignedIntType, PerspectiveCamera } from 'three/webgpu';
import { FIRE_OP } from '../../src/api/events.js';
import { createGridReadback, sampleGrid, makeNoiseTexture, makeNoise3, depthNodes, Quad } from '../../src/kit/webgpu/index.js';
import { TIER } from '../classic/index.js';
import { KNOBS, DEPOSIT, RES, LIGHT_COLS } from '../classic/solver.js';
import { setWorld, W } from './world.js';
import { FluidSolverGPU } from './solver.js';
import { VolumePassGPU, LOOK } from './volume.js';
import { EmbersGPU } from './embers.js';
import { JetGPU, JET, jetLanding } from './jet.js';
import { SteamGPU, STEAM } from './steam.js';
import { ColumnsGPU, COLUMN_PRESETS, COLUMN_RAMPS } from './column.js';
import { info } from './info.js';

export { info, KNOBS, DEPOSIT, LOOK, JET, RES, STEAM, COLUMN_PRESETS, COLUMN_RAMPS, jetLanding };

const FIRE_LIGHT_COLOR = LIGHT_COLS[0];   // orange
const MAX_EMBERS = Math.max(...Object.values(TIER).map((t) => t.embers));

/**
 * @param {import('../../src/api/index.js').Host} host
 * @returns {Promise<import('../../src/api/index.js').FireModule & Record<string, any>>}
 */
export async function create(host) {
  const renderer = host.renderer;
  if (!renderer?.isWebGPURenderer) throw new Error('classic-webgpu: needs three.js WebGPURenderer (the webgpu edition); use classic with WebGLRenderer');
  if (renderer.backend && !renderer.backend.isWebGPUBackend) throw new Error('classic-webgpu: the WebGPURenderer runs on its WebGL2 fallback backend (no WebGPU here); use classic');
  const slots = host.slots?.length ? host.slots : info.slots;
  const G = slots.includes('ground'), L = slots.includes('lance');
  let quality = host.quality in TIER ? host.quality : 'high';
  let style = host.style === 'hybrid' ? 'hybrid' : 'smooth';
  setWorld(host.world);
  JET.speed = W.lance.speed; JET.gravity = W.lance.gravity;   // the visual flies the game's arc

  const noise = makeNoiseTexture();
  const noise3 = makeNoise3(noise);
  const depth = depthNodes(new DepthTexture(1, 1));   // one camera/depth pair for every part (set once a frame)
  const solver = G ? new FluidSolverGPU(renderer, quality, { noise3 }) : null;
  const quad = solver ? solver.quad : new Quad();
  const volume = new VolumePassGPU(renderer, { quad, noise3, depth });
  const embers = G ? new EmbersGPU(renderer, { noise3, depth, max: MAX_EMBERS }) : null;
  const jetFx = L ? new JetGPU(renderer, { noise3, depth }) : null;
  const steam = G ? new SteamGPU(renderer, { noise3, depth }) : null;
  const columns = G ? new ColumnsGPU(renderer, { noise3, depth }) : null;   // the ending's pillar and the demon's fire

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

  /** The fire light at a point, from the read-back (the CPU twin of the light map; classic's lightAt). */
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
        const h0 = hueGrid[k] / 255, h1 = hueGrid[k + 1] / 255, h2 = hueGrid[k + 2] / 255, h3 = hueGrid[k + 3] / 255, ho = Math.max(0, 1 - h0 - h1 - h2 - h3);
        for (let c = 0; c < 3; c++) {
          const col = LIGHT_COLS[0][c] * ho + LIGHT_COLS[1][c] * h0 + LIGHT_COLS[2][c] * h1 + LIGHT_COLS[3][c] * h2 + LIGHT_COLS[4][c] * h3;
          if (c === 0) cr += w * col; else if (c === 1) cg += w * col; else cb += w * col;
        }
      }
    }
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
    /** Frames since the landed grid was issued (it holds its last state until the next read lands). */
    get ageFrames() { return rb.landed < 0 ? -1 : S.frame - rb.landed; },
  } : undefined;

  const time = () => (solver ? solver.time : S.time);
  const camPos = new Vector3();
  const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

  /** Composite the fire + smoke volume, the jet, the embers, the steam and the columns over `colorTex` into `target`. */
  function render(r, { colorTex, depthTex, camera, target = null, width, height }) {
    if (S.disposed) return;
    const t0 = performance.now();
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    camera.updateMatrixWorld();
    S.camera = camera;
    if (G) {
      // is the eye standing in fire? From the read-back and the eye's height above the ground; eased so it never pops
      camPos.setFromMatrixPosition(camera.matrixWorld);
      let f = 0;
      if (S.ready) for (let dz = -1.2; dz <= 1.21; dz += 1.2) for (let dx = -1.2; dx <= 1.21; dx += 1.2) f = Math.max(f, fire.fire(camPos.x + dx, camPos.z + dz) * (dx || dz ? 0.7 : 1));
      const want = smooth(0.03, 0.3, f) * (1 - smooth(2.4, 3.5, camPos.y - W.groundHeight(camPos.x, camPos.z)));
      const now = performance.now(), dtc = Math.min(0.1, (now - (S.camT || now)) / 1000); S.camT = now;
      S.camFire += (want - S.camFire) * Math.min(1, dtc * 6 + (S.camFireInit ? 0 : 1)); S.camFireInit = true;
      volume.setCamFire(S.camFire);
    }
    volume.setCamera(camera, depthTex);
    if (S.preKey !== width + 'x' + height) { S.preKey = width + 'x' + height; volume.prealloc(width, height); }
    const sk = api.debug.skip;
    // hue reads only while coloured fire can be alive (≤ 40 s after the last hued op or a hued jet)
    volume.setHue(time() - S.hueT < 40 || (jetFx && jetFx.alive > 0 && (jetFx.cmd.hue || jetFx.streamHue || 'orange') !== 'orange'));
    if (G && S.enabled && !sk.march) volume.march(solver, { width, height, time: solver.time });
    else volume.clear(width, height);
    if (jetFx && S.enabled && !sk.jet) jetFx.render(volume.rt, camera);
    volume.composite(colorTex, target, width, height);
    if (G && S.enabled && !sk.embers) embers.render(target, camera, width, height, volume.pixelSize(height));
    if (G && S.enabled) steam.render(target, camera, width, height, volume.pixelSize(height));
    if (G && S.enabled && (columns.count || columns.sp.n)) { const tc = performance.now(); columns.render(target, camera, width, height, volume.pixelSize(height)); S.colMs = performance.now() - tc; }
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
    S.renderMs = performance.now() - t0;
  }

  /** WebGPU builds a pipeline at its first draw: draw one small frame through every pass and variant (both styles, the
   *  hue and in-fire marches, the jet, the embers, the steam, the columns and their sparks) into throwaway targets that
   *  match the game's (a half-float colour + a 32-bit depth texture). */
  function warmDraws(r, camera) {
    if (S.disposed) return;
    const Wd = 192, Hd = 108, keep = S.style, prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    const mk = () => { const t = new RenderTarget(Wd, Hd, { type: HalfFloatType, depthBuffer: true, generateMipmaps: false }); t.depthTexture = new DepthTexture(Wd, Hd); t.depthTexture.type = UnsignedIntType; return t; };
    const sceneT = mk(), outT = mk();
    const keepHue = volume.hueOn, keepFire = volume.camFire || 0, jetN = jetFx?.mesh.geometry.instanceCount ?? 0, steamN = steam?.mesh.geometry.instanceCount ?? 0;
    r.autoClear = false;
    try {
      camera.updateMatrixWorld();
      r.setRenderTarget(sceneT); r.clear(true, true, false);
      r.setRenderTarget(outT); r.clear(true, true, false);
      for (const st of ['smooth', 'hybrid']) {
        volume.setStyle(st); embers?.setStyle(st); steam?.setStyle(st);
        for (const [hue, inf] of [[false, false], [true, false], [false, true], [true, true]]) {
          volume.setHue(hue); volume.setCamFire(inf ? 0.5 : 0);
          volume.setCamera(camera, sceneT.depthTexture);
          if (G) volume.march(solver, { width: Wd, height: Hd, time: solver.time }); else volume.clear(Wd, Hd);
          if (jetFx && !hue && !inf) { jetFx.mesh.geometry.instanceCount = 1; r.setRenderTarget(volume.rt); r.render(jetFx.mesh, camera); }   // a zero-size puff
          volume.composite(sceneT.texture, outT, Wd, Hd);
        }
        if (G) {
          embers.render(outT, camera, Wd, Hd, volume.pixelSize(Hd));
          steam.mesh.geometry.instanceCount = 1; r.setRenderTarget(outT); r.render(steam.mesh, camera);
          columns.set('__warm', { preset: 'pillar', x: 0, y: 0, z: 0, intensity: 1 }); columns.setStyle(st);
          columns.sp.n = 1; columns.sparks.geometry.instanceCount = 1;
          columns.render(outT, camera, Wd, Hd, volume.pixelSize(Hd));
          columns.set('__warm', null); columns.sp.n = 0; columns.sparks.geometry.instanceCount = 0;
        }
      }
    } finally {
      if (jetFx) jetFx.mesh.geometry.instanceCount = jetN;
      if (steam) steam.mesh.geometry.instanceCount = steamN;
      volume.setStyle(keep); embers?.setStyle(keep); steam?.setStyle(keep); columns?.setStyle(keep); volume.setHue(keepHue); volume.setCamFire(keepFire);
      volume.dropSize(Wd, Hd);
      for (const t of [sceneT, outT]) { t.depthTexture.dispose(); t.dispose(); }
      r.autoClear = prevAuto; r.setRenderTarget(prevRT);
    }
  }

  function step(dt) {
    if (S.disposed) return;
    const t0 = performance.now();
    S.frame++;
    // the grid that landed since the last frame (the read never waits)
    if (rb && !api.debug.skip.readback && rb.poll(S.frame)) { S.ready = true; fire.ready = true; }
    let n = 0;
    if (G) {
      solver.lightSplats = columns.count ? columns.lights() : [];   // the columns light the world (the light map)
      n = S.enabled ? solver.step(api.debug.lockStep ? 1 / solver.cfg.hz : dt) : 0;
    } else S.time += Math.max(0, dt);
    if (S.enabled) {
      if (G) embers.update(solver, Math.min(dt, 0.05));
      jetFx?.update(dt);
      if (G) { steam.update(dt); columns.update(dt); }
    }
    if (rb && !api.debug.skip.readback && n) rb.kick(S.frame);   // (after the sim: the grid read is this frame's)
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
          // steam where fire was (the read-back grid); while the grid is stale a bucket-sized douse still puffs a little
          const r = op.r ?? 2, fresh = S.ready && S.frame - rb.landed <= 30;
          const seg = op.x0 != null ? { x0: op.x0, z0: op.z0, x1: op.x1 ?? op.x0, z1: op.z1 ?? op.z0 } : null;   // a tide line
          const cx = seg ? (seg.x0 + seg.x1) / 2 : op.x, cz = seg ? (seg.z0 + seg.z1) / 2 : op.z;
          if (fresh) steam.douse(cx, cz, r, fire.heat, wind, seg ? 4 : undefined, seg);
          else if (r <= 4 && !seg) steam.douse(cx, cz, r, () => 0.25, wind, 8);
        }
      }
    },
    /** lance: the Ember Lance this frame ({ on, origin, dir, range, t, hue }). */
    lance(s) { if (jetFx && s) jetFx.set(s); },
    /** Advance by game seconds; the solver sub-steps at its fixed rate (60 Hz; 30 Hz on low), ≤ 3 sub-steps a frame. */
    update(dt, ctx = {}) {
      if (G && ctx.rain != null) solver.rain = Math.max(0, Math.min(1, +ctx.rain || 0));
      step(dt);
    },
    render,
    fire,
    /** ground: the light map over the fire area (RGB = fire light colour × strength, linear; half float, filterable). */
    get lightMap() { return G ? solver.lightRT.texture : null; },
    /** The fire light at a point (the first-person hands); false while no grid has landed. */
    nearLight(x, y, z, out) { if (!G || !S.ready) return false; lightAt(x, y, z, out); return true; },
    /** Extra: the ending's fire columns (classic's API). */
    columns: G ? { set: (id, cfg) => columns.set(id, cfg), clear: () => columns.reset(), get: (id) => columns.map.get(id)?.p ?? null } : undefined,
    setStyle(s) { S.style = s === 'hybrid' ? 'hybrid' : 'smooth'; volume.setStyle(S.style); embers?.setStyle(S.style); steam?.setStyle(S.style); columns?.setStyle(S.style); },
    setQuality(q) { if (!(q in TIER)) return; S.quality = q; solver?.setQuality(q); applyTier(q); },
    stats() {
      const c = solver?.cfg;
      return {
        module: info.id, slots: [...slots], backend: 'webgpu',
        simMs: +S.simMs.toFixed(3), renderMs: +S.renderMs.toFixed(3),
        res: { vel: c?.vel ?? 0, scalars: c?.sca ?? 0, volume: [volume.w, volume.h], embers: embers?.count ?? 0, jacobi: solver?.lastJacobi ?? 0, hz: c?.hz ?? 0 },
        steps: solver?.stepsLast ?? 0, readbackAgeFrames: rb && rb.landed >= 0 ? S.frame - rb.landed : -1,
        gpuSimMs: null, gpuRenderMs: null,
        style: S.style, quality: S.quality, camFire: +S.camFire.toFixed(2), jetParticles: jetFx?.alive ?? 0, steamPuffs: steam?.alive ?? 0, rain: solver?.rain ?? 0, columns: columns?.count ?? 0, sparks: columns?.sp.n ?? 0, columnMs: +S.colMs.toFixed(3),
        readbackMaxMs: rb ? rb.stats(S.frame) : null,
      };
    },
    /** Build every pipeline (both styles, every variant) behind the loading cover, and run one sub-step. */
    async warm(r = renderer, cam) {
      step(1 / 60);
      warmDraws(r, cam || new PerspectiveCamera());
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
      look: LOOK, rbReset() { rb?.resetStats(); }, grid, solver, volume, embers, jet: jetFx, steam, columns, get camera() { return S.camera; }, groundTSL: typeof host.world?.groundTSL === 'function',
      reset: () => api.reset(), setEnabled(on) { S.enabled = !!on; }, setGpuTiming() { return false; },
    },
    dispose() {
      if (S.disposed) return;
      S.disposed = true;
      rb?.dispose();
      solver?.dispose(); volume.dispose(); embers?.dispose(); jetFx?.dispose(); steam?.dispose(); columns?.dispose(); noise.dispose();
    },
  };
  // ?rbmode=off (perf experiments only): no read-back
  { const m = typeof window !== 'undefined' && /[?&]rbmode=([a-z0-9,]+)/.exec(window.location?.search || ''); if (m) for (const k of m[1].split(',')) if (k === 'off') api.debug.skip.readback = true; }
  return api;
}
