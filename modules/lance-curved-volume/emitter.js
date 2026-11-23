import { Vector3 } from 'three';

const STEP = 1 / 60;
const MAX_STEPS = 3;
const BIRTH_RATE = 180;
export const CAPACITY = 192;
const SEED = 2083;
const EPS = 1e-8;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function fixedSteps(seconds) {
  const available = Math.floor((seconds + EPS) / STEP);
  const steps = Math.min(available, MAX_STEPS);
  return {
    steps, remainder: Math.max(0, seconds - available * STEP),
    dropped: (available - steps) * STEP,
  };
}

function newCommand() {
  return { on: false, origin: new Vector3(), dir: new Vector3(0, 0, 1), range: 0 };
}

function copyCommand(dst, state) {
  dst.on = Boolean(state?.on && state.origin && state.dir && state.range > 0);
  if (!dst.on) return;
  dst.origin.copy(state.origin);
  dst.dir.copy(state.dir).normalize();
  dst.range = state.range;
  if (state.landing) {
    // The host can shorten the shot against a solid. Measure along aim to ignore lateral muzzle offset.
    const x = state.landing.x - dst.origin.x, z = state.landing.z - dst.origin.z;
    const horizontal = Math.hypot(dst.dir.x, dst.dir.z);
    const distance = (x * dst.dir.x + z * dst.dir.z) / Math.max(EPS, horizontal);
    if (distance > 0) dst.range = Math.min(dst.range, distance);
  }
}

/** World-space ballistic source particles for the curved volume. */
class Emitter {
  constructor(lance, groundHeight) {
    this.speed = lance.speed;
    this.gravity = lance.gravity;
    this.groundHeight = groundHeight;
    this.pool = Array.from({ length: CAPACITY }, () => ({
      origin: new Vector3(), velocity: new Vector3(), age: 0, end: 0, delay: 0,
    }));
    this.a = new Vector3();
    this.b = new Vector3();
    this.reset();
  }

  reset() {
    this.count = 0;
    this.nextBirth = 0;
    this.births = 0;
    this.seed = SEED;
  }

  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296 - 0.5;
  }

  birth(from, to, alpha, offset) {
    if (this.count >= CAPACITY) return;
    const p = this.pool[this.count++];
    p.origin.copy(from.origin).lerp(to.origin, alpha);
    p.velocity.copy(from.dir).lerp(to.dir, alpha);
    p.velocity.x += 0.065 * this.random();
    p.velocity.y += 0.045 * this.random();
    p.velocity.z += 0.065 * this.random();
    p.velocity.normalize().multiplyScalar(this.speed);
    p.age = 0;
    p.delay = offset;
    p.end = Math.min(1.3, (from.range + (to.range - from.range) * alpha) / Math.max(EPS, Math.hypot(p.velocity.x, p.velocity.z)));
    this.births++;
  }

  at(out, p, t) {
    out.copy(p.origin).addScaledVector(p.velocity, t);
    out.y -= 0.5 * this.gravity * t * t;
  }

  advance(from, to, alphaStart, alphaEnd) {
    if (to.on) {
      if (!from.on) from = to;
      for (; this.nextBirth < STEP - EPS; this.nextBirth += 1 / BIRTH_RATE) {
        const alpha = clamp01(alphaStart + (alphaEnd - alphaStart) * this.nextBirth / STEP);
        this.birth(from, to, alpha, this.nextBirth);
      }
      this.nextBirth = Math.max(0, this.nextBirth - STEP);
    } else {
      this.nextBirth = 0;
    }

    for (let i = 0; i < this.count;) {
      const p = this.pool[i], t0 = p.age;
      const t1 = Math.min(t0 + STEP - p.delay, p.end);
      this.at(this.a, p, t0);
      this.at(this.b, p, t1);
      const done = t1 >= p.end || this.a.y <= this.groundHeight(this.a.x, this.a.z)
        || this.b.y <= this.groundHeight(this.b.x, this.b.z);
      p.age = t1;
      p.delay = 0;
      if (done) {
        this.pool[i] = this.pool[--this.count];
        this.pool[this.count] = p;
      } else {
        i++;
      }
    }
  }
}

/** Fixed-step particle clock. The host latches aim after update and before render. */
export class SourceStream {
  constructor(world) {
    this.emitter = new Emitter(world.lance, world.groundHeight);
    this.current = newCommand();
    this.previous = newCommand();
    this.reset();
  }

  latch(state) { copyCommand(this.current, state); }

  update(dt) {
    if (Number.isFinite(dt) && dt > 0) this.queued += dt;
  }

  advance() {
    const elapsed = this.queued;
    if (!elapsed) return;
    const fixed = fixedSteps(this.carry + elapsed);
    const first = fixed.dropped - this.carry;
    this.queued = 0;
    this.carry = fixed.remainder;
    this.droppedSeconds += fixed.dropped;
    for (let i = 0; i < fixed.steps; i++) {
      this.time += STEP;
      if (!this.current.on && !this.emitter.count) continue;
      const start = first + i * STEP;
      this.emitter.advance(this.previous, this.current, start / elapsed, (start + STEP) / elapsed);
      this.totalSteps++;
    }
    copyCommand(this.previous, this.current);
  }

  reset() {
    this.time = this.queued = this.carry = this.droppedSeconds = this.totalSteps = 0;
    this.current.on = this.previous.on = false;
    this.emitter.reset();
  }
}
