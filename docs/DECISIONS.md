# Decisions

The full record, with its rationale, is in the game repo:
`Valleyward/docs/decisions/0001-fire-modules-and-two-editions.md`. The parts that shape this repo:

1. **Two repos.**
   - `valleyward` is the game, hosted by us.
   - `firewraith` holds the API, the kit, the reference modules and the author docs.

   Community modules live in their authors' repos.
2. **Slots.**
   - v1 has `lance` (the Ember Lance's airborne flame, the smallest and purely visual slot) and `ground` (the fire on
     the ground).
   - A module fills one or both.
   - `classic` fills both, or either alone.
3. **Modules may decide gameplay.** The game is for fun and a playground, and balance is not a concern. So a `ground`
   module may provide the gameplay grid.
   - The game's CPU fire grid always runs beside it, as the fallback while the module's grid is missing or stale.
   - The Lance's airborne damage stays on the game's own ballistic arc.
4. **The host owns the hard plumbing.** Loading, fallback (to `classic`), the world light, and the CPU grid are the
   game's job. The kit gives authors the GPU helpers, including a read-back that never stalls.
5. **One game, two editions.**
   - The game has two shading layers: WebGL2 (`WebGLRenderer` + GLSL) and WebGPU (`WebGPURenderer` + TSL / WGSL).
   - It boots in the edition of the chosen module's `backend`, so every module runs natively. There is no bridge
     between graphics APIs.
   - Considered and rejected:
     - a WebGL2-only game with a WebGPU bridge (copies, lag);
     - a single `WebGPURenderer` layer (GLSL modules could never run natively);
     - two game repos (the sim and the assets would fork).
6. **Vocabulary.**
   - "fire module", not "engine" (which clashes with "game engine") and not "algo".
   - "method" is whatever a module does inside.
