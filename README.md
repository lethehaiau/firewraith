<h1 align="center">Firewraith</h1>

<p align="center"><b>A playground for real-time volumetric fire in the browser.</b></p>

<p align="center">
  <a href="https://valleyward.app/?firemod=classic"><b>Play WebGL2</b></a> ·
  <a href="https://valleyward.app/?firemod=classic-webgpu"><b>Play WebGPU</b></a> ·
  <a href="#build-a-module">Build a module</a> ·
  <a href="#contribute-a-module">Contribute a module</a>
</p>

Build your own fire or smoke simulation and try it in VALLEYWARD, a browser horde survivor. Firewraith gives you a
module API and GPU helpers for Three.js. Your fire can react to wind and rain, light the scene, and decide what burns
as you play. [VALLEYWARD source](https://github.com/lethehaiau/valleyward)

## Bring your own fire

The reference fire uses a 2D fluid grid rendered as a ray-marched 2.5D volume. Try it in WebGL2 or WebGPU using the links
above, or read how it works in the [classic breakdown](modules/classic/FLUID.md) and [WebGPU port](modules/classic-webgpu/README.md).

What would you try? Run a full 3D grid on WebGPU and see how smoke rolls over the walls. Try particles for a flame that
breaks into glowing embers. Render at a lower resolution and see how much detail you can recover with upsampling.

## Build a module

Start with one effect. A `lance` module draws the Ember Lance's airborne flame. A `ground` module handles fire and smoke
on the ground, with the option to light the world or tell the game what burns. A module can fill both roles, and a
[setup](docs/API.md#setups) can pair it with a partner of your choice. See the [Fire API](docs/API.md) for the `info`
and `create(host)` exports and what the game provides each frame.

With Node.js 24, clone Firewraith and run the module checks.

```sh
git clone https://github.com/lethehaiau/firewraith.git
cd firewraith
npm ci
npm test
```

Put your implementation in `modules/<id>/` with an `info.js`, `index.js`, and `README.md`. Give it a unique ID and add it
to the [module catalog](modules/catalog.js). Then run VALLEYWARD against your local Firewraith checkout.

```sh
cd ..
git clone https://github.com/lethehaiau/valleyward.git
cd valleyward
npm ci
npm install --no-save ../firewraith
npm run dev
```

Open `http://127.0.0.1:5350/?firemod=<id>` with your module ID. To swap one effect, use `?lance=<id>` or `?ground=<id>`.
Add `&perf=1` to see frame times, and inspect `__ew.perf().fire` in the browser console for module stats.

You can also prototype in your own repo. Serve a browser-ready ES module from a local dev server and load it in your
local game with a URL such as `http://127.0.0.1:5350/?lance=http://localhost:5173/src/index.js`.

## Contribute a module

1. Fork Firewraith. Add `modules/<id>/` and register the same ID in [`modules/catalog.js`](modules/catalog.js) so a linked Valleyward checkout can load it. Credit yourself in `info.author` and the module README.
2. Run `npm test` and try your module in VALLEYWARD.
3. Open a pull request. Describe your idea, include a screenshot or short clip, and share your browser, GPU, and
   performance results.

After review and merge, your module can ship in a Firewraith release. Once VALLEYWARD deploys that release, anyone can
pick your module under **P → Fire module** or play it at `https://valleyward.app/?firemod=<id>`.

Improvements to the API, GPU helpers, and reference modules are welcome too. [Contribution guide](CONTRIBUTING.md)

## Cite Firewraith

Cite the release you used. [v0.3.0 DOI](https://doi.org/10.5281/zenodo.24478877) ·
[All versions](https://doi.org/10.5281/zenodo.24362891) · [Citation metadata](CITATION.cff)

## Licence

Firewraith and modules contributed here are MIT-licensed. [MIT License](LICENSE) ·
[Third-party notices](THIRD-PARTY-NOTICES.md)
