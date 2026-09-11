import { describe, expect, it } from 'vitest';
import {
    buildOpenSpawn,
    buildWin32DirectorySpawn,
    buildWin32FileSpawn,
    detectWsl,
    hasGraphicalSession,
    powerShellLiteral,
    resolveLaunchers,
    type LaunchHost,
} from '../src/win32.js';

/** Build a launch host for a platform, with an isolated env by default. */
function host(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = {},
    release = '',
): LaunchHost {
    return { platform, env, release };
}

const CMD = process.env.ComSpec || 'cmd.exe';

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
        expect(spec.file).toBe(CMD);
        expect(spec.args[3]).toBe('start "" "C:\\Workspace\\a.txt"');
        expect(spec.windowsVerbatimArguments).toBe(true);
    });
});

describe('resolveLaunchers', () => {
    it('prefers COM for Windows directories and keeps `start` as the fallback', () => {
        const chain = resolveLaunchers('C:\\w', true, host('win32'));
        expect(chain.map((spec) => spec.file)).toEqual(['powershell.exe', CMD]);
        // The fallback still opens the folder, just through ShellExecute.
        expect(chain[1].args[3]).toBe('start "" "C:\\w"');
    });

    it('uses a single `start` channel for Windows files and URLs', () => {
        expect(resolveLaunchers('C:\\w\\a.txt', false, host('win32')).map((spec) => spec.file)).toEqual([CMD]);
        expect(resolveLaunchers('https://example.com', false, host('win32')).map((spec) => spec.file)).toEqual([CMD]);
    });

    it('uses `open` on macOS for folders, files and URLs alike', () => {
        for (const target of ['/tmp/x', '/tmp/x.md', 'https://example.com']) {
            const chain = resolveLaunchers(target, false, host('darwin'));
            expect(chain).toHaveLength(1);
            expect(chain[0]).toMatchObject({ file: 'open', args: [target] });
        }
    });

    it('offers the full Linux launcher chain in preference order', () => {
        const chain = resolveLaunchers('/tmp/x.md', false, host('linux', { DISPLAY: ':0' }));
        expect(chain.map((spec) => spec.file)).toEqual(['xdg-open', 'gio', 'kde-open5', 'kde-open', 'exo-open']);
        // `gio` needs its subcommand, the others take the target directly.
        expect(chain[1].args).toEqual(['open', '/tmp/x.md']);
        expect(chain[2].args).toEqual(['/tmp/x.md']);
        // POSIX children stay fire-and-forget.
        expect(chain.every((spec) => spec.detached)).toBe(true);
    });

    it('prefers wslview first on WSL and keeps Windows-side handlers reachable', () => {
        const wsl = host('linux', { WSL_DISTRO_NAME: 'Ubuntu' });
        expect(resolveLaunchers('/mnt/c/w', true, wsl)[0].file).toBe('wslview');
        const urlChain = resolveLaunchers('https://example.com', false, wsl).map((spec) => spec.file);
        expect(urlChain[0]).toBe('wslview');
        expect(urlChain[urlChain.length - 1]).toBe('cmd.exe'); // last resort for URLs
        // …but a local path has no Windows-side channel (paths would not resolve).
        expect(resolveLaunchers('/mnt/c/w/x.md', false, wsl).some((spec) => spec.file === 'cmd.exe')).toBe(false);
    });
});

describe('detectWsl', () => {
    it('recognises WSL from the env markers or the kernel release string', () => {
        expect(detectWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
        expect(detectWsl('linux', { WSL_INTEROP: '/run/WSL/8_interop' })).toBe(true);
        expect(detectWsl('linux', {}, '5.15.90.1-microsoft-standard-WSL2')).toBe(true);
    });

    it('does not fire on native Linux or Windows', () => {
        expect(detectWsl('linux', {}, '6.8.0-45-generic')).toBe(false);
        expect(detectWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(false);
        expect(detectWsl('darwin', {}, '23.6.0')).toBe(false);
    });
});

describe('buildOpenSpawn by platform', () => {
    it('routes directories through COM and files through start on Windows', () => {
        expect(buildOpenSpawn('C:\\w', true, 'win32').file).toBe('powershell.exe');
        expect(buildOpenSpawn('C:\\w\\a.ts', false, 'win32').file).toBe(CMD);
    });
    it('uses `open` on macOS', () => {
        expect(buildOpenSpawn('/tmp/x.md', false, 'darwin')).toMatchObject({ file: 'open', args: ['/tmp/x.md'] });
    });
    it('uses xdg-open as the first Linux candidate', () => {
        expect(buildOpenSpawn('/tmp/x.md', false, 'linux')).toMatchObject({ file: 'xdg-open', args: ['/tmp/x.md'] });
    });
});

describe('hasGraphicalSession', () => {
    it('always reports true on Windows and macOS', () => {
        expect(hasGraphicalSession('win32', {})).toBe(true);
        expect(hasGraphicalSession('darwin', {})).toBe(true);
    });

    it('requires DISPLAY/WAYLAND_DISPLAY on native Linux', () => {
        expect(hasGraphicalSession('linux', {}, '6.8.0-45-generic')).toBe(false);
        expect(hasGraphicalSession('linux', { DISPLAY: ':0' }, '6.8.0-45-generic')).toBe(true);
        expect(hasGraphicalSession('linux', { WAYLAND_DISPLAY: 'wayland-0' }, '6.8.0-45-generic')).toBe(true);
    });

    it('treats WSL as having a session even without X/Wayland', () => {
        // A WSL distro without WSLg has no DISPLAY, yet the Windows handlers
        // are reachable — the old check wrongly reported "no graphic session".
        expect(hasGraphicalSession('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(true);
        expect(hasGraphicalSession('linux', {}, '5.15.90.1-microsoft-standard-WSL2')).toBe(true);
    });
});
