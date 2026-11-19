// FIREWRAITH · kit · webgl2 · a GPU → CPU grid read-back that never stalls the frame. This is how a `ground` module
// turns its GPU fire into the `fire.heat(x, z)` the game asks (docs/API.md "Gameplay").
//
//   const rb = createGridReadback(renderer, { reads: [{ target: () => summaryRT, w: 64, h: 64 }] });
//   each frame:  rb.poll(frame)  (first, before this frame's GL work: true when a grid landed in rb.data)
//                … your sim …
//                rb.kick(frame)  (after the sim: start reading this frame's grid)
//
// How (measured in VALLEYWARD on Chrome / ANGLE-Metal, 2026-11-14; modules/classic/FLUID.md "The read-back"):
// - one fresh pixel-pack buffer per read, holding every target's pixels, read with readPixels, then a fence;
// - the fence is polled with getSyncParameter (non-blocking) once a frame; getBufferSubData runs only after it signalled;
// - a read is taken only when the fence came back within `maxLag` frames, otherwise it is dropped: when the GPU queue
//   is deep the grid ages (rb.landed falls behind) instead of the frame stalling. After a slow get (> 4 ms) the gate is
//   held at 1 frame for 120 frames;
// - the buffer is deleted after its read and never re-used: Chrome then never prints "READ-usage buffer was written,
//   then fenced, but written again before being read back", which it did even for a ring of buffers.
// Never clientWaitSync: in Chrome it ends in a command-buffer Finish that blocks the main thread for the whole GPU queue.

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {{ reads: { target: () => import('three').WebGLRenderTarget, w: number, h: number, x?: number, y?: number }[], maxLag?: number }} o
 */
export function createGridReadback(renderer, { reads, maxLag = 1 }) {
  const gl = renderer.getContext();
  const sizes = reads.map((r) => r.w * r.h * 4);
  const data = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  const S = { buf: null, sync: null, issued: -1, landed: -1, maxPoll: 0, maxGet: 0, maxKick: 0, gets: 0, slow: 0, dropped: 0, tightUntil: -1, disposed: false };
  function dropBuffer() { if (S.buf) gl.deleteBuffer(S.buf); S.buf = null; }
  const rb = {
    /** The bytes of every read, back to back (RGBA8 rows of each target). */
    data,
    /** Frames between a read's fence and its acceptance (1: at 120 Hz a 2-frame gate let 7–14 of ≈ 600–1,600 reads take 15–30 ms). */
    maxLag,
    /** The frame whose grid is in `data` (−1: none yet). */
    get landed() { return S.landed; },
    /** Is a read in flight? */
    get busy() { return !!S.sync; },
    /** Start reading this frame's grid (no-op while one is in flight). @param {number} frame */
    kick(frame) {
      if (S.sync || S.disposed || gl.isContextLost()) return;
      const tk = performance.now();
      dropBuffer();
      S.buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, data.byteLength, gl.STREAM_READ);
      const prevRT = renderer.getRenderTarget();
      let off = 0;
      reads.forEach((r, i) => {
        renderer.setRenderTarget(r.target());
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.buf);   // (setRenderTarget leaves the pack binding alone; bound again to be sure)
        gl.readPixels(r.x || 0, r.y || 0, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, off);
        off += sizes[i];
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      renderer.setRenderTarget(prevRT);
      S.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      S.issued = frame;
      const dk = performance.now() - tk; if (dk > S.maxKick) S.maxKick = dk;
    },
    /** Take the read in flight if its fence signalled in time. Returns true when a new grid landed. @param {number} frame */
    poll(frame) {
      if (!S.sync) return false;
      const t0 = performance.now();
      const st = gl.getSyncParameter(S.sync, gl.SYNC_STATUS);   // non-blocking; the status updates between tasks
      const t1 = performance.now();
      if (t1 - t0 > S.maxPoll) S.maxPoll = t1 - t0;
      if (st !== gl.SIGNALED) return false;
      const lag = frame - S.issued, gate = frame < S.tightUntil ? 1 : rb.maxLag;
      if (lag > gate) { gl.deleteSync(S.sync); S.sync = null; S.dropped++; dropBuffer(); return false; }   // a deep queue: no drain
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(S.sync); S.sync = null;
      dropBuffer();   // never written again: Chrome's warning (and its discarded shadow) cannot happen
      const t2 = performance.now();
      S.gets++; if (t2 - t1 > 4) { S.slow++; S.tightUntil = frame + 120; }
      if (t2 - t1 > S.maxGet) S.maxGet = t2 - t1;
      S.landed = S.issued;
      return true;
    },
    /** Abandon the read in flight and forget the grid (its buffer is never written again). */
    reset() { if (S.sync) { gl.deleteSync(S.sync); S.sync = null; dropBuffer(); } data.fill(0); },
    /** @param {number} frame */
    stats(frame) {
      return { kick: +S.maxKick.toFixed(2), poll: +S.maxPoll.toFixed(2), get: +S.maxGet.toFixed(2), gets: S.gets, slowGets: S.slow, dropped: S.dropped, tight: frame < S.tightUntil };
    },
    resetStats() { S.maxPoll = S.maxGet = S.maxKick = 0; S.gets = S.slow = S.dropped = 0; },
    dispose() { S.disposed = true; if (S.sync) gl.deleteSync(S.sync); S.sync = null; dropBuffer(); },
  };
  return rb;
}

/** Optional GPU timing (EXT_disjoint_timer_query_webgl2): non-blocking; results land a few frames later. Null when the
 *  extension is missing. timer.begin(name) … timer.end(); timer.poll() once a frame; timer.last[name] = ms (smoothed). */
export function makeGpuTimer(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const pending = [];
  const last = {};
  let active = null;
  return {
    begin(name) { if (active) return; const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = { q, name }; },
    end() { if (!active) return; gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; },
    poll() {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
          if (!disjoint) { const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6; last[p.name] = last[p.name] == null ? ms : last[p.name] * 0.8 + ms * 0.2; }
          gl.deleteQuery(p.q); pending.splice(i, 1);
        }
      }
      if (pending.length > 24) { for (const p of pending.splice(0, pending.length - 24)) gl.deleteQuery(p.q); }
      return last;
    },
    last,
  };
}

/** Bilinear lookup in an RGBA8 grid laid over `area` (0..1). @param {Uint8Array} grid @param {number} n cells per side
 *  @param {{ x0: number, z0: number, size: number }} area @param {number} ch channel 0..3 */
export function sampleGrid(grid, n, area, ch, x, z) {
  const gx = (x - area.x0) / area.size * n - 0.5, gz = (z - area.z0) / area.size * n - 0.5;
  if (gx < -0.5 || gz < -0.5 || gx > n - 0.5 || gz > n - 0.5) return 0;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(gx))), j0 = Math.max(0, Math.min(n - 1, Math.floor(gz)));
  const i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
  const fx = Math.max(0, Math.min(1, gx - i0)), fz = Math.max(0, Math.min(1, gz - j0));
  const g = (i, j) => grid[(j * n + i) * 4 + ch];
  const a = g(i0, j0) + (g(i1, j0) - g(i0, j0)) * fx, b = g(i0, j1) + (g(i1, j1) - g(i0, j1)) * fx;
  return (a + (b - a) * fz) / 255;
}
