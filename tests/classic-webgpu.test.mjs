// The classic-webgpu reference module and the webgpu kit: the info, loading (three/webgpu imports in Node; no GPU is
// needed to load), the shared knobs, the import boundary, and the non-stalling read-back's bookkeeping (a fake renderer).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkInfo } from '../src/api/index.js';
import { info } from '../modules/classic-webgpu/info.js';
import { info as classicInfo } from '../modules/classic/info.js';

test('classic-webgpu info is valid and fills both slots on webgpu', () => {
  assert.deepEqual(checkInfo(info), []);
  assert.equal(info.id, 'classic-webgpu');
  assert.equal(info.name, 'Classic (WebGPU)');
  assert.equal(info.backend, 'webgpu');
  assert.deepEqual([...info.slots], ['lance', 'ground']);
  assert.deepEqual([...info.slots], [...classicInfo.slots]);
  assert.ok(Object.isFrozen(info) && Object.isFrozen(info.slots));
});

test('classic-webgpu loads, exports create(), and shares classic\'s knobs (the same objects, never copies)', async () => {
  const m = await import('../modules/classic-webgpu/index.js');
  const c = await import('../modules/classic/index.js');
  const { HUE_RAMPS } = await import('../modules/classic/volume.js');
  assert.equal(typeof m.create, 'function');
  assert.equal(m.info.id, 'classic-webgpu');
  for (const k of ['KNOBS', 'DEPOSIT', 'LOOK', 'JET', 'RES', 'STEAM', 'COLUMN_PRESETS', 'COLUMN_RAMPS', 'jetLanding']) assert.equal(m[k], c[k], k);
  const v = await import('../modules/classic-webgpu/volume.js');
  assert.equal(v.LOOK, c.LOOK);
  assert.ok(HUE_RAMPS.orange.length === 6);
});

test('classic-webgpu refuses a renderer that is not a WebGPURenderer on WebGPU', async () => {
  const { create } = await import('../modules/classic-webgpu/index.js');
  await assert.rejects(create({ api: 1, backend: 'webgl2', renderer: { isWebGLRenderer: true }, slots: ['ground'], world: {} }), /WebGPURenderer/);
  await assert.rejects(create({ api: 1, backend: 'webgpu', renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: false } }, slots: ['ground'], world: {} }), /fallback/);
});

test('classic-webgpu takes nothing from the game: imports stay in the package (three, three/webgpu, three/tsl)', () => {
  const dir = new URL('../modules/classic-webgpu/', import.meta.url);
  const kit = new URL('../src/kit/webgpu/', import.meta.url);
  for (const [base, files] of [[dir, fs.readdirSync(dir)], [kit, fs.readdirSync(kit)]]) {
    for (const f of files.filter((n) => n.endsWith('.js'))) {
      const s = fs.readFileSync(new URL(f, base), 'utf8');
      for (const [, spec] of s.matchAll(/^import .* from '([^']+)'/gm)) {
        assert.ok(['three', 'three/webgpu', 'three/tsl'].includes(spec) || spec.startsWith('./') || spec.startsWith('../classic/') || spec.startsWith('../../src/') || spec.startsWith('../webgl2/'), `${f} imports ${spec}`);
        assert.doesNotMatch(spec, /emberwatch|valleyward|\/src\/(fire|gfx|shared|sim)\//i, `${f} imports the game: ${spec}`);
      }
    }
  }
});

test('the package exports the webgpu kit and classic-webgpu (and the files exist)', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const k of ['./kit/webgpu', './modules/classic-webgpu', './modules/classic-webgpu/info']) {
    assert.ok(pkg.exports[k], k);
    assert.ok(fs.existsSync(new URL('../' + pkg.exports[k].slice(2), import.meta.url)), pkg.exports[k]);
  }
  const kit = await import('../src/kit/webgpu/index.js');
  for (const k of ['makeTarget', 'PingPong', 'Quad', 'passMaterial', 'texNode', 'mrtOutput', 'clearTargets', 'uvToClip', 'instancedQuad', 'depthNodes', 'makeNoiseTexture', 'makeNoise3', 'createGridReadback', 'sampleGrid']) assert.ok(kit[k], k);
  const gl = await import('../src/kit/webgl2/index.js');
  assert.equal(kit.sampleGrid, gl.sampleGrid);
});

test('webgpu read-back: one read in flight, lands on a later poll with the kick frame, drops row padding, reset forgets', async () => {
  const { createGridReadback } = await import('../src/kit/webgpu/readback.js');
  const pending = [];
  // a fake WebGPURenderer: readRenderTargetPixelsAsync resolves when the test says so; rows padded to 256 bytes like copyTextureToBuffer
  const renderer = { readRenderTargetPixelsAsync: (rt, x, y, w, h) => new Promise((ok) => pending.push(() => {
    const pitch = Math.ceil(w * 4 / 256) * 256, out = new Uint8Array((h - 1) * pitch + w * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w * 4; i++) out[j * pitch + i] = rt.fill(j, i);
    ok(out);
  })) };
  const A = { fill: (j, i) => (j * 7 + i) & 255 }, B = { fill: () => 9 };
  const rb = createGridReadback(renderer, { reads: [{ target: () => A, w: 8, h: 4 }, { target: () => B, w: 8, h: 4 }] });
  assert.equal(rb.landed, -1);
  rb.kick(10);
  assert.ok(rb.busy);
  rb.kick(11);                                   // still in flight: no second read
  assert.equal(pending.length, 2);
  assert.equal(rb.poll(11), false);              // not resolved yet: the frame never waits
  pending.splice(0).forEach((f) => f());
  await new Promise((ok) => setTimeout(ok, 0));
  assert.equal(rb.poll(12), true);
  assert.equal(rb.landed, 10);                   // ageFrames = frame − landed
  assert.equal(rb.busy, false);
  assert.equal(rb.data.length, 2 * 8 * 4 * 4);
  assert.equal(rb.data[1 * 32 + 5], (1 * 7 + 5) & 255);   // row 1 of A, de-padded
  assert.equal(rb.data[8 * 4 * 4], 9);           // B follows A
  rb.kick(20);
  rb.reset();                                    // the read in flight is abandoned
  pending.splice(0).forEach((f) => f());
  await new Promise((ok) => setTimeout(ok, 0));
  assert.equal(rb.poll(21), false);
  assert.equal(rb.data[1 * 32 + 5], 0);
  assert.equal(rb.landed, 10);
});
