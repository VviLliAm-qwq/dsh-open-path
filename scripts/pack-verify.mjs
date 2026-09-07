#!/usr/bin/env node
/**
 * Pack verification for dsh-open-path.
 *
 * Simulates what npm would publish: every entry of package.json `files` must
 * exist, the artifact must carry the runtime entry (lib/index.js), the
 * manifest, the bundle patch, the README, and the license; source, tests and
 * scripts must NOT leak into the artifact. Exit 1 on failure; read-only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];
const fail = (message) => failures.push(message);

const files = pkg.files ?? [];
for (const entry of files) {
    if (['lib', 'dsh-plugin.json', 'cordis.patch.yml', 'README.md', 'LICENSE'].includes(entry)) continue;
    if (!existsSync(join(root, entry))) fail(`files entry missing from disk: ${entry}`);
}

for (const required of ['lib/index.js', 'lib/index.d.ts', 'dsh-plugin.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (!existsSync(join(root, required))) fail(`artifact must contain: ${required}`);
}
for (const leaked of ['src', 'test', 'scripts', 'tsconfig.json', 'node_modules']) {
    if (files.includes(leaked)) fail(`source/test/scripts must not be published (blocked: ${leaked})`);
}
if (pkg.main !== 'lib/index.js') fail('main must be lib/index.js');
if (pkg.type !== 'module') fail('package must be ESM (type: module)');

if (failures.length > 0) {
    for (const failure of failures) console.error(`❌ ${failure}`);
    process.exit(1);
}
console.log('✅ pack layout verifies: lib + manifest + patch + docs only');
