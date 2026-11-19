// FIREWRAITH · classic-webgpu · the world this module draws into. The plain data (area, walls, ground height in JS, the
// Lance's physics, the light knobs) lives in classic's world store, which classic's CPU code reads (the jet's arc, the
// steam, the splat queue); this file adds the terrain in TSL (`host.world.groundTSL`, docs/API.md).
import { Fn, float } from 'three/tsl';
import { W, setWorld as setClassicWorld } from '../classic/world.js';

export { W };

/** The terrain height in TSL: (vec2 xz) → float. Flat until the host gives `world.groundTSL`. */
export const WG = { ground: Fn(() => float(0.0)) };

/** Copy host.world into classic's store and keep its TSL terrain. @param {any} w */
export function setWorld(w = {}) {
  setClassicWorld(w);
  if (typeof w.groundTSL === 'function') WG.ground = w.groundTSL;
}

/** The terrain height at a world xz (a vec2 node). */
export const ground = (xz) => WG.ground(xz);
