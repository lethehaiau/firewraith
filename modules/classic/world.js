// FIREWRAITH · classic · the world this module draws into: `create(host)` copies host.world here before anything is
// built (the shaders read the ground GLSL and the fire area when their materials are made). One world per page.

/** @type {import('../../src/api/index.js').World} */
export const W = {
  area: { x0: -32, z0: -32, size: 64 },
  groundHeight: () => 0,
  groundGLSL: 'float ewGround(vec2 p) { return 0.0; }',
  walls: [],
  moonDir: { x: 0, y: 1, z: 0 },
  lance: { speed: 16, gravity: 14 },
  light: { gain: 1, height: 4 },
};

/** @param {Partial<import('../../src/api/index.js').World>} w */
export function setWorld(w = {}) {
  if (w.area) W.area = { x0: +w.area.x0, z0: +w.area.z0, size: +w.area.size };
  if (typeof w.groundHeight === 'function') W.groundHeight = w.groundHeight;
  if (typeof w.groundGLSL === 'string' && w.groundGLSL.includes('ewGround')) W.groundGLSL = w.groundGLSL;
  if (Array.isArray(w.walls)) W.walls = w.walls.map((b) => [+b[0], +b[1], +b[2], +b[3]]);
  if (w.moonDir) W.moonDir = { x: +w.moonDir.x, y: +w.moonDir.y, z: +w.moonDir.z };
  if (w.lance) W.lance = { speed: +w.lance.speed || 16, gravity: +w.lance.gravity || 14 };
  if (w.light) W.light = w.light;   // live getters (the game's knobs)
}
