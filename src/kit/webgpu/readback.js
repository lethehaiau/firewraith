// FIREWRAITH · kit · webgpu · a GPU → CPU grid read-back that never stalls the frame: the WebGPU twin of
// src/kit/webgl2/readback.js, with the same calls (docs/API.md "Gameplay").
//
//   const rb = createGridReadback(renderer, { reads: [{ target: () => summaryRT, w: 64, h: 64 }] });
//   each frame:  rb.poll(frame)  (first: true when a grid landed in rb.data)
//                … your sim …
//                rb.kick(frame)  (after the sim: start reading this frame's grid)
//
// How: `renderer.readRenderTargetPixelsAsync` copies each target into a fresh MAP_READ buffer (submitted at once, after
// the work already queued) and maps it with `mapAsync`, which resolves when the GPU is done; nothing ever waits on it.
// At most one read is in flight; `poll` takes a read that has resolved, so a grid lands at the start of a later frame and
// `landed` is the frame it was kicked in (the game's `ageFrames` = frame − landed). A deep GPU queue only makes the read
// resolve later (the grid ages); a read older than `maxLag` frames when it lands is dropped (default: never).
// WebGPU targets are top-down, so row 0 of the bytes is the target's first row (the uv y = 0 row): lay a grid out with
// uv.y along +z and it comes back in the same order as the webgl2 kit's (row j = z cell j), ready for `sampleGrid`.

/**
 * @param {any} renderer a three.js WebGPURenderer
 * @param {{ reads: { target: () => any, w: number, h: number, x?: number, y?: number, index?: number }[], maxLag?: number }} o
 */
export function createGridReadback(renderer, { reads, maxLag = Infinity }) {
  const sizes = reads.map((r) => r.w * r.h * 4);
  const data = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  const S = { busy: false, done: null, issued: -1, landed: -1, gen: 0, maxKick: 0, maxPoll: 0, maxLag: 0, gets: 0, dropped: 0, errors: 0, disposed: false };
  /** Copy one read's bytes into `data`, dropping the 256-byte row padding of a narrow target. */
  function put(bytes, r, off) {
    const row = r.w * 4, pitch = r.h > 1 ? (bytes.length - row) / (r.h - 1) : row;
    if (pitch === row) { data.set(bytes.subarray(0, row * r.h), off); return; }
    for (let j = 0; j < r.h; j++) data.set(bytes.subarray(j * pitch, j * pitch + row), off + j * row);
  }
  const rb = {
    /** The bytes of every read, back to back (RGBA8 rows of each target, first row first). */
    data,
    /** Frames a read may take to land before it is dropped (Infinity: never dropped; WebGPU reads cannot stall). */
    maxLag,
    /** The frame whose grid is in `data` (−1: none yet). */
    get landed() { return S.landed; },
    /** Is a read in flight? */
    get busy() { return S.busy; },
    /** Start reading this frame's grid (no-op while one is in flight). @param {number} frame */
    kick(frame) {
      if (S.busy || S.disposed) return;
      const tk = performance.now();
      const gen = S.gen;
      S.busy = true; S.issued = frame;
      let ps;
      try { ps = reads.map((r) => renderer.readRenderTargetPixelsAsync(r.target(), r.x || 0, r.y || 0, r.w, r.h, r.index || 0)); }
      catch (e) { S.busy = false; S.errors++; return; }
      Promise.all(ps).then((arrs) => {
        if (gen !== S.gen || S.disposed) return;
        S.done = arrs.map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      }, () => { if (gen === S.gen) { S.busy = false; S.errors++; } });
      const dk = performance.now() - tk; if (dk > S.maxKick) S.maxKick = dk;
    },
    /** Take the read that has landed, if any. Returns true when a new grid landed. @param {number} frame */
    poll(frame) {
      if (!S.done) return false;
      const t0 = performance.now();
      const arrs = S.done; S.done = null; S.busy = false;
      const lag = frame - S.issued;
      if (lag > S.maxLag) S.maxLag = lag;
      if (lag > rb.maxLag) { S.dropped++; return false; }
      let off = 0;
      reads.forEach((r, i) => { put(arrs[i], r, off); off += sizes[i]; });
      S.gets++;
      S.landed = S.issued;
      const dp = performance.now() - t0; if (dp > S.maxPoll) S.maxPoll = dp;
      return true;
    },
    /** Abandon the read in flight (its result is ignored when it lands) and forget the grid. */
    reset() { S.gen++; S.busy = false; S.done = null; data.fill(0); },
    /** @param {number} frame */
    stats(frame) {
      return { kick: +S.maxKick.toFixed(2), poll: +S.maxPoll.toFixed(2), get: 0, gets: S.gets, slowGets: 0, dropped: S.dropped, errors: S.errors, maxLagFrames: S.maxLag, busy: S.busy, tight: false, frame };
    },
    resetStats() { S.maxPoll = S.maxKick = 0; S.maxLag = 0; S.gets = S.dropped = S.errors = 0; },
    dispose() { S.disposed = true; S.gen++; S.busy = false; S.done = null; },
  };
  return rb;
}

/** GPU timing is not offered in WebGPU yet (three needs `trackTimestamp` when the renderer is created): always null. */
export function makeGpuTimer() { return null; }

export { sampleGrid } from '../webgl2/readback.js';
