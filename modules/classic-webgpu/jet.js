// FIREWRAITH · classic-webgpu · the Ember Lance's airborne jet. The particles are classic's own CPU code (`Jet`: the
// ballistic arc, the births, the skid, the upload into its instanced attributes), subclassed; only the material is new:
// noisy billboards drawn into the volume target's two outputs (fire coverage/temperature + the Lance's hue mass) with a
// soft depth test, premultiplied "over" (classic's FRAG and blending).
import { Vector2, Vector4, CustomBlending, AddEquation, OneFactor, ZeroFactor, OneMinusSrcAlphaFactor } from 'three/webgpu';
import { Fn, uniform, attribute, vec2, vec4, float, Discard, clamp, mix, smoothstep, length, varying, screenCoordinate, positionGeometry, cameraViewMatrix } from 'three/tsl';
import { Jet, JET, jetLanding } from '../classic/jet.js';
import { billboard, spriteMaterial } from './points.js';
import { mrtOutput } from '../../src/kit/webgpu/index.js';

export { JET, jetLanding };

export class JetGPU extends Jet {
  /** @param {any} renderer @param {{ noise3: any, depth: any }} o */
  constructor(renderer, { noise3, depth }) {
    super(renderer, { noise: null, depthU: {} });
    this.mesh.material.dispose();   // classic's GLSL material: never drawn here
    // the same names classic's render() writes (`.value`)
    this.uniforms = { uVolRes: uniform(new Vector2(1, 1)), uTime: uniform(0), uGain: uniform(JET.gain), uAlpha: uniform(JET.alpha), uHue: uniform(new Vector4()) };
    const U = this.uniforms, D = depth, tex = noise3.tex;
    const aP = attribute('aP', 'vec4'), aD = attribute('aD', 'vec4');
    const vertex = Fn(() => billboard({ world: aP.xyz, angle: aD.y.mul(6.2831).add(aD.x.mul(2.0)), half: aP.w }).clip)();
    const vViewZ = varying(cameraViewMatrix.mul(vec4(aP.xyz, 1.0)).z.negate(), 'vViewZ');   // the puff's centre (as classic)
    const frag = mrtOutput((out1) => {
      const vC = positionGeometry.xy, vHeat = aD.z, vSeed = aD.y, vAge = aD.x;
      const sceneZ = D.viewDepthAt(screenCoordinate.xy.div(U.uVolRes));
      const vis = float(1.0).sub(smoothstep(-0.15, 0.25, vViewZ.sub(sceneZ))).toVar();
      Discard(vis.lessThanEqual(0.0));
      const n = tex.sample(vC.mul(0.22).add(vec2(vSeed.mul(7.0), vSeed.mul(3.0).sub(U.uTime.mul(0.9))))).r.toVar();
      const n2 = tex.sample(vC.mul(0.5).add(vec2(vSeed.mul(2.0).add(U.uTime.mul(0.4)), vSeed.mul(5.0)))).g.toVar();
      const r = length(vC).add(n.sub(0.5).mul(0.75)).add(n2.sub(0.5).mul(0.35));
      const m = float(1.0).sub(smoothstep(0.15, 0.95, r)).toVar();
      Discard(m.lessThanEqual(0.0));
      // translucent puffs: hot and bright near the nozzle, an orange body, a dark red ragged tail
      const a = m.mul(vis).mul(U.uAlpha).mul(mix(0.85, 1.0, smoothstep(0.25, 1.2, vViewZ))).mul(float(1.0).sub(smoothstep(0.6, 1.0, vAge).mul(0.5))).toVar();
      const core = float(1.0).sub(smoothstep(0.0, 0.85, length(vC).add(n.sub(0.5).mul(0.5)))).toVar();
      // R = coverage, G = R × temperature (the volume's layout): white-yellow at the nozzle core, orange body, crimson tail
      const e = a.mul(vHeat).mul(U.uGain).mul(core.mul(0.9).add(0.55)).toVar();
      const tj = clamp(vHeat.mul(0.45).add(0.2).add(core.mul(0.4).mul(vHeat)), 0.0, 1.0);
      // the hue output: the Lance's hue mass; its alpha only fades what lies behind (blendSrcAlpha 0)
      out1.assign(vec4(U.uHue.xyz.mul(e), a));
      return vec4(e, e.mul(tj), 0.0, a);
    });
    this.mesh.material = spriteMaterial('fw-jet', vertex, frag, {
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneMinusSrcAlphaFactor,
    });
  }
}
