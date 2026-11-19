// @ts-check
// FIREWRAITH · Fire API v1 (docs/API.md is the normative text). What a fire module exports, what the game (the host)
// gives it, and small validators for tests, benches and the host. Pure JS, no three.js import: the game's Node tests
// load it too.
export { FIRE_OP, FIRE_HUE, FIRE_CAPS, HUE_RAMPS, HUE_LIGHT, isFireEvent } from './events.js';

/** The API version this package describes. A module states the version it was written for in `info.api`. */
export const API_VERSION = 1;
/** Where a module can plug in. `lance`: the Ember Lance's airborne flame. `ground`: the fire on the ground. */
export const SLOTS = Object.freeze(['lance', 'ground']);
/** Which graphics API a module draws with: the game boots the edition (shading layer) that matches. */
export const BACKENDS = Object.freeze(['webgl2', 'webgpu']);
export const STYLES = Object.freeze(['smooth', 'hybrid']);
export const QUALITIES = Object.freeze(['high', 'medium', 'low']);

/**
 * @typedef {'lance'|'ground'} Slot
 * @typedef {'webgl2'|'webgpu'} Backend
 *
 * @typedef {object} ModuleInfo  what a module says about itself (`export const info`)
 * @property {string} id         short, URL-safe: [a-z0-9-]
 * @property {string} name       shown in the game's picker
 * @property {string} version    semver of the module
 * @property {number} api        the Fire API version it was written for (1)
 * @property {Backend} backend
 * @property {Slot[]} slots      the slots it can fill
 * @property {string} [author]
 * @property {string} [method]   one line: how it works (a 2D grid, a 3D grid, particles, …)
 * @property {string} [description]
 * @property {string} [homepage]
 *
 * @typedef {object} World       the game world a module draws into (`host.world`); metres, y up
 * @property {{ x0: number, z0: number, size: number }} area   the square on the ground the ground fire lives in
 * @property {(x: number, z: number) => number} groundHeight   the terrain height
 * @property {string} [groundGLSL]   webgl2: GLSL that defines `float ewGround(vec2 xz)`, identical to groundHeight
 * @property {Function} [groundTSL]  webgpu: a TSL `Fn(vec2 xz) → float`, identical to groundHeight (optional)
 * @property {number[][]} walls      boxes [x0, z0, x1, z1] that fire and air cannot enter (the keep's wall and towers)
 * @property {{ x: number, y: number, z: number }} moonDir   unit vector toward the moon (the night's key light)
 * @property {{ speed: number, gravity: number }} lance      the Lance stream's ballistic physics (m/s, m/s²)
 * @property {{ readonly gain: number, readonly height: number }} light   the game's fire-light knobs (strength; the
 *           height at which the light halves), for `nearLight`
 *
 * @typedef {object} Host        what `create(host)` receives
 * @property {number} api
 * @property {Backend} backend
 * @property {any} renderer      webgl2: the game's THREE.WebGLRenderer; webgpu: its THREE.WebGPURenderer (shared, never
 *                               create your own canvas)
 * @property {'high'|'medium'|'low'} quality
 * @property {'smooth'|'hybrid'} style   the look the player picked: smooth, or pixel-art "hybrid"; a hint
 * @property {Slot[]} slots      the slots this instance must fill (a subset of info.slots)
 * @property {World} world
 * @property {{ debug?: boolean, gpuTiming?: boolean, params?: URLSearchParams }} options
 *
 * @typedef {object} LanceState  `module.lance(state)`, once a frame
 * @property {boolean} on
 * @property {{ x: number, y: number, z: number }} origin   the nozzle (world)
 * @property {{ x: number, y: number, z: number }} dir      unit aim direction
 * @property {number} range      horizontal reach (m); past it the stream rains down
 * @property {number} t          seconds the trigger has been held
 * @property {string} hue        FIRE_HUE
 * @property {{ x: number, y: number, z: number } | null} landing   where the game's arc touches down (null when off)
 *
 * @typedef {object} RenderArgs
 * @property {any} colorTex      the scene so far (linear HDR)
 * @property {any} depthTex      the scene depth (standard perspective depth)
 * @property {any} camera
 * @property {any} target        draw the scene + your fire here (linear HDR); null = the canvas
 * @property {number} width
 * @property {number} height
 *
 * @typedef {object} FireProvider   the gameplay fire a `ground` module may provide (it then decides what burns)
 * @property {(x: number, z: number) => number} heat   0..1; a goblin catches fire at ≥ 0.22
 * @property {(x: number, z: number) => number} fuel   0..1 oil on the ground
 * @property {(x: number, z: number) => number} [fire]
 * @property {boolean} ready     false until the first grid is available
 * @property {number} ageFrames  frames since the grid was made; the game uses its CPU fire grid while this is > 30
 *
 * @typedef {object} FireModule  what `create(host)` returns
 * @property {(list: object[], wind: { x: number, z: number }) => void} [events]   ground: the fire events since last frame
 * @property {(state: LanceState) => void} [lance]                               lance: the Lance, once a frame
 * @property {(dt: number, ctx: { rain: number, time: number }) => void} update    game seconds (0 while paused)
 * @property {(renderer: any, args: RenderArgs) => void} render
 * @property {FireProvider} [fire]          ground, optional: gameplay
 * @property {any} [lightMap]               ground, optional: a texture over world.area, RGB = linear fire light
 * @property {(x: number, y: number, z: number, out: { setRGB: Function }) => boolean} [nearLight]   optional
 * @property {{ set: Function, clear: Function, get?: Function }} [columns]   optional extra: the ending's fire columns
 * @property {(renderer: any, camera: any) => Promise<void>|void} [warm]   compile every shader before play
 * @property {(style: 'smooth'|'hybrid') => void} [setStyle]
 * @property {(quality: 'high'|'medium'|'low') => void} [setQuality]
 * @property {() => object} [stats]
 * @property {() => void} reset            a fresh night: clear everything
 * @property {() => void} dispose
 */

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Problems with a module's `info` (an empty list = valid). @param {any} info @returns {string[]} */
export function checkInfo(info) {
  const p = [];
  if (!info || typeof info !== 'object') return ['info is missing'];
  if (typeof info.id !== 'string' || !ID.test(info.id)) p.push('info.id must be 1–40 chars of a-z, 0-9 and -');
  if (typeof info.name !== 'string' || !info.name.trim()) p.push('info.name is required');
  if (typeof info.version !== 'string' || !info.version) p.push('info.version is required');
  if (info.api !== API_VERSION) p.push(`info.api must be ${API_VERSION} (this game speaks Fire API v${API_VERSION})`);
  if (!BACKENDS.includes(info.backend)) p.push(`info.backend must be one of ${BACKENDS.join(', ')}`);
  if (!Array.isArray(info.slots) || !info.slots.length || !info.slots.every((s) => SLOTS.includes(s))) p.push(`info.slots must list some of ${SLOTS.join(', ')}`);
  return p;
}

/** Problems with what `create(host)` returned for the given slots (an empty list = valid).
 *  @param {any} m @param {Slot[]} slots @returns {string[]} */
export function checkModule(m, slots) {
  const p = [];
  if (!m || typeof m !== 'object') return ['create() returned nothing'];
  for (const k of ['update', 'render', 'reset', 'dispose']) if (typeof m[k] !== 'function') p.push(`module.${k}() is required`);
  if (slots.includes('ground') && typeof m.events !== 'function') p.push('a ground module needs events(list, wind)');
  if (slots.includes('lance') && typeof m.lance !== 'function') p.push('a lance module needs lance(state)');
  if (m.fire != null) for (const k of ['heat', 'fuel']) if (typeof m.fire[k] !== 'function') p.push(`module.fire.${k}(x, z) must be a function`);
  return p;
}

/** Helper for authors: returns `info` frozen after checking it (throws with every problem listed). @param {ModuleInfo} info */
export function defineInfo(info) {
  const p = checkInfo(info);
  if (p.length) throw new Error(`firewraith: bad module info: ${p.join('; ')}`);
  return Object.freeze({ ...info, slots: Object.freeze([...info.slots]) });
}
