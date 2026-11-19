// FIREWRAITH · kit · webgl2 · small three.js WebGL helpers every grid fire needs: render targets, ping-pong pairs, a
// full-screen pass runner, depth reconstruction and a noise texture. Import from 'firewraith/kit/webgl2'.
import * as THREE from 'three';

/** The vertex shader every full-screen pass uses (a 2×2 plane in clip space). */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Which float type the GPU can render into. WebGL2 needs EXT_color_buffer_float (or EXT_color_buffer_half_float) to
 * render into half-float targets; 16F textures are filterable in WebGL2 core. Returns null when neither exists.
 * @param {THREE.WebGLRenderer} renderer
 */
export function pickFloatTypes(renderer) {
  const ext = renderer.extensions;
  const f32 = ext.has('EXT_color_buffer_float');
  const f16 = f32 || ext.has('EXT_color_buffer_half_float');
  if (!f16) return null;
  return { half: THREE.HalfFloatType, particle: f32 ? THREE.FloatType : THREE.HalfFloatType };
}

/** A colour target without depth. `count` > 1 makes a multiple-render-target (MRT) target: `rt.textures[i]`.
 * @param {number} w @param {number} h @param {{ type?: THREE.TextureDataType, filter?: THREE.MagnificationTextureFilter, format?: THREE.PixelFormat, wrap?: THREE.Wrapping, count?: number }} [o] */
export function makeTarget(w, h, o = {}) {
  const filter = o.filter ?? THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: o.type ?? THREE.HalfFloatType, format: o.format ?? THREE.RGBAFormat,
    minFilter: filter, magFilter: filter, wrapS: o.wrap ?? THREE.ClampToEdgeWrapping, wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, count: o.count ?? 1,
  });
  for (const t of rt.textures) t.generateMipmaps = false;
  return rt;
}

/** GLSL3 two-output header for MRT passes (ShaderMaterial with glslVersion GLSL3: no gl_FragColor from three). */
export const MRT2 = /* glsl */`
layout(location = 0) out highp vec4 pc_fragColor;
layout(location = 1) out highp vec4 pc_fragHue;
#define gl_FragColor pc_fragColor
`;

/** A read/write pair of targets. */
export class PingPong {
  /** @param {number} w @param {number} h @param {Parameters<typeof makeTarget>[2]} [o] */
  constructor(w, h, o) { this.a = makeTarget(w, h, o); this.b = makeTarget(w, h, o); this.w = w; this.h = h; }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Runs ShaderMaterials over a full-screen quad into a target. */
export class Quad {
  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
  }
  /** @param {THREE.WebGLRenderer} renderer @param {THREE.Material} material @param {THREE.WebGLRenderTarget|null} target */
  run(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }
  dispose() { this.mesh.geometry.dispose(); }
}

/** A ShaderMaterial for a full-screen pass (no depth, no blending unless asked). `extra.mrt`: two outputs (MRT2). */
export function passMaterial(frag, uniforms, extra = {}) {
  if (extra.mrt) { const { mrt, ...rest } = extra; return passMaterial(MRT2 + frag, uniforms, { ...rest, glslVersion: THREE.GLSL3 }); }
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra,
  });
}

/** sRGB hex → linear THREE.Color (THREE.Color parses sRGB hex into linear with ColorManagement on). @param {string|number} hex */
export function linColor(hex) { return new THREE.Color(hex); }

/**
 * Scene depth → view distance and world position in GLSL. Pair with `depthUniforms()` and `setDepthCamera()`.
 *   float viewDepthAt(vec2 uv)                    positive distance along the view axis
 *   vec3 worldAt(vec2 uv, out float rawDepth)      the world position of the scene at uv
 * (The game's depth is a standard perspective DepthTexture: not reversed, not logarithmic.)
 */
export const DEPTH_GLSL = /* glsl */`
uniform sampler2D uDepth; uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform float uNear; uniform float uFar;
float viewDepthAt(vec2 uv) {             // positive distance along the view axis (perspective depth, not reversed/log)
  float d = texture2D(uDepth, uv).x;
  return (uNear * uFar) / ((uFar - uNear) * d - uFar) * -1.0;
}
vec3 worldAt(vec2 uv, out float rawDepth) {
  rawDepth = texture2D(uDepth, uv).x;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
  v /= v.w;
  return (uCamWorld * vec4(v.xyz, 1.0)).xyz;
}`;

/** The uniforms DEPTH_GLSL reads (share one object between materials so one update reaches all). */
export function depthUniforms() {
  return { uDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uNear: { value: 0.1 }, uFar: { value: 1000 } };
}
/** Point depthUniforms() at this frame's camera and depth texture. */
export function setDepthCamera(u, camera, depthTex) {
  u.uDepth.value = depthTex;
  u.uInvProj.value.copy(camera.projectionMatrixInverse);
  u.uCamWorld.value.copy(camera.matrixWorld);
  u.uNear.value = camera.near; u.uFar.value = camera.far;
}

/** A tileable 256² value-noise texture for NOISE_GLSL's `noise3` (Inigo Quilez's two-slice trick, MIT: THIRD-PARTY-NOTICES.md; G = R shifted by (37, 17)). */
export function makeNoiseTexture(seed = 1337) {
  const n = 256, d = new Uint8Array(n * n * 4);
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const R = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) R[i] = (rnd() * 256) | 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    d[i] = R[y * n + x];
    d[i + 1] = R[((y - 17 + n) % n) * n + ((x - 37 + n) % n)];
    d[i + 2] = (rnd() * 256) | 0; d[i + 3] = (rnd() * 256) | 0;
  }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

/** `float noise3(vec3 x)`: smooth 3D value noise from makeNoiseTexture() bound to `uNoise`. */
export const NOISE_GLSL = /* glsl */`
uniform sampler2D uNoise;
float noise3(vec3 x) {
  vec3 p = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (p.xy + vec2(37.0, 17.0) * p.z) + f.xy;
  vec2 rg = texture2D(uNoise, (uv + 0.5) / 256.0).yx;
  return mix(rg.x, rg.y, f.z);
}`;
