// FIREWRAITH · classic-webgpu · what this module says about itself (Fire API v1 `info`). No imports: hosts and tests read
// it without loading three.js.
export const info = Object.freeze({
  id: 'classic-webgpu',
  name: 'Classic (WebGPU)',
  version: '1.0.0',
  api: 1,
  backend: 'webgpu',
  slots: Object.freeze(['lance', 'ground']),
  author: 'VALLEYWARD',
  method: 'classic ported to TSL: ground: a 2D GPU grid fluid (fuel, fire, smoke, heat, flow) drawn as a ray-marched 2.5D volume; lance: CPU particles on the ballistic arc',
  description: 'The classic fire on WebGPU: the same marbled ground fire, smoke, embers, steam, five hues, smooth and pixel-art styles, light map and gameplay grid as the webgl2 classic, with the same knobs.',
});
