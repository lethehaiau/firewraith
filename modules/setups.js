// FIREWRAITH · the setups: whole fires a game can offer in its picker, one catalog module per slot. A module without a
// setup still plays alone: the game puts it in the slots it fills and the edition's reference module in the others. Add
// a setup to choose those partners yourself, or to offer a named combination of modules. A key is a setup id. It may be
// the id of a module in the setup, which then replaces that module's default setup; any other key must not be a module
// id. tests/setups.test.mjs checks every entry against the catalog (see docs/API.md, "Setups").

/** @param {import('../src/api/index.js').Setup} s */
const setup = (s) => Object.freeze({ ...s, slots: Object.freeze({ ...s.slots }) });

/** id → { name, backend, slots: { lance, ground }, description? } */
export const SETUPS = Object.freeze({
  'lance-curved-volume': setup({
    name: 'Curved Volume Lance', backend: 'webgl2',
    slots: { lance: 'lance-curved-volume', ground: 'classic' },
    description: 'The Curved Volume Lance over the classic ground fire.',
  }),
});
