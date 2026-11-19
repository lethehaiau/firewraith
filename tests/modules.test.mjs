// The checks every module in the catalog must pass. They run for each module folder, so a new module is checked the
// moment it is listed (and an unlisted folder fails the catalog check). See CONTRIBUTING.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../modules/catalog.js';
import { checkInfo } from '../src/api/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'modules');
const MAX_FOLDER_BYTES = 512 * 1024;   // a module's whole folder, docs included
const BARE_OK = new Set(['three', 'three/webgpu', 'three/tsl']);

const folders = fs.readdirSync(MODS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const filesOf = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? filesOf(path.join(dir, d.name)) : [path.join(dir, d.name)]));
// code with its comments removed (a // inside a string may cut a line short: fine for these checks)
const codeOf = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// What a module may not do (Fire API rule 4 and the review policy): reach the network, run strings as code, store
// data, read cookies, navigate, or start other threads. A module that needs one of these must ask first (see CONTRIBUTING.md).
const FORBIDDEN = [
  [/\bfetch\s*\(/, 'network: fetch()'],
  [/\bXMLHttpRequest\b/, 'network: XMLHttpRequest'],
  [/\bWebSocket\b/, 'network: WebSocket'],
  [/\bEventSource\b/, 'network: EventSource'],
  [/\bsendBeacon\b/, 'network: navigator.sendBeacon'],
  [/\bimportScripts\b/, 'network: importScripts'],
  [/\bimport\s*\(\s*(?!['"]\.{1,2}\/)/, 'dynamic import() of anything but a relative path'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b|(?<![\w.])Function\s*\(/, 'new Function()'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'storage'],
  [/\bdocument\.cookie\b|\bcookieStore\b/, 'cookies'],
  [/\bdocument\.write\b|\bwindow\.open\s*\(|\blocation\.(assign|replace)\s*\(|\blocation\.href\s*=/, 'navigation or page writes'],
  [/\bnew\s+(Shared)?Worker\s*\(/, 'workers'],
];

test('the catalog lists exactly the module folders, each under its own id', () => {
  assert.deepEqual(Object.keys(MODULES).sort(), folders, 'every folder in modules/ needs one catalog entry, and every entry a folder');
  for (const [id, m] of Object.entries(MODULES)) {
    assert.equal(m.info.id, id, `${id}: the catalog key must equal info.id`);
    assert.equal(typeof m.load, 'function', `${id}: load() is missing`);
  }
});

for (const id of folders) {
  const dir = path.join(MODS, id);
  const files = filesOf(dir);
  const js = files.filter((f) => /\.m?js$/.test(f));

  test(`${id}: has index.js, info.js and README.md, and a valid info`, async () => {
    for (const f of ['index.js', 'info.js', 'README.md']) assert.ok(fs.existsSync(path.join(dir, f)), `${id}: ${f} is missing`);
    const { info } = await import(path.join(dir, 'info.js'));
    assert.deepEqual(checkInfo(info), [], `${id}: info problems`);
    assert.equal(info.id, id, `${id}: info.id must equal the folder name`);
  });

  test(`${id}: loads, exports create() and the same info`, async () => {
    const mod = await MODULES[id].load();
    const { info } = await import(path.join(dir, 'info.js'));
    assert.equal(typeof mod.create, 'function', `${id}: index.js must export create(host)`);
    assert.equal(mod.info, info, `${id}: index.js must re-export the info from info.js`);
  });

  test(`${id}: imports stay inside the package (three, three/webgpu, three/tsl or relative paths)`, () => {
    for (const f of js) {
      for (const [, spec] of codeOf(f).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
        if (BARE_OK.has(spec)) continue;
        assert.ok(spec.startsWith('.'), `${path.relative(ROOT, f)} imports "${spec}"`);
        const target = path.resolve(path.dirname(f), spec);
        assert.ok(target.startsWith(ROOT + path.sep) && !target.includes(`${path.sep}node_modules${path.sep}`),
          `${path.relative(ROOT, f)} reaches outside the package: "${spec}"`);
      }
    }
  });

  test(`${id}: no network, eval, storage, cookies, navigation or workers`, () => {
    const found = [];
    for (const f of js) {
      const code = codeOf(f);
      for (const [re, what] of FORBIDDEN) if (re.test(code)) found.push(`${path.relative(ROOT, f)}: ${what}`);
    }
    assert.deepEqual(found, []);
  });

  test(`${id}: the folder stays under ${MAX_FOLDER_BYTES / 1024} KB`, () => {
    const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    assert.ok(bytes <= MAX_FOLDER_BYTES, `${id}: ${Math.round(bytes / 1024)} KB`);
  });
}
