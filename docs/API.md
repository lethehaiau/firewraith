# Fire API v1

A **fire module** is a swappable implementation of the fire in the VALLEYWARD game. This document is the agreement
between a module and the game (the **host**). Code: `src/api/` (constants, validators, JSDoc types).

Contents:

- [The words](#the-words)
- [What a module exports](#what-a-module-exports)
- [What `create(host)` receives](#what-createhost-receives)
- [What `create(host)` returns](#what-createhost-returns)
- [One frame](#one-frame)
- [Events](#events)
- [Rendering](#rendering)
- [Gameplay](#gameplay)
- [Light](#light)
- [Rules](#rules)
- [Backends and editions](#backends-and-editions)
- [Trying a module in the game](#trying-a-module-in-the-game)
- [Versioning](#versioning)

## The words

| Word | Meaning |
|---|---|
| **fire module** | One swappable implementation of the fire. |
| **slot** | Where a module plugs in. v1 has two. |
| **`lance`** | The Ember Lance's airborne flame, from the nozzle to where the stream lands. |
| **`ground`** | The fire on the ground: flames, smoke, embers, steam, the light it casts, and (optionally) the gameplay grid. |
| **method** | What a module does inside: a 2D or 3D grid, particles, SPH, ray marching, anything. |
| **host** | The game side: it loads modules, feeds them every frame, and falls back to the edition's reference module when one fails (`classic`; `classic-webgpu` in the WebGPU edition). |
| **edition** | The game's shading layer: `webgl2` (three.js `WebGLRenderer`, GLSL) or `webgpu` (three.js `WebGPURenderer`, TSL / WGSL). A module runs in the edition of its `backend`. |
| **gameplay fire** | What decides which goblins burn: a `ground` module's gameplay grid if it has one, else the game's deterministic CPU fire grid (64 × 64, 1 m cells). |

## What a module exports

```js
export const info = {
  id: 'my-fire',              // [a-z0-9-], ≤ 40 chars
  name: 'My fire',            // shown in the game's picker
  version: '0.1.0',
  api: 1,                     // this document
  backend: 'webgl2',          // or 'webgpu'
  slots: ['lance'],           // the slots it can fill: 'lance', 'ground' or both
  author: 'you', method: 'one line: how it works', description: '…', homepage: 'https://…',
};
export async function create(host) { /* … */ return module; }
```

`defineInfo(info)` from `firewraith/api` checks and freezes an `info`. `checkInfo(info)` lists its problems.

## What `create(host)` receives

```js
host = {
  api: 1,
  backend: 'webgl2',          // the edition the game runs
  renderer,                   // the game's three.js renderer: draw with it, never make your own canvas
  quality: 'high',            // 'high' | 'medium' | 'low'
  style: 'hybrid',            // 'smooth' | 'hybrid' (pixel art): what the player picked; a hint
  slots: ['lance'],           // the slots THIS instance fills (a subset of info.slots)
  world: {
    area: { x0, z0, size },   // the square (metres) the ground fire lives in: x east, z south, y up
    groundHeight(x, z),       // the terrain height (m)
    groundGLSL,               // webgl2: GLSL defining `float ewGround(vec2 xz)`, identical to groundHeight
    groundTSL,                // webgpu (optional): a TSL Fn(vec2 xz) → float, identical to groundHeight
    walls: [[x0, z0, x1, z1], …],   // boxes fire and air cannot enter (the keep's wall and towers)
    moonDir: { x, y, z },     // unit vector to the moon, the night's key light
    lance: { speed, gravity },     // the Lance stream's ballistic physics (16 m/s, 14 m/s²)
    light: { gain, height },  // the game's fire-light knobs (for nearLight), live
  },
  options: { debug, gpuTiming, params },   // params: the page's URLSearchParams
}
```

- **`groundGLSL` / `groundTSL`:** the terrain on the GPU, one per backend. A `webgl2` module pastes `groundGLSL` into
  its shaders. A `webgpu` module calls `groundTSL(xz)` inside its TSL (`xz` a vec2 node) and should treat it as
  optional: a host without it gives no TSL terrain (`classic-webgpu` then assumes flat ground at y = 0). VALLEYWARD's
  WebGPU edition gives it (its `ewGround`).

A module may be created more than once on a page, for example once for `lance` and once for `ground`. It should keep
its state per instance. The `world` is the same for every instance.

## What `create(host)` returns

| Member | Slot | Required | What |
|---|---|---|---|
| `events(list, wind)` | ground | yes | The fire events of every sim tick since the last frame. `wind` = `{ x, z }` m/s. |
| `lance(state)` | lance | yes | The Lance this frame (below). |
| `update(dt, ctx)` | both | yes | Advance by `dt` **game** seconds: 0 while paused; larger in slow-motion catch-up and hit-stop recovery, up to about 0.13 s. `ctx` = `{ rain: 0..1, time }`. |
| `render(renderer, args)` | both | yes | Draw (see [Rendering](#rendering)). |
| `reset()` | both | yes | A fresh night: clear all fire. |
| `dispose()` | both | yes | Free everything. |
| `fire` | ground | no | The gameplay grid (see [Gameplay](#gameplay)). |
| `lightMap` | ground | no | A texture over `world.area`: RGB = linear fire light (see [Light](#light)). |
| `nearLight(x, y, z, out)` | ground | no | The fire light at a point; set `out.setRGB(r, g, b)` and return true. |
| `warm(renderer, camera)` | both | no | Compile every shader before play (the game calls it behind the loading cover). |
| `setStyle(s)`, `setQuality(q)` | both | no | The player changed the style or quality. |
| `stats()` | both | no | Anything worth showing: `{ gpuMs, cells, particles, … }`. |
| `columns` | ground | no | Extra: `{ set(id, cfg \| null), clear(), get(id) }`, the ending's fire columns (`classic` has them). Without it the ending shows none. |

`checkModule(module, slots)` lists problems with a returned module.

`state` for `lance(state)`:

```js
{ on, origin: { x, y, z }, dir: { x, y, z }, range, t, hue, landing: { x, y, z } | null }
```

- `origin` is the nozzle.
- `dir` is the unit aim.
- `range` is the horizontal reach in m (11, more with cards); past it the stream rains down.
- `t` is the seconds the trigger has been held.
- `landing` is where the game's arc touches down.

The game burns everything along its own arc: speed `world.lance.speed`, gravity `world.lance.gravity`, no drag, cut at
`range`. Draw the flame on that arc, so that what players see is what burns.

## One frame

The host calls, in order:

1. `events(list, wind)`: `ground` only.
2. `update(dt, { rain, time })`: every instance.
3. `lance(state)`: `lance` only.
4. `render(renderer, args)`: the `ground` instance first, then the `lance` instance.

If two different modules fill the slots, the host passes the ground module's output to the lance module as its
`colorTex`.

## Events

These are plain objects (`firewraith/api`: `FIRE_OP`, `FIRE_HUE`, `isFireEvent`). Units are metres, metres per second
and seconds. Amounts are 0..1 "how much" knobs, and your module decides what they mean.

| `kind` | Fields | From |
|---|---|---|
| `stream` | `x0, z0, x1, z1, vx, vz, amount, radius, hue?` | the Lance landing: a moving line, one per tick while spraying |
| `burst` | `x, z, r, amount, push, hue?` | firebombs, barrels, the Sunburst ring |
| `fuel` | `x, z, r, amount` or `box: { x0, z0, x1, z1 }, amount` | oil poured, not lit (troughs, barrels, oil-soaked goblins) |
| `ember` | `x, z, amount, hue?` | a burning goblin, a brazier spill; up to 160 per tick |
| `push` | `x, z, vx, vz, r` | air pushed without fire: crowds, stomps, shock waves |
| `douse` | `x, z, r` or `x0, z0, x1, z1, r, vx?, vz?` | remove fire: buckets, the dawn, a rain front |
| `swirl` | `x, z, r, spin, pull, amount` | a whirlpool (the Rainmother) |

**Hues:** `orange` (the default), `violet`, `blue`, `green`, `lilac`. `HUE_RAMPS` holds the reference six-colour ramps,
and `HUE_LIGHT` the light colours.

## Rendering

```js
render(renderer, { colorTex, depthTex, camera, target, width, height })
```

- **Inputs:**
  - `colorTex`: the scene so far, linear HDR.
  - `depthTex`: the scene depth, a standard perspective depth texture (not reversed, not logarithmic).
- **Output:** write the scene plus your fire to `target` (null = the canvas) at `width × height`, in linear HDR. The
  game applies bloom, exposure, tone mapping and grading afterwards, so don't tone-map.
- **Depth:** use `depthTex` to hide fire behind walls and goblins. The first-person gun is drawn after you, on top.
- **GL state:** leave the renderer's render target and `autoClear` as you found them.
- **Helpers:** `firewraith/kit/webgl2` has `DEPTH_GLSL` (`viewDepthAt`, `worldAt`), `depthUniforms()` and
  `setDepthCamera()`. `firewraith/kit/webgpu` has `depthNodes(depthTexture)`: TSL `viewDepthAt(uv)` and `worldAt(uv)`,
  with `set(camera, depthTex)` once a frame. It uses three's `getViewPosition` / `perspectiveDepthToViewZ`, which know
  WebGPU's 0..1 depth.
- **WebGPU orientation:** render targets are stored top-down. A full-screen pass's `uv()` and `texture(t, uv)` agree on
  y = 0 (the first row), so a field read and written by uv needs no flip. Screen uv and `screenCoordinate` count from
  the top of the frame. A vertex that places itself on a target by uv needs clip y = 1 − 2 v (`uvToClip`), which also
  reverses its winding. For `lightMap` and the gameplay grid, keep row j = z cell j (uv.y along +z), as in WebGL2.

## Gameplay

A `ground` module may decide what burns by providing `fire`:

```js
fire = {
  heat(x, z),     // 0..1: a goblin standing here catches fire at ≥ 0.22
  fuel(x, z),     // 0..1: oil on the ground
  fire(x, z),     // optional, 0..1
  ready,          // false until the first grid exists
  ageFrames,      // frames since the grid was made
}
```

- The game uses your grid while it is fresh, and its own CPU fire grid while `ageFrames > 30`.
- Without `fire`, your module is visual only, and the CPU grid decides.
- **Getting the grid from the GPU:** `createGridReadback()` reads a small render target (for example 64 × 64 RGBA8)
  back to the CPU without ever stalling the frame. `sampleGrid()` does the bilinear lookup. Both kits have it, with the
  same calls (`rb.poll(frame)` first, `rb.kick(frame)` after the sim, `rb.landed` for `ageFrames`):
  - `firewraith/kit/webgl2`: a pixel-pack buffer and a fence, polled once a frame;
  - `firewraith/kit/webgpu`: `renderer.readRenderTargetPixelsAsync` (`mapAsync` underneath), at most one read in
    flight. A read lands at the first `poll` after its promise resolves, usually 1–3 frames later. Narrow targets' rows
    come back padded to 256 bytes, and the kit removes the padding. Keep the grid uv.y along +z, so row j is z cell j.

Game balance is not a concern: a fiercer fire is allowed.

## Light

The game's materials read one light-map texture over `world.area`. RGB = linear fire light; the game multiplies it by
each surface's albedo and fades it with height.

- If your `ground` module has a `lightMap`, the world is lit by your fire.
- Without one, the world is not lit by fire.
- `nearLight()` lights the first-person hands.

## Rules

1. **Shared renderer.** Draw only with `host.renderer`, only inside `render`, `update` and `warm`. Never create a canvas
   or a second context.
2. **Any frame time.** Handle `dt = 0` (pause) and large time jumps.
3. **Restore the GL state.** Leave the render target and `autoClear` as you found them.
4. **Don't take over the page.** No network calls and no DOM changes, apart from optional debug UI behind
   `options.debug`.
5. **Throwing is survivable.** If your module throws, the game replaces it with the edition's reference module (`classic` or `classic-webgpu`) for its slots and keeps
   playing.
6. **Stay cheap enough for 60 fps** on the reference machine. `stats()` should report your cost.

## Backends and editions

- **`webgl2`:** `host.renderer` is a three.js r186 `WebGLRenderer`; write GLSL `ShaderMaterial`s.
- **`webgpu`:** `host.renderer` is a three.js r186 `WebGPURenderer`; write TSL or WGSL, and use compute. The
  reference module is `classic-webgpu` (the port of `classic`); the kit is `firewraith/kit/webgpu`. A `lightMap` must
  be filterable: RGBA8 or half float, not 32-bit float (the game's materials sample it bilinearly).

The game boots the edition of the modules picked (`?gpu=webgl2|webgpu` forces one). Every module therefore runs
natively, with no copies between graphics APIs. A module for the other backend is refused, with the reason shown, and
the edition's reference module stands in (`classic` in WebGL2, `classic-webgpu` in WebGPU).

## Trying a module in the game

- **`?lance=<id>`, `?ground=<id>`:** pick a module per slot. `?firemod=<id>` sets both.
- **The id:** a listed module (`classic`, `classic-webgpu`), or a URL on your own machine (`http://localhost:5173/src/index.js`). The
  game only loads module URLs from `localhost` / `127.0.0.1`.
- **`__ew.modules().fire` and `__ew.perf().fire.modules`:** which module runs each slot, and why a slot fell back.

## Versioning

- `info.api` is the version a module was written for.
- v1 hosts load v1 modules.
- Additions (new optional members, new event kinds) keep v1. Breaking changes make v2.
