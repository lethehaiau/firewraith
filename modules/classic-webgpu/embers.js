// FIREWRAITH · classic-webgpu · embers: classic's embers.js on WebGPU. The state (xyz world, w = seconds left + 8 × hue
// index) lives in a storage buffer and is updated by one compute dispatch a frame (classic: a fragment pass over a 128-wide
// float texture; here the same per-slot code, with the slot's id = the texel centre it would have had, so the same seeds
// spawn the same way). Drawn as instanced quads read straight from the buffer (WebGPU points are one pixel wide): soft
// dots in `smooth`, squares on the fire-pixel grid in `hybrid`; additive, with a manual depth test against the scene.
import { Mesh, Vector2, Vector3, Vector4, CustomBlending, AddEquation, OneFactor } from 'three/webgpu';
import {
  Fn, instancedArray, instanceIndex, uniform, uniformArray, vec2, vec3, vec4, float, int, uint, If, Return, Discard, select,
  min, max, clamp, mix, smoothstep, step, dot, exp, floor, fract, varying, positionGeometry, cameraViewMatrix, cameraProjectionMatrix,
  screenCoordinate,
} from 'three/tsl';
import { EMBER_SMOOTH, EMBER_HYBRID } from '../classic/embers.js';
import { W, ground } from './world.js';
import { instancedQuad, texNode } from '../../src/kit/webgpu/index.js';
import { pointSprite, spriteMaterial } from './points.js';

const WIDTH = 128;   // classic's state texture is 128 texels wide: a slot's id is its texel centre there

/** hash12: "Hash without Sine" (c) 2014 David Hoskins, MIT (THIRD-PARTY-NOTICES.md), as classic's. @param {any} p vec2 */
const hash12 = (p) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};

export class EmbersGPU {
  /** @param {any} renderer @param {{ noise3: any, depth: any, max: number }} o */
  constructor(renderer, { noise3, depth, max: maxCount }) {
    this.renderer = renderer; this.D = depth; this.noise3 = noise3;
    this.max = Math.ceil(maxCount / WIDTH) * WIDTH;
    this.seed = 0; this.time = 0; this.count = 0; this.style = 'smooth';
    this.buf = instancedArray(this.max, 'vec4');
    this.u = {
      rect4: uniform(new Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size)),
      dt: uniform(0), time: uniform(0), seed: uniform(0), spawn: uniform(2.2), count: uniform(0, 'uint'),
      res: uniform(new Vector2(1, 1)), pix: uniform(4), pxScale: uniform(500),
      embS: uniformArray(EMBER_SMOOTH.flat().map((c) => new Vector3(...c)), 'vec3'), embH: uniformArray(EMBER_HYBRID.flat().map((c) => new Vector3(...c)), 'vec3'),
    };
    this.T = { S: texNode(), H: texNode(), vel: texNode() };
    this.drawCache = new Map();
    this.mesh = new Mesh(instancedQuad(), null);
    this.mesh.frustumCulled = false;
  }

  /** The compute nodes (built at the first update, when the field textures exist). */
  _buildCompute() {
    if (this.updNode) return;
    const { u, T, noise3, buf } = this;
    const rect = u.rect4;
    this.updNode = Fn(() => {
      If(instanceIndex.greaterThanEqual(u.count), () => { Return(); });
      const slot = buf.element(instanceIndex);
      const st = vec4(slot).toVar();
      const id = vec2(float(instanceIndex.mod(uint(WIDTH))).add(0.5), float(instanceIndex.div(uint(WIDTH))).add(0.5)).toVar();
      If(st.w.greaterThan(0.0), () => {
        const hueI = floor(st.w.div(8.0)).toVar();
        const life = st.w.sub(hueI.mul(8.0)).toVar();
        const uvf = st.xz.sub(rect.xy).div(rect.zw).toVar();
        const v = T.vel.sample(uvf).xy.toVar();
        const h = st.y.sub(ground(st.xz)).toVar();
        const rise = hash12(id.add(3.1)).mul(1.7).add(0.7).toVar();
        const tx = noise3(vec3(st.x.mul(0.8), st.z.mul(0.8), u.time.mul(0.9).add(id.x.mul(0.01)))).sub(0.5).toVar();
        const tz = noise3(vec3(st.z.mul(0.8).add(9.0), st.x.mul(0.8), u.time.mul(0.9).add(id.y.mul(0.01)))).sub(0.5).toVar();
        const vel = vec3(v.x.mul(0.9).add(tx.mul(2.6)), rise.mul(float(1.0).sub(smoothstep(3.0, 9.0, h).mul(0.6))), v.y.mul(0.9).add(tz.mul(2.6)));
        const pos = st.xyz.add(vel.mul(u.dt)).toVar();
        life.subAssign(u.dt);
        const dead = uvf.x.lessThan(0.0).or(uvf.y.lessThan(0.0)).or(uvf.x.greaterThan(1.0)).or(uvf.y.greaterThan(1.0)).or(life.lessThanEqual(0.0));
        st.assign(vec4(pos, select(dead, float(-1.0), life.add(hueI.mul(8.0)))));
      }).Else(() => {
        const r = vec2(hash12(id.add(u.seed.mul(1.31))), hash12(id.yx.mul(1.7).add(u.seed.mul(2.17)).add(4.3))).toVar();
        const s = T.S.sample(r).toVar();
        const p = clamp(s.g.sub(0.08), 0.0, 2.0).mul(u.spawn).mul(u.dt);
        If(hash12(id.mul(1.37).add(u.seed.mul(2.93))).lessThan(p), () => {
          const xz = rect.xy.add(r.mul(rect.zw)).toVar();
          const life = hash12(id.add(u.seed.mul(0.37))).mul(2.6).add(0.8).toVar();
          // the hue of the fire it rises from: pick one of the cell's hues by its share
          const fr = clamp(max(T.H.sample(r), 0.0).div(max(s.g, 0.02)), 0.0, 1.0).toVar();
          fr.divAssign(max(1.0, dot(fr, vec4(1.0))));
          const uh = hash12(id.mul(2.11).add(u.seed.mul(3.7)).add(1.9)).toVar();
          const hueI = float(0.0).toVar(), c = float(1.0).sub(dot(fr, vec4(1.0))).toVar();
          If(uh.greaterThanEqual(c), () => {
            hueI.assign(1.0); c.addAssign(fr.x);
            If(uh.greaterThanEqual(c), () => {
              hueI.assign(2.0); c.addAssign(fr.y);
              If(uh.greaterThanEqual(c), () => { hueI.assign(3.0); c.addAssign(fr.z); If(uh.greaterThanEqual(c), () => { hueI.assign(4.0); }); });
            });
          });
          st.assign(vec4(xz.x, ground(xz).add(0.1).add(hash12(id.add(u.seed.mul(5.1))).mul(1.3).mul(min(s.g, 1.0))), xz.y, life.add(hueI.mul(8.0))));
        }).Else(() => { st.assign(vec4(0.0, -100.0, 0.0, -1.0)); });
      });
      slot.assign(st);
    })().compute(this.max, [64]);
  }

  _buildDraw() {
    if (this.drawCache.has(this.style)) { this.mesh.material = this.drawCache.get(this.style); return; }
    const hybrid = this.style === 'hybrid', { u, D } = this;
    const st = this.buf.element(instanceIndex);
    const sv = vec4(st);
    const hueV = select(sv.w.greaterThan(0.0), floor(sv.w.div(8.0)), float(0.0));
    const life = sv.w.sub(hueV.mul(8.0));
    const vertex = Fn(() => pointSprite({
      world: sv.xyz, alive: sv.w.greaterThan(0.0), hybrid, res: u.res, pix: u.pix,
      size: (viewZ) => (hybrid ? select(viewZ.lessThan(18.0), u.pix, max(1.0, floor(u.pix.mul(0.5)))) : clamp(u.pxScale.mul(0.06).div(max(viewZ, 0.1)), 1.4, 5.0)),
    }).clip)();
    const viewZ = cameraViewMatrix.mul(vec4(sv.xyz, 1.0)).z.negate();
    const vLife = varying(life, 'vLife'), vViewZ = varying(viewZ, 'vViewZ'), vHue = varying(hueV, 'vHue');
    const frag = Fn(() => {
      Discard(vLife.lessThanEqual(0.0));
      const sceneZ = D.viewDepthAt(screenCoordinate.xy.div(u.res));
      Discard(vViewZ.greaterThan(sceneZ.add(0.05)));
      const heat = clamp(vLife.div(2.2), 0.0, 1.0).toVar();
      const fade = smoothstep(0.0, 0.35, vLife).mul(smoothstep(0.4, 1.6, vViewZ)).toVar();
      if (hybrid) {
        const h = int(vHue.add(0.5)).mul(int(3)).toVar();
        const col = select(heat.greaterThan(0.55), u.embH.element(h).mul(3.0), select(heat.greaterThan(0.25), u.embH.element(h.add(int(1))).mul(2.2), u.embH.element(h.add(int(2))).mul(1.6)));
        return vec4(col.mul(step(0.3, fade)), 1.0);
      }
      const c = positionGeometry.xy;
      const a = exp(dot(c, c).mul(-2.6));
      const h = int(vHue.add(0.5)).mul(int(2)).toVar();
      const col = mix(u.embS.element(h), u.embS.element(h.add(int(1))), heat).mul(heat.mul(3.2).add(0.9));
      return vec4(col.mul(a).mul(fade), 1.0);
    })();
    const m = spriteMaterial('fw-embers-' + this.style, vertex, frag, { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor });
    this.drawCache.set(this.style, m);
    this.mesh.material = m;
  }

  get drawMat() { return this.mesh.material; }
  setStyle(s) { if (s !== this.style || !this.mesh.material) { this.style = s; this._buildDraw(); } }

  /** @param {number} n particles (rounded to whole 128-wide rows, like classic's texture) */
  setCount(n) {
    const count = Math.min(this.max, WIDTH * Math.max(1, Math.ceil(n / WIDTH)));
    if (this.count === count) return;
    this.count = count;
    this.u.count.value = count;
    this.mesh.geometry.instanceCount = count;
    this.reset();
  }

  /** Kill every ember (a fresh night). */
  reset() {
    this.clearNode ||= Fn(() => { this.buf.element(instanceIndex).assign(vec4(0.0)); })().compute(this.max, [64]);
    this.renderer.compute(this.clearNode);
  }

  update(solver, dt) {
    if (!this.count || dt <= 0) return;
    this.time += dt; this.seed = (this.seed + 1) % 4096;
    const u = this.u;
    this.T.S.value = solver.S.read.textures[0]; this.T.H.value = solver.S.read.textures[1]; this.T.vel.value = solver.V.read.texture;
    u.dt.value = Math.min(dt, 0.05); u.time.value = this.time; u.seed.value = this.seed * 0.731;
    // spawn rate per unit fire per dead slot, scaled so a smaller pool still shows a similar ember density (classic's)
    u.spawn.value = 0.45 * 16384 / this.count;
    this._buildCompute();
    this.renderer.compute(this.updNode);
  }

  render(target, camera, width, height, pix) {
    if (!this.count) return;
    const u = this.u;
    u.res.value.set(width, height); u.pix.value = pix;
    u.pxScale.value = camera.projectionMatrix.elements[5] * height * 0.5;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.mesh, camera);
  }

  dispose() { this.mesh.geometry.dispose(); for (const m of this.drawCache.values()) m.dispose(); }
}
