import { defineInfo } from '../../src/api/index.js';

export const info = defineInfo({
  id: 'lance-curved-volume',
  name: 'Curved Volume Lance',
  version: '0.1.0',
  api: 1,
  backend: 'webgl2',
  slots: ['lance'],
  author: 'Au Le',
  method: 'Sweep a tapered lattice along ballistic particles and shade its view-aligned slices',
  description: 'A procedural Lance flame with a bright core that bends with the shot and breaks during sharp turns.',
});
