// A swept lattice in the spirit of Fuller et al. The lattice carries radial coordinates and flight age;
// view-aligned slices fill it with a procedural flame profile.
import * as THREE from 'three';
import { CAPACITY } from './emitter.js';
import { DEPTH_GLSL, depthUniforms, makeNoiseTexture, NOISE_GLSL, setDepthCamera } from '../../src/kit/webgl2/index.js';

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const EDGES = [[0,1], [1,2], [2,3], [3,0], [4,5], [5,6], [6,7], [7,4], [0,4], [1,5], [2,6], [3,7]];
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const STRIDE = 8;
const MAX_VERTICES = CAPACITY * 32 * 12;
const NOZZLE_RADIUS = 0.076;
const BODY_RADIUS = 0.49;
const BREAK_ANGLE = 0.88;
const KNOT_STRIDE = 3;

const VERT = /* glsl */`
attribute vec4 aProfile;
attribute float aRadius;
varying vec4 vProfile;
varying float vRadius, vDepth;
void main() {
  vProfile = aProfile;
  vRadius = aRadius;
  vDepth = -position.z;
  gl_Position = projectionMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
${DEPTH_GLSL}
${NOISE_GLSL}
uniform sampler2D uProfile;
uniform vec2 uResolution;
uniform float uTime, uSpacing, uSpeed;
varying vec4 vProfile;
varying float vRadius, vDepth;

void main() {
  float sceneDepth = viewDepthAt(gl_FragCoord.xy / uResolution);
  if (vDepth > sceneDepth) discard;
  float radial = length(vProfile.xy);
  if (radial >= 1.0) discard;
  float age = vProfile.z;
  float mature = smoothstep(0.02, 0.22, age);
  // Use metres in noise space so the detail keeps its scale as the lattice tapers or bends.
  float twist = age * 13.0 - uTime * 2.1;
  mat2 turn = mat2(cos(twist), sin(twist), -sin(twist), cos(twist));
  vec3 p = vec3(turn * vProfile.xy * vRadius, age * uSpeed - uTime * 5.2);
  float large = noise3(p * 4.2);
  float medium = noise3(p * 9.3 + vec3(8.7, 0.3, 16.0));
  float small = noise3(p * 20.0 + vec3(5.3, 9.2, 0.5));
  float turbulence = 0.54 * large + 0.31 * medium + 0.15 * small;
  float warped = radial + (0.50 - large) * mix(0.10, 0.93, mature) + (0.51 - medium) * 0.37 * mature;
  float axial = clamp((age + (turbulence - 0.5) * 0.13) / 0.44, 0.0, 1.0);
  vec2 profile = texture2D(uProfile, vec2(clamp(warped, 0.0, 1.0), axial)).rg;
  float breakup = mix(0.92, 0.045 + 1.85 * smoothstep(0.39, 0.66, turbulence), mature);
  float density = profile.x * breakup * vProfile.w;
  density *= 1.0 - smoothstep(0.88, 1.0, radial);
  float opacity = 1.0 - exp(-density * 10.5 * uSpacing);
  // Narrow ridges in the noise brighten the folds around the cooler orange body.
  float ridge = 1.0 - smoothstep(0.012, 0.095, abs(medium - 0.54));
  float fold = ridge * smoothstep(0.18, 0.75, radial);
  float heat = profile.y + mature * ((turbulence - 0.52) * 0.77 - 0.14 + fold * 0.54);
  vec3 color = mix(vec3(0.90, 0.067, 0.004), vec3(2.55, 0.63, 0.025), smoothstep(0.16, 0.67, heat));
  color = mix(color, vec3(3.9, 2.38, 0.42), smoothstep(0.66, 0.97, heat));
  gl_FragColor = vec4(color * opacity, opacity);
}
`;

const smooth = (x, lo, hi) => THREE.MathUtils.smoothstep(x, lo, hi);

/** The radial/longitudinal fire profile. Red is density and green is heat. */
function makeProfile() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const age = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const r = x / (size - 1);
      const density = (1 - smooth(r, 0.17, 0.92)) * (1 - 0.31 * age);
      const heat = 0.29 + (1 - smooth(r, 0.04, 0.83)) * (0.69 - 0.27 * age);
      const i = 4 * (y * size + x);
      data[i] = Math.round(density * 255);
      data[i + 1] = Math.round(heat * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function node() {
  return { p: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, ring: new Float32Array(4 * STRIDE) };
}

function makeSlice() {
  return {
    depth: 0,
    points: Array.from({ length: 12 }, () => new Float32Array(STRIDE)),
    winding: [],
  };
}

/** Intersect one eight-corner lattice section with a plane in view space. */
function intersectSlice(slice, a, b, z) {
  const { points, winding } = slice;
  winding.length = 0;
  let cx = 0, cy = 0;
  for (const [i, j] of EDGES) {
    const from = i < 4 ? a : b, to = j < 4 ? a : b;
    const k = (i % 4) * STRIDE, l = (j % 4) * STRIDE;
    const pz = from[k + 2], qz = to[l + 2];
    if ((pz < z) === (qz < z)) continue;
    const t = (z - pz) / (qz - pz);
    const p = points[winding.length];
    for (let c = 0; c < STRIDE; c++) p[c] = THREE.MathUtils.lerp(from[k + c], to[l + c], t);
    p[2] = z;
    winding.push(p);
    cx += p[0];
    cy += p[1];
  }
  if (winding.length < 3) return false;
  cx /= winding.length;
  cy /= winding.length;
  winding.sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
  slice.depth = -z;
  return true;
}

export class CurvedVolume {
  constructor(speed) {
    this.sorted = [];
    this.nodes = Array.from({ length: CAPACITY + 1 }, node);
    this.knots = [];
    this.slices = [];
    this.visible = [];
    this.profile = makeProfile();
    this.noise = makeNoiseTexture(716);
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(MAX_VERTICES * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(MAX_VERTICES * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.radius = new THREE.BufferAttribute(new Float32Array(MAX_VERTICES), 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aProfile', this.uv);
    this.geometry.setAttribute('aRadius', this.radius);
    this.geometry.setDrawRange(0, 0);
    this.depth = depthUniforms();
    this.uniforms = {
      ...this.depth, uResolution: { value: new THREE.Vector2() },
      uProfile: { value: this.profile }, uNoise: { value: this.noise },
      uTime: { value: 0 }, uSpacing: { value: 0.07 }, uSpeed: { value: speed },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.tangent = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.position3 = new THREE.Vector3();
    this.count = 0;
    this.chains = 0;
    this.vertices = 0;
    this.sections = 0;
  }

  collect(stream) {
    const { sorted, nodes } = this;
    const { emitter, current } = stream;
    sorted.length = emitter.count;
    for (let i = 0; i < emitter.count; i++) sorted[i] = emitter.pool[i];
    sorted.sort((a, b) => a.age - b.age);
    this.count = 0;
    if (!sorted.length) return;

    // Keep the youngest section attached to the drawn muzzle while the trigger is held.
    if (current.on && sorted[0].age <= 0.025) {
      const n = nodes[this.count++];
      n.p.copy(current.origin);
      n.v.copy(current.dir);
      n.age = 0;
    }
    for (const particle of sorted) {
      const n = nodes[this.count++];
      emitter.at(n.p, particle, particle.age);
      n.v.copy(particle.velocity).normalize();
      n.age = particle.age;
    }
  }

  fillRing(knot, tangent, camera, fade, taper) {
    const { right, up, position3 } = this;
    right.crossVectors(tangent, Math.abs(tangent.y) < 0.96 ? UP : X).normalize();
    up.crossVectors(right, tangent).normalize();
    const grow = smooth(knot.age, 0.015, 0.26);
    const radius = THREE.MathUtils.lerp(NOZZLE_RADIUS, BODY_RADIUS, grow) * taper;
    const { ring, p } = knot;
    for (let i = 0; i < 4; i++) {
      const [rx, ry] = CORNERS[i];
      position3.copy(p).addScaledVector(right, rx * radius).addScaledVector(up, ry * radius).applyMatrix4(camera.matrixWorldInverse);
      ring.set([position3.x, position3.y, position3.z, rx, ry, knot.age, fade, radius], i * STRIDE);
    }
  }

  sliceChain(start, end, attached, camera, spacing) {
    if (end === start) return;
    const { nodes, knots, visible, slices, tangent } = this;
    knots.length = 0;
    for (let i = start; i < end; i += KNOT_STRIDE) knots.push(nodes[i]);
    knots.push(nodes[end]);
    const firstAge = knots[0].age, lastAge = knots.at(-1).age;
    for (let i = 0; i < knots.length; i++) {
      const k = knots[i];
      const left = knots[Math.max(0, i - 1)], right = knots[Math.min(knots.length - 1, i + 1)];
      tangent.subVectors(right.p, left.p).normalize();
      if (tangent.lengthSq() < 1e-8) tangent.copy(k.v);
      const fadeLength = Math.min(0.028, (lastAge - firstAge) / 2);
      const leading = attached ? 0.5 + 0.5 * smooth(k.age, 0, 0.016) : smooth(k.age - firstAge, -0.002, fadeLength);
      // The plume tapers out at its oldest particles and short runs remain legible.
      const tip = smooth(lastAge - k.age, 0, fadeLength);
      this.fillRing(k, tangent, camera, leading * tip, 0.54 + 0.46 * tip);
    }

    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1].ring, b = knots[i].ring;
      let min = Infinity, max = -Infinity;
      for (let k = 2; k < a.length; k += STRIDE) {
        min = Math.min(min, -a[k], -b[k]);
        max = Math.max(max, -a[k], -b[k]);
      }
      const from = Math.ceil(Math.max(min, camera.near) / spacing - 0.5);
      const to = Math.floor(Math.min(max, camera.far) / spacing - 0.5);
      for (let j = from; j <= to; j++) {
        const s = slices[visible.length] ?? (slices[visible.length] = makeSlice());
        if (intersectSlice(s, a, b, -(j + 0.5) * spacing)) visible.push(s);
      }
      this.sections++;
    }
    this.chains++;
  }

  draw(renderer, camera, depthTex, width, height, stream, spacing) {
    this.sections = this.chains = this.vertices = 0;
    this.collect(stream);
    if (this.count < 2) return;
    this.visible.length = 0;
    camera.updateMatrixWorld();

    let start = 0;
    for (let i = 1; i < this.count; i++) {
      const a = this.nodes[i - 1], b = this.nodes[i];
      const discontinuous = b.age - a.age > 0.018 || a.p.distanceToSquared(b.p) > 0.30 || a.v.dot(b.v) < BREAK_ANGLE;
      if (!discontinuous) continue;
      this.sliceChain(start, i - 1, start === 0 && this.nodes[0].age === 0, camera, spacing);
      start = i;
    }
    this.sliceChain(start, this.count - 1, start === 0 && this.nodes[0].age === 0, camera, spacing);
    this.visible.sort((a, b) => b.depth - a.depth);
    let vertices = 0;
    for (const { winding } of this.visible) {
      for (let i = 1; i + 1 < winding.length && vertices + 3 <= MAX_VERTICES; i++) {
        for (const p of [winding[0], winding[i], winding[i + 1]]) {
          this.position.setXYZ(vertices, p[0], p[1], p[2]);
          this.uv.setXYZW(vertices, p[3], p[4], p[5], p[6]);
          this.radius.setX(vertices++, p[7]);
        }
      }
    }
    this.vertices = vertices;
    if (!vertices) return;
    for (const attr of [this.position, this.uv, this.radius]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, vertices * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, vertices);
    this.uniforms.uTime.value = stream.time;
    this.uniforms.uSpacing.value = spacing;
    this.uniforms.uResolution.value.set(width, height);
    setDepthCamera(this.depth, camera, depthTex);
    renderer.render(this.mesh, camera);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.noise.dispose();
    this.profile.dispose();
  }
}
