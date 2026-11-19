// FIREWRAITH · classic · steam: a `douse` op (the Douser's bucket, dawn) reads as a quick puff of
// pale grey-white steam where fire is actually removed. CPU puffs (≤ 256), spawned from the read-back grid inside the
// douse radius (only cells that were hot), rising and swelling for ≈ 1–1.6 s; drawn after the composite as soft noisy
// billboards with a soft depth test (`smooth`) or on the fire-pixel grid with two flat alpha steps (`hybrid`).
import * as THREE from 'three';
import { W } from './world.js';
import { DEPTH_GLSL } from './volume.js';

const MAX = 256;
/** Steam knobs (FLUID.md "Knobs"). */
export const STEAM = { perOp: 14, heatMin: 0.12, rise: 1.6, life: [0.9, 1.6], size: [0.4, 1.8], alpha: 0.3, color: [0.3, 0.33, 0.35] };

const VERT = /* glsl */`
attribute vec4 aP; attribute vec4 aD;
varying vec2 vC; varying float vViewZ; varying float vSeed; varying float vAge; varying float vAmt;
void main() {
  vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
  float a = aD.y * 6.2831;
  mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  vC = position.xy;
  mv.xy += R * position.xy * aP.w;
  vViewZ = -mv.z; vSeed = aD.y; vAge = aD.x; vAmt = aD.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec2 uRes; uniform sampler2D uNoise; uniform float uTime; uniform float uAlpha; uniform vec3 uColor; uniform float uPix;
varying vec2 vC; varying float vViewZ; varying float vSeed; varying float vAge; varying float vAmt;
${DEPTH_GLSL}
void main() {
  vec2 fc = gl_FragCoord.xy;
#ifdef HYBRID
  fc = (floor(fc / uPix) + 0.5) * uPix;
#endif
  float sceneZ = viewDepthAt(fc / uRes);
  float vis = 1.0 - smoothstep(-0.3, 0.6, vViewZ - sceneZ);   // soft against the ground and walls
  if (vis <= 0.0) discard;
  float n = texture2D(uNoise, vC * 0.3 + vec2(vSeed * 7.0, vSeed * 3.0 - uTime * 0.25)).r;
  float n2 = texture2D(uNoise, vC * 0.7 + vec2(vSeed * 2.0 + uTime * 0.2, vSeed * 5.0)).g;
  float r = length(vC) + (n - 0.5) * 0.55 + (n2 - 0.5) * 0.25;
  float m = (1.0 - smoothstep(0.1, 1.0, r)) * (0.55 + 0.45 * n2);   // wispy, not a solid dome
  float life = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge));   // a quick puff: in, then thins out
  float a = m * life * vis * uAlpha * vAmt * smoothstep(0.4, 2.0, vViewZ);
#ifdef HYBRID
  a = a < 0.12 ? 0.0 : (a < 0.3 ? 0.22 : 0.42);
#endif
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColor * (0.85 + 0.3 * n2), a);
}`;

export class Steam {
  /** @param {THREE.WebGLRenderer} renderer @param {{ noise: THREE.Texture, depthU: any }} o */
  constructor(renderer, { noise, depthU }) {
    this.renderer = renderer;
    this.pos = new Float32Array(MAX * 3); this.vel = new Float32Array(MAX * 3);
    this.age = new Float32Array(MAX); this.life = new Float32Array(MAX); this.seed = new Float32Array(MAX); this.amt = new Float32Array(MAX);
    this.alive = 0; this.time = 0; this.style = 'smooth'; this._rng = 777;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.aP); geo.setAttribute('aD', this.aD);
    geo.instanceCount = 0;
    this.uniforms = { ...depthU, uRes: { value: new THREE.Vector2(1, 1) }, uNoise: { value: noise }, uTime: { value: 0 }, uAlpha: { value: STEAM.alpha },
      uColor: { value: new THREE.Vector3(...STEAM.color) }, uPix: { value: 4 } };
    this.mats = {};
    for (const st of ['smooth', 'hybrid']) {
      this.mats[st] = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, defines: st === 'hybrid' ? { HYBRID: 1 } : {},
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        depthTest: false, depthWrite: false, transparent: true,
      });
    }
    this.mesh = new THREE.Mesh(geo, this.mats.smooth);
    this.mesh.frustumCulled = false;
  }

  _rand() { this._rng = (this._rng * 1664525 + 1013904223) >>> 0; return this._rng / 4294967296; }

  setStyle(s) { this.style = s === 'hybrid' ? 'hybrid' : 'smooth'; this.mesh.material = this.mats[this.style]; }

  /**
   * A douse at (x, z) with radius r: puffs where the read-back says the ground was hot (heat(x, z) 0..1).
   * @param {number} x @param {number} z @param {number} r @param {(x:number,z:number)=>number} heatAt @param {{x:number,z:number}} [wind] @param {number} [cap]
   */
  douse(x, z, r, heatAt, wind, cap = STEAM.perOp, seg = null) {
    const cand = [];
    const step = Math.max(0.7, r / 6);
    if (seg) {   // a line (the Rainmother's tide): sample along it, cap scaled by its length
      const L = Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0), n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k <= n; k++) for (let o = -r; o <= r + 1e-6; o += step) {
        const u = k / n, nx = -(seg.z1 - seg.z0) / (L || 1), nz = (seg.x1 - seg.x0) / (L || 1);
        const px = seg.x0 + (seg.x1 - seg.x0) * u + nx * o, pz = seg.z0 + (seg.z1 - seg.z0) * u + nz * o, h = heatAt(px, pz);
        if (h >= STEAM.heatMin) cand.push([px, pz, h]);
      }
      cap = Math.min(MAX, Math.round(cap * Math.max(1, L / (4 * r))));
    } else for (let dz = -r; dz <= r + 1e-6; dz += step) for (let dx = -r; dx <= r + 1e-6; dx += step) {
      if (dx * dx + dz * dz > r * r) continue;
      const h = heatAt(x + dx, z + dz);
      if (h >= STEAM.heatMin) cand.push([x + dx, z + dz, h]);
    }
    if (!cand.length) return 0;
    const n = Math.min(cap, Math.ceil(cand.length * 1.5), MAX - this.alive);
    for (let k = 0; k < n; k++) {
      const c = cand[Math.floor(this._rand() * cand.length)];
      const i = this.alive++, p = i * 3;
      const px = c[0] + (this._rand() - 0.5) * step, pz = c[1] + (this._rand() - 0.5) * step;
      this.pos[p] = px; this.pos[p + 1] = W.groundHeight(px, pz) + 0.2 + this._rand() * 0.5; this.pos[p + 2] = pz;
      this.vel[p] = (wind?.x || 0) * 0.5 + (this._rand() - 0.5) * 0.8;
      this.vel[p + 1] = STEAM.rise * (0.7 + 0.6 * this._rand());
      this.vel[p + 2] = (wind?.z || 0) * 0.5 + (this._rand() - 0.5) * 0.8;
      this.age[i] = 0; this.life[i] = STEAM.life[0] + (STEAM.life[1] - STEAM.life[0]) * this._rand();
      this.seed[i] = this._rand(); this.amt[i] = Math.min(1, 0.45 + c[2]);
    }
    return n;
  }

  update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    let n = 0;
    const P = this.pos, V = this.vel;
    for (let i = 0; i < this.alive; i++) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) continue;
      const k = i * 3, m = n * 3;
      V[k + 1] *= Math.exp(-0.9 * dt); V[k] *= Math.exp(-0.6 * dt); V[k + 2] *= Math.exp(-0.6 * dt);
      P[m] = P[k] + V[k] * dt; P[m + 1] = P[k + 1] + V[k + 1] * dt; P[m + 2] = P[k + 2] + V[k + 2] * dt;
      V[m] = V[k]; V[m + 1] = V[k + 1]; V[m + 2] = V[k + 2];
      this.age[n] = a; this.life[n] = this.life[i]; this.seed[n] = this.seed[i]; this.amt[n] = this.amt[i];
      n++;
    }
    this.alive = n;
    const ap = this.aP.array, ad = this.aD.array;
    for (let i = 0; i < n; i++) {
      const k = i * 3, j = i * 4, u = this.age[i] / this.life[i];
      ap[j] = P[k]; ap[j + 1] = P[k + 1]; ap[j + 2] = P[k + 2];
      ap[j + 3] = STEAM.size[0] + (STEAM.size[1] - STEAM.size[0]) * Math.sqrt(u);
      ad[j] = u; ad[j + 1] = this.seed[i]; ad[j + 2] = this.amt[i]; ad[j + 3] = 0;
    }
    this.aP.clearUpdateRanges(); this.aP.addUpdateRange(0, n * 4); this.aP.needsUpdate = true;
    this.aD.clearUpdateRanges(); this.aD.addUpdateRange(0, n * 4); this.aD.needsUpdate = true;
    this.mesh.geometry.instanceCount = n;
  }

  reset() { this.alive = 0; this.mesh.geometry.instanceCount = 0; }

  render(target, camera, width, height, pix) {
    if (!this.alive) return;
    this.uniforms.uRes.value.set(width, height); this.uniforms.uTime.value = this.time; this.uniforms.uPix.value = pix;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.mesh, camera);
  }

  dispose() { this.mesh.geometry.dispose(); for (const m of Object.values(this.mats)) m.dispose(); }
}
