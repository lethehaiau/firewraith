// FIREWRAITH · the module catalog: every fire module a host can list. A module lives in `modules/<id>/` and joins the
// catalog with one entry below (see CONTRIBUTING.md). `info` is the module's light self-description (no three.js);
// `load()` imports its code only when a game picks it, so a host can list every module without paying for them.
import { info as classic } from './classic/info.js';
import { info as classicWebgpu } from './classic-webgpu/info.js';
import { info as curvedVolume } from './lance-curved-volume/info.js';

/** @param {import('../src/api/index.js').ModuleInfo} info @param {() => Promise<any>} load */
const entry = (info, load) => Object.freeze({ info, load });

/** id → { info, load }. Keys must equal `info.id` and the folder name (the checks in tests/modules.test.mjs enforce it). */
export const MODULES = Object.freeze({
  classic: entry(classic, () => import('./classic/index.js')),
  'classic-webgpu': entry(classicWebgpu, () => import('./classic-webgpu/index.js')),
  'lance-curved-volume': entry(curvedVolume, () => import('./lance-curved-volume/index.js')),
});
