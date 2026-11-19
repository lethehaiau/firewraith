// @ts-check
// FIREWRAITH · Fire API v1 · the fire events: what the game sends a `ground` module every frame (docs/API.md "Events").
// Pure data, no imports.
//
// Every sim tick the game collects plain objects like these; once a frame the host hands the events of every tick since
// the last frame to `module.events(list, wind)`. Units are world metres, metres per second and seconds; x/z are world
// coordinates (y is up; `host.world.area` is the rectangle the fire lives in). Amounts are 0..1 "how much" knobs; each
// module decides what they mean in its own simulation.

export const FIRE_OP = Object.freeze({
  /** The Ember Lance's jet landing on the ground: a moving line source. One per tick while spraying.
   *  { kind:'stream', x0, z0, x1, z1, vx, vz, amount, radius, hue? }  the segment from where the jet first touches down
   *  to its far end this tick; (vx, vz) the jet's ground velocity (m/s); radius ≈ 0.6–1.2 m. */
  STREAM: 'stream',
  /** A burst of fire with a radial push: firebombs, barrel explosions, the Sunburst ring's leading edge.
   *  { kind:'burst', x, z, r, amount, push, hue? }  push = outward speed m/s at the rim. */
  BURST: 'burst',
  /** Pour fuel (oil) without lighting it: barrel splashes, refilled troughs, oil-soaked goblins.
   *  { kind:'fuel', x, z, r, amount } or { kind:'fuel', box:{ x0, z0, x1, z1 }, amount } */
  FUEL: 'fuel',
  /** A small fire source: a burning goblin, a brazier spill. Many per tick (≤ FIRE_CAPS.ember).
   *  { kind:'ember', x, z, amount, hue? } */
  EMBER: 'ember',
  /** Push the air without fire (enemy movement, the troll's stomp, shock waves).  { kind:'push', x, z, vx, vz, r } */
  PUSH: 'push',
  /** Remove fire and heat: in a disc { kind:'douse', x, z, r } or along a line { kind:'douse', x0, z0, x1, z1, r, vx?, vz? }
   *  (a rain front, the dawn, a bucket). */
  DOUSE: 'douse',
  /** A whirlpool that pulls and spins the air and the fire.  { kind:'swirl', x, z, r, spin, pull, amount } */
  SWIRL: 'swirl',
});

/** Fire colours. Events that make fire (stream, burst, ember) may carry `hue`; missing means 'orange'. */
export const FIRE_HUE = Object.freeze({ ORANGE: 'orange', VIOLET: 'violet', BLUE: 'blue', GREEN: 'green', LILAC: 'lilac' });

/** Each hue's reference ramp (sRGB hex, coolest → hottest), the one the `classic` module draws with: what a "violet"
 *  fire should read as. Modules may use their own colours. */
export const HUE_RAMPS = Object.freeze({
  orange: Object.freeze(['#4a1612', '#a3241a', '#e85a1c', '#ff9a2e', '#ffd24a', '#fff2b8']),
  violet: Object.freeze(['#2c0a52', '#6a1fb3', '#9a45f0', '#c46bff', '#e4b2ff', '#fff0ff']),
  blue: Object.freeze(['#0a1c5c', '#1a4fd6', '#2f8cf2', '#4fb8ff', '#aee6ff', '#eaffff']),
  green: Object.freeze(['#0b3a14', '#1f8f2a', '#4fd23a', '#7dff4f', '#c6ff94', '#f4ffd8']),
  lilac: Object.freeze(['#33195e', '#7f4fc4', '#a571ea', '#cf98ff', '#ebcbff', '#fff4ff']),
});
/** Each hue's light colour (linear RGB): the colour a fire of that hue casts on the world. */
export const HUE_LIGHT = Object.freeze({
  orange: Object.freeze([1.0, 0.42, 0.13]), violet: Object.freeze([0.62, 0.2, 1.0]), blue: Object.freeze([0.12, 0.5, 1.0]),
  green: Object.freeze([0.3, 0.95, 0.14]), lilac: Object.freeze([0.78, 0.48, 1.0]),
});

/** Most events per tick the game sends (it keeps to these; a module may merge further). */
export const FIRE_CAPS = Object.freeze({ ember: 160, push: 256, total: 480 });

const KINDS = new Set(Object.values(FIRE_OP));
/** Is `op` a well-formed fire event (kind known, numbers finite)? For tests and benches. @param {any} op */
export function isFireEvent(op) {
  if (!op || typeof op !== 'object' || !KINDS.has(op.kind)) return false;
  for (const [k, v] of Object.entries(op)) if (typeof v === 'number' && !Number.isFinite(v)) return false;
  if (op.hue != null && !Object.values(FIRE_HUE).includes(op.hue)) return false;
  return true;
}
