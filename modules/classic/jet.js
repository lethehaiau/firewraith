// FIREWRAITH · classic · the Ember Lance's airborne jet: CPU particles (≤ 640) shot from the nozzle along `dir` with
// gravity (the game's ballistic arc), expanding as they fly, skidding on the ground; drawn as noisy billboards into the
// volume target's fire channel (so both styles colour and pixelate them like the ground fire) with a soft depth test.
// The sim emits the `stream` ops where the jet lands; this module is only the look. FLUID.md "The jet".
import * as THREE from 'three';
import { W } from './world.js';
import { DEPTH_GLSL } from './volume.js';
import { MRT2, hueVec } from './gl.js';

const MAX = 640;
// Physics = the game's lanceArc (VALLEYWARD src/sim/weapons.js, WEAPON.lance: speed 16 m/s, gravity 14 m/s², no drag,
// cut at the horizontal range, after which the stream rains down), so the visual lands where the sim emits its `stream`
// ops; create() copies speed and gravity from host.world.lance.
// A visible ribbon from the nozzle: size0 0.14 and gain 2.3 (raised from 0.05 and 1.9), no near halving of the alpha.
export const JET = { rate: 900, speed: 16, gravity: 14, rain: 0.18, spread: 0.035, size0: 0.14, size1: 0.6, gain: 2.3, alpha: 0.46 };

const VERT = /* glsl */`
attribute vec4 aP; attribute vec4 aD;
varying vec2 vC; varying float vHeat; varying float vViewZ; varying float vSeed; varying float vAge;
void main() {
  vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
  float a = aD.y * 6.2831 + aD.x * 2.0;
  mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  vC = position.xy;
  mv.xy += R * position.xy * aP.w;
  vViewZ = -mv.z; vHeat = aD.z; vSeed = aD.y; vAge = aD.x;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = MRT2 + /* glsl */`
uniform vec2 uVolRes; uniform sampler2D uNoise; uniform float uTime; uniform float uGain; uniform float uAlpha; uniform vec4 uHue;
varying vec2 vC; varying float vHeat; varying float vViewZ; varying float vSeed; varying float vAge;
${DEPTH_GLSL}
void main() {
  float sceneZ = viewDepthAt(gl_FragCoord.xy / uVolRes);
  float vis = 1.0 - smoothstep(-0.15, 0.25, vViewZ - sceneZ);
  if (vis <= 0.0) discard;
  float n = texture2D(uNoise, vC * 0.22 + vec2(vSeed * 7.0, vSeed * 3.0 - uTime * 0.9)).r;
  float n2 = texture2D(uNoise, vC * 0.5 + vec2(vSeed * 2.0 + uTime * 0.4, vSeed * 5.0)).g;
  float r = length(vC) + (n - 0.5) * 0.75 + (n2 - 0.5) * 0.35;
  float m = 1.0 - smoothstep(0.15, 0.95, r);
  if (m <= 0.0) discard;
  // translucent puffs: hot and bright near the nozzle, an orange body, a dark red ragged tail
  float a = m * vis * uAlpha * mix(0.85, 1.0, smoothstep(0.25, 1.2, vViewZ)) * (1.0 - 0.5 * smoothstep(0.6, 1.0, vAge));
  float core = 1.0 - smoothstep(0.0, 0.85, length(vC) + (n - 0.5) * 0.5);
  // R = coverage, G = R × temperature (the volume's layout): white-yellow at the nozzle core, orange body, crimson tail
  float e = a * vHeat * uGain * (0.55 + 0.9 * core);
  float tj = clamp(0.2 + 0.45 * vHeat + 0.4 * core * vHeat, 0.0, 1.0);
  gl_FragColor = vec4(e, e * tj, 0.0, a);
  // the volume's hue output: the Lance's hue mass; its alpha only fades what lies behind (blendSrcAlpha 0)
  pc_fragHue = vec4(uHue.xyz * e, a);
}`;

/**
 * Where the jet's centreline lands (same physics as the particles and the game's lanceArc),
 * so the sim's `stream` ops can sit exactly under the visual. Returns { x, y, z, t, hit } (hit = false when the jet ran
 * out of range in the air; then the point is where it ends).
 * @param {{x:number,y:number,z:number}} origin @param {{x:number,y:number,z:number}} dir unit vector @param {number} range
 */
export function jetLanding(origin, dir, range) {
  const speed = JET.speed, h = 1 / 240;
  let x = origin.x, y = origin.y, z = origin.z, vx = dir.x * speed, vy = dir.y * speed, vz = dir.z * speed, t = 0;
  while (t < 3) {
    vy -= JET.gravity * h;
    x += vx * h; y += vy * h; z += vz * h; t += h;
    const g = W.groundHeight(x, z);
    if (y <= g) return { x, y: g, z, t, hit: true };
    if (Math.hypot(x - origin.x, z - origin.z) >= range) return { x, y, z, t, hit: false };
  }
  return { x, y, z, t, hit: false };
}

export class Jet {
  /** @param {THREE.WebGLRenderer} renderer @param {{ noise: THREE.Texture, depthU: any }} o */
  constructor(renderer, { noise, depthU }) {
    this.renderer = renderer;
    this.pos = new Float32Array(MAX * 3); this.vel = new Float32Array(MAX * 3);
    this.age = new Float32Array(MAX); this.life = new Float32Array(MAX); this.seed = new Float32Array(MAX);
    this.org = new Float32Array(MAX * 2); this.cut = new Float32Array(MAX); this.range = new Float32Array(MAX);
    this.alive = 0; this.carry = 0; this.time = 0;
    this.cmd = { on: false, origin: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), range: 11, hue: null };
    this.streamHue = 'orange';   // the hue of the last stream op (events()), used when set() names none
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.aP); geo.setAttribute('aD', this.aD);
    geo.instanceCount = 0;
    this.uniforms = { ...depthU, uVolRes: { value: new THREE.Vector2(1, 1) }, uNoise: { value: noise }, uTime: { value: 0 }, uGain: { value: JET.gain }, uAlpha: { value: JET.alpha }, uHue: { value: new THREE.Vector4() } };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, glslVersion: THREE.GLSL3,
      // premultiplied "over": overlapping puffs saturate at their own heat instead of summing to white. Alpha: the
      // volume stores the transmittance T, so T' = T (1 − a) (src alpha × 0); the same factor fades the hue
      // output's fourth channel (lilac) behind the puff. The jet itself can therefore be any hue but lilac (lilac → violet).
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      depthTest: false, depthWrite: false, transparent: true,
    }));
    this.mesh.frustumCulled = false;
    this._rng = 12345;
  }

  _rand() { this._rng = (this._rng * 1664525 + 1013904223) >>> 0; return this._rng / 4294967296; }

  /** @param {{ on: boolean, origin?: THREE.Vector3, dir?: THREE.Vector3, range?: number, t?: number, hue?: string }} c
   *  hue: the Lance's hue ('green' with the Witchfire Wick); omitted = the hue of the last stream op. */
  set(c) {
    this.cmd.on = !!c.on;
    if ('hue' in c) this.cmd.hue = c.hue || null;
    if (c.origin) this.cmd.origin.copy(c.origin);
    if (c.dir) this.cmd.dir.copy(c.dir).normalize();
    if (c.range) this.cmd.range = c.range;
  }

  update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    const P = this.pos, V = this.vel, c = this.cmd;
    // integrate + compact
    let n = 0;
    for (let i = 0; i < this.alive; i++) {
      let a = this.age[i] + dt;
      const k = i * 3;
      V[k + 1] -= JET.gravity * dt;
      P[k] += V[k] * dt; P[k + 1] += V[k + 1] * dt; P[k + 2] += V[k + 2] * dt;
      if (!this.cut[i] && Math.hypot(P[k] - this.org[i * 2], P[k + 2] - this.org[i * 2 + 1]) >= this.range[i]) {
        this.cut[i] = 1; V[k] *= JET.rain; V[k + 2] *= JET.rain; V[k + 1] = Math.min(V[k + 1], 0);   // past the range: it rains down
      }
      const g = W.groundHeight(P[k], P[k + 2]) + 0.12;
      if (P[k + 1] < g) { P[k + 1] = g; V[k + 1] = Math.max(0.4, -V[k + 1] * 0.1); V[k] *= 0.8; V[k + 2] *= 0.8; a += dt * 1.5; }
      if (a >= this.life[i]) continue;
      if (n !== i) {
        const m = n * 3;
        P[m] = P[k]; P[m + 1] = P[k + 1]; P[m + 2] = P[k + 2]; V[m] = V[k]; V[m + 1] = V[k + 1]; V[m + 2] = V[k + 2];
        this.life[n] = this.life[i]; this.seed[n] = this.seed[i];
        this.org[n * 2] = this.org[i * 2]; this.org[n * 2 + 1] = this.org[i * 2 + 1]; this.cut[n] = this.cut[i]; this.range[n] = this.range[i];
      }
      this.age[n] = a; n++;
    }
    this.alive = n;
    // emit
    if (c.on) {
      this.carry += JET.rate * dt;
      const speed = JET.speed;
      const flight = jetLanding(c.origin, c.dir, c.range).t;
      while (this.carry >= 1 && this.alive < MAX) {
        this.carry -= 1;
        const i = this.alive++, k = i * 3;
        const sx = (this._rand() - 0.5) * 2 * JET.spread, sy = (this._rand() - 0.5) * 2 * JET.spread, sz = (this._rand() - 0.5) * 2 * JET.spread;
        const f = this._rand();   // spread the births over the frame
        V[k] = (c.dir.x + sx) * speed; V[k + 1] = (c.dir.y + sy) * speed; V[k + 2] = (c.dir.z + sz) * speed;
        P[k] = c.origin.x + V[k] * dt * f; P[k + 1] = c.origin.y + V[k + 1] * dt * f; P[k + 2] = c.origin.z + V[k + 2] * dt * f;
        this.age[i] = dt * f;
        this.life[i] = flight * (1.2 + 0.35 * this._rand()) + 0.15;
        this.org[i * 2] = c.origin.x; this.org[i * 2 + 1] = c.origin.z; this.cut[i] = 0; this.range[i] = c.range;
        this.seed[i] = this._rand();
      }
      if (this.carry > 1) this.carry = 0;
    } else this.carry = 0;
    // upload
    const ap = this.aP.array, ad = this.aD.array;
    for (let i = 0; i < this.alive; i++) {
      const k = i * 3, j = i * 4, u = Math.min(1, this.age[i] / this.life[i]);
      ap[j] = P[k]; ap[j + 1] = P[k + 1]; ap[j + 2] = P[k + 2];
      ap[j + 3] = JET.size0 + (JET.size1 - JET.size0) * Math.pow(u, 0.75);
      ad[j] = u; ad[j + 1] = this.seed[i]; ad[j + 2] = Math.max(0.18, 1 - Math.pow(u, 0.8) * 0.85) * Math.min(1, u * 10 + 0.35); ad[j + 3] = 0;
    }
    this.aP.clearUpdateRanges(); this.aP.addUpdateRange(0, this.alive * 4); this.aP.needsUpdate = true;
    this.aD.clearUpdateRanges(); this.aD.addUpdateRange(0, this.alive * 4); this.aD.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.alive;
  }

  /** Drop every particle (a fresh night). */
  reset() { this.alive = 0; this.carry = 0; this.mesh.geometry.instanceCount = 0; }

  /** Draw into the (bound) volume target. */
  render(volumeRT, camera) {
    if (!this.alive) return;
    this.uniforms.uVolRes.value.set(volumeRT.width, volumeRT.height);
    this.uniforms.uTime.value = this.time;
    let h = this.cmd.hue || this.streamHue || 'orange';
    if (h === 'lilac') h = 'violet';   // the hue output's 4th channel is the blend's alpha here (see the material)
    this.uniforms.uHue.value.fromArray(hueVec(h));
    this.renderer.setRenderTarget(volumeRT);
    this.renderer.render(this.mesh, camera);
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
