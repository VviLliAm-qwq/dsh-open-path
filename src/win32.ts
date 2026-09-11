/**
 * Platform launch specs for @dsh-tui-ecosystem/dsh-open-path.
 *
 * Pure functions only: they assemble an ORDERED list of spawn descriptors and
 * the caller owns the actual `child_process.spawn`. Keeping the assembly pure
 * means every platform branch is unit-testable on any host, and the ordered
 * list is what makes the command survive minimal systems (a Linux box without
 * xdg-utils, a WSL distro without WSLg, …): the caller walks the list and falls
 * through to the next candidate whenever one cannot be spawned or fails fast.
 *
 * Channels per platform:
 *  - win32  directories → PowerShell `(New-Object -ComObject Shell.Application)
 *           .Open('<dir>')`, with `start` as the fallback candidate; files and
 *           URLs → `cmd /d /s /c start "" "<target>"` (the quoted empty title is
 *           mandatory, otherwise `start` treats a quoted target as the window
 *           title). Windows notes are field knowledge shared with dsh-tui's own
 *           openExternal: on single-instance Explorer setups `start` /
 *           `explorer` / `/select,` silently swallow a folder request while the
 *           COM call works, and that COM child MUST NOT be spawned with
 *           DETACHED_PROCESS (a console-less PowerShell drops the COM call) —
 *           `windowsHide` alone (CREATE_NO_WINDOW) keeps it invisible AND
 *           working.
 *  - darwin `open`.
 *  - linux  `xdg-open` → `gio open` → `kde-open5` → `kde-open` → `exo-open`.
 *           Minimal distributions frequently ship no xdg-utils at all, so a
 *           single fixed channel is not enough to be "supported".
 *  - WSL    `wslview` first, plus a Windows-side `cmd.exe /c start` last resort
 *           for URLs. WSL without WSLg exposes no DISPLAY/WAYLAND_DISPLAY, yet
 *           the Windows handlers remain perfectly reachable — so WSL counts as
 *           a graphical session and must not be told "no graphic session".
 *
 * Module-name note: this file has been called `win32.ts` for historical
 * reasons and has covered macOS/Linux channels since 0.3.0. The name is kept
 * deliberately: the live dsh profile mounts this package through hardlinked
 * `lib/` files, so a module rename would need a profile reinstall before the
 * new file could be loaded.
 *
 * @module dsh-open-path/win32
 */
import { release as osRelease } from 'node:os';

/** A spawn descriptor compatible with `child_process.spawn` options. */
export interface SpawnSpec {
    readonly file: string;
    readonly args: string[];
    readonly windowsHide: boolean;
    readonly detached: boolean;
    readonly windowsVerbatimArguments: boolean;
}

/** Everything platform resolution needs to know about the host. */
export interface LaunchHost {
    /** Target platform (defaults to the real one at the call sites). */
    readonly platform: NodeJS.Platform;
    /** Environment, for DISPLAY / WAYLAND_DISPLAY / WSL detection. */
    readonly env: NodeJS.ProcessEnv;
    /** `os.release()` — the WSL kernel marker ("…-microsoft-standard-WSL2"). */
    readonly release: string;
}

/** The host we are actually running on. */
export function currentHost(platform: NodeJS.Platform = process.platform): LaunchHost {
    return { platform, env: process.env, release: osRelease() };
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

/** Spawn descriptor for opening a FILE or URL on Windows via `start`. */
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
 * Is this Linux actually a WSL distribution? Best effort and pure: the env
 * markers are set by WSL itself, and the kernel release string carries
 * "microsoft" on both WSL1 and WSL2.
 */
export function detectWsl(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    release = '',
): boolean {
    if (platform !== 'linux') return false;
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true;
    return /microsoft/iu.test(release);
}

/** One POSIX launcher candidate: the command plus its fixed leading arguments. */
interface PosixLauncher {
    readonly file: string;
    readonly args: readonly string[];
}

/**
 * Linux/other-Unix candidates in preference order. Every entry accepts a file,
 * a directory or an http(s) URL as its final argument, so one list serves all
 * three target kinds.
 */
const POSIX_LAUNCHERS: readonly PosixLauncher[] = [
    { file: 'xdg-open', args: [] },
    { file: 'gio', args: ['open'] },
    { file: 'kde-open5', args: [] },
    { file: 'kde-open', args: [] },
    { file: 'exo-open', args: [] },
];

/** Local copy of the http(s)-only trust boundary (importing open.ts would cycle). */
const HTTP_URL = /^https?:\/\//iu;

/** Build a fire-and-forget POSIX spawn descriptor. */
function posixSpawn(file: string, args: readonly string[]): SpawnSpec {
    return {
        file,
        args: [...args],
        windowsHide: false,
        detached: true,
        windowsVerbatimArguments: false,
    };
}

/**
 * Assemble the ordered launcher chain for `absPath`.
 *
 * The FIRST entry is the preferred channel; later entries are fallbacks the
 * caller tries when an earlier one cannot be spawned or exits non-zero.
 * Directories open the file manager; files open with their associated app;
 * http(s) URLs with the default browser.
 */
export function resolveLaunchers(
    absPath: string,
    isDir: boolean,
    host: LaunchHost,
): SpawnSpec[] {
    if (host.platform === 'win32') {
        // Directories prefer the COM channel (single-instance Explorer swallows
        // `start <dir>`), files/URLs go through `start`.
        return isDir
            ? [buildWin32DirectorySpawn(absPath), buildWin32FileSpawn(absPath)]
            : [buildWin32FileSpawn(absPath)];
    }

    if (host.platform === 'darwin') {
        return [posixSpawn('open', [absPath])];
    }

    const wsl = detectWsl(host.platform, host.env, host.release);
    const chain: SpawnSpec[] = [];
    if (wsl) chain.push(posixSpawn('wslview', [absPath]));
    for (const launcher of POSIX_LAUNCHERS) {
        chain.push(posixSpawn(launcher.file, [...launcher.args, absPath]));
    }
    if (wsl && HTTP_URL.test(absPath)) {
        // Last resort on WSL: hand the URL to the Windows-side default browser.
        chain.push({
            file: 'cmd.exe',
            args: ['/d', '/s', '/c', `start "" "${absPath}"`],
            windowsHide: false,
            detached: true,
            windowsVerbatimArguments: true,
        });
    }
    return chain;
}

/**
 * Pick the preferred spawn descriptor for `absPath` on the given platform.
 * Kept as the stable single-descriptor entry point; `resolveLaunchers` returns
 * the full fallback chain the command actually walks.
 */
export function buildOpenSpawn(
    absPath: string,
    isDir: boolean,
    platform: NodeJS.Platform = process.platform,
): SpawnSpec {
    return resolveLaunchers(absPath, isDir, currentHost(platform))[0];
}

/**
 * Is this environment able to reach a graphical session at all?
 *
 * Windows and macOS always can (the OS handler is part of the session); a WSL
 * distro can through the Windows side; a plain Linux box needs a display
 * server. `env`/`release` are injectable so the answer is testable on any host
 * instead of depending on the machine that happens to run the suite.
 */
export function hasGraphicalSession(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    release: string = osRelease(),
): boolean {
    if (platform === 'win32') return true;
    if (platform === 'darwin') return true;
    if (detectWsl(platform, env, release)) return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
