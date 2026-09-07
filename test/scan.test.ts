import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace } from '../src/scan.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
});

function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-open-path-scan-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'a.txt'), '');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.md'), '');
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'node_modules', 'pkg'));
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), '');
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden', 'c.txt'), '');
    mkdirSync(join(root, 'deep'));
    for (let depth = 1; depth <= 7; depth += 1) {
        mkdirSync(join(root, 'deep', ...Array.from({ length: depth }, (_, i) => String(i + 1))));
    }
    writeFileSync(join(root, 'deep', '1', '2', '3', '4', '5', '6', '7.txt'), '');
    return root;
}

describe('scanWorkspace', () => {
    it('collects files and dirs while skipping node_modules and hidden paths', async () => {
        const root = makeTree();
        const entries = await scanWorkspace(root);
        const rel = entries.map((entry) => entry.relPath);
        expect(rel).toContain('a.txt');
        expect(rel).toContain('sub/b.md');
        expect(rel.some((path) => path.startsWith('node_modules'))).toBe(false);
        expect(rel.some((path) => path.startsWith('.hidden'))).toBe(false);
    });

    it('honours includeHidden', async () => {
        const root = makeTree();
        const entries = await scanWorkspace(root, { maxDepth: 6, maxEntries: 20000, includeHidden: true });
        expect(entries.map((entry) => entry.relPath)).toContain('.hidden/c.txt');
    });

    it('caps total entries at maxEntries', async () => {
        const root = makeTree();
        const entries = await scanWorkspace(root, { maxDepth: 6, maxEntries: 3, includeHidden: false });
        expect(entries.length).toBeLessThanOrEqual(3);
    });

    it('does not walk deeper than maxDepth (7.txt is 7 levels below root)', async () => {
        const root = makeTree();
        const entries = await scanWorkspace(root);
        expect(entries.map((entry) => entry.relPath)).not.toContain('deep/1/2/3/4/5/6/7.txt');
        // the depth-6 directory itself is still collected
        expect(entries.map((entry) => entry.relPath)).toContain('deep/1/2/3/4/5/6');
    });

    it('stops promptly on an aborted signal and returns what it had', async () => {
        const root = makeTree();
        const controller = new AbortController();
        controller.abort();
        const entries = await scanWorkspace(root, { maxDepth: 6, maxEntries: 20000, includeHidden: false }, controller.signal);
        expect(Array.isArray(entries)).toBe(true);
    });

    it('skips a vanished workspace without throwing', async () => {
        const entries = await scanWorkspace(join(tmpdir(), 'dsh-open-path-ghost-' + Date.now()));
        expect(entries).toEqual([]);
    });
});
