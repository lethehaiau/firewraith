// FIREWRAITH · classic · GL helpers: the kit's (render targets, ping-pong pairs, the full-screen pass runner), plus the
// hue channels and the world's ground GLSL, which `passMaterial` puts where a shader says /*@ew_ground*/.
import { FS_VERT, pickFloatTypes, makeTarget, MRT2, PingPong, Quad, passMaterial as kitPassMaterial, linColor } from '../../src/kit/webgl2/index.js';
import { W } from './world.js';

export { FS_VERT, pickFloatTypes, makeTarget, MRT2, PingPong, Quad, linColor };

/** Where a shader wants the world's `float ewGround(vec2 xz)` (host.world.groundGLSL). */
export const GROUND_MARK = '/*@ew_ground*/';
/** @param {string} glsl */
export function withWorld(glsl) { return glsl.includes(GROUND_MARK) ? glsl.split(GROUND_MARK).join(W.groundGLSL) : glsl; }

/** A ShaderMaterial for a full-screen pass (no depth, no blending unless asked), with the world's ground GLSL. */
export function passMaterial(frag, uniforms, extra = {}) { return kitPassMaterial(withWorld(frag), uniforms, extra); }

/** The hue channels of the hue fields: orange has no channel (1 − the sum of the others). */
export const HUE_INDEX = Object.freeze({ orange: -1, violet: 0, blue: 1, green: 2, lilac: 3 });
/** One-hot vec4 for an op's hue (unknown or missing = orange = zeros). @param {string|undefined} hue @returns {number[]} */
export function hueVec(hue) {
  const i = hue ? HUE_INDEX[hue] ?? -1 : -1;
  const v = [0, 0, 0, 0]; if (i >= 0) v[i] = 1; return v;
}
