# classic

VALLEYWARD's original fire as a Fire API v1 module (`webgl2`, slots `lance` and `ground`, together or either alone).

| Slot | What it draws | Method |
|---|---|---|
| `ground` | Marbled ground fire that spreads along oil, rising smoke, embers, steam where fire is doused, the ending's fire columns, five hues, smooth and pixel-art (hybrid) styles | a 2D GPU grid fluid (fuel, fire, smoke, heat, a pressure-projected flow) over the fire area, drawn as a ray-marched 2.5D volume |
| `lance` | The Ember Lance's airborne stream | up to 640 CPU particles on the game's ballistic arc, drawn into the same volume buffer as the ground fire |

It also provides:

- **the gameplay grid** (`fire`): a 64² summary read back with the kit's non-stalling read-back;
- **the light map** (`lightMap`);
- **the light at the camera** (`nearLight`);
- **`stats()`**;
- **`debug`**: the benches' and perf tools' hooks.

| File | What |
|---|---|
| `index.js` | `create(host)`: wires the parts per slot, the read-back, `render`, `warm` |
| `solver.js` | The grid solver: the fields and passes |
| `volume.js` | The ray march and the composite, both styles |
| `embers.js` | GPU sparks |
| `jet.js` | The Lance's particles |
| `steam.js` | Douse puffs |
| `column.js` | The ending's pillar and the demon's fire |
| `gl.js`, `world.js` | Helpers and `host.world` |
| `FLUID.md` | How it works, its knobs, its measured cost and the decisions behind it |
