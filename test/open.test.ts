import { describe, expect, it, vi } from 'vitest';
import { expandTilde, guessBareUrl, runOpenCommand, type OpenDialogLike } from '../src/open.js';
import type { SpawnSpec } from '../src/win32.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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

/** The plugin's shipped defaults: `maxCandidates: 0` = unlimited candidates. */
const DEFAULT_OPTIONS = { maxCandidates: 0, includeHidden: false };

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

    /** A synthetic scan result: `count` entries that all match the query. */
    function syntheticEntries(root: string, count: number): Array<{ relPath: string; absPath: string; isDir: boolean; basename: string }> {
        return Array.from({ length: count }, (_, index) => {
            const name = `item-${String(index).padStart(3, '0')}.ts`;
            return { relPath: `src/${name}`, absPath: join(root, 'src', name), isDir: false, basename: name };
        });
    }

    it('offers every match to the dialog — the default is unlimited, not ten', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        const entries = syntheticEntries(ws.root, 30);
        try {
            await runOpenCommand(
                'item',
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, scan: async () => entries, spawn: async () => true },
                DEFAULT_OPTIONS,
            );
            const call = h.dialog.select.mock.calls[0][0] as { title: string; options: Array<{ id: string }> };
            expect(call.options).toHaveLength(30); // all of them, not the old cap of 10
            expect(call.options[0].id).toBe('src/item-000.ts');
            expect(call.title).toContain('30');
        }
        finally {
            ws.cleanup();
        }
    });

    it('caps the request at the host option ceiling and reports the drop in the title', async () => {
        const ws = makeWorkspace();
        const h = makeHarness();
        const entries = syntheticEntries(ws.root, 150);
        try {
            await runOpenCommand(
                'item',
                { cwd: ws.root, platform: 'win32', dialogs: h.dialog, scan: async () => entries, spawn: async () => true },
                DEFAULT_OPTIONS,
            );
            const call = h.dialog.select.mock.calls[0][0] as { title: string; options: Array<{ id: string }> };
            // The host keeps the first 100 of a select request — never overshoot.
            expect(call.options).toHaveLength(100);
            // …and the title must not pretend the other 50 do not exist.
            expect(call.title).toContain('150');
            expect(call.title).toContain('100');
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
            // The env is injected: asking the real process.env made this test
            // pass on a headless CI box and fail on any Linux desktop or WSL
            // machine that happens to run the suite with DISPLAY set.
            const result = await runOpenCommand(
                '',
                { cwd: ws.root, platform: 'linux', env: {}, release: '6.8.0-45-generic' },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('图形会话');
        }
        finally {
            ws.cleanup();
        }
    });

    it('reports a vanished working directory instead of a fake success', async () => {
        const ghost = join(tmpdir(), 'dsh-open-path-ghost-' + Date.now());
        const spawns: SpawnSpec[] = [];
        const result = await runOpenCommand(
            '',
            { cwd: ghost, platform: 'win32', spawn: async (spec) => { spawns.push(spec); return true; } },
            DEFAULT_OPTIONS,
        );
        expect(result.kind).toBe('error');
        expect(result.text ?? '').toContain('目标不存在');
        expect(spawns).toHaveLength(0); // nothing was handed to the OS
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
                    platform: 'win32',
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

describe('runOpenCommand / cross-platform launchers', () => {
    it('uses `open` on macOS', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                '',
                { cwd: ws.root, platform: 'darwin', env: {}, spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns).toHaveLength(1);
            expect(spawns[0].file).toBe('open');
            expect(spawns[0].args).toEqual([ws.root]);
        }
        finally {
            ws.cleanup();
        }
    });

    it('falls through to the next launcher when the first one cannot spawn (Linux)', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'src/index.ts',
                {
                    cwd: ws.root,
                    platform: 'linux',
                    env: { DISPLAY: ':0' },
                    release: '6.8.0-45-generic',
                    // xdg-open is not installed → ENOENT; gio takes over.
                    spawn: async (spec) => { spawns.push(spec); return spawns.length > 1; },
                },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns.map((spec) => spec.file)).toEqual(['xdg-open', 'gio']);
            expect(spawns[1].args).toEqual(['open', join(ws.root, 'src', 'index.ts')]);
        }
        finally {
            ws.cleanup();
        }
    });

    it('names every attempted launcher when the whole Linux chain fails', async () => {
        const ws = makeWorkspace();
        try {
            const result = await runOpenCommand(
                '',
                {
                    cwd: ws.root,
                    platform: 'linux',
                    env: { DISPLAY: ':0' },
                    release: '6.8.0-45-generic',
                    spawn: async () => false,
                },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('error');
            expect(result.text ?? '').toContain('无法打开');
            expect(result.text ?? '').toContain('xdg-open');
            expect(result.text ?? '').toContain('exo-open');
            expect(result.text ?? '').toContain('xdg-utils');
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens a URL through the Linux chain without any path probe', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                'https://example.com/docs',
                {
                    cwd: ws.root,
                    platform: 'linux',
                    env: { WAYLAND_DISPLAY: 'wayland-0' },
                    release: '6.8.0-45-generic',
                    spawn: async (spec) => { spawns.push(spec); return true; },
                },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args).toEqual(['https://example.com/docs']);
        }
        finally {
            ws.cleanup();
        }
    });
});

describe('expandTilde', () => {
    // Platform-native home so the expectations hold on Windows, macOS and Linux
    // (the `/` a user types must come out as this platform's separator).
    const HOME = join(tmpdir(), 'dsh-open-path-home');

    it('expands a bare `~` and normalises the typed separator', () => {
        expect(expandTilde('~', HOME)).toBe(HOME);
        expect(expandTilde('~/docs', HOME)).toBe(join(HOME, 'docs'));
        expect(expandTilde('~\\docs', HOME)).toBe(join(HOME, 'docs'));
        expect(expandTilde('~/docs/deep', HOME)).toBe(join(HOME, 'docs', 'deep'));
    });

    it('leaves `~user` and other paths untouched', () => {
        expect(expandTilde('~root/docs', HOME)).toBe('~root/docs');
        expect(expandTilde('/tmp/~/x', HOME)).toBe('/tmp/~/x');
        expect(expandTilde('docs', HOME)).toBe('docs');
    });

    it('keeps a root home directory single-separated', () => {
        expect(expandTilde('~/docs', sep)).toBe(join(sep, 'docs'));
    });
});

describe('runOpenCommand / ~ expansion', () => {
    it('opens a `~/…` path against the home directory, not the workspace', async () => {
        const ws = makeWorkspace();
        const home = join(ws.root, 'home');
        mkdirSync(join(home, 'docs'), { recursive: true });
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                '~/docs',
                { cwd: ws.root, platform: 'win32', home, spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].file).toBe('powershell.exe'); // a directory
            expect(spawns[0].args.join(' ')).toContain(join(home, 'docs'));
        }
        finally {
            ws.cleanup();
        }
    });

    it('opens the home directory itself for a bare `~`', async () => {
        const ws = makeWorkspace();
        const home = join(ws.root, 'home');
        mkdirSync(home, { recursive: true });
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                '~',
                { cwd: ws.root, platform: 'win32', home, spawn: async (spec) => { spawns.push(spec); return true; } },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain(home);
        }
        finally {
            ws.cleanup();
        }
    });

    it('falls back to fuzzy search when the expanded home path does not exist', async () => {
        const ws = makeWorkspace();
        const spawns: SpawnSpec[] = [];
        try {
            const result = await runOpenCommand(
                '~/readme', // no such file under home → fuzzy finds docs/readme.md
                {
                    cwd: ws.root,
                    platform: 'win32',
                    home: join(ws.root, 'home'),
                    spawn: async (spec) => { spawns.push(spec); return true; },
                },
                DEFAULT_OPTIONS,
            );
            expect(result.kind).toBe('success');
            expect(spawns[0].args.join(' ')).toContain('readme.md');
        }
        finally {
            ws.cleanup();
        }
    });
});
