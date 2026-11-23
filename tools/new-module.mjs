import { mkdir, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MODULES } from '../modules/catalog.js';
import { checkInfo } from '../src/api/index.js';

const usage = 'npm run module:new -- <id> --slot lance|ground|both --author "Your name" [--backend webgl2|webgpu] [--name "Display name"]';
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  slot: { type: 'string' }, backend: { type: 'string', default: 'webgl2' },
  author: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) { console.log(usage); process.exit(0); }
const [id] = positionals;
const slots = values.slot === 'both' ? ['lance', 'ground'] : [values.slot];
const info = {
  id, name: values.name || id, version: '0.1.0', api: 1, backend: values.backend, slots,
  author: values.author?.trim(), method: 'Scene-color copy', description: 'Starter module for a new fire effect.',
};
const problems = checkInfo(info);
if (!info.author) problems.push('Pass --author to credit the module author.');
if (positionals.length !== 1 || problems.length) {
  console.error([...problems, usage].join('\n'));
  process.exit(1);
}
if (Object.hasOwn(MODULES, id)) throw new Error(`A module named ${id} is already registered`);

const gpu = info.backend === 'webgpu';
const hooks = [];
if (slots.includes('lance')) hooks.push('    lance(state) { firing = !!state.on; },');
if (slots.includes('ground')) hooks.push('    events(list) { eventCount += list.length; },');
const firing = slots.includes('lance') ? 'firing' : null;
const events = slots.includes('ground') ? 'eventCount' : null;
const members = ['seconds', 'quality', firing, events].filter(Boolean);
const copySetup = gpu ? `  const sceneColor = texNode(warmSource.texture);
  const material = passMaterial(sceneColor);` : `  const sceneColor = { value: warmSource.texture };
  const material = passMaterial(/* glsl */\`
    uniform sampler2D uScene;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(uScene, vUv); }
  \`, { uScene: sceneColor });`;

const runtime = `import { Quad, makeTarget, passMaterial${gpu ? ', texNode' : ''} } from '../../src/kit/${info.backend}/index.js';
export { info } from './info.js';

export async function create(host) {
  const quad = new Quad();
  const warmSource = makeTarget(1, 1);
${copySetup}
  let seconds = 0, quality = host.quality, warmed = false, disposed = false;
${firing ? '  let firing = false;\n' : ''}${events ? '  let eventCount = 0;\n' : ''}
  function render(renderer, { colorTex, target = null }) {
    if (disposed) return;
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      sceneColor.value = colorTex;
      quad.run(renderer, material, target);
    } finally {
      renderer.setRenderTarget(previous, face, mip);
      renderer.autoClear = autoClear;
    }
  }

  return {
${hooks.join('\n')}
    update(dt) { if (Number.isFinite(dt) && dt > 0) seconds += dt; },
    render,
    async warm(renderer) {
      if (warmed || disposed) return;
      const target = makeTarget(1, 1);
      try {
        render(renderer, { colorTex: warmSource.texture, target });
        warmed = true;
      } finally { target.dispose(); }
    },
    setQuality(next) { quality = next; },
    stats() { return { ${members.join(', ')} }; },
    reset() { seconds = 0;${firing ? ' firing = false;' : ''}${events ? ' eventCount = 0;' : ''} },
    dispose() {
      if (disposed) return;
      disposed = true;
      material.dispose();
      warmSource.dispose();
      quad.dispose();
    },
  };
}
`;
const slotParam = slots.length === 2 ? 'firemod' : slots[0];
const readme = `# ${info.name}

By ${info.author}. Fire API v1, ${info.backend}, ${slots.map((slot) => '\`' + slot + '\`').join(' and ')}.

The starter copies the host's linear scene color. Describe your effect, tuning controls, and GPU cost here as you add them.
See the [rendering contract](../../docs/API.md#rendering) for scene depth, color space, and renderer-state ownership.

Register the ID in [the module catalog](../catalog.js), then [link your Firewraith checkout](../../CONTRIBUTING.md#testing-locally).
Choose the module with \`?${slotParam}=${id}\` and check \`__ew.perf().fire.modules\` for the loaded ID.
Compare with Classic using the same renderer and shot.
`;
const dir = new URL(`../modules/${id}/`, import.meta.url);
await mkdir(dir);
try {
  await writeFile(new URL('info.js', dir), `import { defineInfo } from '../../src/api/index.js';\n\nexport const info = defineInfo(${JSON.stringify(info, null, 2)});\n`);
  await writeFile(new URL('index.js', dir), runtime);
  await writeFile(new URL('README.md', dir), readme);
} catch (error) {
  await rm(dir, { recursive: true, force: true });
  throw error;
}

const variable = `module_${id.replaceAll('-', '_')}`;
console.log(`Created modules/${id}. Add these lines to modules/catalog.js:\n`);
console.log(`import { info as ${variable} } from './${id}/info.js';`);
console.log(`  '${id}': entry(${variable}, () => import('./${id}/index.js')),`);
console.log(`\nThen run npm test and open Valleyward with ?gpu=${info.backend}&${slotParam}=${id}.`);
