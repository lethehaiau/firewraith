// FIREWRAITH · classic · fire columns: local ray-marched fire volumes for fire that stands outside
// the ground fluid's slab (y −16 … 8.5 m): the lamp's black-red **pillar** (the beacon basket up into the portal) and the
// **demon's fire** (a sheath of rising tongues round the ≈ 5 m figure on the wall walk). Procedural (value noise rising
// and twisting in a cylinder), drawn after the composite as premultiplied colour over the target, depth-tested against
// the scene by hand; each brings its own sparks (CPU points) and adds its light to the fire light map. Nothing is drawn
// and nothing costs while no column exists.
//   fluid.columns.set('pillar', { preset: 'pillar', x: 16, y: 14.4, z: 0, intensity: 0..1 });
//   fluid.columns.set('demon', { preset: 'demon', x, y: 5, z, intensity });   fluid.columns.set(id, null) removes it.
// Also exports makeFireVortexMaterial() for a portal disc (the game's fire bench shows it; the game does not use it).
import * as THREE from 'three';
import { NOISE_GLSL, DEPTH_GLSL, makeNoiseTexture } from './volume.js';
import { linColor } from './gl.js';

/** Ramps (sRGB, dark → core). 'blackred': black tongue edges, a deep red body, a white-hot heart. */
export const COLUMN_RAMPS = {
  blackred: ['#020001', '#1c0306', '#5c0610', '#a8101a', '#ff4a22', '#fff0e0'],
  orange: ['#4a1612', '#a3241a', '#e85a1c', '#ff9a2e', '#ffd24a', '#fff2b8'],
};
const RAMP_INDEX = { blackred: 0, orange: 1 };

/** Presets (metres, seconds). r: base radius; h: height; flare: radius growth to the top (× r); shell: 0 a solid column,
 *  1 a sheath round a figure; twist: turns over the height; spin: rad/s; rise: m/s of the noise; freq: noise per metre;
 *  gain: extinction per metre; sparks per second; light: rgb (linear, the light map) and its radius on the ground. */
export const COLUMN_PRESETS = {
  pillar: { r: 3.6, h: 46, flare: 1.5, shell: 0, twist: 0.6, spin: 0.8, rise: 8.0, freq: 0.24, gain: 1.3, bright: 2.2, ramp: 'blackred', sparks: 200, sparkSpeed: 11, light: [1.5, 0.12, 0.06], lightR: 24 },
  demon: { r: 2.8, h: 7.5, flare: -0.2, shell: 1, twist: 0.2, spin: 1.1, rise: 3.0, freq: 0.85, gain: 2.6, bright: 1.8, ramp: 'orange', sparks: 170, sparkSpeed: 3.6, light: [1.0, 0.42, 0.13], lightR: 7 },
};

export const MAX_STEPS = 30;
const VERT = /* glsl */`
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */`
uniform vec2 uRes; uniform float uPix; uniform float uTime; uniform vec3 uCamPos;
uniform vec3 uBase; uniform float uR; uniform float uH; uniform float uFlare; uniform float uShell; uniform float uTwist;
uniform float uSpin; uniform float uRise; uniform float uFreq; uniform float uGain; uniform float uBright; uniform float uIntensity;
uniform vec3 uRamp[12]; uniform float uRampOff;
${NOISE_GLSL}
${DEPTH_GLSL}
const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
float bayer4(vec2 c) { vec2 p = mod(floor(c), 4.0); return (BAYER[int(p.y) * 4 + int(p.x)] + 0.5) / 16.0; }
vec3 ramp(float x) {
  float k = clamp(x, 0.0, 1.0) * 5.0; int i = int(min(floor(k), 4.0)); int o = int(uRampOff);
  return mix(uRamp[o + i], uRamp[o + i + 1], k - float(i));
}
// density and temperature at a point relative to the column's base centre
vec2 fireAt(vec3 p, vec3 toCam) {
  float y = p.y / uH;
  if (y < 0.0 || y > 1.0) return vec2(0.0);
  float R = uR * (1.0 + uFlare * y) * mix(0.45, 1.0, smoothstep(0.0, 0.1, y));   // it erupts narrow from its source, then swells
  float rho = length(p.xz);
  float th = atan(p.z, p.x) + y * uTwist * 6.2831 + uTime * uSpin;
  vec3 q = vec3(cos(th) * rho, sin(th) * rho, p.y - uTime * uRise) * uFreq;
  float n = noise3(q) * 0.62 + noise3(q * 2.3 + 11.0) * 0.38;
  float fade = smoothstep(0.0, 0.025, y) * (1.0 - smoothstep(0.8, 1.0, y));
  float d, temp;
  if (uShell < 0.5) {   // the pillar: a solid twisting column, white-hot at the heart, black at the ragged edge
    float e = rho / R + (n - 0.5) * 1.1;
    d = (1.0 - smoothstep(0.15, 1.05, e)) * (0.35 + 0.65 * (1.0 - smoothstep(0.0, 0.7, e)));   // thin ragged rim, dense heart
    temp = clamp(1.12 - e * 1.35 + (n - 0.5) * 0.45, 0.0, 1.0) * (1.0 - 0.3 * y);   // ragged black rim, deep red body, white heart low in the column
  } else {              // the demon's fire FRAMES the figure: tongues rise behind it and at its sides (the sprite in front
                        // hides what is behind it by depth), a low ring at its feet; nothing on the side facing the camera
    float e = abs(rho - R) / (0.6 * R) + (n - 0.5) * 1.1;
    float thr = 0.24 + 0.36 * y;   // tongues reach high round the figure
    d = (1.0 - smoothstep(0.3, 1.0, e)) * smoothstep(thr, thr + 0.12, n);
    vec2 rd = rho > 1e-3 ? p.xz / rho : vec2(0.0);
    float facing = dot(rd, normalize(toCam.xz + 1e-4));
    float keep = 1.0 - smoothstep(0.05, 0.45, facing);                // behind and at the sides only (face, torso, eyes clear)
    keep = max(keep, (1.0 - smoothstep(0.03, 0.11, y)) * 0.45);       // low flames from the wall walk at its feet, all round
    d *= keep;
    temp = clamp(0.18 + 0.62 * (1.0 - y) * smoothstep(thr, thr + 0.35, n), 0.0, 1.0) * mix(0.75, 1.0, smoothstep(0.0, 0.2, y));   // orange-red at the feet, not a yellow slab
  }
  return vec2(d * fade, temp);
}
void main() {
  vec2 fc = gl_FragCoord.xy;
#ifdef HYBRID
  fc = (floor(fc / uPix) + 0.5) * uPix;   // one ray per fire pixel
#endif
  vec2 uv = fc / uRes;
  float raw; vec3 wp = worldAt(uv, raw);
  vec3 ro = uCamPos, rd = normalize(wp - ro);
  float tScene = raw >= 0.99999 ? 1e5 : length(wp - ro);
  // the column's bounding cylinder (as a box) in world space
  float Rm = uR * max(1.0, 1.0 + uFlare) * 1.25;
  vec3 bmin = uBase - vec3(Rm, 0.0, Rm), bmax = uBase + vec3(Rm, uH, Rm);
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tIn = max(max(tmn.x, tmn.y), max(tmn.z, 0.1)), tOut = min(min(tmx.x, tmx.y), min(tmx.z, tScene));
  if (tIn >= tOut) discard;
  float dt = (tOut - tIn) / float(${MAX_STEPS});
  float jit = texture2D(uNoise, (mod(floor(fc), 256.0) + 0.5) / 256.0).b;
  float T = 1.0, cov = 0.0, tsum = 0.0; vec3 col = vec3(0.0);
  vec3 toCam = ro - uBase;
  for (int i = 0; i < ${MAX_STEPS}; i++) {
    float t = tIn + (float(i) + jit) * dt;
    vec2 f = fireAt(ro + rd * t - uBase, toCam);
    if (f.x > 0.001) {
      float a = 1.0 - exp(-f.x * uGain * uIntensity * dt);
      cov += T * a; tsum += T * a * f.y;
#ifndef HYBRID
      col += T * a * ramp(f.y) * (1.0 + (uBright - 1.0) * smoothstep(0.5, 1.0, f.y));   // per sample: the heart glows through the rim
#endif
      T *= 1.0 - a;
      if (T < 0.02) break;
    }
  }
  if (cov < 0.002) discard;
  float temp = tsum / cov;
#ifdef HYBRID
  float b = bayer4(floor(fc / uPix)) - 0.5;
  float lv = clamp(floor(temp * 6.0 + b * 0.6), 0.0, 5.0);
  float on = step(0.45 + b * 0.35, cov);
  vec3 c = ramp(lv / 5.0) * (lv > 4.5 ? 1.0 + (uBright - 1.0) * 0.25 : 1.0);
  gl_FragColor = vec4(c * on, on);
#else
  gl_FragColor = vec4(col, cov);   // premultiplied: black edges darken what is behind   // premultiplied: black edges darken what is behind
#endif
}`;

const SPARK_MAX = 640;
const SPARK_VERT = /* glsl */`
attribute vec4 aS;   // xyz, heat 0..1 (0 = dead)
uniform float uPxScale; uniform vec2 uRes; uniform float uPix;
varying float vHeat; varying float vViewZ;
void main() {
  vHeat = aS.w;
  vec4 mv = viewMatrix * vec4(aS.xyz, 1.0);
  vViewZ = -mv.z;
  gl_Position = aS.w <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
#ifdef HYBRID
  vec2 px = (gl_Position.xy / gl_Position.w * 0.5 + 0.5) * uRes;
  px = (floor(px / uPix) + 0.5) * uPix;
  gl_Position.xy = (px / uRes * 2.0 - 1.0) * gl_Position.w;
  gl_PointSize = vViewZ < 25.0 ? uPix : max(1.0, floor(uPix * 0.5));
#else
  gl_PointSize = clamp(0.09 * uPxScale / max(vViewZ, 0.1), 1.5, 6.0);
#endif
}`;
const SPARK_FRAG = /* glsl */`
uniform vec2 uRes; uniform vec3 uHot; uniform vec3 uCool;
varying float vHeat; varying float vViewZ;
${DEPTH_GLSL}
void main() {
  if (vHeat <= 0.0) discard;
  if (vViewZ > viewDepthAt(gl_FragCoord.xy / uRes) + 0.05) discard;
#ifdef HYBRID
  gl_FragColor = vec4((vHeat > 0.55 ? uHot * 3.0 : uCool * 2.0), 1.0);
#else
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  gl_FragColor = vec4(mix(uCool, uHot, vHeat) * (0.8 + 3.0 * vHeat) * exp(-dot(c, c) * 2.6), 1.0);
#endif
}`;

export class Columns {
  /** @param {THREE.WebGLRenderer} renderer @param {{ noise: THREE.Texture, depthU: any }} o */
  constructor(renderer, { noise, depthU }) {
    this.renderer = renderer; this.style = 'smooth'; this.time = 0; this.map = new Map(); this._rng = 4242;
    const U = (v) => ({ value: v });
    this.rampU = U(Array.from({ length: 12 }, () => new THREE.Vector3()));
    Object.values(RAMP_INDEX).forEach((k) => { const name = Object.keys(RAMP_INDEX)[k]; COLUMN_RAMPS[name].forEach((hex, i) => { const c = linColor(hex); this.rampU.value[k * 6 + i].set(c.r, c.g, c.b); }); });
    this.shared = { ...depthU, uNoise: U(noise), uRes: U(new THREE.Vector2(1, 1)), uPix: U(4), uTime: U(0), uCamPos: U(new THREE.Vector3()) };
    this.geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.mats = { smooth: [], hybrid: [] };
    // sparks
    this.sp = { pos: new Float32Array(SPARK_MAX * 3), vel: new Float32Array(SPARK_MAX * 3), age: new Float32Array(SPARK_MAX), life: new Float32Array(SPARK_MAX), col: new Uint8Array(SPARK_MAX), n: 0 };
    this.sparkAttr = new THREE.BufferAttribute(new Float32Array(SPARK_MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_MAX * 3), 3));
    sg.setAttribute('aS', this.sparkAttr);
    sg.setDrawRange(0, 0);
    this.sparkU = { ...depthU, uRes: this.shared.uRes, uPix: this.shared.uPix, uPxScale: U(500), uHot: U(new THREE.Vector3(1.0, 0.75, 0.4)), uCool: U(new THREE.Vector3(1.0, 0.2, 0.04)) };
    this.sparkMats = {};
    for (const st of ['smooth', 'hybrid']) {
      this.sparkMats[st] = new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: this.sparkU, defines: st === 'hybrid' ? { HYBRID: 1 } : {},
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        depthTest: false, depthWrite: false, transparent: true });
    }
    this.sparks = new THREE.Points(sg, this.sparkMats.smooth); this.sparks.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.sparks);
  }

  _rand() { this._rng = (this._rng * 1664525 + 1013904223) >>> 0; return this._rng / 4294967296; }

  _material(style) {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, defines: style === 'hybrid' ? { HYBRID: 1 } : {},
      uniforms: { ...this.shared, uRamp: this.rampU, uBase: { value: new THREE.Vector3() }, uR: { value: 1 }, uH: { value: 1 }, uFlare: { value: 0 }, uShell: { value: 0 },
        uTwist: { value: 0 }, uSpin: { value: 0 }, uRise: { value: 0 }, uFreq: { value: 1 }, uGain: { value: 1 }, uBright: { value: 1 }, uIntensity: { value: 1 }, uRampOff: { value: 0 } },
      side: THREE.BackSide,   // drawn from inside the box too (a close camera)
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, transparent: true,
    });
    return m;
  }

  /** Add, change or remove (cfg null) a column. cfg: { preset: 'pillar'|'demon', x, y, z, intensity 0..1, ...overrides } */
  set(id, cfg) {
    if (!cfg) { const c = this.map.get(id); if (c) { this.scene.remove(c.mesh); c.mesh.material.dispose(); c.hyb.dispose(); this.map.delete(id); } return; }
    let c = this.map.get(id);
    if (!c) {
      const mesh = new THREE.Mesh(this.geo, this._material('smooth')); mesh.frustumCulled = false;
      c = { mesh, smooth: mesh.material, hyb: this._material('hybrid'), p: { ...COLUMN_PRESETS.pillar }, carry: 0 };
      this.map.set(id, c); this.scene.add(mesh);
    }
    const base = COLUMN_PRESETS[cfg.preset || c.p.preset || 'pillar'] || COLUMN_PRESETS.pillar;
    c.p = { ...base, preset: cfg.preset || c.p.preset || 'pillar', intensity: 1, ...cfg };
    this._apply(c);
  }

  _apply(c) {
    const p = c.p;
    for (const m of [c.smooth, c.hyb]) {
      const u = m.uniforms;
      u.uBase.value.set(p.x, p.y, p.z); u.uR.value = p.r; u.uH.value = p.h; u.uFlare.value = p.flare; u.uShell.value = p.shell;
      u.uTwist.value = p.twist; u.uSpin.value = p.spin; u.uRise.value = p.rise; u.uFreq.value = p.freq; u.uGain.value = p.gain;
      u.uBright.value = p.bright; u.uIntensity.value = Math.max(0, Math.min(1, p.intensity)); u.uRampOff.value = (RAMP_INDEX[p.ramp] ?? 1) * 6;
    }
    const Rm = p.r * Math.max(1, 1 + p.flare) * 1.25;
    c.mesh.position.set(p.x, p.y, p.z); c.mesh.scale.set(2 * Rm, p.h, 2 * Rm); c.mesh.updateMatrixWorld();
  }

  get count() { return this.map.size; }
  setStyle(s) { this.style = s === 'hybrid' ? 'hybrid' : 'smooth'; for (const c of this.map.values()) c.mesh.material = this.style === 'hybrid' ? c.hyb : c.smooth; this.sparks.material = this.sparkMats[this.style]; }

  /** The columns' light for the light map: [{ x, z, r, rgb }]. */
  lights() {
    const out = [];
    for (const c of this.map.values()) { const p = c.p, k = Math.max(0, Math.min(1, p.intensity)); if (k > 0) out.push({ x: p.x, z: p.z, r: p.lightR, rgb: p.light.map((v) => v * k) }); }
    return out;
  }

  update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    const S = this.sp;
    // emit
    for (const c of this.map.values()) {
      const p = c.p, k = Math.max(0, Math.min(1, p.intensity));
      c.carry += p.sparks * k * dt;
      while (c.carry >= 1 && S.n < SPARK_MAX) {
        c.carry -= 1;
        const i = S.n++, j = i * 3, a = this._rand() * 6.2831, y = this._rand() * (p.shell ? 0.5 : 0.25) * p.h;
        const R = p.r * (1 + p.flare * y / p.h) * (p.shell ? 0.9 + 0.3 * this._rand() : 0.4 + 0.6 * this._rand());
        S.pos[j] = p.x + Math.cos(a) * R; S.pos[j + 1] = p.y + y; S.pos[j + 2] = p.z + Math.sin(a) * R;
        const sw = p.spin * R * 0.8;   // swirl with the column
        S.vel[j] = -Math.sin(a) * sw + (this._rand() - 0.5); S.vel[j + 1] = p.sparkSpeed * (0.6 + 0.8 * this._rand()); S.vel[j + 2] = Math.cos(a) * sw + (this._rand() - 0.5);
        S.age[i] = 0; S.life[i] = 1.0 + 1.6 * this._rand(); S.col[i] = 0;
      }
      if (c.carry > 1) c.carry = 0;
    }
    // integrate + compact
    let n = 0;
    for (let i = 0; i < S.n; i++) {
      const a = S.age[i] + dt; if (a >= S.life[i]) continue;
      const j = i * 3, m = n * 3;
      S.pos[m] = S.pos[j] + S.vel[j] * dt; S.pos[m + 1] = S.pos[j + 1] + S.vel[j + 1] * dt; S.pos[m + 2] = S.pos[j + 2] + S.vel[j + 2] * dt;
      S.vel[m] = S.vel[j] * 0.99; S.vel[m + 1] = S.vel[j + 1] * 0.995; S.vel[m + 2] = S.vel[j + 2] * 0.99;
      S.age[n] = a; S.life[n] = S.life[i]; n++;
    }
    S.n = n;
    const A = this.sparkAttr.array;
    for (let i = 0; i < n; i++) { const j = i * 3; A.set([S.pos[j], S.pos[j + 1], S.pos[j + 2], Math.max(0.02, 1 - S.age[i] / S.life[i])], i * 4); }
    this.sparkAttr.clearUpdateRanges(); this.sparkAttr.addUpdateRange(0, n * 4); this.sparkAttr.needsUpdate = true;
    this.sparks.geometry.setDrawRange(0, n);
  }

  /** Draw over the composite (target bound by the caller). */
  render(target, camera, width, height, pix) {
    if (!this.map.size && !this.sp.n) return;
    const u = this.shared;
    u.uRes.value.set(width, height); u.uPix.value = pix; u.uTime.value = this.time; u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    this.sparkU.uPxScale.value = camera.projectionMatrix.elements[5] * height * 0.5;
    const pre = [...this.map.values()].find((c) => c.p.ramp === 'blackred');
    if (pre) { this.sparkU.uHot.value.set(1.0, 0.55, 0.35); this.sparkU.uCool.value.set(0.7, 0.03, 0.02); } else { this.sparkU.uHot.value.set(1.0, 0.75, 0.4); this.sparkU.uCool.value.set(1.0, 0.2, 0.04); }
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, camera);
  }

  /** All programs (warm-up). */
  materials() { this._probe ||= this._material('smooth'); this._probeH ||= this._material('hybrid'); return [this._probe, this._probeH, this.sparkMats.smooth, this.sparkMats.hybrid]; }

  reset() { for (const id of [...this.map.keys()]) this.set(id, null); this.sp.n = 0; this.sparks.geometry.setDrawRange(0, 0); }

  dispose() { this.reset(); this.geo.dispose(); this.sparks.geometry.dispose(); for (const m of Object.values(this.sparkMats)) m.dispose(); this._probe?.dispose(); this._probeH?.dispose(); }
}

/**
 * A swirling fire-vortex material for a disc (the portal): put it on a CircleGeometry (uv
 * 0..1), additive. uniforms.uTime (s), uIntensity (0..1). Ramp 'blackred' by default.
 */
export function makeFireVortexMaterial({ ramp = 'blackred', noise = makeNoiseTexture(77) } = {}) {
  const cols = (COLUMN_RAMPS[ramp] || COLUMN_RAMPS.blackred).map((h) => { const c = linColor(h); return new THREE.Vector3(c.r, c.g, c.b); });
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uRamp: { value: cols }, uNoise: { value: noise } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime; uniform float uIntensity; uniform vec3 uRamp[6];
${NOISE_GLSL}
      vec3 ramp(float x){ float k = clamp(x, 0.0, 1.0) * 5.0; int i = int(min(floor(k), 4.0)); return mix(uRamp[i], uRamp[i + 1], k - float(i)); }
      void main(){
        vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
        float a = atan(p.y, p.x) + 2.6 / (r + 0.25) + uTime * 0.7;          // arms wind tighter toward the eye
        vec3 q = vec3(cos(a) * r * 3.0, sin(a) * r * 3.0, r * 4.0 - uTime * 1.3);
        float n = noise3(q) * 0.6 + noise3(q * 2.2 + 7.0) * 0.4;
        float heat = clamp(n * 1.3 - 0.15 + (1.0 - r) * 0.45, 0.0, 1.0);
        float rim = smoothstep(1.0, 0.86, r) * smoothstep(0.55, 0.92, r);     // the ring of fire
        float t = max(heat * smoothstep(1.0, 0.2, r), rim * (0.7 + 0.3 * n));
        gl_FragColor = vec4(ramp(t) * (0.4 + 2.4 * t * t) * uIntensity, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
}
