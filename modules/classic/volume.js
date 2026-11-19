// FIREWRAITH · classic · the volume: a ray-marched slab above the terrain (ground height in GLSL: host.world.groundGLSL,
// the same formula as host.world.groundHeight), depth-tested against the scene, then composited over the scene colour.
// Volume target channels: R fire coverage (emission = extinction, ≤ 1; includes the orange glow of smoke lit from below),
// G = R × temperature, B smoke lit by the moon/sky, A opacity (1 − transmittance). The composite colours the fire by
// its emission-weighted temperature through the six-colour fire ramp: `smooth` (continuous, bilateral upsample of a
// half-res march) or `hybrid` (a coarse pixel grid, the 6 colours stepped, Bayer dither only at band borders).
// Coloured fire: the march is a two-output pass. Output 0 keeps the channels above except A, which now holds the
// transmittance T (so the jet's "over" blend can also fade output 1); output 1 = the emission-weighted hue mass (violet,
// blue, green, lilac) from the solver's hue field. The composite turns mass / R into hue weights and colours each hue
// through its own ramp (smooth: blended; hybrid: the dominant hue's stepped colours, Bayer-dithered only where two
// hues are close). Orange (no hue) goes through exactly the orange-only path.
import * as THREE from 'three';
import { W } from './world.js';
import { makeTarget, passMaterial, linColor } from './gl.js';
import { makeNoiseTexture, NOISE_GLSL, DEPTH_GLSL } from '../../src/kit/webgl2/index.js';

/** Look knobs (FLUID.md "Knobs"). */
export const LOOK = {
  flameH: 2.8,        // m, tongue height at full fire (short licking tongues, not curtains)
  lean: 0.24,         // s: tongues lean downwind by velocity × height × lean
  smokeLean: 0.45,
  fireGain: 3.6,      // tongue extinction (= emission) per metre: a dense tongue is nearly opaque, so the nearest wins
  fireExposure: 1.1,  // fire coverage scale in the composite
  sheetGain: 3.0,     // the marbled ground sheet's density
  sheetH: 0.25,       // m, its thickness
  smokeK: 0.65,       // smoke extinction per unit smoke per metre
  smokeMaxA: 0.6,     // the smoke's opacity never passes this (translucent, never a black hole)
  smokeGlow: 0.3,     // how strongly the fire below lights the smoke orange
  smokeFar: 70,       // m: smoke thins out toward this distance
  smokeTop: 7.5,      // m, tallest smoke
  nearFade: 3.0,      // m: the volume thins within this distance of the camera
  // standing in fire (Hearthblood heals only while the player stands in fire): while the eye is in a burning patch, the
  // flames close to the eye fade over a longer distance, most at the screen centre and above the horizon, so the player
  // sees flames licking round the lower part of the view and the world beyond (it was a yellow-white wall)
  inFireFade0: 1.4,   // m: where the in-fire fade starts (full weight)
  inFireFade1: 6.5,   // m: where the fire is back to full density (full weight; rays down at the feet get about half)
  inFireSheet: 0.35,  // the burning ground within ≈ 5 m dims to this in fire (it was a white-hot floor)
  inFireCool: 0.78,   // near flames round an eye in fire are drawn this much cooler (orange, not a white-yellow wall)
  tall: 1,            // 1 = standing flames (taller over dense fire, hotter cores), 0 = the older low, flat shape
  softSmoke: 1,       // hybrid: 1 = smoke drawn soft (not quantised), 0 = smoke in flat steps on the coarse grid
  fineStep: 1,        // 1 = finer march steps inside the flame layer (crisper tongues, costs more), 0 = off
  bright: 2.4,        // HDR multiplier of the white-yellow core only (the bloom catches it); the body stays ≤ 1
  // toward the key art: its white-yellow core covers 0.4–0.7 % of the frame and its crimson rim 4.7–9.7 %; without
  // these knobs ours measured 0.0–0.1 % and 0.3–1.1 %
  coreHeat: 0.85,     // how far the base of dense fire is pushed toward #fff2b8 (was 0.42)
  rimGain: 1.3,       // extra emission of the cool flame edge (#a3241a) in smooth (not the smoke's glow)
  wallFade: 0.6,      // m: flames and smoke fade within this distance in front of a surface (no streaks up the walls)
  rainFlame: 0.3,     // flames are this much lower at full rain
  rainSteam: 0.6,     // how far the smoke turns to pale steam grey at full rain
};
export const SMOKE_COL = [0.048, 0.034, 0.038], STEAM_COL = [0.075, 0.08, 0.085];

// sRGB palette (VALLEYWARD's art direction), dark → core.
const PALETTE = ['#4a1612', '#a3241a', '#e85a1c', '#ff9a2e', '#ffd24a', '#fff2b8'];
/** Per-hue ramps, dark edge → white core, six stops like PALETTE (index 1 = the deep hue edge,
 *  3 = the hue body, 5 = the core). Orange is PALETTE, unchanged. Mutable: the bench tunes them, then `setRamps()`. */
export const HUE_RAMPS = {
  orange: PALETTE,
  violet: ['#2c0a52', '#6a1fb3', '#9a45f0', '#c46bff', '#e4b2ff', '#fff0ff'],
  blue: ['#0a1c5c', '#1a4fd6', '#2f8cf2', '#4fb8ff', '#aee6ff', '#eaffff'],
  green: ['#0b3a14', '#1f8f2a', '#4fd23a', '#7dff4f', '#c6ff94', '#f4ffd8'],
  lilac: ['#33195e', '#7f4fc4', '#a571ea', '#cf98ff', '#ebcbff', '#fff4ff'],   // a touch more saturated than #d9a6ff: it read pink-white
};
export const HUE_ORDER = ['orange', 'violet', 'blue', 'green', 'lilac'];   // = the hue channels + 1 (orange first)
export const ORANGE_RIM = [0.366, 0.018, 0.01];   // hybrid's rim: #a3241a (brighter than the first dark crimson-brown, like the key art); other hues: their deep edge

export { makeNoiseTexture, NOISE_GLSL, DEPTH_GLSL };

const MARCH = /* glsl */`
varying vec2 vUv;
uniform sampler2D uS; uniform sampler2D uHueMap; uniform float uHueOn; uniform sampler2D uVel; uniform sampler2D uLight;
uniform vec3 uCamPos; uniform vec4 uRect; uniform vec2 uVolRes;
uniform float uTime; uniform float uFrame; uniform float uJitter;
uniform float uFlameH, uLean, uSmokeLean, uFireGain, uSmokeK, uSmokeTop, uNearFade, uStepScale;
uniform float uSheetGain, uSheetH, uSmokeGlow, uSmokeMaxA, uSmokeFar, uFineStep, uTall;
uniform float uCoreHeat, uWallFade;
uniform vec3 uInFire;   // (fade start, fade end, sheet dim) for an eye standing in fire
uniform float uInFireCool; uniform float uCamFire;
uniform vec3 uMoonDir;
/*@ew_ground*/
${NOISE_GLSL}
${DEPTH_GLSL}
// stable white-noise jitter from the noise texture (no diagonal structure, unlike interleaved-gradient noise; no TAA)
float jitter(vec2 c) { return texture2D(uNoise, (mod(floor(c), 256.0) + 0.5) / 256.0).b; }
// the fire's colour coordinate (0 crimson edge … 0.6 orange body … 1 white-yellow core)
float flameTemp(float hot, float f, float d) {
  float r2 = 0.2 + 0.46 * d * (0.5 + 0.5 * f) + 0.36 * smoothstep(0.55, 1.4, hot) * d * d * f * f;
  float r3 = 0.2 + 0.42 * d * (0.45 + 0.55 * f) + uCoreHeat * smoothstep(0.3, 0.9, hot) * d * f * f;   // the base of dense fire reaches #fff2b8
  return mix(r2, r3, uTall);
}
// the hue weights (violet, blue, green, lilac) at a field uv: the solver's 64² hue map (fire-weighted fractions over a
// 2 m window, bilinear: a small cached texture, much cheaper per march step than the 512² hue field; measured)
vec4 hueAt(vec2 uv) { return texture2D(uHueMap, uv); }
void main() {
  vec2 uv = (floor(vUv * uVolRes) + 0.5) / uVolRes;   // the texel centre (the upsample reads the same depth)
  float raw;
  vec3 wp = worldAt(uv, raw);
  vec3 ro = uCamPos;
  vec3 rd = normalize(wp - ro);
  float tScene = raw >= 0.99999 ? 1e5 : length(wp - ro);
  // the domain box
  vec3 bmin = vec3(uRect.x, -16.0, uRect.y), bmax = vec3(uRect.x + uRect.z, uSmokeTop + 1.0, uRect.y + uRect.w);
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tIn = max(max(tmin.x, tmin.y), max(tmin.z, 0.15));
  float tOut = min(min(tmax.x, tmax.y), min(tmax.z, tScene));
  if (tIn >= tOut) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); pc_fragHue = vec4(0.0); return; }
  // R = fire coverage (emission = extinction, so it is ≤ 1 and the nearest tongue wins), G = R × temperature,
  // B = smoke lit by the moon and the sky, A = opacity. T = transmittance, Ts = the smoke's own (capped at 1 − uSmokeMaxA).
  float T = 1.0, Ts = 1.0; vec4 acc = vec4(0.0); vec4 hueAcc = vec4(0.0);
  float jit = mix(0.5, jitter(gl_FragCoord.xy), uJitter);   // hybrid: no jitter (clean stepped bands, not speckle)
  // is the eye standing in fire? (0..1 from the CPU: the read-back's fire round the camera's ground point, only
  // with the eye ≤ ≈ 3 m above the ground — never on the wall walk; eased over ≈ 0.2 s). A per-pixel probe of the field
  // cost +0.1 ms; the uniform costs nothing while no one stands in fire.
#ifdef INFIRE
  float inFire = uCamFire;
  // the fade's weight on this ray: most above the horizon and at the screen centre, little for rays down at the feet
  vec2 sc = (vUv - 0.5) * vec2(uVolRes.x / uVolRes.y, 1.0);
  float wDir = max(max(smoothstep(-0.32, 0.08, rd.y), 0.85 * (1.0 - smoothstep(0.08, 0.42, length(sc)))), 0.5);
  float wF = inFire * wDir;
  float n0 = mix(0.6, uInFire.x, wF), n1 = mix(uNearFade, uInFire.y, wF);
#else
  float inFire = 0.0, n0 = 0.6, n1 = uNearFade;   // (the march without the in-fire fade)
#endif
  float t = tIn + jit * min(clamp(tIn * 0.05, 0.08, 1.0), 0.22 + tIn * 0.03) * uStepScale;   // ≤ one flame-layer step: less grain
  for (int i = 0; i < MAX_STEPS; i++) {
    if (t >= tOut || T < 0.03) break;
    vec3 p = ro + rd * t;
    float g = ewGround(p.xz);
    float h = p.y - g;
    float dt = clamp(t * 0.075, 0.09, 2.0) * uStepScale;
    vec2 uv0 = (p.xz - uRect.xy) / uRect.zw;
    vec4 L = texture2D(uLight, uv0);
    if (h < -0.25) { if (rd.y < 0.0) break; t += dt; continue; }
    if (h > uSmokeTop && rd.y >= 0.0) break;                     // above the smoke and rising: nothing more
    if (L.a < 0.015 || h > uSmokeTop) { t += max(dt, 1.6); continue; }   // empty (the occupancy is blurred ≥ 2 m)
    bool smokeFull = Ts <= 1.0 - uSmokeMaxA + 0.03;               // the smoke's opacity is capped: once full, only fire matters
    if (smokeFull) break;   // the cost bound: behind capped smoke the ray ends (the scene shows through at 1 − uSmokeMaxA)
    float near = smoothstep(n0, n1, t);   // (n0 = 0.6, n1 = uNearFade unless the eye stands in fire)
    vec2 vel = texture2D(uVel, uv0).xy;
    float hc = max(h, 0.0);
    // fire: short tongues that lean with the flow. A 2D blob noise (advected sideways by the flow, licking upward) is cut
    // by a threshold that rises with height, so each tongue tapers to a tip and gaps open between them.
    vec2 q = p.xz - vel * hc * uLean;
    vec2 uvq = (q - uRect.xy) / uRect.zw;
    vec4 s = texture2D(uS, uvq);
    float hot = clamp(s.g, 0.0, 2.0);
    float aF = 0.0, temp = 0.0;
    if (hot > 0.02) {
      float fh = uFlameH * pow(clamp(hot * 0.85 + s.a * 0.15, 0.0, 1.5), mix(0.6, 0.9, uTall));   // standing flames over dense fire: ≈ 1.5 m at fire 0.5, 2.4 m at 1; weak fire stays low
      float f = 1.0 - hc / max(fh, 0.05);
      if (f > 0.0) {
        dt = mix(dt, min(dt, 0.22 + t * 0.03), uFineStep);   // finer steps inside the flame layer (cost knob)
        vec2 qa = q;
        float n = noise3(vec3(qa * 1.15, uTime * 0.55 - hc * mix(0.35, 0.8, uTall)));   // tall flames break up as they rise (no thin columns)
        if (t < 22.0 && hc < mix(99.0, 1.6, uTall)) n = n * 0.62 + noise3(vec3(qa * 2.5 + 7.0, hc * 1.7 - uTime * 2.4)) * 0.38;   // licks near the base only
        float thr = mix(0.22, 0.72, pow(1.0 - f, mix(0.8, 1.0, uTall)));
        float d = smoothstep(thr, thr + 0.10, n);
        float e = d * pow(f, 0.5) * smoothstep(0.02, 0.45, hot) * uFireGain * near;
        e *= smoothstep(0.0, uWallFade, tScene - t);                 // fade in front of a surface: no streaks painted up a wall
        aF = 1.0 - exp(-e * dt);
        temp = flameTemp(hot, f, smoothstep(thr, thr + 0.22, n));
#ifdef INFIRE
        temp *= mix(1.0, uInFireCool, inFire * (1.0 - smoothstep(n1, n1 + 3.0, t)));
#endif
      }
    }
    // smoke: translucent charcoal, rolls up and drifts with the flow, thins with distance, never fully opaque
    float sm = s.b;
    if (smokeFull) sm = 0.0;
    else if (hc > 1.0 && sm > 0.004) sm = texture2D(uS, uv0 - vel * hc * uSmokeLean / uRect.zw).b;
    sm = clamp(sm - 0.02, 0.0, 2.0);
    float aS = 0.0, cool = 0.0, glow = 0.0;
    if (sm > 0.01) {
      float top = 1.8 + (uSmokeTop - 1.8) * clamp(sm * 0.8, 0.0, 1.0);
      float prof = smoothstep(0.0, 0.9, hc) * (1.0 - smoothstep(top * 0.4, top, hc));
      float bn = noise3(vec3(p.x * 0.5, p.z * 0.5, hc * 0.45 - uTime * 0.32));
      if (t < 12.0) bn = bn * 0.65 + noise3(vec3(p.x * 1.3, p.z * 1.3, hc * 1.1 - uTime * 0.6)) * 0.35;
      float sd = sm * prof * smoothstep(0.36, 0.7, bn + 0.1) * uSmokeK;
      sd *= smoothstep(1.0, 2.0 * uNearFade, t) * (1.0 - smoothstep(uSmokeFar * 0.4, uSmokeFar, t));
      sd *= smoothstep(1.0 - uSmokeMaxA, 1.0 - uSmokeMaxA + 0.25, Ts);   // the smoke's opacity saturates at uSmokeMaxA
      aS = 1.0 - exp(-sd * dt * smoothstep(0.0, uWallFade, tScene - t));
      glow = min(dot(L.rgb, vec3(0.3, 0.55, 0.15)) * uSmokeGlow, 0.6) * exp(-hc * 0.5);   // lit orange by the fire below
      cool = 0.45 + 0.55 * smoothstep(0.0, uSmokeTop * 0.7, hc);                           // the moon and the sky above
      if (t < 25.0) cool *= exp(-0.9 * texture2D(uS, uv0 + uMoonDir.xz * 1.5 / uRect.zw).b);
    }
    if (aF + aS > 0.0) {
      float wE = aF + aS * glow;
#ifdef HUE
      if (aF > 0.0 || aS * glow > 0.002) hueAcc += T * wE * hueAt(uvq);   // (faint smoke glow counts as orange)
#endif
      acc.r += T * (aF + aS * glow);
      acc.g += T * (aF * temp + aS * glow * 0.12);
      acc.b += T * (1.0 - aF) * aS * cool;
      T *= (1.0 - aF) * (1.0 - aS);
      Ts *= 1.0 - aS;
    }
    t += (aF == 0.0 && smokeFull) ? dt * 2.0 : dt;   // behind full smoke and outside the flames: stride
  }
  // the ground sheet: a thin marbled layer of burning oil under the tongues, where the ray ends on the ground. Domain-
  // warped by slow noise and the field's own curls, with thin bright veins: a marbled, molten-looking burning floor.
  if (tScene < 1e4 && tOut >= tScene - 0.01 && T > 0.03) {
    vec3 pe = ro + rd * tScene;
    float he = pe.y - ewGround(pe.xz);
    vec2 uvE = (pe.xz - uRect.xy) / uRect.zw;
    if (he < 0.7 && uvE.x > 0.0 && uvE.y > 0.0 && uvE.x < 1.0 && uvE.y < 1.0) {
      vec2 vel = texture2D(uVel, uvE).xy;
      vec2 w2 = vec2(noise3(vec3(pe.xz * 0.42, uTime * 0.2)), noise3(vec3(pe.xz * 0.42 + 31.7, uTime * 0.2))) - 0.5;
      vec2 uvS = uvE + (w2 * 1.3 - vel * 0.12) / uRect.zw;
      vec4 s0 = texture2D(uS, uvS);
      float hot = s0.g;
      if (hot > 0.02) {
        vec2 qm = pe.xz + w2 * 2.4 - vel * 0.35;
        float m = noise3(vec3(qm * 1.25, uTime * 0.3));
        float m2 = noise3(vec3(qm * 2.9 + 11.0, uTime * 0.5));
        float vein = pow(1.0 - abs(2.0 * m - 1.0), 6.0);
        float body = smoothstep(0.03, 0.7, hot);
        float len = clamp(uSheetH / max(-rd.y, 0.1), 0.0, 3.0);
        float eS = body * (0.45 + 0.55 * m2) * uSheetGain * len * smoothstep(0.6, uNearFade, tScene);
#ifdef INFIRE
        eS *= mix(1.0, uInFire.z, inFire * (1.0 - smoothstep(3.0, 8.0, tScene)));   // no white-hot floor round an eye in fire
#endif
        float aG = 1.0 - exp(-eS);
        float tS = 0.24 + 0.40 * body * (0.5 + 0.5 * m2) + 0.7 * vein * body;   // hot veins reach the white-yellow core
        acc.r += T * aG; acc.g += T * aG * tS;
#ifdef HUE
        hueAcc += T * aG * hueAt(uvS);
#endif
        T *= 1.0 - aG;
      }
    }
  }
  gl_FragColor = vec4(acc.rgb, T);   // A = transmittance (the jet's blend fades it; the composite uses 1 − A)
  pc_fragHue = hueAcc;
}`;

const COMPOSITE = /* glsl */`
varying vec2 vUv;
uniform sampler2D uScene; uniform sampler2D uVol; uniform sampler2D uVolHue; uniform vec2 uVolRes; uniform vec2 uFullRes; uniform float uPix;
uniform vec3 uPal[30]; uniform vec3 uRim[5]; uniform float uExposure; uniform float uBright; uniform float uHueOn; uniform float uRimGain;
uniform vec3 uSmokeCol; uniform vec3 uSmokeWarm; uniform float uSmokeFloor; uniform float uSoftSmoke;
${DEPTH_GLSL}
// hue h's ramp (0 orange, 1 violet, 2 blue, 3 green, 4 lilac), continuous
vec3 rampH(int h, float x) {
  float k = clamp(x, 0.0, 1.0) * 5.0;
  int i = int(min(floor(k), 4.0));
  float f = k - float(i);
  return mix(uPal[h * 6 + i], uPal[h * 6 + i + 1], f);
}
// hue weights from the volume's hue mass and its coverage R
vec4 hueW(vec4 hv, float r) { vec4 w = clamp(hv / max(r, 1e-4), 0.0, 1.0); return w / max(1.0, dot(w, vec4(1.0))); }
// the hues' ramps blended by weight (orange alone: exactly the orange ramp)
vec3 rampMix(float x, vec4 w) {
  vec3 c = rampH(0, x);
  float s = dot(w, vec4(1.0));
  if (s < 1e-3) return c;
  return c * (1.0 - s) + rampH(1, x) * w.x + rampH(2, x) * w.y + rampH(3, x) * w.z + rampH(4, x) * w.w;
}
// hybrid: one hue per fire pixel, the dominant one; where the top two are within 0.35 a Bayer threshold picks
int domHue(vec4 w, float b2) {
  float wv[5]; wv[0] = 1.0 - dot(w, vec4(1.0)); wv[1] = w.x; wv[2] = w.y; wv[3] = w.z; wv[4] = w.w;
  int h1 = 0; for (int k = 1; k < 5; k++) if (wv[k] > wv[h1]) h1 = k;
  int h2 = h1 == 0 ? 1 : 0; for (int k = 0; k < 5; k++) if (k != h1 && wv[k] > wv[h2]) h2 = k;
  return b2 < 0.5 - (wv[h1] - wv[h2]) / 0.7 ? h2 : h1;
}
const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
float bayer4(vec2 c) {   // the 4×4 Bayer matrix as a constant-array lookup (not a 16-step loop)
  vec2 p = mod(floor(c), 4.0);
  return (BAYER[int(p.y) * 4 + int(p.x)] + 0.5) / 16.0;
}
// hw = the hue weights (not mass); one hue fetch per pixel, from the nearest / the heaviest bilateral tap (measured:
// four bilateral hue fetches per pixel cost +0.4 ms at 1080p; the hue varies slowly, a single tap reads the same)
vec4 volNearest(out vec4 hw) {
  vec2 ti = floor(vUv * uVolRes);
  vec2 uvc = (ti + 0.5) / uVolRes;
  float dC = viewDepthAt(uvc), dF = viewDepthAt(vUv);
  vec4 v = texture2D(uVol, uvc);
  hw = vec4(0.0);
  if (dF < dC * 0.85 && dF < 120.0) { v = vec4(0.0, 0.0, 0.0, 1.0); return v; }   // a foreground edge inside this fire pixel: keep it crisp
#ifdef HUE
  hw = hueW(textureLod(uVolHue, uvc, 0.0), v.r);
#endif
  return v;
}
vec4 volSmooth(out vec4 hw, bool wantHue) {
  vec2 pc = vUv * uVolRes - 0.5;
  vec2 i0 = floor(pc); vec2 fr = pc - i0;
  float dF = viewDepthAt(vUv);
  vec4 sum = vec4(0.0); float wsum = 0.0; vec4 best = vec4(0.0, 0.0, 0.0, 1.0); float bestD = 1e9;
  vec2 uvW = vUv; float wMax = -1.0; vec4 sW = vec4(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 uvn = (clamp(i0 + o, vec2(0.0), uVolRes - 1.0) + 0.5) / uVolRes;
    float dn = viewDepthAt(uvn);
    float bw = (o.x > 0.5 ? fr.x : 1.0 - fr.x) * (o.y > 0.5 ? fr.y : 1.0 - fr.y);
    float diff = abs(dn - dF);
    float w = bw * exp(-diff / (0.02 * dF + 0.05)) + 1e-5 * bw;
    vec4 s = texture2D(uVol, uvn);
    sum += s * w; wsum += w;
    if (diff < bestD) { bestD = diff; best = s; }
    if (w * s.r > wMax) { wMax = w * s.r; uvW = uvn; sW = s; }
  }
  hw = vec4(0.0);
#ifdef HUE
  if (wantHue) hw = hueW(textureLod(uVolHue, uvW, 0.0), sW.r);   // (variant compiled only while coloured fire is alive)
#endif
  return wsum > 1e-3 ? sum / wsum : best;
}
void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;
#ifdef HYBRID
  // the fire is quantised on the coarse grid; its smoke is not (soft, like smooth: quantised smoke became hard-edged
  // dark shapes in the sky)
  vec4 hwN;
  vec4 v = volNearest(hwN);
  float cov = clamp(v.r * uExposure, 0.0, 1.0);
  float temp = clamp(v.g / max(v.r, 1e-4), 0.0, 1.0);
  vec2 cell = floor(vUv * uVolRes);
  float b = bayer4(cell) - 0.5;
  int hd = dot(hwN, vec4(1.0)) > 0.002 ? domHue(hwN, bayer4(cell + vec2(2.0, 1.0))) : 0;   // orange and empty pixels skip it
  vec3 col; float covS = 0.0, tempS = 1.0; vec4 hwS = vec4(0.0);
  if (uSoftSmoke > 0.5 && 1.0 - v.a > 0.002) {   // (empty coarse pixels skip the soft sample)
    vec4 hvS;
    vec4 vs = volSmooth(hvS, false);
    covS = clamp(vs.r * uExposure, 0.0, 1.0);
    tempS = clamp(vs.g / max(vs.r, 1e-4), 0.0, 1.0);
    hwS = hwN;   // the smoke's glow from below takes the fire pixel's hue (no second hue fetch)
    float AsS = clamp(1.0 - vs.a - covS, 0.0, 1.0);
    col = scene * (1.0 - AsS) + max(uSmokeCol * vs.b, scene * AsS * uSmokeFloor);
  } else if (uSoftSmoke > 0.5) {
    col = scene;
  } else {   // softSmoke 0: smoke in flat steps on the coarse grid
    float As = clamp(1.0 - v.a - cov, 0.0, 1.0);
    float aq = As < 0.14 ? 0.0 : (As < 0.32 ? 0.3 : 0.55);
    vec3 sm = max(uSmokeCol * (v.b / max(As, 0.02)), scene * uSmokeFloor);
    col = scene * (1.0 - aq) + sm * aq;
  }
  // the six ART-DIRECTION colours, stepped by temperature; the dither only touches the band borders and the fire's own
  // edge (never the sky, the moon or the smoke)
  float lv = clamp(floor(temp * 6.0 + 0.35 + b * 0.6), 0.0, 5.0);   // + 0.35: the body lands on orange, not crimson
  vec3 c = uPal[hd * 6 + int(lv)];
  c *= lv > 4.5 ? 1.0 + (uBright - 1.0) * 0.2 : 1.0;   // a little HDR only: a bloom halo is not pixel art
  float isFlame = step(0.16, temp);                     // flames (not the smoke's orange underside)
  float fireOn = step(0.5 + b * 0.35, cov) * isFlame;
  float glowOn = (1.0 - fireOn) * step(0.18, cov) * isFlame;   // a #a3241a rim round the flames (not thin veils)
  col += rampMix(tempS, hwS) * covS * (1.0 - step(0.16, tempS));  // the smoke's glow from below stays soft too
  col = mix(col, uRim[hd], glowOn * 0.9);
  col = mix(col, c, fireOn);
#else
  vec4 hw;
  vec4 v = volSmooth(hw, true);
  float A = clamp(1.0 - v.a, 0.0, 1.0);
  float cov = clamp(v.r * uExposure, 0.0, 1.0);          // fire coverage
  float temp = clamp(v.g / max(v.r, 1e-4), 0.0, 1.0);    // emission-weighted temperature
  vec3 smoke = uSmokeCol * v.b;                           // translucent charcoal, moon-lit
  // the cool flame edge (temperature ≈ 0.2: #a3241a) reads as a rim, more opaque and brighter; the smoke's glow
  // from below (0.12) is left alone (boosting it painted a crimson haze up the walls)
  float rimW = smoothstep(0.14, 0.19, temp) * (1.0 - smoothstep(0.26, 0.42, temp));
  vec3 fire = rampMix(temp, hw) * mix(cov, sqrt(cov), rimW * 0.6) * (1.0 + uRimGain * rimW) * mix(1.0, uBright, smoothstep(0.8, 1.0, temp));   // HDR only at the hot cores
  float As = clamp(A - cov, 0.0, 1.0);
  smoke = max(smoke, scene * As * uSmokeFloor);           // smoke is never much darker than what it covers
  vec3 col = scene * (1.0 - A) + smoke + fire;
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

export class VolumePass {
  /** @param {THREE.WebGLRenderer} renderer @param {{ quad: import('./gl.js').Quad, noise: THREE.Texture }} o */
  constructor(renderer, { quad, noise }) {
    this.renderer = renderer; this.quad = quad; this.noise = noise;
    this.style = 'smooth'; this.maxSteps = 72; this.stepScale = 1;
    this.hueOn = false;   // any coloured fire alive (index.js): off = the hue reads are skipped (uniform branch), orange-only cost
    this.rt = null; this.w = 0; this.h = 0; this.frame = 0;
    const U = (v) => ({ value: v });
    this.depthU = { uDepth: U(null), uInvProj: U(new THREE.Matrix4()), uCamWorld: U(new THREE.Matrix4()), uNear: U(0.1), uFar: U(1000) };
    const m = W.moonDir;
    this.marchU = {
      ...this.depthU, uNoise: U(noise), uS: U(null), uHueMap: U(null), uHueOn: U(0), uVel: U(null), uLight: U(null), uCamPos: U(new THREE.Vector3()),
      uRect: U(new THREE.Vector4(W.area.x0, W.area.z0, W.area.size, W.area.size)), uVolRes: U(new THREE.Vector2(1, 1)),
      uTime: U(0), uFrame: U(0), uJitter: U(1), uFlameH: U(0), uLean: U(0), uSmokeLean: U(0), uFireGain: U(0), uSmokeK: U(0), uSmokeTop: U(LOOK.smokeTop),
      uNearFade: U(0), uStepScale: U(1), uSheetGain: U(LOOK.sheetGain), uSheetH: U(LOOK.sheetH), uSmokeGlow: U(LOOK.smokeGlow),
      uSmokeMaxA: U(LOOK.smokeMaxA), uSmokeFar: U(LOOK.smokeFar), uFineStep: U(1), uTall: U(1), uInFire: U(new THREE.Vector3(1.4, 6.5, 0.35)), uInFireCool: U(0.78), uCamFire: U(0), uCoreHeat: U(LOOK.coreHeat), uWallFade: U(LOOK.wallFade), uMoonDir: U(new THREE.Vector3(m.x, m.y, m.z)),
    };
    this.compU = {
      ...this.depthU, uScene: U(null), uVol: U(null), uVolHue: U(null), uVolRes: this.marchU.uVolRes, uFullRes: U(new THREE.Vector2(1, 1)), uPix: U(4),
      uPal: U(Array.from({ length: 30 }, () => new THREE.Vector3())), uRim: U(Array.from({ length: 5 }, () => new THREE.Vector3())),
      uExposure: U(LOOK.fireExposure), uBright: U(LOOK.bright), uHueOn: this.marchU.uHueOn, uRimGain: U(LOOK.rimGain),
      // charcoal-brown #312526 lit by the moon (linear, per unit of moon-lit smoke); the hybrid's crimson-brown rim
      uSmokeCol: U(new THREE.Vector3(0.048, 0.034, 0.038)), uSmokeWarm: U(new THREE.Vector3(0.16, 0.025, 0.01)), uSmokeFloor: U(0.3), uSoftSmoke: U(1),
    };
    this.setRamps();
    this._build();
  }

  /** (Re)load HUE_RAMPS into the composite's palette (orange = PALETTE) and the hybrid rims. */
  setRamps() {
    HUE_ORDER.forEach((h, k) => {
      HUE_RAMPS[h].forEach((hex, i) => { const c = linColor(hex); this.compU.uPal.value[k * 6 + i].set(c.r, c.g, c.b); });
      if (k === 0) this.compU.uRim.value[0].set(...ORANGE_RIM);
      else { const c = linColor(HUE_RAMPS[h][1]); this.compU.uRim.value[k].set(c.r, c.g, c.b); }
    });
  }

  /** Materials are cached per style/step count (never disposed on a switch, so their programs stay compiled). */
  _build() {
    this.cache = this.cache || new Map();
    // two variants each: without HUE the march and composite are the orange-only shaders (no hue reads at all: a
    // uniform-guarded fetch measured +0.4 ms at 1080p, the compiler flattens it); with HUE, the coloured-fire ones
    // the march also comes with INFIRE (the eye stands in fire) or without (the plain march)
    for (const hue of [false, true]) {
      const ck = 'c' + this.style + (hue ? 'h' : '');
      const hd = hue ? { HUE: 1 } : {};
      for (const inf of [false, true]) {
        const mk = 'm' + this.maxSteps + (hue ? 'h' : '') + (inf ? 'f' : '');
        if (!this.cache.has(mk)) this.cache.set(mk, passMaterial(MARCH, this.marchU, { defines: { MAX_STEPS: this.maxSteps, ...hd, ...(inf ? { INFIRE: 1 } : {}) }, mrt: true }));
      }
      if (!this.cache.has(ck)) this.cache.set(ck, passMaterial(COMPOSITE, this.compU, { defines: this.style === 'hybrid' ? { HYBRID: 1, ...hd } : hd }));
    }
    const k = this.hueOn ? 'h' : '';
    this.marchMat = this.cache.get('m' + this.maxSteps + k + (this.inFireOn ? 'f' : '')); this.compMat = this.cache.get('c' + this.style + k);
  }

  /** Every variant of the current style/steps (fluid.warm() compiles them all). */
  variants() { return ['', 'h'].flatMap((k) => [this.cache.get('m' + this.maxSteps + k), this.cache.get('m' + this.maxSteps + k + 'f'), this.cache.get('c' + this.style + k)]); }

  /** The eye in fire (0..1): picks the INFIRE march while it is above ≈ 0.01. */
  setCamFire(x) { this.camFire = x; const on = x > 0.01; if (on !== !!this.inFireOn) { this.inFireOn = on; this._build(); } }

  /** Coloured fire alive or not: picks the shader variants (index.js, once a frame). */
  setHue(on) { on = !!on; if (on !== this.hueOn) { this.hueOn = on; this._build(); } }

  setStyle(style) { if (style !== this.style) { this.style = style; this._applySteps(); this._build(); this.w = 0; } }
  /** Tier steps; hybrid marches a quarter of the pixels, so it takes finer steps (less noise in the stepped ramp). */
  setSteps(n, scale) { this.tierSteps = [n, scale]; this._applySteps(); this._build(); }
  _applySteps() {
    const [n, scale] = this.tierSteps || [64, 1];
    this.maxSteps = this.style === 'hybrid' ? Math.round(n * 1.35) : n;
    this.stepScale = this.style === 'hybrid' ? scale * 0.7 : scale;
  }

  /** Fire-pixel size for hybrid: ≈ 4 screen px at 1080p. */
  pixelSize(height) { return this.style === 'hybrid' ? Math.max(2, Math.round(height / 270)) : 2; }

  /** The volume target for a screen size in the current style. The targets are kept per size, so
   *  switching styles back and forth never re-allocates (`prealloc` makes the other style's at the first frame). */
  _ensure(width, height) {
    const k = this.pixelSize(height);
    const w = Math.max(1, Math.ceil(width / k)), h = Math.max(1, Math.ceil(height / k));
    if (this.rt && w === this.w && h === this.h) return;
    this.rt = this._target(w, h);
    this.w = w; this.h = h;
    this.marchU.uVolRes.value.set(w, h);
  }
  _target(w, h) {
    this.rts = this.rts || new Map();
    const key = w + 'x' + h;
    let rt = this.rts.get(key);
    if (!rt) {
      rt = makeTarget(w, h, { type: THREE.HalfFloatType, filter: THREE.NearestFilter, count: 2 });   // [0] fire/smoke/T, [1] hue mass
      this.rts.set(key, rt);
      if (this.rts.size > 4) { for (const [k2, r2] of this.rts) if (r2 !== rt && r2 !== this.rt) { r2.dispose(); this.rts.delete(k2); break; } }   // (a resize: drop the oldest)
    }
    return rt;
  }
  /** Allocate (and clear, so the GPU really allocates) both styles' targets for a screen size. */
  prealloc(width, height) {
    const r = this.renderer, prev = r.getRenderTarget(), pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    for (const k of [2, Math.max(2, Math.round(height / 270))]) {
      const rt = this._target(Math.max(1, Math.ceil(width / k)), Math.max(1, Math.ceil(height / k)));
      r.setRenderTarget(rt); r.clear(true, false, false);
    }
    r.setClearColor(pc, pa); r.setRenderTarget(prev);
  }
  /** Forget the targets of a size (fluid.warm()'s small warm-up frames). */
  dropSize(width, height) {
    for (const k of [2, Math.max(2, Math.round(height / 270))]) {
      const key = Math.max(1, Math.ceil(width / k)) + 'x' + Math.max(1, Math.ceil(height / k)), rt = this.rts?.get(key);
      if (rt) { if (rt === this.rt) { this.rt = null; this.w = 0; this.h = 0; } rt.dispose(); this.rts.delete(key); }
    }
  }

  /** Point the shared depth uniforms at this frame's camera + depth. */
  setCamera(camera, depthTex) {
    const d = this.depthU;
    d.uDepth.value = depthTex;
    d.uInvProj.value.copy(camera.projectionMatrixInverse);
    d.uCamWorld.value.copy(camera.matrixWorld);
    d.uNear.value = camera.near; d.uFar.value = camera.far;
    this.marchU.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  /** March into the volume target. Leaves the target bound for the jet to add into. */
  march(solver, { width, height, time }) {
    this._ensure(width, height);
    const u = this.marchU;
    u.uS.value = solver.S.read.textures[0]; u.uHueMap.value = solver.hueRT.texture; u.uHueOn.value = this.hueOn ? 1 : 0; u.uVel.value = solver.V.read.texture; u.uLight.value = solver.lightRT.texture;
    u.uTime.value = time; u.uFrame.value = this.frame++; u.uJitter.value = this.style === 'hybrid' ? 0 : 1;
    const rn = solver.rain || 0; this.rain = rn;
    u.uFlameH.value = LOOK.flameH * (1 - LOOK.rainFlame * rn); u.uLean.value = LOOK.lean; u.uSmokeLean.value = LOOK.smokeLean; u.uFireGain.value = LOOK.fireGain;
    u.uSmokeK.value = LOOK.smokeK; u.uSmokeTop.value = LOOK.smokeTop; u.uNearFade.value = LOOK.nearFade; u.uStepScale.value = this.stepScale;
    u.uInFire.value.set(LOOK.inFireFade0, LOOK.inFireFade1, LOOK.inFireSheet); u.uInFireCool.value = LOOK.inFireCool; u.uCamFire.value = this.camFire || 0; u.uCoreHeat.value = LOOK.coreHeat; u.uWallFade.value = LOOK.wallFade;
    u.uSheetGain.value = LOOK.sheetGain; u.uSheetH.value = LOOK.sheetH; u.uSmokeGlow.value = LOOK.smokeGlow;
    u.uSmokeMaxA.value = LOOK.smokeMaxA; u.uSmokeFar.value = LOOK.smokeFar; u.uFineStep.value = LOOK.fineStep; u.uTall.value = LOOK.tall;
    this.quad.run(this.renderer, this.marchMat, this.rt);
  }

  /** An empty volume (the fluid is switched off). */
  clear(width, height) {
    this._ensure(width, height);
    const r = this.renderer, pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 1); r.clear(true, false, false); r.setClearColor(pc, pa);   // T = 1 (the hue output's lilac reads 1, but its coverage is 0)
  }

  composite(colorTex, target, width, height) {
    const u = this.compU;
    u.uScene.value = colorTex; u.uVol.value = this.rt.textures[0]; u.uVolHue.value = this.rt.textures[1]; u.uFullRes.value.set(width, height);
    u.uExposure.value = LOOK.fireExposure; u.uBright.value = LOOK.bright; u.uSoftSmoke.value = LOOK.softSmoke; u.uRimGain.value = LOOK.rimGain;
    const st = LOOK.rainSteam * (this.rain || 0);   // steamy, paler smoke in the rain
    u.uSmokeCol.value.set(SMOKE_COL[0] + (STEAM_COL[0] - SMOKE_COL[0]) * st, SMOKE_COL[1] + (STEAM_COL[1] - SMOKE_COL[1]) * st, SMOKE_COL[2] + (STEAM_COL[2] - SMOKE_COL[2]) * st);
    this.quad.run(this.renderer, this.compMat, target);
  }

  dispose() { for (const rt of (this.rts || new Map()).values()) rt.dispose(); this.rt = null; for (const m of this.cache.values()) m.dispose(); }
}
