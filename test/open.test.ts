import { describe, expect, it, vi } from 'vitest';
import { runOpenCommand, type OpenDialogLike } from '../src/open.js';
import type { SpawnSpec } from '../src/win32.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build a real temp workspace with a small tree, cleaned up after the test. */
function makeWorkspace(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-open-path-test-'));
    writeFileSync(join(root, 'a.txt'), 'a');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), '');
    writeFileSync(join(root, 'src', 'main.ts'), '');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'readme.md'), '');
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'a.test.ts'), '');
    writeFileSync(join(root, 'tests', 'b.test.ts'), '');
    return {
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

const DEFAULT_OPTIONS = { maxCandidates: 10, includeHidden: false };

interface Harness {
    spawns: SpawnSpec[];
    dialog: OpenDialogLike & { select: ReturnType<typeof vi.fn> };
}

function makeHarness(): Harness {
    const spawns: SpawnSpec[] = [];
    const dialog: Harness['dialog'] = {
        select: vi.fn(async () => undefined),
    };
    return { spawns, dialog };
}

describe('runOpenCommand', () => {
    it('bare /open opens the session working directory as a folder', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                '',
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.spawns).toHaveLength(1);
            expect(h.spawns[0].file).toBe('powershell.exe'); // dir → COM channel
            expect(h.spawns[0].args.join(' ')).toContain(ws.root);
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens an existing relative path as a file, without asking', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                'src/index.ts',
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.dialog.select).not.toHaveBeenCalled();
            expect(h.spawns).toHaveLength(1);
            expect(h.spawns[0].args.join(' ')).toContain('start');
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens an absolute directory path directly', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                ws.root,
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.spawns[0].file).toBe('powershell.exe');
        }
        finally {
            ws.cleanup();
        }
    });

    it('reports an error when nothing matches', async () => {
        const ws = makeWorkspace();
        try {
            const result = await runOpenCommand(
                '完全不存在的名字xyz',
                { cwd: ws.root, spawn: async () => true },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('找不到');
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens the single fuzzy match without a dialog', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                'readme', // matches docs/readme.md only
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.dialog.select).not.toHaveBeenCalled();
            expect(h.spawns[0].args.join(' ')).toContain('readme.md');
        }
        finally {
            ws.cleanup();
        }
    });

    it('shows the select dialog for multiple matches and opens the pick', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        h.dialog.select.mockResolvedValueOnce('tests/b.test.ts');
        try {
            const result = await runOpenCommand(
                'test',
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.dialog.select).toHaveBeenCalledTimes(1);
            const call = h.dialog.select.mock.calls[0][0] as { options: Array<{ id: string }> };
            expect(call.options.length).toBeGreaterThanOrEqual(2);
            expect(h.spawns[0].args.join(' ')).toContain('b.test.ts');
        }
        finally {
            ws.cleanup();
        }
    });

    it('stays quiet (success, no text) when the dialog is cancelled', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        h.dialog.select.mockResolvedValueOnce(undefined);
        try {
            const result = await runOpenCommand(
                'test',
                { cwd: ws.root, dialogs: h.dialog, spawn: async () => true },
                DEFAULT_OPTIONS,
            );
            expect(result).toEqual({ kind: 'success' });
        }
        finally {
            ws.cleanup();
        }
    });

    it('degrades to an error listing candidates when no dialog service exists', async () => {
        const ws = makeWorkspace();
        try {
            const result = await runOpenCommand(
                'test',
                { cwd: ws.root, spawn: async () => true },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('没有对话框');
            expect(result.text ?? '').toContain('候选');
        }
        finally {
            ws.cleanup();
        }
    });

    it('errors clearly when the platform has no graphical session', async () => {
        const ws = makeWorkspace();
        try {
            const result = await runOpenCommand(
                '',
                { cwd: ws.root, platform: 'linux' },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('图形会话');
        }
        finally {
            ws.cleanup();
        }
    });

    it('falls back to fuzzy search when a path-shaped input does not exist', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                'src/readme.md', // does not exist — fuzzy matches docs/readme.md alone
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(h.dialog.select).not.toHaveBeenCalled(); // unique hit opens directly
            expect(h.spawns).toHaveLength(1);
            expect(h.spawns[0].args.join(' ')).toContain('readme.md');
        }
        finally {
            ws.cleanup();
        }
    });

    it('reports an open failure as an error result', async () => {
        const ws = makeWorkspace();
        try {
            const result = await runOpenCommand(
                '',
                { cwd: ws.root, spawn: async () => false },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('无法打开');
        }
        finally {
            ws.cleanup();
        }
    });

    it('respects maxCandidates: an over-limit fuzzy result opens the best match directly', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        try {
            const result = await runOpenCommand(
                'test',
                { cwd: ws.root, dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
                { maxCandidates: 1, includeHidden: false },
            );
            expect(result.kind).toBe('success');
            expect(h.dialog.select).not.toHaveBeenCalled();
            expect(h.spawns).toHaveLength(1);
        }
        finally {
            ws.cleanup();
        }
    });
});
