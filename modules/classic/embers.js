// FIREWRAITH · classic · embers: GPU particles (state texture ping-pong: xyz world, w = seconds left) advected by the
// fluid's velocity, rising and drifting, spawned at random points weighted by the fire. Drawn as additive points after
// the composite with a manual depth test against the scene depth (tiny soft dots in `smooth`, pixel squares on the
// fire-pixel grid in `hybrid`).
// Coloured fire: an ember takes the hue of the fire it rises from (picked at spawn from the hue field's fractions) and keeps
// it in its state: w = seconds left + 8 × hue index (0 orange, 1 violet, 2 blue, 3 green, 4 lilac).
import * as THREE from 'three';
import { W } from './world.js';
import { PingPong, passMaterial } from './gl.js';
import { NOISE_GLSL, DEPTH_GLSL } from './volume.js';

/** Ember colours per hue (linear; orange first, as HUE_ORDER). smooth: [edge, hot] mixed by heat; hybrid: [hot, mid, low] steps. */
export const EMBER_SMOOTH = [
  [[1.0, 0.22, 0.04], [1.0, 0.72, 0.32]],
  [[0.42, 0.06, 1.0], [0.92, 0.72, 1.0]],
  [[0.03, 0.28, 1.0], [0.62, 0.92, 1.0]],
  [[0.12, 0.75, 0.03], [0.75, 1.0, 0.5]],
  [[0.62, 0.3, 1.0], [1.0, 0.86, 1.0]],
];
export const EMBER_HYBRID = [
  [[1.0, 0.65, 0.22], [1.0, 0.33, 0.06], [0.75, 0.11, 0.04]],
  [[0.85, 0.6, 1.0], [0.55, 0.15, 1.0], [0.3, 0.04, 0.6]],
  [[0.55, 0.85, 1.0], [0.08, 0.48, 1.0], [0.02, 0.1, 0.65]],
  [[0.6, 1.0, 0.35], [0.2, 0.9, 0.08], [0.03, 0.4, 0.04]],
  [[0.95, 0.82, 1.0], [0.7, 0.38, 1.0], [0.4, 0.2, 0.75]],
];

const UPDATE = /* glsl */`
varying vec2 vUv;
uniform sampler2D uState; uniform sampler2D uS; uniform sampler2D uH; uniform sampler2D uVel; uniform vec4 uRect;
uniform float uDt; uniform float uTime; uniform float uSeed; uniform float uSpawn; uniform float uHueEnc;
/*@ew_ground*/
${NOISE_GLSL}
// hash12: "Hash without Sine" (c) 2014 David Hoskins, MIT (THIRD-PARTY-NOTICES.md)
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 st = texture2D(uState, vUv);
  vec2 id = gl_FragCoord.xy;
  if (st.w > 0.0) {
    float hueI = floor(st.w / 8.0);
    st.w -= hueI * 8.0;
    vec2 uv = (st.xz - uRect.xy) / uRect.zw;
    vec2 v = texture2D(uVel, uv).xy;
    float h = st.y - ewGround(st.xz);
    float rise = 0.7 + 1.7 * hash12(id + 3.1);
    float tx = noise3(vec3(st.x * 0.8, st.z * 0.8, uTime * 0.9 + id.x * 0.01)) - 0.5;
    float tz = noise3(vec3(st.z * 0.8 + 9.0, st.x * 0.8, uTime * 0.9 + id.y * 0.01)) - 0.5;
    vec3 vel = vec3(v.x * 0.9 + tx * 2.6, rise * (1.0 - 0.6 * smoothstep(3.0, 9.0, h)), v.y * 0.9 + tz * 2.6);
    st.xyz += vel * uDt;
    st.w -= uDt;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || st.w <= 0.0) st.w = -1.0;
    else st.w += hueI * 8.0;
  } else {
    vec2 r = vec2(hash12(id + uSeed * 1.31), hash12(id.yx * 1.7 + uSeed * 2.17 + 4.3));
    vec4 s = texture2D(uS, r);
    float p = clamp(s.g - 0.08, 0.0, 2.0) * uSpawn * uDt;
    if (hash12(id * 1.37 + uSeed * 2.93) < p) {
      vec2 xz = uRect.xy + r * uRect.zw;
      float life = 0.8 + 2.6 * hash12(id + uSeed * 0.37);
      // the hue of the fire it rises from: pick one of the cell's hues by its share
      vec4 fr = clamp(max(texture2D(uH, r), 0.0) / max(s.g, 0.02), 0.0, 1.0);
      fr /= max(1.0, dot(fr, vec4(1.0)));
      float u = hash12(id * 2.11 + uSeed * 3.7 + 1.9), hueI = 0.0, c = 1.0 - dot(fr, vec4(1.0));
      if (u >= c) { hueI = 1.0; c += fr.x; if (u >= c) { hueI = 2.0; c += fr.y; if (u >= c) { hueI = 3.0; c += fr.z; if (u >= c) hueI = 4.0; } } }
      st = vec4(xz.x, ewGround(xz) + 0.1 + 1.3 * hash12(id + uSeed * 5.1) * min(s.g, 1.0), xz.y, life + 8.0 * hueI * uHueEnc);
    } else {
      st = vec4(0.0, -100.0, 0.0, -1.0);
    }
  }
  gl_FragColor = st;
}`;

const DRAW_VERT = /* glsl */`
attribute vec2 aRef;
uniform sampler2D uState; uniform float uPxScale; uniform vec2 uRes; uniform float uPix;
varying float vLife; varying float vViewZ; varying float vHue;
void main() {
  vec4 st = texture2D(uState, aRef);
  vHue = st.w > 0.0 ? floor(st.w / 8.0) : 0.0;
  vLife = st.w - vHue * 8.0;
  if (st.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = viewMatrix * vec4(st.xyz, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
#ifdef HYBRID
  vec2 px = (gl_Position.xy / gl_Position.w * 0.5 + 0.5) * uRes;
  px = (floor(px / uPix) + 0.5) * uPix;
  gl_Position.xy = (px / uRes * 2.0 - 1.0) * gl_Position.w;
  gl_PointSize = vViewZ < 18.0 ? uPix : max(1.0, floor(uPix * 0.5));
#else
  gl_PointSize = clamp(0.06 * uPxScale / max(vViewZ, 0.1), 1.4, 5.0);
#endif
}`;

const DRAW_FRAG = /* glsl */`
uniform vec2 uRes; uniform vec3 uEmbS[10]; uniform vec3 uEmbH[15];
varying float vLife; varying float vViewZ; varying float vHue;
${DEPTH_GLSL}
void main() {
  if (vLife <= 0.0) discard;
  float sceneZ = viewDepthAt(gl_FragCoord.xy / uRes);
  if (vViewZ > sceneZ + 0.05) discard;
  float heat = clamp(vLife / 2.2, 0.0, 1.0);
  float fade = smoothstep(0.0, 0.35, vLife) * smoothstep(0.4, 1.6, vViewZ);
#ifdef HYBRID
  int h = int(vHue + 0.5) * 3;
  vec3 col = heat > 0.55 ? uEmbH[h] * 3.0 : heat > 0.25 ? uEmbH[h + 1] * 2.2 : uEmbH[h + 2] * 1.6;
  gl_FragColor = vec4(col * step(0.3, fade), 1.0);
#else
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 2.6);
  int h = int(vHue + 0.5) * 2;
  vec3 col = mix(uEmbS[h], uEmbS[h + 1], heat) * (0.9 + 3.2 * heat);
  gl_FragColor = vec4(col * a * fade, 1.0);
#endif
}`;

export class Embers {
  /** @param {THREE.WebGLRenderer} renderer @param {{ quad: import('./gl.js').Quad, noise: THREE.Texture, type: THREE.TextureDataType, depthU: any }} o */
  constructor(renderer, { quad, noise, type, depthU }) {
    this.renderer = renderer; this.quad = quad; this.noise = noise; this.type = type; this.depthU = depthU;
    this.seed = 0; this.time = 0; this.count = 0; this.style = 'smooth';
    this.updU = {
      uState: { value: null }, uS: { value: null }, uVel: { value: null }, uNoise: { value: noise },
      uRect: { value: new THREE.Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size) },
      uDt: { value: 0 }, uTime: { value: 0 }, uSeed: { value: 0 }, uSpawn: { value: 2.2 }, uH: { value: null },
      // the hue rides in w (+ 8 × hue): fine in a float32 state; a half-float state (no EXT_color_buffer_float) would lose
      // the seconds at w ≥ 8, so there the embers stay orange
      uHueEnc: { value: type === THREE.FloatType ? 1 : 0 },
    };
    this.updMat = passMaterial(UPDATE, this.updU);
    this.drawU = { ...depthU, uState: { value: null }, uPxScale: { value: 500 }, uRes: { value: new THREE.Vector2(1, 1) }, uPix: { value: 4 },
      uEmbS: { value: EMBER_SMOOTH.flat().map((c) => new THREE.Vector3(...c)) }, uEmbH: { value: EMBER_HYBRID.flat().map((c) => new THREE.Vector3(...c)) } };
    this._buildDraw();
  }

  _buildDraw() {
    this.drawCache = this.drawCache || new Map();
    if (this.drawCache.has(this.style)) { this.drawMat = this.drawCache.get(this.style); if (this.points) this.points.material = this.drawMat; return; }
    this.drawMat = new THREE.ShaderMaterial({
      vertexShader: DRAW_VERT, fragmentShader: DRAW_FRAG, uniforms: this.drawU, defines: this.style === 'hybrid' ? { HYBRID: 1 } : {},
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true,
    });
    this.drawCache.set(this.style, this.drawMat);
    if (this.points) this.points.material = this.drawMat;
  }

  setStyle(s) { if (s !== this.style) { this.style = s; this._buildDraw(); } }

  /** @param {number} n particles (rounded to a w × h texture) */
  setCount(n) {
    const w = 128, h = Math.max(1, Math.ceil(n / w));
    if (this.count === w * h) return;
    this.state?.dispose(); this.points?.geometry.dispose();
    this.state = new PingPong(w, h, { type: this.type, filter: THREE.NearestFilter });
    const r = this.renderer, prev = r.getRenderTarget(), pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.state.a, this.state.b]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(pc, pa); r.setRenderTarget(prev);
    const ref = new Float32Array(w * h * 2);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = (j * w + i) * 2; ref[k] = (i + 0.5) / w; ref[k + 1] = (j + 0.5) / h; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(w * h * 3), 3));
    geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
    if (!this.points) { this.points = new THREE.Points(geo, this.drawMat); this.points.frustumCulled = false; }
    else this.points.geometry = geo;
    this.count = w * h;
  }

  /** Kill every ember (a fresh night). */
  reset() {
    if (!this.state) return;
    const r = this.renderer, prev = r.getRenderTarget(), pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.state.a, this.state.b]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(pc, pa); r.setRenderTarget(prev);
  }

  update(solver, dt) {
    if (!this.count || dt <= 0) return;
    this.time += dt; this.seed = (this.seed + 1) % 4096;
    const u = this.updU;
    u.uState.value = this.state.read.texture; u.uS.value = solver.S.read.textures[0]; u.uH.value = solver.S.read.textures[1]; u.uVel.value = solver.V.read.texture;
    u.uDt.value = Math.min(dt, 0.05); u.uTime.value = this.time; u.uSeed.value = this.seed * 0.731;
    // spawn rate per unit fire per dead slot, scaled so a smaller pool still shows a similar ember density
    u.uSpawn.value = 0.45 * 16384 / this.count;
    this.quad.run(this.renderer, this.updMat, this.state.write);
    this.state.swap();
  }

  render(target, camera, width, height, pix) {
    if (!this.count) return;
    const u = this.drawU;
    u.uState.value = this.state.read.texture; u.uRes.value.set(width, height); u.uPix.value = pix;
    u.uPxScale.value = camera.projectionMatrix.elements[5] * height * 0.5;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.points, camera);
  }

  dispose() { this.state?.dispose(); this.points?.geometry.dispose(); this.updMat.dispose(); for (const m of this.drawCache.values()) m.dispose(); }
}
