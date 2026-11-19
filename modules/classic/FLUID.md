# classic · how the fire works

`classic` is VALLEYWARD's original fire, packaged as a Fire API v1 module (`webgl2`). It fills two slots:

- **`ground`:** a 2D GPU grid fluid over the fire area (fuel, fire, smoke, heat and a pressure-projected flow), drawn as
  a ray-marched 2.5D volume, with embers, steam, the ending's fire columns, five hues and two styles (`smooth` and the
  pixel-art `hybrid`). It also gives the game a gameplay grid (what burns), a light map (what the fire lights) and the
  light at the camera.
- **`lance`:** the Ember Lance's airborne stream, as CPU particles on the game's ballistic arc, drawn into the same
  volume buffer so both styles colour it like the ground fire.

The module follows [docs/API.md](../../docs/API.md); this file says how it works inside, how to tune it, what it costs
and why it is built this way. Its WebGPU twin is [`classic-webgpu`](../classic-webgpu/README.md) (see
[classic-webgpu](#classic-webgpu)).

| File | What |
|---|---|
| `index.js` | `create(host)`: the parts per slot, the read-back, `render`, `warm`, `stats`, `debug`; `TIER` |
| `solver.js` | The grid solver: fields, passes, the op → splat mapping, the summary, the hue map and the light map; `KNOBS`, `DEPOSIT`, `RES`, `LIGHT_COLS` |
| `volume.js` | The ray march and the composite, both styles, every shader variant; `LOOK`, `HUE_RAMPS` |
| `embers.js` | GPU embers (a state texture updated by a fragment pass); `EMBER_SMOOTH`, `EMBER_HYBRID` |
| `jet.js` | The Lance's particles; `JET`, `jetLanding()` |
| `steam.js` | Steam puffs where fire is doused; `STEAM` |
| `column.js` | The ending's pillar and the demon's fire; `COLUMN_PRESETS`, `COLUMN_RAMPS`, `makeFireVortexMaterial()` |
| `gl.js`, `world.js`, `info.js` | Kit re-exports and the hue channels; the copy of `host.world`; the module's `info` |

It uses the webgl2 kit (`src/kit/webgl2/`): render targets, ping-pong pairs, the full-screen pass runner, depth
reconstruction, the noise texture and the non-stalling read-back.

The game side lives in the VALLEYWARD repo: the fire host (`src/fire/`) loads modules and builds `host.world`;
`src/shared/firelight.js` lights the world's materials from the light map; the fire bench is `preview/fluid.html`.

## How it works

### The domain and the fields

The fire lives in `host.world.area`, a square on the ground (in VALLEYWARD 64 × 64 m), with u along +x and v along +z.
The fields are half-float RGBA ping-pong targets:

| Field | high | medium | low |
|---|---|---|---|
| Velocity V (xy = m/s; z = this step's whirlpool sink), pressure, divergence, curl | 256² | 128² | 128² |
| Scalars S = (fuel, fire, smoke, heat) and the hue mass H (S's second attachment) | 512² | 256² | 256² |
| Jacobi iterations per sub-step (warm-started) | 16 | 16 | 10 |
| Sub-step rate | 60 Hz | 60 Hz | 30 Hz |

`RES` in `solver.js` holds these. A static 256² obstacle mask comes from `host.world.walls` (in VALLEYWARD the keep's
south wall, gate included, and its two south towers). Trough rims do not block. The borders are open (pressure 0), and
the flow relaxes to the wind within three texels of them.

### One sub-step

`solver.step(dt)` runs fixed sub-steps at the tier's rate, at most 3 a frame, so a slow frame never spirals. Queued ops
force one step, so they never wait. Each sub-step:

1. **Splat** the queued ops: one instanced draw into S (+ H) and one into V, with additive blending. Shapes are a
   capsule (stream, burst, ember, push, douse, a fuel disc) or a soft box (`fuel` with `box`). A douse adds large
   negatives, which the reaction clamps. Up to 4096 splats a frame (`MAX_SPLATS`); the game sends at most 480 events a
   tick (`FIRE_CAPS.total`), so 8 ticks fit.
2. **Advect V** (semi-Lagrangian), damp it (`velDecay`) and relax it toward the wind (`windPull`).
3. **Vorticity confinement** on the curl (`curl`), strongest inside fire and smoke, plus a slowly drifting churn force
   inside the fire (`turb`, ≈ 2 m eddies). These two make the marbled, curling look.
4. **Divergence**, with the combustion expansion as a source (`expand` × fire): hot gas pushes outward, so a firebomb
   blooms and a stream spreads. The whirlpool sinks are added here too.
5. **Pressure:** Jacobi, warm-started from the last step's pressure × `pressureKeep`.
6. **Project:** subtract the gradient; walls get zero velocity.
7. **Advect and react S and H** in one two-output pass:
   - fire, smoke and heat advect; fuel stays put;
   - on oil, flames and heat mostly stay put (`stick`) instead of drifting off with the flow;
   - heat diffuses a little (`heatDiffuse`), and oil within `spreadDist` of a flame heats up (`spread`), so fire runs
     along a trough at ≈ 2 m/s;
   - fuel burns where heat passes `ignite` (`burnRate`, × `fireYield` into fire); fire feeds heat (`heatGain`) and
     decays (`fireDecay`) into smoke (`smokeYield`); smoke dissipates (`smokeDecay`, plus a small constant so thin
     smoke clears and the empty-space skip keeps working); heat cools (`cool`).

### Per frame: the summary, the hue map and the light map

After the sub-steps of a frame, three 64² passes run (one texel = one 1 m cell):

- **The summary** (RGBA8): R = gameplay heat = the max over the cell of max(heat, 0.8 × fire); G = mean fuel; B = mean
  fire; A = mean smoke. This is the gameplay grid the game reads back.
- **The hue map** (RGBA8): the fire-weighted hue fractions (violet, blue, green, lilac) over a 2 m window round each
  cell. A cell beside a coloured flame carries its hue, so the bilinear map leaves no orange rim round a coloured fire.
- **The light map** (RGBA16F): a 9-tap separable Gaussian over the summary. RGB = the cell's light colour (its hue mix
  of `LIGHT_COLS` × 1.5) × (1.15 fire + 0.35 heat). A = occupancy (max of fire, heat and 1.5 × smoke), which the march
  uses to skip empty space. The fire columns then add their light as discs.

### The render pass

`render(renderer, { colorTex, depthTex, camera, target, width, height })` draws, in order:

1. **The march** into the volume target: half resolution in `smooth`; in `hybrid` one texel per fire pixel of
   `round(height / 270)` screen pixels (4 at 1080p).
2. **The jet**, into the same target with the same channel layout.
3. **The composite** of the volume over `colorTex` into `target`.
4. **The embers**, additive, with a manual depth test.
5. **The steam** and **the fire columns**, over the composite.

It leaves the renderer's target and `autoClear` as it found them.

#### The march

Per volume texel the shader rebuilds the world ray and the scene distance from `depthTex`, clips the ray to the domain
box (y from −16 m to `smokeTop` + 1 = 8.5 m), and steps with `dt = clamp(0.075 t, 0.09, 2.0) × stepScale`. Inside the
flame layer the step is at most 0.22 + 0.03 t (`fineStep`). A ray skips ≥ 1.6 m where the light map's occupancy is ~0,
stops above the smoke when rising, and ends when the transmittance falls below 0.03 or the smoke's capped opacity is
full. A stable white-noise jitter of at most one flame step hides banding in `smooth`; `hybrid` uses none.

- **Flames:** short tongues. A 2D blob noise, carried sideways by the flow and licking upward, is cut by a threshold
  that rises with height, so each tongue tapers to a tip and gaps open between them. The lookup leans downwind by
  velocity × height × `lean`. Flame height is ≈ `flameH` × fire^0.9 (heat adds a little): dense fire (troughs,
  pools, bursts) stands ≈ 1.5 m at fire 0.5 and ≈ 2.4 m at 1, and weak fire stays low. The noise varies faster with
  height so tall flames break up instead of drawing thin columns; a second "lick" octave runs within 22 m and below
  1.6 m. Tongues are nearly opaque (emission = extinction, `fireGain`), so the nearest tongue wins instead of a column
  of emission summing to a curtain.
- **Temperature:** each flame sample has a colour coordinate: crimson at a tongue's edge and tip, orange body,
  white-yellow at the base of dense fire (`coreHeat`).
- **The ground sheet:** where the ray ends on the ground, one more sample of a thin burning layer (`sheetH` 0.25 m,
  path length 1/|rd.y|): the fire field, domain-warped by slow noise and the flow, with thin bright veins that reach the
  white-yellow core. It reads as a marbled, molten burning floor.
- **Smoke:** translucent charcoal that rolls up to `smokeTop`, drifts with the flow and thins with distance
  (`smokeFar`). Its own opacity is capped at `smokeMaxA` 0.6. The fire below lights it orange (`smokeGlow`, from the
  light map); the moon and sky light it from above, with a self-shadow toward the moon within 25 m. A second smoke
  octave runs within 12 m.
- **Fades:** the volume thins within `nearFade` of the camera (0.6 → 3 m), and flames and smoke fade within `wallFade`
  0.6 m in front of any surface, so tall tongues do not paint streaks up the stone.

Output 0: R = fire coverage (≤ 1), G = R × temperature, B = moon-lit smoke, A = the transmittance T. Output 1 = the
emission-weighted hue mass (only in the hue variant).

#### The composite: `smooth` and `hybrid`

The fire colour is the six-stop ramp at the emission-weighted temperature G/R:
`#4a1612 → #a3241a → #e85a1c → #ff9a2e → #ffd24a → #fff2b8` (dark edge → core; `HUE_RAMPS.orange`).

- **`smooth`:** a depth-aware bilateral upsample of the half-res volume and a continuous ramp. The body stays ≤ 1.0
  linear; only temperatures from 0.8 up go HDR (× `bright` 2.4), so the bloom catches the cores. The cool flame edge
  (temperature ≈ 0.2, `#a3241a`) is drawn more opaque and brighter (`rimGain`) as a crimson rim.
- **`hybrid`:** a nearest upsample on the fire-pixel grid, and the six colours stepped by temperature (+ 0.35, so the
  body lands on orange, not crimson). A 4×4 Bayer dither touches only band borders and the fire's own edge, never the
  sky, the moon or the smoke. The top level gets a little HDR (× 1.28): a bloom halo is not pixel art. Thin fire at the
  edge (coverage ≥ 0.18) gets a `#a3241a` rim. A foreground edge inside a fire pixel stays crisp. The smoke comes from
  the soft bilateral sample, like `smooth` (`softSmoke` 1).
- **Smoke** in both: `uSmokeCol` (charcoal-brown `#312526`, moon-lit) × B, never darker than 0.3 × what it covers.

#### The jet

The Lance's stream is up to 640 CPU particles (`JET.rate` 900 a second) shot from the nozzle along the aim with gravity.
They fly the game's arc: `create()` copies speed and gravity from `host.world.lance` (VALLEYWARD: 16 m/s, 14 m/s², no
drag, the game's `lanceArc` in `src/sim/weapons.js`). Past the horizontal range a particle loses most of its horizontal
speed and rains down; on the ground it skids and ages faster. `jetLanding(origin, dir, range)` gives the centreline's
touch-down, so the game's `stream` ops can sit exactly under the visual.

The particles are noisy billboards (half-width 0.14 → 0.6 m) drawn into the volume target with a soft depth test and a
premultiplied "over" blend, so overlapping puffs saturate at their own heat instead of summing to white. Their
temperature runs from white-yellow at the nozzle core through an orange body to a crimson tail, so both styles colour
and pixelate the jet exactly like the ground fire.

#### Embers

GPU particles in a 128-wide state texture (xyz world, w = seconds left), 16384 / 8192 / 4096 per tier. A fragment
pass updates them: dead slots spawn at random points weighted by the fire, live ones rise (0.7–2.4 m/s, slowing above
3–9 m), drift with the flow plus noise, and die out of the area. The spawn rate scales with the pool size, so a smaller
tier shows a similar density. They are drawn as additive points: soft dots of 1.4–5 px in `smooth`, squares of the
fire-pixel size in `hybrid`.

#### Steam

A `douse` op puffs pale grey steam where the read-back says the ground was hot (heat ≥ 0.12) inside its radius: at
most 14 puffs an op, 256 alive, each living 0.9–1.6 s while it rises and swells (half-width 0.4 → 1.8 m), alpha
≤ 0.3. A bucket on bare ground makes none, and nor do the repeated douses after the first at dawn. While the grid is
stale (> 30 frames old) a bucket-sized douse (r ≤ 4 m) still makes 8 puffs and a large one none. A tide line samples
along its length and makes a few puffs per tick (the game sends one op per tick at the wave front). `smooth` draws soft
wispy billboards; `hybrid` puts them on the fire-pixel grid with two flat alpha steps.

### Coloured fire

Coloured fire: some fire sources carry a hue, to tell them apart and to look cooler. Ops that
make fire (`stream`, `burst`, `ember`) may carry `hue`: `orange` (the default), `violet`, `blue`, `green` or `lilac`.
An unknown hue is orange. The gameplay grid ignores hue.

- **The hue field.** H is S's second attachment: the fire-weighted hue mass of violet, blue, green and lilac (orange =
  fire minus their sum, so it needs no channel). The splat writes `hue one-hot × fire deposit`. The scalars pass reads
  H at the same back-traced point and with the same `stick` as the fire, turns it into fractions and writes
  `fraction × the new fire`, so a hue rides exactly with its fire and dies with it. Where hues meet they blend by fire
  weight. Oil that catches from a neighbour's flame takes that flame's hue, so a violet nova that lights a trough burns
  violet along it.
- **The render.** The march adds `T × emission × hue fractions` from the 64² hue map to its second output. Hue borders
  are therefore soft over ≈ 1 m on screen, while H itself stays sharp. The composite turns hue mass / coverage into
  weights. `smooth` blends the hues' ramps by weight; `hybrid` takes the dominant hue per fire pixel and dithers between
  the top two only where their weights are within 0.35, with the hue's deep edge (ramp index 1) as its rim (orange
  keeps `#a3241a`). The HDR boost of the hot core is shared, so every hue's core blooms white-ish.
- **Only while needed.** Each march and composite has an orange-only variant without any hue read, and a `HUE` variant.
  The coloured one runs only while a hued op arrived in the last 40 s or the jet is hued (`volume.setHue`).
- **Light, embers, jet.** The light map and `nearLight` mix `LIGHT_COLS` by the hue map, so walls and sprites near a
  violet fire go violet. An ember picks a hue at spawn from its cell's fractions and keeps it in its state
  (w = seconds left + 8 × hue index; with a half-float state, on GPUs without `EXT_color_buffer_float`, embers stay
  orange). The jet takes `lance({ hue })` when given, else the hue of the last `stream` op. It cannot draw lilac (lilac
  draws violet): its blend uses the hue output's fourth channel to fade what lies behind it.

| Hue | Ramp (dark edge → core) | Light colour (× 1.5) |
|---|---|---|
| orange | `#4a1612 #a3241a #e85a1c #ff9a2e #ffd24a #fff2b8` | (1, 0.42, 0.13) |
| violet | `#2c0a52 #6a1fb3 #9a45f0 #c46bff #e4b2ff #fff0ff` | (0.62, 0.2, 1) |
| blue | `#0a1c5c #1a4fd6 #2f8cf2 #4fb8ff #aee6ff #eaffff` | (0.12, 0.5, 1) |
| green | `#0b3a14 #1f8f2a #4fd23a #7dff4f #c6ff94 #f4ffd8` | (0.3, 0.95, 0.14) |
| lilac | `#33195e #7f4fc4 #a571ea #cf98ff #ebcbff #fff4ff` | (0.78, 0.48, 1) |

The same values are the Fire API's reference `HUE_RAMPS` and `HUE_LIGHT` (`src/api/events.js`). Lilac is more
saturated than a first `#d9a6ff`, which read pink-white. Green is the most luminous and may look loud next to orange;
the game's grade decides.

### Rain, tide lines and whirlpools

- **Rain** (`update(dt, { rain })`, 0..1) scales the reaction constants on the CPU, so it has no shader cost. At full
  rain: fire decays × 1.6 (`rainDecay`), fuel burns × 0.72 (`rainBurn`), heat cools × 1.45 (`rainCool`), ignition
  needs 0.06 more heat (`rainIgnite`), smoke yield × 1.6 (`rainSmoke`). A fire on oil settles at ≈ 0.45 × its dry
  strength. The flames stand 30 % lower (`LOOK.rainFlame`), the smoke moves 60 % toward a pale steam grey
  (`LOOK.rainSteam`), and the fire light dims by 45 % (`rainLight`).
- **Tide lines** (`{ kind:'douse', x0, z0, x1, z1, r, vx?, vz? }`): the douse splat is already a capsule, so a line
  costs nothing new; `vx`/`vz` shove the flow with the wave. Steam rises along the line where fire was.
- **Whirlpools** (`{ kind:'swirl', x, z, r, spin, pull, amount }`, one op per tick):
  - the velocity splat adds a tangential flow, peaking between 0.35 r and 0.7 r. The per-tick increment is
    `spin × 0.024`; with the damping that settles at ≈ 1.5 × `spin` m/s before the vorticity and the fire's expansion
    take their share (at × 0.016 the arms were too loose in the game);
  - it writes a **sink** into V.z, which advection and vorticity carry to the divergence pass. The projection keeps a
    convergence it is given as a source, so the inward pull survives (a plain inward push would be projected away);
  - the water washes the oil away over r (`DEPOSIT.swirl.wash`, 0.014 fuel a tick) and quenches the eye (r × 0.3), so
    burning oil is dragged round and in and dies at the centre.

### Standing in fire

Hearthblood heals the player only while they stand in fire, so players stand in it on purpose. A first-person eye
inside the flames used to see a yellow-white wall. Now the CPU measures `camFire` (0..1, in `stats().camFire`): the
read-back's fire at the camera's ground point and 1.2 m round it, only while the eye is ≤ ≈ 3 m above the ground (never
on the wall walk), eased over ≈ 0.2 s. While it is above 0.01 the march runs its **INFIRE** variant:

- the near fade of the flames stretches from 0.6 → 3 m to 1.4 → 6.5 m (`inFireFade0/1`), fully on rays above the
  horizon and at the screen centre, about half on rays down at the feet, so flames still lick round the lower view;
- flames within that range are drawn cooler (`inFireCool` 0.78: orange, not white-yellow);
- the burning ground within ≈ 5 m dims to 0.35 (`inFireSheet`).

Fire beyond ≈ 6.5 m, and all fire while the eye is not in it, looks the same as without the variant.

### Fire columns (the ending)

`columns.set(id, { preset, x, y, z, intensity, …overrides })` adds local ray-marched fire outside the ground slab;
`set(id, null)` removes one and `clear()` (also `reset()`) removes all. Nothing is drawn and nothing costs while no
column exists. Each column is a box mesh drawn after the composite (back faces, so it also works from inside), marched in
30 steps through value noise that rises and twists in a cylinder, depth-tested against the scene by hand, and blended
premultiplied over the target, so its black edges darken what is behind. `hybrid` marches one ray per fire pixel and
steps the ramp with the Bayer dither. Each column emits CPU sparks (≤ 640 in all, additive points) and adds a light
disc to the light map, so the keep is lit red by the pillar.

- **`pillar`:** radius 3.6 m swelling × 2.5 to the top, 46 m tall from the beacon basket up into the portal, twisting,
  rising 8 m/s; the `blackred` ramp `#020001 #1c0306 #5c0610 #a8101a #ff4a22 #fff0e0` (black ragged rim, deep red
  body, white-hot heart low in the column); 200 sparks/s; a deep red light of radius 24 m.
- **`demon`:** 7.5 m tongues on a radius of 2.8 m that frame the ≈ 5 m figure on the wall walk. They burn only behind
  it and at its sides (none where the shell faces the camera), plus a low orange-red ring at its feet; the sprite in
  front hides what is behind it by depth. Orange ramp, gain 2.6, HDR 1.8, 170 sparks/s, light radius 7 m.

`makeFireVortexMaterial({ ramp })` is a swirling fire-vortex material for a portal disc. The game's bench shows it; the
game itself does not use it.

## The read-back and the gameplay grid

The gameplay grid (`fire.heat/fuel/fire(x, z)`, bilinear between 1 m cells, 0 outside the area) comes from the 64²
summary, read back with the kit's `createGridReadback` (`src/kit/webgl2/readback.js`). One read carries both 64² RGBA8
grids, the summary and the hue map (32 KB):

- `rb.poll(frame)` runs first in each frame's `update`, before the frame's own GL work, so the round trip waits only for
  work already queued. `rb.kick(frame)` runs after the sim, when a sub-step ran.
- Each read gets a fresh pixel-pack buffer: two `readPixels`, one fence, then `getSyncParameter` once a frame (never
  `clientWaitSync`, which in Chrome ends in a command-buffer Finish that blocks the main thread for the whole GPU
  queue). `getBufferSubData` runs only after the fence signalled, and only if it signalled within `maxLag` frames
  (1, `debug.rbMaxLag`). Otherwise the read is dropped. Either way the buffer is deleted and never re-used.
- After a slow get (> 4 ms) the gate is held at 1 frame for 120 frames (it matters only when `maxLag` is raised).
- When the GPU queue stays deep, reads are dropped and the grid ages: `fire.ageFrames` = frames since the landed grid
  was kicked. The game uses the module's grid while `ageFrames` ≤ 30 and its own CPU fire grid when it is older
  (switching back at ≤ 8).
- `stats().readbackMaxMs` = `{ kick, poll, get, gets, slowGets, dropped, tight }`; `debug.rbReset()` clears it.

**Why it is built this way** (measured 2026-11-14 in the game, Chrome on ANGLE/Metal, headless). Chrome's fast path
for `getBufferSubData`, a shadow copy, never engaged on this setup. Any re-use of a READ buffer printed "READ-usage
buffer was written, then fenced, but written again before being read back" (257 times a page), even with a ring of 3
buffer pairs, reads delayed past the signal, `clientWaitSync` polling or a `flush` after the fence. A minimal page with
one PBO behaved the same. So every `getBufferSubData` pays a round trip through the GPU process's queue: 27 ms a read
with no load, 200–1,000 ms under GPU load. Only a buffer deleted after its read never warns. The cost of a read is the
queue's depth, which the fence's latency measures, hence the gate. A gate of 2 frames let 7–14 of 600–1,600 reads take
15–30 ms at a 120 Hz cadence. An older "accept a lag ≤ 8 after 45 frames without a read" override caused reads of
37–511 ms, so there is no starvation override.

Measured with that design (production build, 1920×1080, high, game scenes "Organ" and "Ending", load average 3.3–4.6):

| Run | Frame max | Grid age (max / mean frames) | Reads > 4 ms / reads (max) | Warnings |
|---|---|---|---|---|
| Organ, 60 fps cap | 16.8 ms | 1 / 1 | 1 / 826 (6.0 ms) | 0 |
| Ending, 60 fps cap | 16.8 ms | 1 / 1 | 0 / 3,091 (1.3 ms) | 0 |
| Organ, 120 Hz cadence | 34.1 ms (the cadence's gaps); callback max 7.6 ms | 4 / 1.8 | 2 / 573 (5.5 ms) | 0 |
| Ending, 120 Hz cadence | 34.4 ms; callback max 6.3 ms | 132 / 7.5 (the CPU grid took over in gaps) | 0 / 1,364 (0.9 ms) | 0 |
| Organ, `?fps=0` uncapped | 14.7 ms | never read (38 dropped) | 0 / 0 | 0 |
| Ending, `?fps=0` uncapped | 598 ms at the ending's beats (not the read-back: 0 reads) | never read | 0 / 0 | 0 |

## The light map and the light at the camera

- **`lightMap`** is the 64² RGBA16F texture over `host.world.area`: RGB = linear fire light (hue colour × strength),
  A = occupancy. The game's `src/shared/firelight.js` patches its materials (Lambert, Standard/Physical, Phong, Toon and
  Basic; plain, instanced and batched meshes) to add `map(worldPos + normal × reach)` × albedo, faded by height above
  the real ground as 1 / (1 + (h / height)²) and to zero at the area's edge. Own shaders (sprites) include its
  `FIRELIGHT_GLSL`. The game's `uFireLightGain`, `uFireLightReach` (1.6 m) and `uFireLightHeight` (4 m) tune it.
- **`nearLight(x, y, z, out)`** is the CPU twin of the light map, for the first-person hands. It sums the read-back's
  cells within 6 cells of the point with a Gaussian of 2.2 cells, weights fire × 1.15 + heat × 0.35, mixes
  `LIGHT_COLS` by the read-back hue map, and fades with height above y = 1.2 m as 1 / (1 + (h / height)²). It returns
  false until a grid has landed.

## Knobs

All tuning lives in exported, mutable objects; the values in the code are the tuned ones. The game's bench writes into
them live (the module's `debug.look` is `LOOK`).

| Object (file) | Knob | Value | What it does |
|---|---|---|---|
| `KNOBS` (`solver.js`) | `curl`, `turb` | 22, 26 | how curly and churning the fire is |
| | `expand` | 0.26 | how hard fire pushes outward (a firebomb's bloom, a stream's spread) |
| | `velDecay`, `windPull` | 0.35, 0.6 /s | flow damping, relaxation toward the wind |
| | `ignite`, `burnRate`, `fireYield` | 0.18, 0.075 /s, 20 | when fuel catches; a full oil cell burns ≈ 13 s; flame strength on fuel |
| | `fireDecay`, `heatGain`, `cool`, `heatDiffuse` | 1.15 /s, 4, 2.2 /s, 0.3 | a burst fades in ≈ 2–3 s; how hot fire gets; how fast heat fades; how far it bleeds |
| | `spread`, `spreadDist`, `stick` | 8, 0.4 m, 0.75 | how fast fire runs across oil, the hop, how firmly flames sit on oil |
| | `smokeYield`, `smokeDecay` | 0.9, 0.28 /s | how much smoke, how long it stays |
| | `pressureKeep` | 0.85 | the Jacobi warm start |
| | `rainDecay`, `rainBurn`, `rainCool`, `rainIgnite`, `rainSmoke`, `rainLight` | 0.6, 0.28, 0.45, 0.06, 0.6, 0.45 | the rain's effect at full strength |
| `DEPOSIT` (`solver.js`) | `stream` | fire 0.55, heat 0.6, fuel 0.01, push × 0.35, min r 0.6 m | one Lance landing op (× its `amount`) |
| | `burst` | fire 2.2, heat 1.4, smoke 0.5 | one burst (radius × 0.75, radial push `op.push`, default 4 m/s) |
| | `ember`, `fuel`, `douse` | fire 0.4, heat 0.7, r 0.5 m; fuel 1; k 12 | a burning goblin; poured oil; a douse removes 12 × fire and heat |
| | `swirl` | core 0.3, quench 0.9, wash 0.014 | the whirlpool's quenched eye and how fast it washes oil away |
| `LOOK` (`volume.js`) | `flameH`, `lean`, `smokeLean`, `smokeTop` | 2.8 m, 0.24 s, 0.45, 7.5 m | flame height, lean with the flow, smoke drift and height |
| | `fireGain`, `fireExposure`, `bright`, `coreHeat`, `rimGain` | 3.6, 1.1, 2.4, 0.85, 1.3 | flame density, coverage scale, HDR core, how white the base of dense fire gets, the crimson rim |
| | `smokeK`, `smokeMaxA`, `smokeGlow`, `smokeFar` | 0.65, 0.6, 0.3, 70 m | smoke extinction, its opacity cap, its orange underside, where it thins out |
| | `sheetGain`, `sheetH` | 3.0, 0.25 m | the burning ground sheet |
| | `nearFade`, `wallFade` | 3 m, 0.6 m | the fade near the camera and in front of surfaces |
| | `inFireFade0/1`, `inFireSheet`, `inFireCool` | 1.4 m, 6.5 m, 0.35, 0.78 | [standing in fire](#standing-in-fire) |
| | `rainFlame`, `rainSteam` | 0.3, 0.6 | lower flames and paler smoke in the rain |
| | `tall`, `softSmoke`, `fineStep` | 1, 1, 1 | 0 = the older low flat flame shape; 0 = hybrid smoke in flat steps; 0 = no finer steps in the flame layer (saves ≈ 0.1–0.3 ms, softer tongues) |
| `TIER` (`index.js`) | high / medium / low | 40 / 38 / 30 march steps, step scale 1 / 1.25 / 1.6, 16384 / 8192 / 4096 embers | `hybrid` takes 1.35 × the steps at 0.7 × the size |
| `RES` (`solver.js`) | | see [the fields](#the-domain-and-the-fields) | |
| `JET` (`jet.js`) | `rate`, `spread`, `size0`, `size1`, `gain`, `alpha`, `rain` | 900 /s, 0.035, 0.14 m, 0.6 m, 2.3, 0.46, 0.18 | the jet's look; `speed`/`gravity` come from `host.world.lance` |
| `STEAM` (`steam.js`) | `perOp`, `heatMin`, `rise`, `life`, `size`, `alpha`, `color` | 14, 0.12, 1.6 m/s, 0.9–1.6 s, 0.4–1.8 m, 0.3, (0.3, 0.33, 0.35) | the steam puffs |
| `COLUMN_PRESETS`, `COLUMN_RAMPS` (`column.js`) | | see [fire columns](#fire-columns-the-ending) | |
| `HUE_RAMPS` (`volume.js`; then `volume.setRamps()`), `LIGHT_COLS` (`solver.js`), `EMBER_SMOOTH` / `EMBER_HYBRID` (`embers.js`) | | see [coloured fire](#coloured-fire) | each hue's ramp, light colour and ember colours |
| `debug` | `rbMaxLag`, `lockStep`, `skip.{march, jet, embers, readback}` | 1, false, false | the read-back gate; one sim sub-step per rendered frame; switch parts off for perf runs |

`setStyle('smooth'|'hybrid')` and `setQuality('high'|'medium'|'low')` work at runtime; a quality change resamples the
fields into the new resolution, so nothing is lost.

## What the game calls

Beyond the Fire API members (`events`, `update`, `lance`, `render`, `fire`, `lightMap`, `nearLight`, `stats`, `warm`,
`reset`, `dispose`; see [docs/API.md](../../docs/API.md)):

- `create(host)` throws if the GPU cannot render into float targets (no `EXT_color_buffer_float` or
  `EXT_color_buffer_half_float`); the game then keeps its CPU fire grid.
- `columns` (`set`, `clear`, `get`), `setStyle`, `setQuality`.
- `warm(renderer, camera)` compiles every program of both styles, runs one sub-step, then draws one 192×108 frame
  through every pass and variant (both styles; with and without hue and in-fire; the jet, the embers, the steam, a
  pillar and its sparks) into throwaway targets. On ANGLE/Metal a program's pipeline is built at its first draw, not
  at compile: before the warm-up draws, the first switch to `smooth` cost a 66 ms frame with no new program.
- `reset()` clears fuel, fire, smoke, heat, velocity, pressure, embers, the jet, the steam, the columns and the
  read-back grid (the game calls it on a retry).
- `stats()`: `simMs`, `renderMs` (CPU ms), `res`, `steps`, `readbackAgeFrames`, `gpuSimMs`/`gpuRenderMs` (only with
  `host.options.gpuTiming` and the timer extension), `style`, `quality`, `camFire`, `jetParticles`, `steamPuffs`,
  `rain`, `columns`, `sparks`, `columnMs`, `readbackMaxMs`.
- `debug`: `skip`, `lockStep`, `rbMaxLag`, `rbReset()`, `look` (= `LOOK`), `grid`, the parts (`solver`, `volume`,
  `embers`, `jet`, `steam`, `columns`), `setEnabled(on)`, `setGpuTiming(on)`.
- `?rbmode=off` turns the read-back off and `?rbmode=lagN` sets another gate (perf experiments only).

## Performance

The fire's budget in the game is 4.5 ms of GPU time on high at 1080p.

**Bench throughput.** The production build of the game's bench (`preview/fluid.html`), headless Chrome (ANGLE/Metal) on
the reference Mac (Apple M4), 1920×1080, DPR 1, high. Scene `busy`: both troughs burning, three firebombs, 86 burning
stand-in goblins and the Lance sweeping, after 4 s of sim. Each number is fluid-on minus fluid-off for 120–150 frames
rendered back to back with a 1-pixel `readPixels` before and after (GPU-bound throughput, not rAF-paced), on and off
interleaved × 3 to cancel load drift.

| What | `smooth` | `hybrid` | Conditions |
|---|---|---|---|
| Orange fire, the current look | 4.09 ms | 1.83 ms | 2026-11-15, load average 2.8–8 |
| Eye standing in fire (`camFire` ≈ 1) | 4.64 ms | 2.12 ms | same run |
| Coloured fire alive, over the same fire in orange | +0.38 ms | +0.36 ms | 2026-11-13, load 2.9–4.1; the sim side is +0.05–0.07 of it |
| Full rain against dry | ≈ 0 | +0.2–0.3 ms | 2026-11-14, load 22–60 (≈ 2× quiet) |
| A whirlpool; a tide line | ≈ 0; nothing new | ≈ 0; nothing new | same |
| The ending's pillar (≈ 15 % of the screen) | +1.5–1.6 ms | +1.1–1.3 ms | 2026-11-14, load 22–60, where the bench reads ≈ 2× its quiet numbers |
| The demon's fire (close) | ≤ +0.7 ms | ≤ +1.3 ms | same; only from its reveal to the fade to black |

The split by tier was last measured on 2026-11-13 (load ≈ 2.7), on an earlier look that cost ≈ 15 % less on high than
today's. It still shows the shape: medium costs ≈ 0.8× high and low ≈ 0.6×, and on high the sim alone is ≈ 1.1 ms.

| Tier | `smooth` total | sim only / pass only | `hybrid` total | sim only / pass only |
|---|---|---|---|---|
| high | 3.43 ms | 1.17 / 2.91 | 1.62 ms | 1.08 / 1.10 |
| medium | 2.67 ms | 0.72 / 2.37 | 1.25 ms | 0.74 / 0.99 |
| low | 2.03 ms | 0.43 / 1.44 | 0.93 ms | 0.42 / 0.68 |

("Sim only" steps the fire without drawing it; "pass only" draws a frozen fire. They overlap, so they do not add up
to the total.) The jet costs ≈ 0.1–0.2 ms; the embers are within noise.

**In the game** (2026-11-13, an earlier look, vsync off, `debug.lockStep` so each frame carries exactly one 60 Hz
sub-step, 1080p high, a staging with the Lance, two bursts and ≈ 170–650 goblins): `smooth` +1.6 ms (1.0–2.3), `hybrid`
+1.25 ms. CPU-side `stats()` in the game (2026-11-18, 1600×900, the Lance spraying, mean of 240 frames): `simMs` 0.69,
`renderMs` 0.08 (`smooth`), 0.68 / 0.07 (`hybrid`).

**GPU timer queries are not a cost measure on ANGLE/Metal.** With the fire off they still read 7.6–10.3 ms for its
render span (an empty clear plus one composite): they time queueing. The budget is judged by bench throughput.

**GPU memory** on high at 1080p is ≈ 22 MiB, computed from the target sizes (not measured): the scalar and hue fields
8 MiB, velocity, pressure, curl and divergence 3 MiB, the embers 0.5 MiB, both styles' volume targets ≈ 10 MiB.

## Measured fire behaviour

The game's CPU fire grid (`src/sim/fireproxy.js`) stands in for this fire whenever its grid is stale or missing, so its
constants are tuned against these numbers. Measured with the bench's `--experiments` (high, 60 Hz, no wind, the game's
op amounts; the summary read synchronously every 0.25 s). "Burning" means gameplay heat ≥ 0.22 (the game's catch
threshold) in a 1 m cell; areas are in m². Dry and rain 1 on 2026-11-14; out-times from 2026-11-13 (only the smoke yield
has changed since, which does not feed heat or fuel).

| Setup | Dry | Rain 1 |
|---|---|---|
| Lance, 1 s burst (stream ops 8 m out, r 0.9, push 7 m/s, 60 ticks) | 69 at 1 s (reaching ≈ 9 m beyond the landing point), peak 126 at 2 s, 29 at 4 s, 4 at 10 s, out at ≈ 11 s | 57 at 1 s, peak 76 at 2 s (× 0.6), 13 at 4 s, 8 at 10 s |
| Firebomb (burst r 3.5, push 6, plus fuel r 2.5 × 0.7) | peak 73 at 2–3 s (radius ≈ 4.8 m), out at 11.8 s | peak 45 at 1 s (× 0.44), 32 at 3–4 s, out at 14.3 s |
| Trough lit by one ember at its end | the fire runs along it at ≈ 2 m/s, the far end burns at 4 s, peak ≈ 47, out ≈ 20 s after lighting | far end at 6 s (front × 0.65), peak ≈ 27 |
| Oil pool (fuel r 2.5, one ember at its rim) | crosses 4.8 m in ≈ 2.25–3 s, peak 68, out at ≈ 17 s | crosses by 5 s, peak 42 (× 0.62) |
| Heat in front of a burning trough | 1.0 at 0–1 m, 0.46 at 1.5–2 m, 0.30–0.36 at 3 m, 0.15 at 4 m | 0.58–0.72 at 0.5–1 m, 0.08–0.10 at 1.5–2 m, 0 at 3 m |

So in full rain burning areas shrink to × 0.45–0.6 and fronts run × 0.6–0.65 as fast, and a burning trough sets goblins
alight only within ≈ 1 m of its rim (dry ≈ 3.5 m). The game's CPU grid models rain as decay × (1 + 1.2 rain), which is
close on areas; the reach in front of a trough is the number that differs most.

## Decisions

- **Half-float RGBA fields.** RGBA16F is filterable in WebGL2 and renderable with either colour-buffer extension. The
  summary and hue map are RGBA8 because they are read with `readPixels(RGBA, UNSIGNED_BYTE)`.
- **Gameplay heat is the cell's max, not its mean:** a 0.3 m strip of flame must still set a goblin in that 1 m cell
  alight.
- **Expansion as a divergence source.** A gradient force pushing outward would be projected away; a source in the
  divergence is kept. The whirlpool's inward pull uses the same trick.
- **`stick` on oil.** Without it a single burning goblin's ember never lit a trough: the expansion flow blew the young
  flame off the oil.
- **No MacCormack advection:** the vorticity and churn give the detail, and the extra pass did not pay for itself.
- **Jacobi 16 on high:** 24 looked the same and cost 0.2 ms more.
- **Short opaque tongues, not emissive curtains.** Emission = extinction, so the nearest tongue wins; summing emission
  along a ray drew vertical curtains.
- **The body stays ≤ 1.0 linear; only the hot core goes HDR.** Driving the whole fire × 4 into HDR made the game's
  Neutral tone map desaturate it to salmon.
- **Stable white-noise jitter.** There is no TAA in the look, so moving noise reads as shimmer; interleaved-gradient
  noise drew diagonal hatching. `hybrid` uses no jitter: its stepped ramp turns noise into speckle, and banding is
  on-style there.
- **The step count is the cost bound.** Dense smoke ends rays early (transmittance < 3 %); thin smoke does not, so the
  same scene costs more with thinner smoke (at 64 steps a thinner-smoke look measured 5.76 ms against 4.11 ms). The
  tiers therefore cap the steps (40 / 38 / 30), and the smoke's opacity is capped at 0.6 with the ray ending once that
  is reached, so the worst case stays inside the budget whatever the smoke looks like. A denser, taller smoke cost more
  and smothered the flames, so it was dropped.
- **Cuts that bought the current look:** the finer flame-layer steps only up to 0.22 + 0.03 t; the second tongue octave
  only within 22 m, the second smoke octave within 12 m, the moon self-shadow within 25 m; 40 steps on high. A wider,
  taller tongue shape cost about twice as much and was dropped.
- **Soft smoke in `hybrid`.** Quantised smoke became hard-edged dark shapes in the sky.
- **The rim boost is a narrow temperature band.** Boosting the smoke's glow from below as well painted a crimson haze
  up the walls. `wallFade` stops tall tongues painting red streaks up the stone.
- **The jet is CPU particles drawn into the volume target**, not another ray-marched field: it is near the camera,
  outside the slab on the wall walk, and must turn instantly with the aim.
- **The hue rides in S's second attachment at full resolution.** The hue mass must be advected by exactly the fire's
  samples to stay consistent. A separate smaller field would need its own advection with five more fetches; the MRT
  costs two fetches and one write in the existing pass.
- **Shader variants, not uniform branches, for the hue and the in-fire fade.** A uniform-guarded fetch cost as much as
  an unguarded one (the compiler flattens the guard). The march reads the 64² hue map, not the 512² hue field (that
  cost +0.5 ms), and the composite fetches the hue once per pixel, from the heaviest bilateral tap (four fetches cost
  +0.4 ms at 1080p).
- **Rain is CPU-side constants:** no shader cost.
- **The in-fire fade comes from a CPU uniform.** A first version probed the fire field per pixel in the shader
  (+0.1 ms in `smooth`); the uniform and the variant cost nothing while no one stands in fire.
- **Steam is light.** 22 puffs an op at alpha 0.5 summed to an opaque white dome, so it is 14 puffs at alpha 0.3 with a
  darker grey and a wispy noise mask.
- **The demon's fire frames the figure.** The first sheath was a wall of flame in front of it, and only the horns
  showed.
- **No hitch on a style switch.** Materials are cached per style and step count and never disposed on a switch; volume
  targets are kept per size and both styles' targets are allocated at the first frame of a size; `warm()` draws every
  variant once (see [What the game calls](#what-the-game-calls)).
- **The read-back is the only CPU ↔ GPU sync** and never stalls: see [the read-back](#the-read-back-and-the-gameplay-grid).

## Open issues

- **An uncapped loop starves the grid.** With no frame cap the GPU queue stays deep, no read can be cheap (Chrome's
  shadow-copy path is off here), so the grid never lands and the game plays on its CPU grid. A few reads at a 120 Hz
  cadence take 5–6 ms.
- **The look against the key art** (last compared 2026-11-15). The key art's white-yellow core covers 0.4–0.7 % of the
  frame and its crimson 4.7–9.7 %. In `hybrid` the core now reaches 0.56 %, but the crimson stays at 0.4–2.2 %, and
  `smooth` barely moved: the key art's crimson is a big swirling body of red flame, ours a thin edge round orange
  tongues. The art's fire is also a larger swirling mass with a tall charcoal plume.
- **`smooth` is a little grainy** (white-noise jitter at half resolution, no TAA), and a few small detached flame tips
  appear.
- **Some red filaments still stand in front of the tower edge**, more than `wallFade` (0.6 m) from it.
- **The whirlpool's spiral reads only once the fire thins**; over dense fire it is a curling mass with a darker eye.
- **The jet starts under the gun** (game side, unverified since 2026-11-15): the muzzle point the game passes projects
  to the middle of the drawn barrel, not the nozzle tip, and the viewmodel is drawn over the fire.
- **Coloured fire costs +0.36–0.38 ms while alive.** If that matters: read the hue once per ray (at the first flame
  sample) instead of per sample, and evaluate only the two dominant ramps in `smooth`.
- **The game's light patch** was run on Lambert, Standard, instanced Lambert and instanced Basic/Standard materials;
  Phong, Toon, Physical and `BatchedMesh` use the same chunks but were not run (unverified).
- **Arena geometry** (2026-11-13, unverified since): the east trough's last 2.2 m lies inside the SE tower's footprint
  and never burns.

## classic-webgpu

`modules/classic-webgpu/` is the same fire for the game's WebGPU edition (three.js `WebGPURenderer`, TSL). It imports
this module's knob objects (`KNOBS`, `DEPOSIT`, `RES`, `LIGHT_COLS`, `LOOK`, `HUE_RAMPS`, `JET`, `STEAM`,
`COLUMN_PRESETS`, `TIER`, the ember colours), so a bench that tunes `classic` tunes it too, and it subclasses this
module's CPU code (the op → splat mapping, `Jet`, `Steam`, `Columns`, the obstacle mask, the world store). Every GLSL
shader has a TSL twin with the same arithmetic in the same order. What differs, from its code and
[its README](../classic-webgpu/README.md):

- **Embers** live in a storage buffer updated by one compute dispatch, drawn as instanced quads. Each slot keeps the id
  it would have had as a texel of the 128-wide texture, so the hash seeds spawn the same way. Storage is float32, so
  the hue is always kept.
- **Points** (embers, column sparks) and billboards are instanced quads (WebGPU points are one pixel wide).
- **Orientation:** WebGPU targets are stored top-down. Every field keeps uv.y along +z, so the light map and the
  read-back line up with the world unchanged. Screen passes count from the top of the frame, so the hybrid pixel snap
  and the Bayer cells do too, and the dither pattern is mirrored vertically.
- **MRT clears:** three's WebGPU clear sets every attachment after the first to (0, 0, 0, 1), so the webgpu kit's
  `clearTargets` fills such targets with a pass instead.
- **The read-back** uses `readRenderTargetPixelsAsync` (`mapAsync` underneath). It never waits and never drops a read
  (`maxLag` Infinity); a grid lands one or more frames after its kick.
- **Terrain:** `host.world.groundTSL`; without it the module assumes flat ground at y = 0.
- **Not there:** GPU timing (`gpuSimMs`/`gpuRenderMs` are null), `makeFireVortexMaterial()`, `?rbmode=lagN`.
- **Needs** a `WebGPURenderer` on its WebGPU backend: `create()` throws on `WebGLRenderer` or on three's WebGL2
  fallback backend.
- **Measured** (2026-11-18, the game, headless Chrome, 1600×900, the Lance spraying, CPU-side `stats()`, mean of 240
  frames): `simMs` 0.94, `renderMs` 0.15 (`classic`: 0.69 / 0.08). Its gameplay grid correlates 0.744 with the game's
  CPU grid (`classic`: 0.75).

## Running, testing and the bench

**Tests** (this repo, Node, no GPU): `npm test`. They check the API validators, that `classic` and `classic-webgpu`
load and import nothing from the game, that the world's ground GLSL reaches the shaders, and the webgpu read-back. The
look and the cost are checked in the game and its bench.

**In the game** (`../Valleyward`):

```bash
cd ../Valleyward && npm ci && npm run dev
# http://127.0.0.1:5350/?ground=classic&lance=classic
#   &fluidDebug=1   the ground module on window.__ewFluid (stats(), debug)
#   &debug=1        __ew.fireCompare(): how well the module's grid and the game's CPU grid agree
#   &rbmode=off     no read-back (the CPU grid decides); &rbmode=lag2: another read-back gate
```

**The bench** (`preview/fluid.html` in the game repo) runs `classic` through the game's fire host with its own minimal
render path (scene → half-float target with a depth texture → the fire → a cheap bloom → ACES → screen), which stands in
for the game's look. Automation hooks are on `window.__fluidBench`.

```bash
cd ../Valleyward
npx vite --config vite.config.js --port 5353 --strictPort
#   http://127.0.0.1:5353/preview/fluid.html   ?fire=hybrid ?quality=medium ?view=m2 ?debug=1 ?noui=1 ?timing=1
#   ?scenario=m1&t=4   a scripted fire, advanced 4 s, then live
# production build for perf numbers (any scratch directory outside the repo):
npx vite build --config preview/fluid.vite.config.js --outDir <scratch> --emptyOutDir
npx vite preview --config preview/fluid.vite.config.js --outDir <scratch> --port 5353 --strictPort
# captures, perf per tier and style, fire-behaviour experiments (one headless Chrome, under the GPU lock):
tools/gpu-lock.sh node preview/fluid.capture.mjs --out <dir> \
  --shots m1:smooth,m1:hybrid,m2:smooth,m2:hybrid --perf --prof --experiments --variants '[null,{"rain":1}]'
```

- **Controls:** hold the mouse to spray the Lance at the cursor's ground point; **B** firebomb; **V** violet nova;
  **O** blue orbit embers; **M** green meteor; **L** lilac trail (all at the cursor); **W** the green Witchfire Lance;
  **T** fill and light the troughs; **E** burning goblins on/off; **U** a bucket douse at the cursor; **D** douse
  everything; **R** rain 0 / 0.5 / 1; **K** a tide line; **Y** a whirlpool; **X** the pillar; **Z** the demon's fire;
  **S** smooth / hybrid; **1/2/3** quality; **C** cycle the cameras (`m1`, `m2`, `m2b` over the parapet, `top`, `end`,
  `demon`); **F** fire on/off; **G** the read-back grid (R heat, G fire, B fuel; north up); **P** pause; sliders for
  the wind's speed and direction. The HUD shows the frame time, the `stats()` fields and the light at the camera.
- **Scenarios** (`?scenario=`): `m1`, `m2` (the key-art framings), `busy` (the perf scene), `pair_<hue>_<m1|m2>` (the
  same source in orange and in a hue side by side), `hues_m1`, `witch_m1`, `douse_m1`, `m1rain` / `m1dry`, `tide_m1`,
  `whirl_m1`, `pillar_end`.
- **`--perf`** measures each tier and style in `busy` (on, off, sim only, pass only; `--prof` adds the march, jet and
  embers skipped). **`--experiments`** runs `lance1s`, `firebomb`, `trough`, `pool` and `edge` and reports the burning
  area over time; `--variants` reruns them with knob overrides such as rain.
- **A/B comparisons** of two builds: serve each production build, run `--perf` on one page at a time, and interleave the
  runs. Compare only within a run when the machine is busy: at a load average above ≈ 8 every number roughly doubles.
