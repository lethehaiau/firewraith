// FIREWRAITH · classic-webgpu · steam where fire is doused. The puffs are classic's own CPU code (`Steam`: douse()
// samples the read-back grid, update() rises and swells them), subclassed; only the materials are new: soft noisy
// billboards with a soft depth test (`smooth`) or on the fire-pixel grid with two flat alpha steps (`hybrid`).
import { Vector2, Vector3, CustomBlending, AddEquation, SrcAlphaFactor, OneMinusSrcAlphaFactor, ZeroFactor, OneFactor } from 'three/webgpu';
import { Fn, uniform, attribute, vec2, vec4, float, Discard, select, smoothstep, length, floor, varying, screenCoordinate, positionGeometry, cameraViewMatrix } from 'three/tsl';
import { Steam, STEAM } from '../classic/steam.js';
import { billboard, spriteMaterial } from './points.js';

export { STEAM };

export class SteamGPU extends Steam {
  /** @param {any} renderer @param {{ noise3: any, depth: any }} o */
  constructor(renderer, { noise3, depth }) {
    super(renderer, { noise: null, depthU: {} });
    for (const m of Object.values(this.mats)) m.dispose();   // classic's GLSL materials: never drawn here
    // the same names classic's render() writes (`.value`)
    this.uniforms = { uRes: uniform(new Vector2(1, 1)), uTime: uniform(0), uAlpha: uniform(STEAM.alpha), uColor: uniform(new Vector3(...STEAM.color)), uPix: uniform(4) };
    const U = this.uniforms, D = depth, tex = noise3.tex;
    const aP = attribute('aP', 'vec4'), aD = attribute('aD', 'vec4');
    const vertex = Fn(() => billboard({ world: aP.xyz, angle: aD.y.mul(6.2831), half: aP.w }).clip)();
    const vViewZ = varying(cameraViewMatrix.mul(vec4(aP.xyz, 1.0)).z.negate(), 'vViewZ');
    const make = (hybrid) => spriteMaterial('fw-steam-' + (hybrid ? 'hybrid' : 'smooth'), vertex, Fn(() => {
      const vC = positionGeometry.xy, vSeed = aD.y, vAge = aD.x, vAmt = aD.z;
      const fc = hybrid ? floor(screenCoordinate.xy.div(U.uPix)).add(0.5).mul(U.uPix) : screenCoordinate.xy;
      const sceneZ = D.viewDepthAt(fc.div(U.uRes));
      const vis = float(1.0).sub(smoothstep(-0.3, 0.6, vViewZ.sub(sceneZ))).toVar();   // soft against the ground and walls
      Discard(vis.lessThanEqual(0.0));
      const n = tex.sample(vC.mul(0.3).add(vec2(vSeed.mul(7.0), vSeed.mul(3.0).sub(U.uTime.mul(0.25))))).r.toVar();
      const n2 = tex.sample(vC.mul(0.7).add(vec2(vSeed.mul(2.0).add(U.uTime.mul(0.2)), vSeed.mul(5.0)))).g.toVar();
      const r = length(vC).add(n.sub(0.5).mul(0.55)).add(n2.sub(0.5).mul(0.25));
      const m = float(1.0).sub(smoothstep(0.1, 1.0, r)).mul(n2.mul(0.45).add(0.55));   // wispy, not a solid dome
      const life = smoothstep(0.0, 0.12, vAge).mul(float(1.0).sub(smoothstep(0.35, 1.0, vAge)));   // a quick puff: in, then thins out
      const a = m.mul(life).mul(vis).mul(U.uAlpha).mul(vAmt).mul(smoothstep(0.4, 2.0, vViewZ)).toVar();
      if (hybrid) a.assign(select(a.lessThan(0.12), float(0.0), select(a.lessThan(0.3), float(0.22), float(0.42))));
      Discard(a.lessThanEqual(0.0));
      return vec4(U.uColor.mul(n2.mul(0.3).add(0.85)), a);
    })(), {
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
    });
    this.mats = { smooth: make(false), hybrid: make(true) };
    this.mesh.material = this.mats[this.style];
  }
}
