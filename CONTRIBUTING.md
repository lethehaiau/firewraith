# Contributing to Firewraith

Firewraith is a set of swappable real-time fire modules for three.js games, starting with
[VALLEYWARD](https://github.com/lethehaiau/valleyward). The most welcome contribution is **a new fire module**: your own
take on the Ember Lance's flame, the fire on the ground, or both. Fixes and improvements to the API, the kit and the
reference modules are welcome too.

## Before you start

- Read [`docs/API.md`](docs/API.md): what a module exports, what `create(host)` receives and returns, and the rules.
- Look at the reference modules: [`modules/classic/`](modules/classic/) (WebGL2) and
  [`modules/classic-webgpu/`](modules/classic-webgpu/) (WebGPU).
- For a change to the Fire API itself, open an issue first: every module depends on it.

## A fire module

### Layout

```
modules/<id>/
  info.js      export const info = { id, name, version, api: 1, backend, slots, author, method, description }
  index.js     export { info } from './info.js'; export async function create(host) { … }
  README.md    who wrote it, what it does, its knobs, its cost
  …            any other files your module needs
```

To generate a scene-copy starter with lifecycle hooks, run `npm run module:new -- my-fire --slot lance --author "Your name"`.
Use `--slot ground` for ground events or `--slot both` for both hooks. The default uses WebGL2. Pass `--backend webgpu`
for a WebGPU starter. The command prints the two catalog lines to add before running the existing module checks.

- **`<id>`:** lowercase `a-z`, `0-9` and `-`, at most 40 characters, unique. It is the folder name, `info.id` and the
  catalog key.
- **`backend`:** `webgl2` (three.js `WebGLRenderer`, GLSL) or `webgpu` (`WebGPURenderer`, TSL / WGSL). The game boots the
  edition that matches the module a player picks.
- **`slots`:** `lance`, `ground`, or both. A `ground` module may also provide the gameplay grid (what burns); without it
  the game's CPU fire grid decides. See `docs/API.md`, "Gameplay".
- **Imports:** only `three`, `three/webgpu`, `three/tsl` and relative paths inside this package (your folder, `src/kit/`,
  `src/api/`). No other npm packages, and no files fetched at run time: put textures and data in your folder or generate
  them in code.

### Add it to the catalog

Register the module in [`modules/catalog.js`](modules/catalog.js) as soon as you create its entry point. Valleyward reads this catalog from the linked Firewraith checkout. A folder alone does not register an ID. Use the same ID for the folder, `info.id`, and the catalog key.

```js
import { info as myFire } from './my-fire/info.js';
// …
  'my-fire': entry(myFire, () => import('./my-fire/index.js')),
```

The game loads the implementation only when a player picks its catalog ID. Restart Valleyward's dev server after changing the catalog, then launch with `?firemod=<id>`, `?lance=<id>` or `?ground=<id>`. With `?firemod=<id>`, your module fills the slots it declares and the reference module fills the others.

### Rules (checked)

`npm test` runs [`tests/modules.test.mjs`](tests/modules.test.mjs) on every module. It checks that:

- the catalog lists exactly the module folders, under ids that match `info.id`;
- `index.js`, `info.js` and `README.md` exist, `info` is valid and `index.js` exports `create` and the same `info`;
- imports stay inside the package;
- the code makes no network calls (`fetch`, `XMLHttpRequest`, `WebSocket`, …), runs no `eval` / `new Function`, uses
  no storage or cookies, does not navigate and starts no workers;
- the folder stays under 512 KB.

If your module needs one of the things above, open an issue and explain why before you build on it.

### Rules (reviewed)

The Fire API rules (`docs/API.md`, "Rules"), plus:

- **Draw only with the host's renderer**, inside `render`, `update` and `warm`, and restore the GL state you change.
- **Any frame time:** handle a paused frame (`dt = 0`) and large time jumps.
- **Cheap enough for 60 fps.** On `high` at 1080p the game's whole fire budget is about 4.5 ms of GPU time on an Apple
  M4. Honour `setQuality()` and report your cost in `stats()`.
- **Throwing is survivable** (the game swaps in the reference module), but a module that throws is not merged.

## Testing locally

1. **Firewraith's checks**

   ```bash
   git clone https://github.com/lethehaiau/firewraith.git && cd firewraith
   npm ci
   npm test
   ```

2. **Your module in the game.** Clone VALLEYWARD next to Firewraith and point it at your local copy:

   ```bash
   cd .. && git clone https://github.com/lethehaiau/valleyward.git && cd valleyward
   npm ci
   npm install --no-save ../firewraith   # use your local Firewraith instead of the published one
   npm run dev                           # http://127.0.0.1:5350/
   ```

   Then open `http://127.0.0.1:5350/?firemod=<id>` (your module in its slots, the reference module in the others), or
   `?lance=<id>` / `?ground=<id>` for one slot. In dev, the **P** menu also switches the **Fire module**, **Lance module**
   and **Ground module**.
   - A `webgpu` module needs a browser with WebGPU.
   - The game is silent in a clone: its audio is not part of the repo.
   - Useful while you work: `?debug=1` draws the gameplay grid; `?perf=1` shows frame times. In the console,
     `__ew.perf().fire` shows your module's stats, `__ew.perf().fire.modules` shows which module fills each slot and why
     a slot fell back, and (with `?debug=1`) `__ew.fireCompare()` compares a ground module's grid with the CPU grid.

3. **Without the catalog** (for example while your module lives in its own repo): serve it from any local dev server and
   load it by URL, e.g. `http://127.0.0.1:5350/?lance=http://localhost:5173/src/index.js`. The game loads module URLs
   only from `localhost` / `127.0.0.1`.

### Produce playtest evidence

With a Valleyward checkout that includes `module:check`, run `npm run module:check -- my-fire --slot lance` from
Valleyward. Use `--slot ground` for ground fire. The command checks the linked path and catalog, prints a matched
Classic URL, and records the in-game slot report, screenshots, browser errors, and timing. Add `--preflight` to
confirm registration and get the playtest links before opening a browser.

Watch the effect in the actual game camera through the tap, held shot, turn, and release, or the ground burst.
Keep the renderer, pose, quality, and other slot fixed when comparing it with Classic. In the PR, report what was
measured and the browser and GPU used. Label GPU time, CPU submission, and paced frame intervals separately.

## Submitting a pull request

1. Fork the repo and make a branch.
2. Add your module folder and its catalog entry, or make your fix. Keep unrelated changes out.
3. Run `npm test`. The same checks run on GitHub for every pull request.
4. Open the pull request and fill in the [template](.github/pull_request_template.md). Include a copyable Valleyward URL,
   the loaded slot IDs, and a screenshot or clip. The [Curved Volume module](modules/lance-curved-volume/README.md)
   shows the module layout, tuning notes, and a matched comparison with Classic.
5. A maintainer reviews it. Modules run in every player's browser, so every line is reviewed for safety, cost and the
   rules above. Expect questions and requests for changes.

## After your module is merged

- It ships in the next Firewraith release. Releases are tagged on GitHub and archived on Zenodo with a DOI (see
  [`CITATION.cff`](CITATION.cff)).
- VALLEYWARD then updates to that release. With its next deploy, players can pick your module in the hosted game under
  **P → Fire module**, or open `https://valleyward.app/?firemod=<id>`.
- Credit stays with you: your name in `info.author` and your module's `README.md`, and in the release notes.

## Licence

Firewraith is MIT-licensed ([`LICENSE`](LICENSE)). By submitting a contribution, you confirm that you wrote it or have the
right to submit it, and you agree that it is licensed under the MIT License. Code from elsewhere must be MIT-compatible
and credited in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Be kind

Be respectful and constructive in issues, reviews and discussions. Fire is hard; everyone here is learning.
