import { passMaterial, Quad } from '../../src/kit/webgl2/index.js';
import { info } from './info.js';
import { SourceStream } from './emitter.js';
import { CurvedVolume } from './curved-volume.js';

export { info } from './info.js';

const SPACING = { high: 0.065, medium: 0.086, low: 0.12 };
const COPY = /* glsl */`
uniform sampler2D uScene;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uScene, vUv); }
`;

export async function create(host) {
  const stream = new SourceStream(host.world);
  const volume = new CurvedVolume(host.world.lance.speed);
  const quad = new Quad();
  const copy = passMaterial(COPY, { uScene: { value: null } });
  let spacing = SPACING[host.quality] ?? SPACING.high;
  let disposed = false;

  return {
    lance(state) { stream.latch(state); },
    update(dt) { stream.update(dt); },
    render(r, { colorTex, depthTex, camera, target = null, width, height }) {
      if (disposed) return;
      stream.advance();
      const prev = r.getRenderTarget(), ac = r.autoClear;
      const face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
      r.autoClear = false;
      try {
        copy.uniforms.uScene.value = colorTex;
        quad.run(r, copy, target);
        volume.draw(r, camera, depthTex, width, height, stream, spacing);
      } finally {
        r.autoClear = ac;
        r.setRenderTarget(prev, face, mip);
      }
    },
    async warm(r, camera) { await r.compileAsync(volume.mesh, camera); },
    setQuality(q) { spacing = SPACING[q] ?? SPACING.high; },
    stats() {
      return {
        module: info.id, particles: stream.emitter.count, births: stream.emitter.births, time: stream.time,
        chains: volume.chains, sections: volume.sections, triangles: volume.vertices / 3, spacing,
        totalSteps: stream.totalSteps, droppedSeconds: stream.droppedSeconds,
      };
    },
    reset() { stream.reset(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      volume.dispose();
      copy.dispose();
      quad.dispose();
    },
  };
}
