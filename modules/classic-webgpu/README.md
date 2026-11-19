# classic-webgpu

The `classic` fire as a Fire API v1 module for the **`webgpu`** backend: three.js `WebGPURenderer` and TSL. It is the
WebGPU edition's reference module (its default, and the fallback for a slot whose module fails), so that VALLEYWARD
looks the same in both editions. Slots `lance` and `ground`, together or either alone, exactly like `classic`.

| Slot | What it draws | Method |
|---|---|---|
| `ground` | Marbled ground fire that spreads along oil, rising smoke, embers, steam where fire is doused, the ending's fire columns, five hues, smooth and pixel-art (hybrid) styles | classic's 2D GPU grid fluid, pass for pass in TSL, drawn as the same ray-marched 2.5D volume |
| `lance` | The Ember Lance's airborne stream | classic's CPU particles on the game's ballistic arc, drawn into the same volume buffer |

It also provides, like classic: the gameplay grid (`fire`, read back with the webgpu kit's non-stalling read-back), the
light map (`lightMap`, half float, filterable), `nearLight`, `columns`, `stats()`, `warm()` and `debug`.

## How it is a port, not a copy

- **The knobs are classic's objects**, imported, never copied: `KNOBS`, `DEPOSIT`, `RES`, `LIGHT_COLS`, `LOOK`,
  `HUE_RAMPS`, `JET`, `STEAM`, `COLUMN_PRESETS`, `COLUMN_RAMPS`, the tier table and the ember colours. A bench that
  tunes `classic` tunes this module too.
- **The CPU work is classic's own code**:
  - the op → splat mapping (`FluidSolver.prototype.queue`, with the same attributes);
  - the jet's particles (`Jet`), the steam puffs (`Steam`) and the columns' bookkeeping and sparks (`Columns`) are
    subclassed, and only their materials are replaced;
  - the obstacle mask (`buildObstacles`) and the world store (`world.js`).
- **The GPU work is new**: every GLSL shader of classic has a TSL twin here, with the same arithmetic in the same order.

| File | What | classic's |
|---|---|---|
| `index.js` | `create(host)`: the parts per slot, the read-back, `render`, `warm`, the light at a point | `index.js` |
| `solver.js` | The grid solver: splats, advection, vorticity, divergence, Jacobi, projection, the scalar reaction (MRT with the hue mass), the 64² summary and hue grids, the light map | `solver.js` |
| `volume.js` | The march (± hue, ± in-fire) and the composite (smooth / hybrid, ± hue) | `volume.js` |
| `embers.js` | The embers: a storage buffer updated by one compute dispatch, drawn as instanced point sprites | `embers.js` (a fragment pass over a float texture) |
| `jet.js`, `steam.js`, `column.js` | TSL materials on classic's CPU particles | the same names |
| `points.js` | Point sprites and billboards from instanced quads (WebGPU points are one pixel wide) | `gl_PointSize` |
| `world.js` | classic's world store plus `host.world.groundTSL` | `world.js` |

## What differs from classic

- **Embers** run in a compute shader over a storage buffer instead of a ping-pong float texture. Each slot keeps the id
  it had as a texel of classic's 128-wide texture, so the hash seeds spawn the same way. The hue is always kept: storage
  is float32.
- **Points** (embers, column sparks) are instanced quads with the same pixel sizes.
- **Orientation:** WebGPU render targets are stored top-down. Every field keeps uv.y along +z, so the light map and the
  read-back line up with the world unchanged. Screen passes use WebGPU's screen uv (y down). The hybrid pixel snap and
  the Bayer cells therefore count from the top of the frame. The dither pattern is mirrored vertically; its character
  is the same.
- **Clearing MRT targets:** three's WebGPU clear sets every attachment after the first to (0, 0, 0, 1). The kit's
  `clearTargets` fills such targets with a pass instead, so a cleared hue field is empty, as in classic.
- **GPU timing:** none yet (`gpuSimMs` / `gpuRenderMs` are null; three needs `trackTimestamp` when the renderer is
  created).
- **The read-back** lands one or more frames after its kick, when `mapAsync` resolves. It never waits and never drops a
  read (`maxLag` defaults to Infinity). The game uses the grid while `ageFrames` ≤ 30.
- **Not ported:** `makeFireVortexMaterial()` (classic's offered portal material; the game does not use it), and
  `?rbmode=lagN` (a WebGL-only read-back experiment; `?rbmode=off` works).
- **Needs** a `WebGPURenderer` on its WebGPU backend. `create()` throws on WebGL, or on three's WebGL2 fallback backend,
  so the host falls back to the CPU fire grid.

## Measured (VALLEYWARD, 2026-11-18, an Apple M4, headless Chrome, m1 view at 1600 × 900, the Lance spraying)

`stats()` is CPU-side time (`performance.now()`, 0.1 ms resolution), mean of 240 frames:

| | simMs | renderMs |
|---|---|---|
| classic (WebGL2), smooth / hybrid | 0.69 / 0.68 | 0.08 / 0.07 |
| classic-webgpu, smooth / hybrid | 0.94 / 0.93 | 0.15 / 0.14 |

The gameplay grid against the game's CPU fire grid (`__ew.fireCompare()` after spraying, the `debug_fire` capture):
correlation 0.744 (classic: 0.75).
