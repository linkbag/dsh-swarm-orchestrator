import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toolchain = () => ({ node: process.version, typescript: require('typescript/package.json').version, esbuild: require('esbuild/package.json').version });
function tree(root, name, accept) {
  const records = {};
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('build inputs/outputs must not contain symlinks: ' + file);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && accept(file)) records[relative(root, file).replaceAll('\\', '/')] = digest(readFileSync(file));
    }
  };
  visit(join(root, name));
  return records;
}
export function collectBuildInputs(root) {
  const records = { ...tree(root, 'src', (p) => p.endsWith('.ts')), ...tree(root, 'client', (p) => /\.(?:ts|tsx|css)$/.test(p)), ...tree(root, 'scripts', (p) => /\.(?:mjs|mts)$/.test(p)) };
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (existsSync(join(root, file))) records[file] = digest(readFileSync(join(root, file)));
  }
  return Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
}
export function collectBuildOutputs(root) {
  return tree(root, 'lib', (p) => /\.(?:js|ts|map)$/.test(p));
}
export function makeBuildReceipt(root, scope) {
  if (scope !== 'full' && scope !== 'client-only') throw new Error('invalid build scope');
  return { version: 1, scope, toolchain: toolchain(), inputs: collectBuildInputs(root), outputs: collectBuildOutputs(root) };
}
export function validateBuildReceipt(root, receipt) {
  const issues = [];
  if (receipt?.version !== 1 || receipt.scope !== 'full') issues.push('full host/client build receipt required');
  if (JSON.stringify(receipt?.toolchain) !== JSON.stringify(toolchain())) issues.push('toolchain changed');
  const compare = (label, expected, actual) => {
    const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) if (expected?.[key] !== actual[key]) issues.push(label + ' changed: ' + key);
  };
  compare('input', receipt?.inputs, collectBuildInputs(root));
  compare('output', receipt?.outputs, collectBuildOutputs(root));
  if (!receipt?.outputs?.['lib/client.js'] || !receipt?.outputs?.['lib/index.js']) issues.push('host or client output missing');
  return issues;
}
