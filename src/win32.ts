/**
 * Platform-specific "open with the default handler" launch specs for
 * @dsh-tui-ecosystem/dsh-open-path.
 *
 * Pure functions only: they build a spawn descriptor; the caller owns the
 * actual `child_process.spawn`. This keeps every branch unit-testable.
 *
 * Windows notes (platform knowledge shared by dsh-tui's own openExternal — the
 * Shell.Application COM channel is the ONLY reliably working folder opener on
 * single-instance Explorer setups; plain `start`/`explorer`/`/select,` silently
 * swallow the request):
 *  - directories → PowerShell `Shell.Application.Open('<dir>')`, MUST NOT be
 *    spawned with DETACHED_PROCESS (console-less PS drops the COM call) —
 *    `windowsHide` alone (CREATE_NO_WINDOW) keeps it invisible AND working.
 *  - files/URLs → `cmd /d /s /c start "" "<path>"` (double quotes required so
 *    `start` does not treat the path as the window title).
 *
 * @module dsh-open-path/win32
 */

/** A spawn descriptor compatible with `child_process.spawn` options. */
export interface SpawnSpec {
    readonly file: string;
    readonly args: string[];
    readonly windowsHide: boolean;
    readonly detached: boolean;
    readonly windowsVerbatimArguments: boolean;
}

/** Escape a path for a single-quoted PowerShell literal ('' doubling). */
export function powerShellLiteral(path: string): string {
    return `'${path.replace(/'/g, "''")}'`;
}

/** Spawn descriptor for opening a DIRECTORY on Windows (COM channel). */
export function buildWin32DirectorySpawn(absPath: string): SpawnSpec {
    return {
        file: 'powershell.exe',
        args: [
            '-NoProfile',
            '-Command',
            `(New-Object -ComObject Shell.Application).Open(${powerShellLiteral(absPath)})`,
        ],
        windowsHide: true,
        detached: false,
        windowsVerbatimArguments: false,
    };
}

/** Spawn descriptor for opening a FILE on Windows via `start`. */
export function buildWin32FileSpawn(absPath: string): SpawnSpec {
    return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `start "" "${absPath}"`],
        windowsHide: true,
        detached: true,
        windowsVerbatimArguments: true,
    };
}

/**
 * Pick the spawn descriptor for `absPath` on the given platform.
 * Directories open the file manager; files open with their associated app.
 */
export function buildOpenSpawn(
    absPath: string,
    isDir: boolean,
    platform: NodeJS.Platform = process.platform,
): SpawnSpec {
    if (platform === 'win32') {
        return isDir ? buildWin32DirectorySpawn(absPath) : buildWin32FileSpawn(absPath);
    }
    if (platform === 'darwin') {
        return {
            file: 'open',
            args: [absPath],
            windowsHide: false,
            detached: true,
            windowsVerbatimArguments: false,
        };
    }
    return {
        file: 'xdg-open',
        args: [absPath],
        windowsHide: false,
        detached: true,
        windowsVerbatimArguments: false,
    };
}

/** Is this environment able to reach a graphical session at all? */
export function hasGraphicalSession(platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') return true;
    if (platform === 'darwin') return true;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
