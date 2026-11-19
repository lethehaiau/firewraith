// FIREWRAITH · kit · webgpu · the three.js WebGPU (TSL) helpers every grid fire needs, the twins of src/kit/webgl2/gl.js:
// render targets, ping-pong pairs, a full-screen pass runner, depth reconstruction, a noise texture with a TSL `noise3`,
// and instanced quads for particles (WebGPU draws points one pixel wide). Import from 'firewraith/kit/webgpu'.
//
// Conventions (WebGPU differs from WebGL here):
// - A render target is stored top-down. A full-screen pass's `uv()` has y = 0 at the first row in memory, which is also
//   where `texture(t, uv)` reads y = 0, so a pass that only reads and writes textures by uv needs no flip. A vertex that
//   places itself on a target by uv needs clip y = 1 − 2 v (see `uvToClip`).
// - Screen-space uv (the scene's colour and depth) has y = 0 at the TOP of the frame; `screenCoordinate` (the fragment's
//   pixel) also counts from the top. `getViewPosition` / `perspectiveDepthToViewZ` know WebGPU's 0..1 depth.
// - A texture node is compiled for the texture it holds when the material is first drawn (its sample type: filterable or
//   not, float or uint). Build every node with the real texture (or one of the same type and filter), then swap `.value`
//   between textures of that same kind only.
import {
  RenderTarget, NodeMaterial, QuadMesh, HalfFloatType, FloatType, RGBAFormat, LinearFilter, ClampToEdgeWrapping,
  InstancedBufferGeometry, Float32BufferAttribute, Matrix4, Vector4, Color,
} from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec4, floor, fract, mix, outputStruct, perspectiveDepthToViewZ, getViewPosition } from 'three/tsl';
import { makeNoiseTexture as makeNoiseTextureGL } from '../webgl2/gl.js';

/** The float types: WebGPU renders into and filters rgba16float everywhere, and renders into rgba32float. */
export function pickFloatTypes(renderer) {
  if (!renderer?.isWebGPURenderer) return null;
  return { half: HalfFloatType, particle: FloatType };
}

/** A colour target without depth. `count` > 1 makes a multiple-render-target (MRT) target: `rt.textures[i]`; write it
 *  from a pass whose fragment node is an `outputStruct(a, b, …)` (`mrtOutput` builds one for two outputs), and clear it
 *  with `clearTargets` (three's clear leaves the extra attachments at alpha 1).
 * @param {number} w @param {number} h @param {{ type?: number, filter?: number, format?: number, wrap?: number, count?: number }} [o] */
export function makeTarget(w, h, o = {}) {
  const filter = o.filter ?? LinearFilter;
  const rt = new RenderTarget(w, h, {
    type: o.type ?? HalfFloatType, format: o.format ?? RGBAFormat,
    minFilter: filter, magFilter: filter, wrapS: o.wrap ?? ClampToEdgeWrapping, wrapT: o.wrap ?? ClampToEdgeWrapping,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, count: o.count ?? 1,
  });
  for (const t of rt.textures) t.generateMipmaps = false;
  return rt;
}

/** A read/write pair of targets (the same API as the webgl2 kit's). */
export class PingPong {
  /** @param {number} w @param {number} h @param {Parameters<typeof makeTarget>[2]} [o] */
  constructor(w, h, o) { this.a = makeTarget(w, h, o); this.b = makeTarget(w, h, o); this.w = w; this.h = h; }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** A NodeMaterial for a full-screen pass: `node` is the fragment colour (a vec4, or `outputStruct(…)` for an MRT target).
 *  No depth, no blending unless `extra` sets it. */
export function passMaterial(node, extra = {}) {
  const m = new NodeMaterial();
  m.fragmentNode = node;
  m.depthTest = false; m.depthWrite = false; m.fog = false; m.lights = false; m.toneMapped = false;
  Object.assign(m, extra);
  return m;
}

/**
 * A texture node to sample with `.sample(uv)` and re-point with `.value = t` (every `.sample()` clone follows it). Unlike
 * `texture(t)`, its samples skip three's per-sample uv-transform matrix (a mat3 multiply and an object uniform per
 * sample: render targets and data textures are never offset or repeated here).
 * @param {any} [t] the texture it is first built with (its kind sets the sample type: see the header)
 */
export const texNode = (t) => texture(t, uv());

/**
 * A fragment node with two outputs, for a two-texture (MRT) target. `body(out1)` builds the pass, assigns the second
 * output to `out1` (a vec4 var, 0 until assigned) and returns the first. (A `Fn` that returns `outputStruct(…)` is not an
 * output struct itself, so its members would not reach the target.)
 * @param {(out1: any) => any} body
 */
export function mrtOutput(body) {
  const out1 = vec4(0.0).toVar('fw_out1');
  const first = Fn(() => { out1.assign(vec4(0.0)); return body(out1); })();
  return outputStruct(first, out1);
}

/** Runs pass materials over a full-screen triangle into a target (one QuadMesh; its material is swapped per pass). */
export class Quad {
  constructor() { this.mesh = new QuadMesh(); this.mesh.frustumCulled = false; }
  /** @param {any} renderer a WebGPURenderer @param {NodeMaterial} material @param {RenderTarget|null} target */
  run(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    this.mesh.render(renderer);
  }
  dispose() { /* the QuadMesh's geometry is shared by three */ }
}

const _fill = { quad: null, color: null, mats: new Map() };
/**
 * Clear targets to a colour (default transparent black), restoring the renderer's clear colour and target. Every
 * attachment of an MRT target gets the colour: three's WebGPU clear sets attachments after the first to (0, 0, 0, 1), so
 * those targets are filled by a full-screen pass instead (a field cleared to "alpha 1" is not empty).
 * @param {any} renderer @param {RenderTarget[]} targets
 */
export function clearTargets(renderer, targets, rgb = 0x000000, alpha = 0) {
  const prev = renderer.getRenderTarget(), pc = renderer.getClearColor(new Color()), pa = renderer.getClearAlpha(), pAuto = renderer.autoClear;
  renderer.setClearColor(rgb, alpha);
  renderer.autoClear = false;
  for (const t of targets) {
    const n = t.textures?.length ?? 1;
    if (n === 1) { renderer.setRenderTarget(t); renderer.clear(true, false, false); continue; }
    if (!_fill.quad) { _fill.quad = new Quad(); _fill.color = uniform(new Vector4()); }
    let m = _fill.mats.get(n);
    if (!m) { m = passMaterial(outputStruct(...Array.from({ length: n }, () => _fill.color))); m.name = 'fw-fill' + n; _fill.mats.set(n, m); }
    const c = new Color(rgb);
    _fill.color.value.set(c.r, c.g, c.b, alpha);
    _fill.quad.run(renderer, m, t);
  }
  renderer.setClearColor(pc, pa);
  renderer.autoClear = pAuto;
  renderer.setRenderTarget(prev);
}

/** Clip position for a point placed on a target by its texture uv (y = 0 at the first row): clip y = 1 − 2 v. The flip
 *  reverses a mesh's winding: draw such quads with `side: DoubleSide` (or wind them the other way). */
export const uvToClip = (uvNode) => vec4(uvNode.x.mul(2.0).sub(1.0), uvNode.y.mul(-2.0).add(1.0), 0.0, 1.0);

/** An InstancedBufferGeometry of one quad (corners ±1 in `position.xy`); give it per-instance attributes and an
 *  `instanceCount`. */
export function instancedQuad() {
  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = 0;
  return geo;
}

/**
 * Scene depth → view distance and world position, in TSL. One object per camera/depth pair; share it between
 * materials so that one `set()` a frame reaches all of them.
 *   const D = depthNodes(depthTexture);                 build with the real depth texture (its sample type)
 *   D.viewDepthAt(uv)                                   positive distance along the view axis
 *   const { raw, pos } = D.worldAt(uv)                  the raw depth (0..1, 1 = sky) and the world position
 *   each frame: D.set(camera, depthTexture)
 * `uv` is screen uv with y = 0 at the top (three's WebGPU screenUV). The game's depth is a standard perspective depth
 * texture (not reversed, not logarithmic).
 * @param {any} depthTexture
 */
export function depthNodes(depthTexture) {
  const D = {
    depth: texNode(depthTexture),
    invProj: uniform(new Matrix4()),
    camWorld: uniform(new Matrix4()),
    near: uniform(0.1),
    far: uniform(1000),
    /** @param {any} uv */
    rawAt(uv) { return D.depth.sample(uv).x; },
    /** @param {any} uv */
    viewDepthAt(uv) { return perspectiveDepthToViewZ(D.depth.sample(uv).x, D.near, D.far).negate(); },
    /** @param {any} uv @returns {{ raw: any, pos: any }} */
    worldAt(uv) {
      const raw = D.depth.sample(uv).x.toVar();
      const v = getViewPosition(uv, raw, D.invProj);
      const pos = D.camWorld.mul(vec4(v, 1.0)).xyz.toVar();
      return { raw, pos };
    },
    /** Point the nodes at this frame's camera and depth texture. */
    set(camera, depthTex) {
      if (depthTex && D.depth.value !== depthTex) D.depth.value = depthTex;
      D.invProj.value.copy(camera.projectionMatrixInverse);
      D.camWorld.value.copy(camera.matrixWorld);
      D.near.value = camera.near; D.far.value = camera.far;
    },
  };
  return D;
}

/** A tileable 256² value-noise texture for `noise3` (the webgl2 kit's, unchanged: a plain DataTexture). */
export const makeNoiseTexture = makeNoiseTextureGL;

/**
 * `noise3(x)`: smooth 3D value noise (IQ's two-slice trick), after Inigo Quilez (MIT: THIRD-PARTY-NOTICES.md) from makeNoiseTexture(), the TSL twin of NOISE_GLSL. Returns a
 * function (vec3 node) → float node, inlined where it is called (call it inside a `Fn`); `noise3.tex` is the texture node
 * (for jitter reads of its other channels). (Not a `setLayout` function: a texture read inside one loses its bindings.)
 * @param {any} noiseTexture
 */
export function makeNoise3(noiseTexture) {
  const tex = texNode(noiseTexture);
  const noise3 = (x) => {
    const p = floor(x).toVar();
    const f0 = fract(x).toVar();
    const f = f0.mul(f0).mul(f0.mul(-2.0).add(3.0)).toVar();
    const uvn = p.xy.add(vec2(37.0, 17.0).mul(p.z)).add(f.xy);
    const rg = tex.sample(uvn.add(0.5).div(256.0)).yx.toVar();
    return mix(rg.x, rg.y, f.z);
  };
  noise3.tex = tex;
  return noise3;
}

/** sRGB hex → linear three Color (Color parses sRGB hex into linear with ColorManagement on). */
export function linColor(hex) { return new Color(hex); }
