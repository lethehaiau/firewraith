// Fire API v1: the validators and the event helpers (pure JS, no GPU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, SLOTS, BACKENDS, FIRE_OP, FIRE_HUE, FIRE_CAPS, HUE_RAMPS, HUE_LIGHT, checkInfo, checkModule, defineInfo, isFireEvent } from '../src/api/index.js';

const good = { id: 'my-fire', name: 'My fire', version: '0.1.0', api: 1, backend: 'webgl2', slots: ['lance'] };

test('constants', () => {
  assert.equal(API_VERSION, 1);
  assert.deepEqual([...SLOTS], ['lance', 'ground']);
  assert.deepEqual([...BACKENDS], ['webgl2', 'webgpu']);
  assert.equal(FIRE_OP.STREAM, 'stream');
  assert.deepEqual(Object.keys(FIRE_OP).sort(), ['BURST', 'DOUSE', 'EMBER', 'FUEL', 'PUSH', 'STREAM', 'SWIRL']);
  assert.deepEqual(Object.values(FIRE_HUE).sort(), Object.keys(HUE_RAMPS).sort());
  assert.deepEqual(Object.keys(HUE_LIGHT).sort(), Object.keys(HUE_RAMPS).sort());
  for (const r of Object.values(HUE_RAMPS)) { assert.equal(r.length, 6); for (const h of r) assert.match(h, /^#[0-9a-f]{6}$/); }
  assert.ok(FIRE_CAPS.total >= FIRE_CAPS.ember);
});

test('checkInfo accepts a good info and lists every problem of a bad one', () => {
  assert.deepEqual(checkInfo(good), []);
  assert.deepEqual(checkInfo({ ...good, slots: ['lance', 'ground'], backend: 'webgpu' }), []);
  const p = checkInfo({ id: 'Bad Id', name: '', version: '', api: 2, backend: 'opengl', slots: ['sky'] });
  assert.equal(p.length, 6, p.join(' | '));
  assert.deepEqual(checkInfo(null), ['info is missing']);
});

test('defineInfo freezes a good info and throws on a bad one', () => {
  const i = defineInfo(good);
  assert.ok(Object.isFrozen(i) && Object.isFrozen(i.slots));
  assert.throws(() => defineInfo({ ...good, api: 0 }), /info.api/);
});

test('checkModule wants the lifecycle and the slot entry points', () => {
  const base = { update() {}, render() {}, reset() {}, dispose() {} };
  assert.deepEqual(checkModule({ ...base, lance() {} }, ['lance']), []);
  assert.deepEqual(checkModule({ ...base, events() {} }, ['ground']), []);
  assert.match(checkModule(base, ['ground']).join(), /events/);
  assert.match(checkModule(base, ['lance']).join(), /lance/);
  assert.match(checkModule({ ...base, events() {}, fire: { heat() {} } }, ['ground']).join(), /fire.fuel/);
  assert.deepEqual(checkModule(null, ['lance']), ['create() returned nothing']);
});

test('isFireEvent', () => {
  assert.ok(isFireEvent({ kind: 'burst', x: 1, z: 2, r: 2, amount: 0.6, push: 2 }));
  assert.ok(isFireEvent({ kind: 'stream', x0: 0, z0: 0, x1: 1, z1: 1, vx: 0, vz: 0, amount: 1, radius: 1, hue: 'green' }));
  assert.ok(!isFireEvent({ kind: 'nuke' }));
  assert.ok(!isFireEvent({ kind: 'ember', x: NaN, z: 0 }));
  assert.ok(!isFireEvent({ kind: 'ember', x: 0, z: 0, hue: 'pink' }));
});
