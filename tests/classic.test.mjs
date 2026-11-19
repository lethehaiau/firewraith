// The classic reference module: its info is valid and every file loads (imports resolve; no GPU needed to load).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkInfo } from '../src/api/index.js';
import { info } from '../modules/classic/info.js';

test('classic info is valid and fills both slots on webgl2', () => {
  assert.deepEqual(checkInfo(info), []);
  assert.deepEqual([...info.slots], ['lance', 'ground']);
  assert.equal(info.backend, 'webgl2');
});

test('classic loads and exports create()', async () => {
  const m = await import('../modules/classic/index.js');
  assert.equal(typeof m.create, 'function');
  assert.equal(m.info.id, 'classic');
  for (const k of ['KNOBS', 'DEPOSIT', 'LOOK', 'JET', 'makeFireVortexMaterial', 'jetLanding']) assert.ok(m[k], k);
});

test('classic takes nothing from the game: no imports outside the package', () => {
  const dir = new URL('../modules/classic/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const s = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const [, spec] of s.matchAll(/^import .* from '([^']+)'/gm)) {
      assert.ok(spec === 'three' || spec.startsWith('./') || spec.startsWith('../../src/'), `${f} imports ${spec}`);
    }
  }
});

test('the world ground GLSL reaches the shaders that ask for it', async () => {
  const { setWorld } = await import('../modules/classic/world.js');
  const { withWorld, GROUND_MARK } = await import('../modules/classic/gl.js');
  setWorld({ groundGLSL: 'float ewGround(vec2 p) { return 1.5; }' });
  assert.match(withWorld(`a ${GROUND_MARK} b`), /return 1\.5/);
});
