// FIREWRAITH · classic · what this module says about itself (Fire API v1 `info`). No imports: hosts and tests read it
// without loading three.js.
export const info = Object.freeze({
  id: 'classic',
  name: 'Classic',
  version: '1.0.0',
  api: 1,
  backend: 'webgl2',
  slots: Object.freeze(['lance', 'ground']),
  author: 'VALLEYWARD',
  method: 'ground: a 2D GPU grid fluid (fuel, fire, smoke, heat, flow) drawn as a ray-marched 2.5D volume; lance: CPU particles on the ballistic arc',
  description: 'VALLEYWARD\'s original fire: marbled ground fire that spreads along oil, rising smoke, embers, steam, five hues, smooth and pixel-art styles.',
});
