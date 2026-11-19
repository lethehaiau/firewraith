# Firewraith

Swappable real-time fire for the VALLEYWARD game. VALLEYWARD is a first-person horde survivor where your fire really
burns the horde.

- **What this repo holds:**
  - the **Fire API**;
  - a **kit** of GPU helpers;
  - the **reference fire modules**.
- **The idea:** write your own fire or fluid simulation as a module, drop it into the game, and play with it.
- **The game:** lives in its own repo and loads modules from here.

> Status: v0.1 (2026-11-18), local, not yet published.
> - **Done:** API v1, the `classic` module (webgl2) and its WebGPU port `classic-webgpu`.
> - **Not yet:** starters, the create tool, the bench and hosting. See "Plan" below.
> - **Licence:** MIT.

## The words

| | |
|---|---|
| **fire module** | One swappable implementation of the fire. |
| **slot** | Where it plugs in: **`lance`** (the Ember Lance's airborne flame) or **`ground`** (the fire on the ground). |
| **method** | Whatever you do inside: a 2D or 3D grid, particles, SPH, anything. |
| **host** | The game side. It loads modules, feeds them, and falls back to `classic` if one fails. |
| **edition** | The game boots in WebGL2 or WebGPU to match your module's `backend`. |

## A module in one screen

```js
export const info = { id: 'my-fire', name: 'My fire', version: '0.1.0', api: 1, backend: 'webgl2', slots: ['lance'] };

export async function create(host) {
  // host.renderer: the game's three.js renderer; host.world: ground height, walls, the Lance's physics, …
  return {
    lance(state) { /* { on, origin, dir, range, hue, landing } */ },
    update(dt, { rain }) { /* simulate */ },
    render(renderer, { colorTex, depthTex, camera, target, width, height }) { /* scene + your fire → target */ },
    reset() {}, dispose() {},
  };
}
```

A `ground` module also gets `events(list, wind)`: firebombs, Lance landings, burning goblins, douses. It may return:

- `fire`: a gameplay grid, so your fire decides what burns;
- `lightMap`: your fire lights the world.

Full rules: **[docs/API.md](docs/API.md)**.

## Climbing the ladder

| Level | You write | You get |
|---|---|---|
| 1 | `lance` + `render` | your own fire-gun flame |
| 2 | `ground`: `events` + `render` | your own ground fire, smoke and embers |
| 3 | `ground` + `fire` (a gameplay grid) | your fire burns goblins |
| extras | `lightMap`, `nearLight`, `stats` | it lights the world, the hands, the perf HUD |

## Layout

| Path | What |
|---|---|
| `src/api/` | The Fire API v1 code: events (`FIRE_OP`, `FIRE_HUE`, `HUE_RAMPS`, `HUE_LIGHT`), `SLOTS`, `BACKENDS`, validators (`checkInfo`, `checkModule`, `defineInfo`), JSDoc types. No three.js. |
| `src/kit/webgl2/` | Helpers for WebGL2 modules: render targets, ping-pong pairs, full-screen passes, depth reconstruction, noise, the non-stalling GPU → CPU grid read-back, a GPU timer. |
| `src/kit/webgpu/` | The same helpers for WebGPU (TSL) modules: render targets and ping-pong pairs, full-screen `QuadMesh` passes, two-output (MRT) passes, MRT-safe clears, depth reconstruction in TSL, the noise texture and `noise3`, instanced quads, and the non-stalling read-back (`readRenderTargetPixelsAsync`). |
| `modules/classic/` | VALLEYWARD's original fire (webgl2, both slots): a 2D GPU grid fluid drawn as a ray-marched 2.5D volume, plus the Lance's particle jet. `FLUID.md` is its technical reference. |
| `modules/classic-webgpu/` | `classic` ported to WebGPU (TSL), both slots: the same fire, knobs and CPU code, the WebGPU edition's default module. Its README lists what differs. |
| `docs/API.md` | The Fire API v1. |
| `docs/DECISIONS.md` | Why it is built this way. |
| `tests/` | `npm test` (Node): the API, classic's and classic-webgpu's loading and boundaries, the webgpu read-back. |

Package entry points:

- `firewraith/api`
- `firewraith/kit/webgl2`
- `firewraith/kit/webgpu`
- `firewraith/modules/classic`
- `firewraith/modules/classic/info`
- `firewraith/modules/classic-webgpu`
- `firewraith/modules/classic-webgpu/info`

`three` 0.186.1 is a peer dependency: modules share the game's three.js.

## Trying it in the game

The game (`../Valleyward`) links this repo (`"firewraith": "file:../Firewraith"`):

```bash
cd ../Valleyward && npm ci && npm run dev
# http://127.0.0.1:5350/?lance=classic&ground=classic
# the WebGPU edition with the WebGPU port: http://127.0.0.1:5350/?firemod=classic-webgpu   (or ?gpu=webgpu)
```

Your own module, served by any dev server on this machine:

```
http://127.0.0.1:5350/?lance=http://localhost:5173/src/index.js
```

## Plan

1. **Done:** the Fire API v1, the kit, `classic`, and the game's fire host (per-slot fallback, `?lance=` / `?ground=`,
   localhost module URLs).
2. **The two game editions** (WebGL2 and WebGPU) and a `webgpu` reference module: `classic-webgpu` is done; the game's
   WebGPU edition is being ported part by part.
3. **For authors:**
   - starters (particles, a 2D grid, a 3D grid from the `cheap-3d-fluid` lab);
   - a `create` tool;
   - a standalone bench;
   - hot reload inside the running game;
   - live switching;
   - a sandbox mode.
4. **Hosting:** the hosted game with a module picker, a registry of listed modules, and checks for listing pull
   requests.

## Licence

MIT: see [LICENSE](LICENSE). It covers everything in this repo: the API, the kit and the reference
modules. A module you write and load into the game is yours, under whatever licence you choose. Two small shader
snippets by other authors (David Hoskins' `hash12`, Inigo Quilez's texture value noise) are MIT too: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The package is still marked `private` until it is published to npm.
