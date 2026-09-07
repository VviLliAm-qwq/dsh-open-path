#!/usr/bin/env node
/**
 * Manifest sanity check for dsh-open-path.
 *
 * Mirrors the admission-driven checks a host would run (TUI-PKG-001 /
 * TUI-PKG-002) without depending on @dsh-std/manifest: the plugin must parse,
 * declare the Command contract, declare the commands.invoke permission for
 * the contributed command id, and keep a v0.15 shape. Exit 1 with a reason on
 * failure; never writes anything.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'dsh-plugin.json');

let failures = [];
const fail = (message) => failures.push(message);

let manifest;
try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
}
catch (error) {
    console.error(`❌ dsh-plugin.json is not valid JSON: ${error.message}`);
    process.exit(1);
}

// A. Identity
if (manifest.$schema !== 'https://dsh.community/schemas/dsh-plugin-0.15.json') {
    fail('$schema must be the absolute dsh-plugin-0.15.json URI');
}
if (manifest.manifestVersion !== '0.15') fail('manifestVersion must be 0.15');
if (typeof manifest.id !== 'string' || !manifest.id.includes('.') || manifest.id.length < 8) {
    fail('plugin id must be a stable reverse-DNS string');
}
if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) fail('version must be semver');

// B. Facet
const host = manifest.facets?.host;
if (!host || typeof host.entry !== 'string' || host.apiVersion !== 'v1alpha1') {
    fail('facets.host must declare entry + apiVersion "v1alpha1"');
}
if (manifest.facets?.client || manifest.facets?.worker) {
    fail('client/worker facets are not allowed in v0.15');
}

// C. Contract: commands.dsh/v1alpha1#Command
const contracts = manifest.requires?.contracts ?? [];
const commandContract = contracts.find(
    (c) => c?.apiVersion === 'commands.dsh/v1alpha1' && c?.kind === 'Command',
);
if (!commandContract) fail('requires.contracts must include { apiVersion: "commands.dsh/v1alpha1", kind: "Command" }');
if (contracts.some((c) => typeof c !== 'object' || c === null)) fail('requires.contracts entries must be objects');
if (manifest.requires?.services) fail('requires.services must not be declared (v0.15)');
if (manifest.provides) fail('provides must not be declared (v0.15)');

// D. Permission + contribution consistency
const contributions = manifest.contributes?.commands ?? [];
if (!Array.isArray(contributions) || contributions.length !== 1) {
    fail('contributes.commands must declare exactly the /open command');
}
const contribution = contributions[0];
if (contribution.id === 'com.dsh-tui-ecosystem.dsh-open-path.open' && contribution.title !== '/open') {
    fail('contributed command title must be "/open"');
}
const granted = (manifest.permissions ?? []).some(
    (p) => p?.name === 'commands.invoke' && p?.scope === contribution?.id,
);
if (!granted) fail(`permissions must grant commands.invoke for scope ${contribution?.id}`);

// E. License
if (manifest.license !== 'MIT') fail('license must be MIT');

if (failures.length > 0) {
    for (const failure of failures) console.error(`❌ ${failure}`);
    process.exit(1);
}
console.log('✅ dsh-plugin.json looks valid (id=%s, version=%s)', manifest.id, manifest.version);
