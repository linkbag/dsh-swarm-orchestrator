import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBuildReceipt } from './build-receipt.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const receipt = JSON.parse(readFileSync(join(root, 'lib/build-receipt.json'), 'utf8'));
const issues = validateBuildReceipt(root, receipt);
assert.deepEqual(issues, [], 'stale or incomplete host/client build: ' + issues.join('; '));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plugin = await import(pathToFileURL(join(root, 'lib/index.js')).href);
assert.equal(plugin.name, manifest.name);
assert.equal(plugin.PLUGIN_VERSION, manifest.version);
for (const name of ['WorkItemCoordinator', 'EventWorkItemCheckpoints', 'RequestLedger', 'createWorkItemManifest']) assert.equal(typeof plugin[name], 'function', name);
assert.equal(plugin.HARDENING_CAPABILITIES.strictIsolation, false);
assert.equal(plugin.HARDENING_CAPABILITIES.hardBudgets, false);
const { registerSwarmTools } = await import(pathToFileURL(join(root, 'lib/tools/index.js')).href);
const definitions = [];
// Compile native tool definitions only: never construct/apply a Host, execute a
// tool, launch a child, or touch a profile or research store.
registerSwarmTools({ get: () => ({ register: (tool) => { definitions.push(tool); return () => {}; } }) }, {});
assert.equal(definitions.length, 7);
assert.equal(new Set(definitions.map((tool) => tool.name)).size, 7);
console.log(JSON.stringify({ verification: 'full content receipt + compiled import/export + native tool registration (not live Host validation)', version: manifest.version, inputs: Object.keys(receipt.inputs).length, outputs: Object.keys(receipt.outputs).length, tools: definitions.length, schemaCharacters: JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))).length }, null, 2));
