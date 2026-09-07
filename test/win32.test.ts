import { describe, expect, it } from 'vitest';
import {
    buildOpenSpawn,
    buildWin32DirectorySpawn,
    buildWin32FileSpawn,
    hasGraphicalSession,
    powerShellLiteral,
} from '../src/win32.js';

describe('powerShellLiteral', () => {
    it('doubles single quotes', () => {
        expect(powerShellLiteral("C:\\Users\\o'Brien\\x")).toBe("'C:\\Users\\o''Brien\\x'");
    });
    it('wraps a plain path in single quotes', () => {
        expect(powerShellLiteral('C:\\workspace')).toBe("'C:\\workspace'");
    });
});

describe('buildWin32DirectorySpawn', () => {
    it('uses the Shell.Application COM channel (the only reliable folder opener)', () => {
        const spec = buildWin32DirectorySpawn('C:\\Workspace');
        expect(spec.file).toBe('powershell.exe');
        expect(spec.args).toContain(`(New-Object -ComObject Shell.Application).Open('C:\\Workspace')`);
        expect(spec.detached).toBe(false); // DETACHED_PROCESS breaks the COM call
        expect(spec.windowsHide).toBe(true);
    });
});

describe('buildWin32FileSpawn', () => {
    it('uses start with a quoted path', () => {
        const spec = buildWin32FileSpawn('C:\\Workspace\\a.txt');
        expect(spec.file).toBe(process.env.ComSpec || 'cmd.exe');
        expect(spec.args[3]).toBe('start "" "C:\\Workspace\\a.txt"');
        expect(spec.windowsVerbatimArguments).toBe(true);
    });
});

describe('buildOpenSpawn by platform', () => {
    it('routes directories through COM and files through start on Windows', () => {
        expect(buildOpenSpawn('C:\\w', true, 'win32').file).toBe('powershell.exe');
        expect(buildOpenSpawn('C:\\w\\a.ts', false, 'win32').file).toBe(process.env.ComSpec || 'cmd.exe');
    });
    it('uses `open` on macOS', () => {
        expect(buildOpenSpawn('/tmp/x.md', false, 'darwin')).toMatchObject({ file: 'open', args: ['/tmp/x.md'] });
    });
    it('uses xdg-open on Linux', () => {
        expect(buildOpenSpawn('/tmp/x.md', false, 'linux')).toMatchObject({ file: 'xdg-open', args: ['/tmp/x.md'] });
    });
});

describe('hasGraphicalSession', () => {
    it('always reports true on Windows and macOS', () => {
        expect(hasGraphicalSession('win32')).toBe(true);
        expect(hasGraphicalSession('darwin')).toBe(true);
    });
    it('requires DISPLAY/WAYLAND_DISPLAY on Linux', () => {
        expect(hasGraphicalSession('linux')).toBe(Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
    });
});
