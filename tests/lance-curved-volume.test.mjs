import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { checkModule } from '../src/api/index.js';
import { MODULES } from '../modules/catalog.js';
import { SourceStream } from '../modules/lance-curved-volume/emitter.js';

const world = { lance: { speed: 16, gravity: 14 }, groundHeight: () => 0 };

test('Curved Volume loads through the catalog and keeps quality per instance', async () => {
  const { info, create } = await MODULES['lance-curved-volume'].load();
  const high = await create({ quality: 'high', world });
  const low = await create({ quality: 'high', world });
  try {
    assert.deepEqual(info.slots, ['lance']);
    assert.deepEqual(checkModule(high, info.slots), []);
    low.setQuality('low');
    assert.ok(low.stats().spacing > high.stats().spacing);
  } finally {
    high.dispose();
    low.dispose();
  }
});

test('a paused stream keeps its particles and release lets them clear without new births', () => {
  const stream = new SourceStream(world);
  stream.latch({ on: true, origin: new Vector3(0, 1.5, 0), dir: new Vector3(0, 0, 1), range: 4 });
  stream.update(1 / 60);
  stream.advance();
  const count = stream.emitter.count, time = stream.time;
  assert.equal(count, 3);

  stream.latch({ on: false });
  stream.update(0);
  stream.advance();
  assert.equal(stream.time, time);
  assert.equal(stream.emitter.count, count);

  for (let i = 0; i < 30; i++) {
    stream.update(1 / 60);
    stream.advance();
  }
  assert.equal(stream.emitter.count, 0);
  assert.equal(stream.emitter.births, count);
  stream.reset();
  assert.equal(stream.time, 0);
  assert.equal(stream.emitter.births, 0);
});
