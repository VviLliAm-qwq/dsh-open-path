import { describe, expect, it, vi } from 'vitest';
import { guessBareUrl, runOpenCommand, type OpenDialogLike } from '../src/open.js';
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', spawn: async () => true },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async () => true },
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
                { cwd: ws.root, platform: 'win32', spawn: async () => true },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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
                { cwd: ws.root, platform: 'win32', spawn: async () => false },
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
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, spawn: async (spec) => { h.spawns.push(spec); return true; } },
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

describe('runOpenCommand / URL support', () => {
    it('opens an http URL with the default handler, skipping the workspace scan', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        const scanSpy = vi.fn(async () => []);
        try {
            const result = await runOpenCommand(
                'https://example.com/docs?page=1',
                {
                    cwd: ws.root,
                    spawn: async (spec) => { spawns.push(spec); return true; },
                    scan: scanSpy,
                },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(result.text ?? '').toContain('https://example.com/docs?page=1');
            expect(scanSpy).not.toHaveBeenCalled();
            expect(spawns).toHaveLength(1);
            expect(spawns[0].args.join(' ')).toContain('https://example.com/docs?page=1');
            // URL goes through the non-directory channel (Windows: start)
            expect(spawns[0].file).toBe(process.env.ComSpec || 'cmd.exe');
        }
        finally {
            ws.cleanup();
        }
    });

    it('detects http URLs case-insensitively', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'HTTP://EXAMPLE.COM',
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain('HTTP://EXAMPLE.COM');
        }
        finally {
            ws.cleanup();
        }
    });

    it('rejects non-http(s) schemes instead of handing them to the OS', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'file:///C:/Windows/temp.txt', 'mailto:a@b.c']) {
            const result = await runOpenCommand(
                bad,
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('http');
        }
        expect(spawns).toHaveLength(0); // nothing reached the OS
        ws.cleanup();
    });
});

describe('guessBareUrl', () => {
    it('prepends https:// to a bare domain', () => {
        expect(guessBareUrl('github.com')).toBe('https://github.com');
        expect(guessBareUrl('www.example.com/path/page?q=1')).toBe('https://www.example.com/path/page?q=1');
        expect(guessBareUrl('sub.domain.co.uk:8443')).toBe('https://sub.domain.co.uk:8443');
        expect(guessBareUrl('WWW.GitHub.COM')).toBe('https://WWW.GitHub.COM');
    });

    it('prepends http:// to localhost and IPv4 literals', () => {
        expect(guessBareUrl('localhost:5173')).toBe('http://localhost:5173');
        expect(guessBareUrl('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
        expect(guessBareUrl('192.168.1.5')).toBe('http://192.168.1.5');
    });

    it('leaves file names and version-like tokens alone', () => {
        expect(guessBareUrl('readme.md')).toBeNull();
        expect(guessBareUrl('index.ts')).toBeNull();
        expect(guessBareUrl('v2.0.1')).toBeNull();
        expect(guessBareUrl('2024.12.31')).toBeNull(); // year segments > 255 → not an IP
        expect(guessBareUrl('a.b')).toBeNull(); // 1-char TLD
        expect(guessBareUrl('src/index.ts')).toBeNull(); // path-shaped
    });
});

describe('runOpenCommand / bare URL support', () => {
    it('opens a protocol-less domain with https://, skipping the scan', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        const scanSpy = vi.fn(async () => []);
        try {
            const result = await runOpenCommand(
                'github.com',
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; }, scan: scanSpy },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(result.text ?? '').toContain('https://github.com');
            expect(scanSpy).not.toHaveBeenCalled();
            expect(spawns[0].args.join(' ')).toContain('https://github.com');
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens localhost with http://', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'localhost:5173',
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain('http://localhost:5173');
        }
        finally {
            ws.cleanup();
        }
    });

    it('prefers a real workspace file over the same-named URL guess', async () => {
        const ws = makeWorkspace();
        writeFileSync(join(ws.root, 'github.com'), 'hosts file');
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'github.com',
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain('github.com');
            expect(spawns[0].args.join(' ')).not.toContain('https://');
        }
        finally {
            ws.cleanup();
        }
    });

    it('keeps opening file names with common extensions (readme.md → workspace file)', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'readme.md',
                { cwd: ws.root, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain('readme.md');
            expect(spawns[0].args.join(' ')).not.toContain('https://');
        }
        finally {
            ws.cleanup();
        }
    });
});
