// FIREWRAITH · classic-webgpu · fire columns (the ending's black-red pillar and the demon's fire). classic's `Columns`
// keeps doing the CPU work here, subclassed: set()/clear(), the presets (COLUMN_PRESETS), the uniforms each column gets,
// the sparks' emission and motion, the columns' light for the light map. New here: the column material (a 30-step march
// of value noise rising and twisting in a cylinder, inside a box drawn back-faces only, depth-tested by hand) and the
// sparks as instanced point sprites.
import {
  Vector2, Vector3, Mesh, InstancedBufferAttribute, DynamicDrawUsage, BackSide, CustomBlending, AddEquation, OneFactor,
  ZeroFactor, OneMinusSrcAlphaFactor,
} from 'three/webgpu';
import {
  Fn, uniform, uniformArray, attribute, vec2, vec3, vec4, float, int, If, Loop, Break, Discard, select, min, max, clamp, mix,
  smoothstep, step, abs, dot, exp, length, normalize, floor, mod, cos, sin, atan, varying, screenCoordinate, positionGeometry,
  cameraViewMatrix,
} from 'three/tsl';
import { Columns, COLUMN_PRESETS, COLUMN_RAMPS, MAX_STEPS } from '../classic/column.js';
import { bayer4 } from './volume.js';
import { pointSprite, spriteMaterial } from './points.js';
import { instancedQuad } from '../../src/kit/webgpu/index.js';

export { COLUMN_PRESETS, COLUMN_RAMPS };

export class ColumnsGPU extends Columns {
  /** @param {any} renderer @param {{ noise3: any, depth: any }} o */
  constructor(renderer, { noise3, depth }) {
    super(renderer, { noise: null, depthU: {} });
    this.D = depth; this.noise3 = noise3;
    // the TSL twins of classic's shared uniforms (classic's render() writes these names)
    this.shared = { uRes: uniform(new Vector2(1, 1)), uPix: uniform(4), uTime: uniform(0), uCamPos: uniform(new Vector3()) };
    this.rampArr = uniformArray(this.rampU.value.map((v) => v.clone()), 'vec3');   // classic's linear COLUMN_RAMPS
    // sparks: classic's emitter and integrator fill `sparkAttr` (xyz, heat); here it feeds instanced point sprites
    const max_ = this.sp.age.length;
    this.scene.remove(this.sparks); this.sparks.geometry.dispose();
    for (const m of Object.values(this.sparkMats)) m.dispose();
    this.sparkAttr = new InstancedBufferAttribute(new Float32Array(max_ * 4), 4).setUsage(DynamicDrawUsage);
    const sg = instancedQuad();
    sg.setAttribute('aS', this.sparkAttr);
    this.sparkU = { uRes: this.shared.uRes, uPix: this.shared.uPix, uPxScale: uniform(500), uHot: uniform(this.sparkU.uHot.value.clone()), uCool: uniform(this.sparkU.uCool.value.clone()) };
    this.sparkMats = { smooth: this._sparkMaterial(false), hybrid: this._sparkMaterial(true) };
    this.sparks = new Mesh(sg, this.sparkMats[this.style]); this.sparks.frustumCulled = false;
    this.scene.add(this.sparks);
  }

  _sparkMaterial(hybrid) {
    const U = this.sparkU, D = this.D;
    const aS = attribute('aS', 'vec4');   // xyz, heat 0..1 (0 = dead)
    const vertex = Fn(() => pointSprite({
      world: aS.xyz, alive: aS.w.greaterThan(0.0), hybrid, res: U.uRes, pix: U.uPix,
      size: (viewZ) => (hybrid ? select(viewZ.lessThan(25.0), U.uPix, max(1.0, floor(U.uPix.mul(0.5)))) : clamp(U.uPxScale.mul(0.09).div(max(viewZ, 0.1)), 1.5, 6.0)),
    }).clip)();
    const vViewZ = varying(cameraViewMatrix.mul(vec4(aS.xyz, 1.0)).z.negate(), 'vViewZ');
    const frag = Fn(() => {
      const vHeat = aS.w;
      Discard(vHeat.lessThanEqual(0.0));
      Discard(vViewZ.greaterThan(D.viewDepthAt(screenCoordinate.xy.div(U.uRes)).add(0.05)));
      if (hybrid) return vec4(select(vHeat.greaterThan(0.55), U.uHot.mul(3.0), U.uCool.mul(2.0)), 1.0);
      const c = positionGeometry.xy;
      return vec4(mix(U.uCool, U.uHot, vHeat).mul(vHeat.mul(3.0).add(0.8)).mul(exp(dot(c, c).mul(-2.6))), 1.0);
    })();
    return spriteMaterial('fw-sparks-' + (hybrid ? 'hybrid' : 'smooth'), vertex, frag,
      { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor });
  }

  /** A column's material: classic's FRAG in TSL, its per-column uniforms under classic's names (classic's _apply sets them). */
  _material(style) {
    const hybrid = style === 'hybrid', S = this.shared, D = this.D, noise3 = this.noise3, ramp = this.rampArr;
    const u = {
      uBase: uniform(new Vector3()), uR: uniform(1), uH: uniform(1), uFlare: uniform(0), uShell: uniform(0), uTwist: uniform(0), uSpin: uniform(0),
      uRise: uniform(0), uFreq: uniform(1), uGain: uniform(1), uBright: uniform(1), uIntensity: uniform(1), uRampOff: uniform(0),
    };
    const rampAt = (x) => {
      const k = clamp(x, 0.0, 1.0).mul(5.0).toVar();
      const i = min(floor(k), 4.0).toVar();
      const idx = int(u.uRampOff).add(int(i)).toVar();
      return mix(ramp.element(idx), ramp.element(idx.add(int(1))), k.sub(i));
    };
    const frag = Fn(() => {
      const fc = (hybrid ? floor(screenCoordinate.xy.div(S.uPix)).add(0.5).mul(S.uPix) : screenCoordinate.xy).toVar();   // hybrid: one ray per fire pixel
      const { raw, pos: wp } = D.worldAt(fc.div(S.uRes));
      const ro = S.uCamPos, rd = normalize(wp.sub(ro)).toVar();
      const tScene = select(raw.greaterThanEqual(0.99999), float(1e5), length(wp.sub(ro))).toVar();
      // the column's bounding cylinder (as a box) in world space
      const Rm = u.uR.mul(max(1.0, u.uFlare.add(1.0))).mul(1.25).toVar();
      const bmin = u.uBase.sub(vec3(Rm, 0.0, Rm)), bmax = u.uBase.add(vec3(Rm, u.uH, Rm));
      const inv = vec3(1.0).div(rd.add(vec3(1e-6))).toVar();
      const t0 = bmin.sub(ro).mul(inv).toVar(), t1 = bmax.sub(ro).mul(inv).toVar();
      const tmn = min(t0, t1).toVar(), tmx = max(t0, t1).toVar();
      const tIn = max(max(tmn.x, tmn.y), max(tmn.z, 0.1)).toVar(), tOut = min(min(tmx.x, tmx.y), min(tmx.z, tScene)).toVar();
      Discard(tIn.greaterThanEqual(tOut));
      const dt = tOut.sub(tIn).div(MAX_STEPS).toVar();
      const jit = noise3.tex.sample(mod(floor(fc), 256.0).add(0.5).div(256.0)).b.toVar();
      const T = float(1.0).toVar(), cov = float(0.0).toVar(), tsum = float(0.0).toVar(), col = vec3(0.0).toVar();
      const toCam = ro.sub(u.uBase).toVar();
      const camDir = normalize(toCam.xz.add(1e-4)).toVar();
      Loop(MAX_STEPS, ({ i }) => {
        const p = ro.add(rd.mul(tIn.add(float(i).add(jit).mul(dt)))).sub(u.uBase).toVar();
        // density and temperature at p (classic fireAt)
        const y = p.y.div(u.uH).toVar();
        const R = u.uR.mul(u.uFlare.mul(y).add(1.0)).mul(mix(0.45, 1.0, smoothstep(0.0, 0.1, y))).toVar();   // erupts narrow, then swells
        const rho = length(p.xz).toVar();
        const th = atan(p.z, p.x).add(y.mul(u.uTwist).mul(6.2831)).add(S.uTime.mul(u.uSpin)).toVar();
        const q = vec3(cos(th).mul(rho), sin(th).mul(rho), p.y.sub(S.uTime.mul(u.uRise))).mul(u.uFreq).toVar();
        const n = noise3(q).mul(0.62).add(noise3(q.mul(2.3).add(11.0)).mul(0.38)).toVar();
        const fade = smoothstep(0.0, 0.025, y).mul(float(1.0).sub(smoothstep(0.8, 1.0, y)));
        const d = float(0.0).toVar(), temp = float(0.0).toVar();
        If(u.uShell.lessThan(0.5), () => {   // the pillar: a solid twisting column, white-hot heart, black ragged rim
          const e = rho.div(R).add(n.sub(0.5).mul(1.1)).toVar();
          d.assign(float(1.0).sub(smoothstep(0.15, 1.05, e)).mul(float(1.0).sub(smoothstep(0.0, 0.7, e)).mul(0.65).add(0.35)));
          temp.assign(clamp(float(1.12).sub(e.mul(1.35)).add(n.sub(0.5).mul(0.45)), 0.0, 1.0).mul(float(1.0).sub(y.mul(0.3))));
        }).Else(() => {   // the demon's fire frames the figure: tongues behind it and at its sides, a low ring at its feet
          const e = abs(rho.sub(R)).div(R.mul(0.6)).add(n.sub(0.5).mul(1.1)).toVar();
          const thr = y.mul(0.36).add(0.24).toVar();
          d.assign(float(1.0).sub(smoothstep(0.3, 1.0, e)).mul(smoothstep(thr, thr.add(0.12), n)));
          const rdir = select(rho.greaterThan(1e-3), p.xz.div(rho), vec2(0.0));
          const facing = dot(rdir, camDir);
          const keep = max(float(1.0).sub(smoothstep(0.05, 0.45, facing)), float(1.0).sub(smoothstep(0.03, 0.11, y)).mul(0.45));
          d.mulAssign(keep);
          temp.assign(clamp(float(0.18).add(float(1.0).sub(y).mul(0.62).mul(smoothstep(thr, thr.add(0.35), n))), 0.0, 1.0).mul(mix(0.75, 1.0, smoothstep(0.0, 0.2, y))));
        });
        const inside = y.greaterThanEqual(0.0).and(y.lessThanEqual(1.0));
        const fx = select(inside, d.mul(fade), float(0.0)).toVar();
        If(fx.greaterThan(0.001), () => {
          const a = float(1.0).sub(exp(fx.mul(u.uGain).mul(u.uIntensity).mul(dt).negate())).toVar();
          cov.addAssign(T.mul(a)); tsum.addAssign(T.mul(a).mul(temp));
          if (!hybrid) col.addAssign(rampAt(temp).mul(T.mul(a)).mul(u.uBright.sub(1.0).mul(smoothstep(0.5, 1.0, temp)).add(1.0)));   // the heart glows through the rim
          T.mulAssign(float(1.0).sub(a));
          If(T.lessThan(0.02), () => { Break(); });
        });
      });
      Discard(cov.lessThan(0.002));
      if (hybrid) {
        const temp = tsum.div(cov).toVar();
        const b = bayer4(floor(fc.div(S.uPix))).sub(0.5).toVar();
        const lv = clamp(floor(temp.mul(6.0).add(b.mul(0.6))), 0.0, 5.0).toVar();
        const on = step(b.mul(0.35).add(0.45), cov).toVar();
        const c = rampAt(lv.div(5.0)).mul(select(lv.greaterThan(4.5), u.uBright.sub(1.0).mul(0.25).add(1.0), float(1.0)));
        return vec4(c.mul(on), on);
      }
      return vec4(col, cov);   // premultiplied: black edges darken what is behind
    })();
    const m = spriteMaterial('fw-column-' + style, null, frag, {
      side: BackSide,   // drawn from inside the box too (a close camera)
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
    });
    m.uniforms = u;
    return m;
  }

  /** classic's update (emission, motion, the spark attribute), then the sprite count. */
  update(dt) {
    super.update(dt);
    this.sparks.geometry.setDrawRange(0, Infinity);   // (classic's draw range counts points; here it is instances)
    this.sparks.geometry.instanceCount = this.sp.n;
  }

  reset() {
    super.reset();
    this.sparks.geometry.setDrawRange(0, Infinity);
    this.sparks.geometry.instanceCount = 0;
  }
}
