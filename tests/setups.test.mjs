// The setups (modules/setups.js): every entry must check out against the catalog, and checkSetup must catch each kind of
// mistake a contributor can make. See docs/API.md, "Setups".
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../modules/catalog.js';
import { SETUPS } from '../modules/setups.js';
import { SLOTS, checkSetup } from '../src/api/index.js';

test('every setup uses catalog modules that fill its slots, on its backend', () => {
  for (const [id, s] of Object.entries(SETUPS)) {
    assert.deepEqual(checkSetup(id, s, MODULES), [], id);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.slots), `${id}: frozen`);
    assert.deepEqual(Object.keys(s.slots).sort(), [...SLOTS].sort(), `${id}: sets every slot`);
  }
});

test('the Curved Volume Lance plays over the classic ground fire', () => {
  assert.deepEqual({ ...SETUPS['lance-curved-volume'].slots }, { lance: 'lance-curved-volume', ground: 'classic' });
  assert.equal(SETUPS['lance-curved-volume'].backend, 'webgl2');
});

test('checkSetup lists every problem', () => {
  const good = { name: 'Pair', backend: 'webgl2', slots: { lance: 'lance-curved-volume', ground: 'classic' } };
  assert.deepEqual(checkSetup('pair', good, MODULES), []);
  assert.deepEqual(checkSetup('lance-curved-volume', good, MODULES), []);
  const problems = (id, s) => checkSetup(id, s, MODULES).join(' | ');
  assert.match(problems('Bad Id', good), /setup id/);
  assert.match(problems('pair', null), /missing/);
  assert.match(problems('pair', { ...good, name: ' ' }), /name/);
  assert.match(problems('pair', { ...good, backend: 'vulkan' }), /backend must be/);
  assert.match(problems('pair', { ...good, slots: { lance: 'lance-curved-volume' } }), /slots\.ground must name a module/);
  assert.match(problems('pair', { ...good, slots: { ...good.slots, ground: 'nope' } }), /slots\.ground must name a module/);
  assert.match(problems('pair', { ...good, slots: { ...good.slots, ground: 'toString' } }), /slots\.ground must name a module/);
  assert.match(problems('pair', { ...good, slots: { ...good.slots, sky: 'classic' } }), /sky is not a slot/);
  assert.match(problems('pair', { ...good, slots: { lance: 'lance-curved-volume', ground: 'lance-curved-volume' } }), /does not fill ground/);
  assert.match(problems('pair', { ...good, slots: { lance: 'lance-curved-volume', ground: 'classic-webgpu' } }), /webgpu module, not webgl2/);
  assert.match(problems('classic-webgpu', good), /is a module the setup does not use/);
});
