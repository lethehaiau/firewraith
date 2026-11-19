// FIREWRAITH · classic · the grid solver on the ground plane over W.area (FLUID.md "How it works").
// Fields (half-float ping-pong targets): velocity V (xy = m/s along +X/+Z), curl, divergence, pressure P, and the
// scalars S = (fuel, fire, smoke, heat). Per sub-step: splat ops → advect V → vorticity confinement → divergence (with
// the combustion expansion as a source) → Jacobi pressure (warm-started) → project → advect + react S.
// Per frame: S → a 64² summary (RGBA8: heat max, fuel, fire, smoke) for the read-back, then a blurred 64² light map.
// Coloured fire: S is a two-attachment target; textures[1] = H, the hue field = fire-weighted hue
// mass (violet, blue, green, lilac; orange = fire − their sum). Splatted with the fire, advected and reacted in the same
// pass as S (MRT), so a hue rides exactly with its fire; where hues meet they blend by fire weight.
// Weather: rain (`setRain`) scales the reaction constants (CPU side, no shader cost); `douse` may be a
// line (x0..x1, the Rainmother's tide); `swirl` ops (her whirlpools) add a tangential flow and a sink: V.z carries the
// sink from the splat through advect + vorticity into the divergence, where it survives the projection (an inward pull
// would otherwise be projected away), so fire and smoke are dragged into a spiral, quenched at the core.
import * as THREE from 'three';
import { W } from './world.js';
import { FIRE_OP } from '../../src/api/events.js';
import { makeTarget, PingPong, Quad, passMaterial, hueVec, MRT2 } from './gl.js';

export const MAX_SPLATS = 4096;
const ZERO4 = [0, 0, 0, 0];

/** Fire-light colours (linear, before × 1.5) per hue: orange, violet, blue, green, lilac. Mutable (the bench tunes
 *  them); FIRE_LIGHT_COLOR (index.js, and the game's firelight.js) is the orange one. Picked from the hue bodies of the
 *  ramps in volume.js and levelled so a coloured fire lights the walls about as strongly as an orange one. */
export const LIGHT_COLS = [
  [1.0, 0.42, 0.13],
  [0.62, 0.2, 1.0],
  [0.12, 0.5, 1.0],
  [0.3, 0.95, 0.14],
  [0.78, 0.48, 1.0],
];

/** The physical knobs (FLUID.md "Knobs"). Mutable: the preview's sliders and setQuality write here. */
export const KNOBS = {
  velDecay: 0.35,      // 1/s velocity damping
  windPull: 0.6,       // 1/s relaxation of the flow toward the wind
  curl: 22,            // vorticity confinement strength
  turb: 26,            // m/s² churn force per unit fire (noise, 7 m features)
  expand: 0.26,        // m/s outflow per unit of fire (combustion expansion, a divergence source)
  ignite: 0.18,        // heat at which fuel starts to burn
  burnRate: 0.075,     // fuel burnt per second at full ignition (1 = a full trough cell → ≈ 13 s)
  fireYield: 20,       // fire made per unit of fuel burnt
  fireDecay: 1.15,     // 1/s fire decay (no fuel: a burst fades in ≈ 2–3 s)
  smokeYield: 0.9,     // smoke made per unit of fire lost
  smokeDecay: 0.28,    // 1/s smoke dissipation
  heatGain: 4.0,       // heat per unit of fire per second
  cool: 2.2,           // 1/s heat loss
  heatDiffuse: 0.3,    // per-step mix toward the 4-neighbour mean
  spread: 8,           // heat per second given to oil by flames ≈ 0.4 m away (fire runs along a trough ≈ 2 m/s)
  spreadDist: 0.4,     // m
  stick: 0.75,         // how much flames and heat on oil stay put instead of drifting with the flow
  pressureKeep: 0.85,  // warm start: fraction of last step's pressure kept
  // rain (0..1, `setRain`) at full strength: fire decays ×(1 + rainDecay), fuel burns ×(1 − rainBurn), heat
  // cools ×(1 + rainCool), ignition needs + rainIgnite more heat; ≈ 0.45 × the fire on oil; more steam
  rainDecay: 0.6, rainBurn: 0.28, rainCool: 0.45, rainIgnite: 0.06, rainSmoke: 0.6,
  rainLight: 0.45,     // the fire light dims by this at full rain
};

/** Per-op deposit constants (what one op adds, before its own `amount`). */
export const DEPOSIT = {
  stream: { fire: 0.55, heat: 0.6, fuel: 0.01, push: 0.35, minR: 0.6 },
  burst: { fire: 2.2, heat: 1.4, smoke: 0.5 },
  fuel: { fuel: 1.0 },
  ember: { fire: 0.4, heat: 0.7, r: 0.5 },
  douse: { k: 12 },
  swirl: { core: 0.3, quench: 0.9, wash: 0.014 },   // whirlpool: the inner 30 % of r is quenched (k per tick, × amount); the water washes the oil away (fuel per tick over r), so burning oil is dragged into the spiral instead of sitting on its oil
};

const COMMON = /* glsl */`
varying vec2 vUv;
uniform vec2 uTexel;
`;

const ADVECT_VEL = COMMON + /* glsl */`
uniform sampler2D uVel; uniform sampler2D uObs;
uniform float uDt; uniform float uDecay; uniform float uWindPull; uniform vec2 uWind; uniform float uSize;
void main() {
  vec4 v0 = texture2D(uVel, vUv);
  vec2 v = v0.xy;
  vec2 p = vUv - uDt * v / uSize;
  vec2 a = texture2D(uVel, p).xy;
  a *= uDecay;
  a += (uWind - a) * min(1.0, uWindPull * uDt);
  vec2 e = min(vUv, 1.0 - vUv);
  a = mix(uWind, a, smoothstep(0.0, 3.0 * uTexel.x, min(e.x, e.y)));
  a *= 1.0 - step(0.5, texture2D(uObs, vUv).r);
  gl_FragColor = vec4(clamp(a, vec2(-60.0), vec2(60.0)), v0.z, 1.0);   // z: this step's sink (swirl ops), not advected
}`;

const CURL = COMMON + /* glsl */`
uniform sampler2D uVel;
void main() {
  float L = texture2D(uVel, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture2D(uVel, vUv + vec2(uTexel.x, 0.0)).y;
  float T = texture2D(uVel, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture2D(uVel, vUv - vec2(0.0, uTexel.y)).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

const VORTICITY = COMMON + /* glsl */`
uniform sampler2D uVel; uniform sampler2D uCurl; uniform sampler2D uS; uniform sampler2D uObs;
uniform float uDt; uniform float uCurlK; uniform float uTurb; uniform float uTime; uniform sampler2D uNoise;
void main() {
  float L = texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  vec4 s = texture2D(uS, vUv);
  float act = 0.25 + 1.6 * clamp(s.g + 0.35 * s.b, 0.0, 1.0);   // the curls live in the fire and the smoke
  force *= uCurlK * C * act;
  force.y *= -1.0;
  // hot gas churns: a slowly drifting noise force inside the fire (the projection keeps only its swirling part)
  vec2 q = vUv * 0.125;   // 32 noise texels across the 64 m domain: ≈ 2 m eddies, drifting ≈ 1 texel/s
  vec2 nz = vec2(texture2D(uNoise, q + vec2(uTime * 0.0045, 0.0)).b, texture2D(uNoise, q.yx + vec2(0.37, uTime * 0.0037)).a) - 0.5;
  force += nz * uTurb * clamp(s.g, 0.0, 1.5);
  vec4 v0 = texture2D(uVel, vUv);
  vec2 v = v0.xy + force * uDt;
  v *= 1.0 - step(0.5, texture2D(uObs, vUv).r);
  gl_FragColor = vec4(v, v0.z, 1.0);
}`;

const DIVERGENCE = COMMON + /* glsl */`
uniform sampler2D uVel; uniform sampler2D uObs; uniform sampler2D uS; uniform float uExpand;
float solid(vec2 p) { return step(0.5, texture2D(uObs, p).r); }
void main() {
  vec2 C = texture2D(uVel, vUv).xy;
  vec2 pL = vUv - vec2(uTexel.x, 0.0), pR = vUv + vec2(uTexel.x, 0.0);
  vec2 pB = vUv - vec2(0.0, uTexel.y), pT = vUv + vec2(0.0, uTexel.y);
  float L = mix(texture2D(uVel, pL).x, -C.x, solid(pL));
  float R = mix(texture2D(uVel, pR).x, -C.x, solid(pR));
  float B = mix(texture2D(uVel, pB).y, -C.y, solid(pB));
  float T = mix(texture2D(uVel, pT).y, -C.y, solid(pT));
  float div = 0.5 * (R - L + T - B);
  vec4 s = texture2D(uS, vUv);
  div -= uExpand * clamp(s.g, 0.0, 2.0);
  div += texture2D(uVel, vUv).z;   // whirlpool sinks (a convergence the projection keeps)
  gl_FragColor = vec4(div * (1.0 - solid(vUv)), 0.0, 0.0, 1.0);
}`;

const JACOBI = COMMON + /* glsl */`
uniform sampler2D uP; uniform sampler2D uDiv; uniform sampler2D uObs; uniform float uKeep;
float pAt(vec2 p, float c) {
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 0.0;           // open borders: p = 0
  return mix(texture2D(uP, p).x * uKeep, c, step(0.5, texture2D(uObs, p).r));  // walls: no flux
}
void main() {
  float c = texture2D(uP, vUv).x * uKeep;
  float L = pAt(vUv - vec2(uTexel.x, 0.0), c);
  float R = pAt(vUv + vec2(uTexel.x, 0.0), c);
  float B = pAt(vUv - vec2(0.0, uTexel.y), c);
  float T = pAt(vUv + vec2(0.0, uTexel.y), c);
  float d = texture2D(uDiv, vUv).x;
  gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}`;

const PROJECT = COMMON + /* glsl */`
uniform sampler2D uP; uniform sampler2D uVel; uniform sampler2D uObs;
float pAt(vec2 p, float c) {
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 0.0;
  return mix(texture2D(uP, p).x, c, step(0.5, texture2D(uObs, p).r));
}
void main() {
  float c = texture2D(uP, vUv).x;
  float L = pAt(vUv - vec2(uTexel.x, 0.0), c);
  float R = pAt(vUv + vec2(uTexel.x, 0.0), c);
  float B = pAt(vUv - vec2(0.0, uTexel.y), c);
  float T = pAt(vUv + vec2(0.0, uTexel.y), c);
  vec2 v = texture2D(uVel, vUv).xy - 0.5 * vec2(R - L, T - B);
  v *= 1.0 - step(0.5, texture2D(uObs, vUv).r);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;

// Scalars: R fuel (does not move), G fire, B smoke, A heat. Second output: the hue mass H (see the header).
const SCALARS = COMMON + /* glsl */`
uniform sampler2D uS; uniform sampler2D uH; uniform sampler2D uVel; uniform sampler2D uObs;
uniform float uDt; uniform float uSize;
uniform float uIgnite, uBurnRate, uFireYield, uFireDecay, uSmokeYield, uSmokeDecay, uHeatGain, uCool, uHeatDiffuse;
uniform float uSpread, uSpreadOff, uStick;
void main() {
  vec4 s0 = texture2D(uS, vUv);
  vec2 v = texture2D(uVel, vUv).xy;
  vec2 p = vUv - uDt * v / uSize;
  vec4 a = texture2D(uS, p);
  vec2 o = 1.5 * uTexel;
  float hn = 0.25 * (texture2D(uS, p + vec2(o.x, 0.0)).a + texture2D(uS, p - vec2(o.x, 0.0)).a
                   + texture2D(uS, p + vec2(0.0, o.y)).a + texture2D(uS, p - vec2(0.0, o.y)).a);
  float fuel = max(s0.r, 0.0);
  // flames sit on burning oil: on fuel, fire and heat only partly move with the flow
  float stick = clamp(fuel * 4.0, 0.0, uStick);
  float fireRaw = mix(a.g, s0.g, stick);
  float fire = max(fireRaw, 0.0), smoke = max(a.b, 0.0), heat = max(mix(a.a, s0.a, stick), 0.0);
  heat = mix(heat, max(hn, 0.0), uHeatDiffuse);
  // the hue fraction of the advected fire (the mass moves exactly like the fire: same sample, same stick)
  vec4 hm = max(mix(texture2D(uH, p), texture2D(uH, vUv), stick), 0.0);
  vec4 fr = hm / max(fireRaw, 0.02);
  // fire runs across oil: fuel next to flames (≈ 0.4 m away) heats up
  if (fuel > 0.02) {
    vec2 oX = vec2(uSpreadOff, 0.0), oY = vec2(0.0, uSpreadOff);
    float gR = texture2D(uS, vUv + oX).g, gL = texture2D(uS, vUv - oX).g, gT = texture2D(uS, vUv + oY).g, gB = texture2D(uS, vUv - oY).g;
    float fn = max(max(gR, gL), max(gT, gB));
    heat += uSpread * clamp(fn, 0.0, 1.5) * uDt;
    // oil that catches from a neighbour's flame (no flame of its own yet) burns in that flame's hue
    if (fireRaw < 0.05 && fn > 0.02) {
      vec2 o = fn == gR ? oX : (fn == gL ? -oX : (fn == gT ? oY : -oY));
      vec4 nfr = max(texture2D(uH, vUv + o), 0.0) / max(fn, 0.02);
      fr = mix(nfr, fr, smoothstep(0.0, 0.05, fireRaw));
    }
  }
  fr = clamp(fr, 0.0, 1.0);
  fr /= max(1.0, dot(fr, vec4(1.0)));
  float ign = smoothstep(uIgnite, uIgnite + 0.22, heat);
  float burn = min(fuel, uBurnRate * ign * min(1.0, fuel * 5.0 + 0.05) * uDt);
  fuel -= burn;
  fire += burn * uFireYield;
  heat += fire * uHeatGain * uDt;
  float loss = fire * min(1.0, uFireDecay * uDt * (1.0 + 0.35 * fire));
  fire -= loss;
  smoke += loss * uSmokeYield;
  heat -= heat * min(1.0, uCool * uDt);
  smoke -= smoke * min(1.0, uSmokeDecay * uDt * (1.0 + smoke));
  smoke = max(0.0, smoke - 0.03 * uDt);                    // thin smoke clears (keeps the empty-space skip effective)
  heat = max(0.0, heat - 0.02 * uDt);
  fire = fire < 0.004 ? 0.0 : fire;
  float solid = step(0.5, texture2D(uObs, vUv).r);
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 6.0 * uTexel.x, min(e.x, e.y));
  vec4 r = vec4(min(fuel, 2.0), min(fire, 3.0), min(smoke, 3.0), min(heat, 2.0));
  r.gba *= edge;
  gl_FragColor = r * (1.0 - solid);
  pc_fragHue = fr * r.g * (1.0 - solid);
}`;

// 64² summary: R heat for gameplay (max over the cell of max(heat, 0.8 fire)), G fuel (mean), B fire (mean), A smoke (mean).
const SUMMARY = COMMON + /* glsl */`
uniform sampler2D uS; uniform vec2 uSrcTexel; uniform float uK;
void main() {
  vec2 base = vUv - 0.5 / 64.0;   // the cell's corner in uv
  float hmax = 0.0; vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 q = base + (vec2(float(i), float(j)) + 0.5) / (4.0 * 64.0);
    vec4 s = texture2D(uS, q);
    hmax = max(hmax, max(s.a, 0.8 * s.g));
    acc += s.rgb;
  }
  acc /= 16.0;
  gl_FragColor = clamp(vec4(hmax, acc.r, acc.g, acc.b), 0.0, 1.0);
}`;

// Light map: separable gaussian over the summary; RGB = fire light colour × strength, A = occupancy (fire, heat, smoke).
// Each tap's light takes its cell's hue mix (uLightCols: orange, violet, blue, green, lilac).
const LIGHT_H = COMMON + /* glsl */`
uniform sampler2D uSrc; uniform sampler2D uHue; uniform vec3 uLightCols[5];
void main() {
  float w[5]; w[0] = 0.227; w[1] = 0.194; w[2] = 0.122; w[3] = 0.054; w[4] = 0.016;
  vec4 acc = vec4(0.0);
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + vec2(float(i) * uTexel.x, 0.0);
    vec4 s = texture2D(uSrc, uv);
    vec4 fr = texture2D(uHue, uv);
    vec3 col = uLightCols[0] * (1.0 - dot(fr, vec4(1.0))) + uLightCols[1] * fr.x + uLightCols[2] * fr.y + uLightCols[3] * fr.z + uLightCols[4] * fr.w;
    float k = w[i < 0 ? -i : i];
    float L = s.b * 1.15 + s.r * 0.35;
    acc += k * vec4(col * L, max(max(s.r, s.b), s.a * 1.5));
  }
  gl_FragColor = acc;
}`;
const LIGHT_V = COMMON + /* glsl */`
uniform sampler2D uSrc;
void main() {
  float w[5]; w[0] = 0.227; w[1] = 0.194; w[2] = 0.122; w[3] = 0.054; w[4] = 0.016;
  vec4 acc = vec4(0.0); float occ = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec4 s = texture2D(uSrc, vUv + vec2(0.0, float(i) * uTexel.y));
    acc += w[i < 0 ? -i : i] * s;
    occ = max(occ, s.a);
  }
  gl_FragColor = vec4(acc.rgb, occ);
}`;

const COPY = COMMON + /* glsl */`
uniform sampler2D uSrc;
void main() { gl_FragColor = texture2D(uSrc, vUv); }`;
const COPY2 = COMMON + /* glsl */`
uniform sampler2D uSrc; uniform sampler2D uSrc2;
void main() { gl_FragColor = texture2D(uSrc, vUv); pc_fragHue = texture2D(uSrc2, vUv); }`;

// 64² hue map (RGBA8): the fire-weighted hue fractions (violet, blue, green, lilac) over a 2 m window round each 1 m
// cell, so a cell beside a flame (no fire of its own) carries that flame's hue and the bilinear map has no orange rim
// round a coloured fire. Used by the light map, the march and nearCamera.
const HUESUM = COMMON + /* glsl */`
uniform sampler2D uS; uniform sampler2D uH;
void main() {
  vec2 base = vUv - 1.0 / 64.0;
  float f = 0.0; vec4 h = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 q = base + (vec2(float(i), float(j)) + 0.5) / (2.0 * 64.0);
    f += max(texture2D(uS, q).g, 0.0); h += max(texture2D(uH, q), 0.0);
  }
  vec4 fr = clamp(h / max(f, 0.01), 0.0, 1.0);
  gl_FragColor = fr / max(1.0, dot(fr, vec4(1.0)));
}`;

// Instanced splats: aSeg = (x0, z0, x1, z1) world, aShape = (radius, kind 0 capsule / 1 box, 0, 0),
// aAdd = scalar deposit (fuel, fire, smoke, heat), aVel = (vx, vz, radial push, 0), aHue = the op's hue (one-hot).
const SPLAT_VERT = /* glsl */`
attribute vec4 aSeg; attribute vec4 aShape; attribute vec4 aAdd; attribute vec4 aVel; attribute vec4 aHue;
uniform vec4 uRect; uniform float uMinR;
varying vec2 vW; varying vec4 vSeg; varying vec4 vShape; varying vec4 vAdd; varying vec4 vVel; varying vec4 vHue;
void main() {
  float r = max(aShape.x, uMinR);
  float pad = aShape.y > 0.5 ? r : r * 1.6;
  vec2 mn = min(aSeg.xy, aSeg.zw) - pad, mx = max(aSeg.xy, aSeg.zw) + pad;
  if (aVel.z != 0.0) { mn -= r * 0.6; mx += r * 0.6; }
  vec2 w = mix(mn, mx, position.xy * 0.5 + 0.5);
  vW = w; vSeg = aSeg; vShape = vec4(r, aShape.yzw); vAdd = aAdd; vVel = aVel; vHue = aHue;
  vec2 uv = (w - uRect.xy) / uRect.zw;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const SPLAT_WEIGHT = /* glsl */`
varying vec2 vW; varying vec4 vSeg; varying vec4 vShape; varying vec4 vAdd; varying vec4 vVel;
float splatWeight() {
  float r = vShape.x;
  if (vShape.y > 0.5) {
    vec2 mn = min(vSeg.xy, vSeg.zw), mx = max(vSeg.xy, vSeg.zw);
    vec2 d = max(mn - vW, vW - mx);
    return 1.0 - smoothstep(-r, r, max(d.x, d.y));
  }
  vec2 pa = vW - vSeg.xy, ba = vSeg.zw - vSeg.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h);
  return exp(-2.6 * d * d / (r * r));
}`;
const SPLAT_S_FRAG = SPLAT_WEIGHT + /* glsl */`
varying vec4 vHue;
void main() { float w = splatWeight(); gl_FragColor = vAdd * w; pc_fragHue = vHue * max(vAdd.g, 0.0) * w; }`;
const SPLAT_V_FRAG = SPLAT_WEIGHT + /* glsl */`
void main() {
  vec2 v = vVel.xy * splatWeight();
  float sink = 0.0;
  if (vVel.z != 0.0) {
    vec2 dv = vW - vSeg.xy; float d = length(dv); float r = vShape.x;
    float prof = clamp(d / r, 0.0, 1.0) * (1.0 - smoothstep(r, r * 1.6, d));
    v += (d > 1e-4 ? dv / d : vec2(0.0)) * vVel.z * prof;
  }
  if (vVel.w != 0.0 || vShape.z != 0.0) {   // a whirlpool: tangential flow (counter-clockwise for w > 0) + a sink
    vec2 dv = vW - vSeg.xy; float d = length(dv); float r = vShape.x;
    float prof = smoothstep(0.0, 0.35 * r, d) * (1.0 - smoothstep(0.7 * r, 1.25 * r, d));
    v += (d > 1e-4 ? vec2(-dv.y, dv.x) / d : vec2(0.0)) * vVel.w * prof;
    sink = vShape.z * exp(-2.0 * d * d / (r * r));
  }
  gl_FragColor = vec4(v, sink, 0.0);
}`;

/** Static obstacle mask over the fire area from host.world.walls (in VALLEYWARD: the south wall incl. the gate, the two south towers). 256², R8. */
export function buildObstacles(n = 256) {
  const data = new Uint8Array(n * n);
  const f = W.area, boxes = W.walls;   // [x0, z0, x1, z1] boxes from host.world.walls
  for (let j = 0; j < n; j++) {
    const z = f.z0 + (j + 0.5) / n * f.size;
    for (let i = 0; i < n; i++) {
      const x = f.x0 + (i + 0.5) / n * f.size;
      let s = 0;
      for (const b of boxes) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) { s = 255; break; }
      data[j * n + i] = s;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export const RES = {
  high: { vel: 256, sca: 512, jacobi: 16, hz: 60 },   // 16 warm-started Jacobi passes (24 looked the same and cost 0.2 ms more)
  medium: { vel: 128, sca: 256, jacobi: 16, hz: 60 },
  low: { vel: 128, sca: 256, jacobi: 10, hz: 30 },
};

export class FluidSolver {
  /** @param {THREE.WebGLRenderer} renderer @param {keyof typeof RES} quality */
  constructor(renderer, quality, noise) {
    this.renderer = renderer;
    this.quad = new Quad();
    this.obs = buildObstacles();
    this.wind = new THREE.Vector2(0, 0);
    this.rain = 0;          // 0..1 (setRain)
    this.lightSplats = [];  // extra light from the fire columns (x, z, r, rgb), added into the light map
    this.time = 0;
    this.accum = 0;
    this.stepsLast = 0;
    this.pending = 0;       // splats queued for the next step
    this.lastJacobi = 0;
    const U = (v) => ({ value: v });
    const T = () => U(new THREE.Vector2());
    this.mats = {
      advectVel: passMaterial(ADVECT_VEL, { uTexel: T(), uVel: U(null), uObs: U(this.obs), uDt: U(0), uDecay: U(1), uWindPull: U(0), uWind: U(this.wind), uSize: U(W.area.size) }),
      curl: passMaterial(CURL, { uTexel: T(), uVel: U(null) }),
      vort: passMaterial(VORTICITY, { uTexel: T(), uVel: U(null), uCurl: U(null), uS: U(null), uObs: U(this.obs), uDt: U(0), uCurlK: U(0), uTurb: U(0), uTime: U(0), uNoise: U(noise) }),
      div: passMaterial(DIVERGENCE, { uTexel: T(), uVel: U(null), uObs: U(this.obs), uS: U(null), uExpand: U(0) }),
      jacobi: passMaterial(JACOBI, { uTexel: T(), uP: U(null), uDiv: U(null), uObs: U(this.obs), uKeep: U(1) }),
      project: passMaterial(PROJECT, { uTexel: T(), uP: U(null), uVel: U(null), uObs: U(this.obs) }),
      scalars: passMaterial(SCALARS, {
        uTexel: T(), uS: U(null), uH: U(null), uVel: U(null), uObs: U(this.obs), uDt: U(0), uSize: U(W.area.size),
        uIgnite: U(0), uBurnRate: U(0), uFireYield: U(0), uFireDecay: U(0), uSmokeYield: U(0), uSmokeDecay: U(0), uHeatGain: U(0), uCool: U(0), uHeatDiffuse: U(0), uSpread: U(0), uSpreadOff: U(0), uStick: U(0),
      }, { mrt: true }),
      hueSum: passMaterial(HUESUM, { uTexel: T(), uS: U(null), uH: U(null) }),
      summary: passMaterial(SUMMARY, { uTexel: T(), uS: U(null), uSrcTexel: T(), uK: U(1) }),
      lightH: passMaterial(LIGHT_H, { uTexel: U(new THREE.Vector2(1 / 64, 1 / 64)), uSrc: U(null), uHue: U(null), uLightCols: U(LIGHT_COLS.map((c) => new THREE.Vector3(c[0], c[1], c[2]).multiplyScalar(1.5))) }),
      lightV: passMaterial(LIGHT_V, { uTexel: U(new THREE.Vector2(1 / 64, 1 / 64)), uSrc: U(null) }),
      copy: passMaterial(COPY, { uTexel: T(), uSrc: U(null) }),
      copy2: passMaterial(COPY2, { uTexel: T(), uSrc: U(null), uSrc2: U(null) }, { mrt: true }),
    };
    // splats
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.splat = {
      seg: new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4),
      shape: new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4),
      add: new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4),
      vel: new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4),
      hue: new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4),
    };
    for (const a of Object.values(this.splat)) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSeg', this.splat.seg); geo.setAttribute('aShape', this.splat.shape);
    geo.setAttribute('aAdd', this.splat.add); geo.setAttribute('aVel', this.splat.vel); geo.setAttribute('aHue', this.splat.hue);
    geo.instanceCount = 0;
    const rect = new THREE.Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size);
    const blendAdd = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, transparent: true };
    this.splatSMat = new THREE.ShaderMaterial({ vertexShader: SPLAT_VERT, fragmentShader: MRT2 + SPLAT_S_FRAG, glslVersion: THREE.GLSL3, uniforms: { uRect: { value: rect }, uMinR: { value: 0.2 } }, ...blendAdd });
    this.splatVMat = new THREE.ShaderMaterial({ vertexShader: SPLAT_VERT, fragmentShader: SPLAT_V_FRAG, uniforms: { uRect: { value: rect }, uMinR: { value: 0.3 } }, ...blendAdd });
    this.splatMesh = new THREE.Mesh(geo, this.splatSMat);
    this.splatMesh.frustumCulled = false;
    this.splatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // outputs that never change size
    this.summaryRT = makeTarget(64, 64, { type: THREE.UnsignedByteType, filter: THREE.LinearFilter });
    this.lightTmp = makeTarget(64, 64, { type: THREE.HalfFloatType });
    this.lightRT = makeTarget(64, 64, { type: THREE.HalfFloatType });
    this.hueRT = makeTarget(64, 64, { type: THREE.UnsignedByteType, filter: THREE.LinearFilter });
    this.setQuality(quality);
  }

  /** (Re)build the fields at a tier's resolution, resampling the current state into the new targets. */
  setQuality(q) {
    const cfg = RES[q] || RES.high;
    const old = this.cfg ? { V: this.V, S: this.S } : null;
    this.cfg = { ...cfg, name: q in RES ? q : 'high' };
    const nv = cfg.vel, ns = cfg.sca;
    const V = new PingPong(nv, nv), P = new PingPong(nv, nv, { filter: THREE.NearestFilter });
    const S = new PingPong(ns, ns, { count: 2 });   // textures[0] = S, textures[1] = H (the hue mass)
    const curl = makeTarget(nv, nv, { filter: THREE.NearestFilter }), div = makeTarget(nv, nv, { filter: THREE.NearestFilter });
    const r = this.renderer, prevRT = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [V.a, V.b, P.a, P.b, S.a, S.b, curl, div]) { r.setRenderTarget(t); r.clear(true, false, false); }
    if (old) {
      this.mats.copy.uniforms.uSrc.value = old.V.read.texture; this.quad.run(r, this.mats.copy, V.read);
      this.mats.copy2.uniforms.uSrc.value = old.S.read.textures[0]; this.mats.copy2.uniforms.uSrc2.value = old.S.read.textures[1]; this.quad.run(r, this.mats.copy2, S.read);
      old.V.dispose(); old.S.dispose(); this.P.dispose(); this.curl.dispose(); this.div.dispose();
    } else {
      for (const t of [this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]) { r.setRenderTarget(t); r.clear(true, false, false); }
    }
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prevRT);
    Object.assign(this, { V, P, S, curl, div });
    const tv = new THREE.Vector2(1 / nv, 1 / nv), ts = new THREE.Vector2(1 / ns, 1 / ns);
    for (const k of ['advectVel', 'curl', 'vort', 'div', 'jacobi', 'project']) this.mats[k].uniforms.uTexel.value.copy(tv);
    this.mats.scalars.uniforms.uTexel.value.copy(ts);
    this.mats.summary.uniforms.uTexel.value.set(1 / 64, 1 / 64);
    this.splatSMat.uniforms.uMinR.value = 1.4 * W.area.size / ns;
    this.splatVMat.uniforms.uMinR.value = 1.4 * W.area.size / nv;
  }

  /** Queue the ops (FIRE_OP objects) for the next sub-step. Ops beyond the instance budget are dropped (embers first). */
  queue(ops) {
    if (!ops || !ops.length) return;
    const s = this.splat;
    for (const op of ops) {
      if (this.pending >= MAX_SPLATS) break;
      const i = this.pending * 4;
      let seg = [0, 0, 0, 0], shape = [1, 0, 0, 0], add = [0, 0, 0, 0], vel = [0, 0, 0, 0], hue = ZERO4;
      const a = op.amount ?? 1;
      switch (op.kind) {
        case FIRE_OP.STREAM: {
          const D = DEPOSIT.stream, r = Math.max(D.minR, op.radius ?? 0.9);
          seg = [op.x0, op.z0, op.x1 ?? op.x0, op.z1 ?? op.z0]; shape = [r, 0, 0, 0];
          add = [D.fuel * a, D.fire * a, 0, D.heat * a]; vel = [(op.vx || 0) * D.push, (op.vz || 0) * D.push, 0, 0]; hue = hueVec(op.hue);
          break;
        }
        case FIRE_OP.BURST: {
          const D = DEPOSIT.burst, r = op.r ?? 3;
          seg = [op.x, op.z, op.x, op.z]; shape = [r * 0.75, 0, 0, 0];
          add = [0, D.fire * a, D.smoke * a, D.heat * a]; vel = [0, 0, op.push ?? 4, 0]; hue = hueVec(op.hue);
          break;
        }
        case FIRE_OP.FUEL: {
          if (op.box) { seg = [op.box.x0, op.box.z0, op.box.x1, op.box.z1]; shape = [0.12, 1, 0, 0]; }
          else { seg = [op.x, op.z, op.x, op.z]; shape = [op.r ?? 1.5, 0, 0, 0]; }
          add = [DEPOSIT.fuel.fuel * a, 0, 0, 0];
          break;
        }
        case FIRE_OP.EMBER: {
          const D = DEPOSIT.ember;
          seg = [op.x, op.z, op.x, op.z]; shape = [D.r, 0, 0, 0]; add = [0, D.fire * a, 0, D.heat * a]; hue = hueVec(op.hue);
          break;
        }
        case FIRE_OP.PUSH: {
          seg = [op.x, op.z, op.x, op.z]; shape = [op.r ?? 1, 0, 0, 0]; vel = [op.vx || 0, op.vz || 0, 0, 0];
          break;
        }
        case FIRE_OP.DOUSE: {
          // { kind:'douse', x0, z0, x1, z1, r, vx?, vz? } is a line (the Rainmother's tide wave; it may shove the flow)
          const k = DEPOSIT.douse.k;
          seg = op.x0 != null ? [op.x0, op.z0, op.x1 ?? op.x0, op.z1 ?? op.z0] : [op.x, op.z, op.x, op.z];
          shape = [op.r ?? 2, 0, 0, 0]; add = [-k * 0.1, -k, -k * 0.05, -k]; vel = [op.vx || 0, op.vz || 0, 0, 0];
          break;
        }
        case 'swirl': {
          // { kind:'swirl', x, z, r, spin, pull, amount? } one per sim tick per whirlpool: spin = tangential m/s at
          // ≈ 0.6 r (> 0 counter-clockwise seen from above), pull = inward m/s at the rim; the core is quenched
          const r = op.r ?? 5, a2 = op.amount ?? 1, h = W.area.size / this.cfg.vel;
          seg = [op.x, op.z, op.x, op.z];
          shape = [r, 0, 2 * (op.pull ?? 1.5) * h / r * a2, 0];
          vel = [0, 0, 0, (op.spin ?? 6) * 0.024 * a2];   // per-tick increment (≈ 1.5 × spin m/s at equilibrium with velDecay + windPull: the vorticity and the fire's expansion eat the rest)
          if (op.quench !== false && this.pending + 1 < MAX_SPLATS) {
            const q = DEPOSIT.swirl.quench * a2, j = (this.pending + 1) * 4;   // the water at its eye eats the fire
            s.seg.array.set(seg, j); s.shape.array.set([r * DEPOSIT.swirl.core, 0, 0, 0], j); s.add.array.set([0, -q, -q * 0.05, -q], j);
            s.vel.array.set(ZERO4, j); s.hue.array.set(ZERO4, j);
            s.seg.array.set(seg, i); s.shape.array.set(shape, i); s.add.array.set([-DEPOSIT.swirl.wash * a2, 0, 0, 0], i); s.vel.array.set(vel, i); s.hue.array.set(ZERO4, i);
            this.pending += 2;
            continue;
          }
          break;
        }
        default: continue;
      }
      s.seg.array.set(seg, i); s.shape.array.set(shape, i); s.add.array.set(add, i); s.vel.array.set(vel, i); s.hue.array.set(hue, i);
      this.pending++;
    }
  }

  _splat() {
    const n = this.pending;
    if (!n) return;
    const geo = this.splatMesh.geometry;
    for (const a of Object.values(this.splat)) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    geo.instanceCount = n;
    const r = this.renderer;
    this.splatMesh.material = this.splatSMat; r.setRenderTarget(this.S.read); r.render(this.splatMesh, this.splatCam);
    this.splatMesh.material = this.splatVMat; r.setRenderTarget(this.V.read); r.render(this.splatMesh, this.splatCam);
    this.pending = 0;
  }

  /** One fixed sub-step. @param {number} dt seconds */
  _step(dt) {
    const r = this.renderer, q = this.quad, m = this.mats, K = KNOBS;
    this._splat();
    let u = m.advectVel.uniforms;
    u.uVel.value = this.V.read.texture; u.uDt.value = dt; u.uDecay.value = Math.exp(-K.velDecay * dt); u.uWindPull.value = K.windPull;
    q.run(r, m.advectVel, this.V.write); this.V.swap();
    m.curl.uniforms.uVel.value = this.V.read.texture; q.run(r, m.curl, this.curl);
    u = m.vort.uniforms; u.uVel.value = this.V.read.texture; u.uCurl.value = this.curl.texture; u.uS.value = this.S.read.texture; u.uDt.value = dt; u.uCurlK.value = K.curl; u.uTurb.value = K.turb; u.uTime.value = this.time;
    q.run(r, m.vort, this.V.write); this.V.swap();
    u = m.div.uniforms; u.uVel.value = this.V.read.texture; u.uS.value = this.S.read.texture; u.uExpand.value = K.expand;
    q.run(r, m.div, this.div);
    u = m.jacobi.uniforms; u.uDiv.value = this.div.texture;
    const iters = this.cfg.jacobi;
    for (let i = 0; i < iters; i++) {
      u.uP.value = this.P.read.texture; u.uKeep.value = i === 0 ? K.pressureKeep : 1;
      q.run(r, m.jacobi, this.P.write); this.P.swap();
    }
    this.lastJacobi = iters;
    u = m.project.uniforms; u.uP.value = this.P.read.texture; u.uVel.value = this.V.read.texture;
    q.run(r, m.project, this.V.write); this.V.swap();
    u = m.scalars.uniforms;
    u.uS.value = this.S.read.textures[0]; u.uH.value = this.S.read.textures[1]; u.uVel.value = this.V.read.texture; u.uDt.value = dt;
    const rn = this.rain;   // rain scales the reaction (no shader cost)
    u.uIgnite.value = K.ignite + K.rainIgnite * rn; u.uBurnRate.value = K.burnRate * (1 - K.rainBurn * rn); u.uFireYield.value = K.fireYield; u.uFireDecay.value = K.fireDecay * (1 + K.rainDecay * rn);
    u.uSmokeYield.value = K.smokeYield * (1 + K.rainSmoke * rn); u.uSmokeDecay.value = K.smokeDecay; u.uHeatGain.value = K.heatGain; u.uCool.value = K.cool * (1 + K.rainCool * rn); u.uHeatDiffuse.value = K.heatDiffuse;
    u.uSpread.value = K.spread; u.uSpreadOff.value = K.spreadDist / W.area.size; u.uStick.value = K.stick;
    q.run(r, m.scalars, this.S.write); this.S.swap();
    this.time += dt;
  }

  /** Advance by real time; fixed sub-steps at the tier's rate, at most 3 per call. Returns the number of steps. */
  step(dt) {
    const h = 1 / this.cfg.hz;
    this.accum = Math.min(this.accum + Math.max(0, dt), h * 3);
    let n = 0;
    const r = this.renderer, prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    if (this.pending && this.accum < h) this.accum = h;   // never sit on queued ops
    while (this.accum >= h - 1e-6 && n < 3) { this._step(h); this.accum -= h; n++; }
    if (n) this._summarize();
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
    this.stepsLast = n;
    return n;
  }

  _summarize() {
    const r = this.renderer, q = this.quad, m = this.mats;
    m.summary.uniforms.uS.value = this.S.read.texture;
    q.run(r, m.summary, this.summaryRT);
    m.hueSum.uniforms.uS.value = this.S.read.textures[0]; m.hueSum.uniforms.uH.value = this.S.read.textures[1];
    q.run(r, m.hueSum, this.hueRT);
    const dim = 1.5 * (1 - KNOBS.rainLight * this.rain);   // the fire light dims in the rain
    m.lightH.uniforms.uLightCols.value.forEach((v, k) => v.set(LIGHT_COLS[k][0] * dim, LIGHT_COLS[k][1] * dim, LIGHT_COLS[k][2] * dim));
    m.lightH.uniforms.uSrc.value = this.summaryRT.texture; m.lightH.uniforms.uHue.value = this.hueRT.texture; q.run(r, m.lightH, this.lightTmp);
    m.lightV.uniforms.uSrc.value = this.lightTmp.texture; q.run(r, m.lightV, this.lightRT);
    this._lightColumns();
  }

  /** The light of the columns (the pillar, the demon's fire), additive discs in the 64² light map. */
  _lightColumns() {
    const n = this.lightSplats.length;
    if (!n) return;
    if (!this.lightMesh) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      this.lightA = new THREE.InstancedBufferAttribute(new Float32Array(16 * 4), 4).setUsage(THREE.DynamicDrawUsage);
      this.lightC = new THREE.InstancedBufferAttribute(new Float32Array(16 * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aL', this.lightA); geo.setAttribute('aC', this.lightC);
      const mat = new THREE.ShaderMaterial({
        vertexShader: `attribute vec4 aL; attribute vec4 aC; uniform vec4 uRect; varying vec2 vD; varying vec3 vC;
          void main() { vD = position.xy; vC = aC.rgb; vec2 w = aL.xy + position.xy * aL.z; gl_Position = vec4((w - uRect.xy) / uRect.zw * 2.0 - 1.0, 0.0, 1.0); }`,
        fragmentShader: `varying vec2 vD; varying vec3 vC; void main() { float d = dot(vD, vD); gl_FragColor = vec4(vC * max(0.0, 1.0 - d) * (1.0 - d), 0.0); }`,
        uniforms: { uRect: { value: new THREE.Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size) } },
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, transparent: true,
      });
      this.lightMesh = new THREE.Mesh(geo, mat); this.lightMesh.frustumCulled = false;
    }
    const k = Math.min(n, 16);
    for (let i = 0; i < k; i++) { const L = this.lightSplats[i]; this.lightA.array.set([L.x, L.z, L.r, 0], i * 4); this.lightC.array.set([L.rgb[0], L.rgb[1], L.rgb[2], 0], i * 4); }
    this.lightA.needsUpdate = true; this.lightC.needsUpdate = true; this.lightMesh.geometry.instanceCount = k;
    this.renderer.setRenderTarget(this.lightRT); this.renderer.render(this.lightMesh, this.splatCam);
  }

  /** Clear every field (fresh fire). */
  reset() {
    const r = this.renderer, prevRT = r.getRenderTarget(), pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.V.a, this.V.b, this.P.a, this.P.b, this.S.a, this.S.b, this.curl, this.div, this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(pc, pa); r.setRenderTarget(prevRT);
    this.pending = 0; this.accum = 0;
  }

  dispose() {
    for (const t of [this.V, this.P, this.S]) t.dispose();
    for (const t of [this.curl, this.div, this.summaryRT, this.lightTmp, this.lightRT, this.hueRT]) t.dispose();
    for (const mm of Object.values(this.mats)) mm.dispose();
    this.splatSMat.dispose(); this.splatVMat.dispose(); this.splatMesh.geometry.dispose();
    this.obs.dispose(); this.quad.dispose();
    if (this.lightMesh) { this.lightMesh.geometry.dispose(); this.lightMesh.material.dispose(); }
  }
}
