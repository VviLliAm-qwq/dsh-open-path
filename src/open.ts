/**
 * /open command flow for @dsh-tui-ecosystem/dsh-open-path.
 *
 * Decision tree (all side effects funnel through injected seams so tests can
 * drive the exact same code path the plugin uses):
 *
 *   `~` / `~/…` prefix       → expanded to the user's home directory
 *   raw input empty          → open the session working directory
 *   http(s):// URL           → open with the platform default handler
 *   absolute / relative path → stat; exists → open; missing → fuzzy search
 *   anything else            → fuzzy search of the workspace index
 *      0 hits                 → { kind: 'error', text: 'no match' }
 *      1 hit                  → open it directly
 *      >1 hits, dialogs ready → managed select dialog → open pick
 *      >1 hits, no dialogs    → error listing the top few candidates
 *
 * Only http/https URLs are accepted; other schemes (file:, javascript:,
 * ftp:, …) are rejected before reaching the OS handler (urlGuard-style
 * trust boundary, mirroring the TUI's own openExternal classification).
 *
 * Opening is a hand-off, not a guarantee: the launcher chain from
 * `resolveLaunchers` is walked in order, and a candidate only counts as a
 * success once it spawned AND survived the grace window without a non-zero
 * exit. That is what turns "xdg-open is not installed" from a silent
 * `已打开` into a real error naming what was tried.
 *
 * @module dsh-open-path/open
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir, release as osRelease } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { rankEntries } from './fuzzy.js';
import { DEFAULT_LIMITS, scanWorkspace, type ScannedEntry } from './scan.js';
import { hasGraphicalSession, resolveLaunchers, type SpawnSpec } from './win32.js';

/** The dsh-commands result shape (structural subset — never imported). */
export interface CommandResultLike {
    readonly kind: 'success' | 'error';
    readonly text?: string;
}

/** Structural subset of `ctx.tuiDialogs` managed select requests. */
export interface OpenDialogOptionLike {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface OpenDialogLike {
    select(request: { readonly title: string; readonly options: readonly OpenDialogOptionLike[] }): Promise<string | undefined>;
}

/** Everything the flow needs from the outside world. */
export interface OpenRuntime {
    /** Session working directory (agent session cwd). */
    readonly cwd: string;
    /** Managed select dialog; missing = degrade to an error listing. */
    readonly dialogs?: OpenDialogLike;
    /** Command cancellation signal. */
    readonly signal?: AbortSignal;
    /** Platform override for tests (defaults to process.platform). */
    readonly platform?: NodeJS.Platform;
    /** Environment for the graphical-session probe (tests inject a bare one). */
    readonly env?: NodeJS.ProcessEnv;
    /** `os.release()` override for tests (drives WSL detection). */
    readonly release?: string;
    /** Home directory for `~` expansion (tests inject a fixture). */
    readonly home?: string;
    /** Spawn seam for tests (defaults to the fire-and-forget child). */
    readonly spawn?: (spec: SpawnSpec) => Promise<boolean>;
    /** Scanner seam for tests (defaults to scanWorkspace). */
    readonly scan?: (root: string, limits?: ScanLimitsLike, signal?: AbortSignal) => Promise<ScannedEntry[]>;
}

/** Structural ScanLimits subset (avoids a second import surface). */
export interface ScanLimitsLike {
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly includeHidden: boolean;
}

/** Effective command options (schema defaults already applied). */
export interface OpenCommandOptions {
    readonly maxCandidates: number;
    readonly includeHidden: boolean;
}

/**
 * How long a launcher gets to fail before the hand-off counts as a success.
 * A launcher that is still alive after this window has either handed the target
 * to the desktop already or is waiting on the opened application to exit — both
 * are "opened" from the command's point of view.
 */
export const LAUNCH_GRACE_MS = 180;

/**
 * Spawn one launcher candidate and decide whether the hand-off worked.
 *
 * Fire-and-forget (no stdio pipes, unref'd) but not blind: a candidate that
 * cannot be spawned at all (ENOENT — no xdg-utils installed) or that exits
 * non-zero (no handler configured for the target) reports failure so the next
 * candidate gets its turn.
 */
function spawnOnce(spec: SpawnSpec, graceMs: number = LAUNCH_GRACE_MS): Promise<boolean> {
    return new Promise<boolean>((resolveSpawn) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (opened: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            resolveSpawn(opened);
        };

        let child;
        try {
            child = spawn(spec.file, spec.args, {
                stdio: 'ignore',
                detached: spec.detached,
                windowsHide: spec.windowsHide,
                windowsVerbatimArguments: spec.windowsVerbatimArguments,
            });
        }
        catch {
            resolveSpawn(false);
            return;
        }

        timer = setTimeout(() => settle(true), graceMs);
        // `on` (not `once`): a late error after the grace window must never
        // surface as an unhandled 'error' event.
        child.on('error', () => settle(false));
        child.once('exit', (code) => settle(code === 0));
        child.unref();
    });
}

/** Human-facing reason to append when every launcher candidate failed. */
function launcherHint(platform: NodeJS.Platform): string {
    if (platform === 'win32') return '请检查系统默认程序关联';
    if (platform === 'darwin') return '请确认 /usr/bin/open 可用';
    return '多数精简发行版需要先安装 xdg-utils（或 gio / kde-open）';
}

/**
 * Open one resolved target, walking the platform launcher chain; every failure
 * becomes an error result. `isDir: false` also covers http/https URLs — the
 * non-directory channels (Windows `start`, macOS `open`, Linux `xdg-open`) take
 * URLs unchanged.
 */
async function openTarget(runtime: OpenRuntime, target: string, isDir: boolean): Promise<CommandResultLike> {
    // A path that is already gone must not be reported as opened: the Windows
    // COM channel silently does nothing for a missing directory, and a
    // fire-and-forget launcher would call that a success. URLs skip the probe.
    if (!isHttpUrl(target) && !existsSync(target)) {
        return { kind: 'error', text: `目标不存在：${target}` };
    }

    const platform = runtime.platform ?? process.platform;
    const env = runtime.env ?? process.env;
    const release = runtime.release ?? osRelease();
    if (!hasGraphicalSession(platform, env, release)) {
        return { kind: 'error', text: '当前环境没有图形会话，无法打开文件管理器' };
    }

    const spawnSpec = runtime.spawn ?? spawnOnce;
    const tried: string[] = [];
    for (const spec of resolveLaunchers(target, isDir, { platform, env, release })) {
        tried.push(spec.file);
        if (await spawnSpec(spec)) {
            return { kind: 'success', text: `已打开 ${target}` };
        }
    }
    const attempted = [...new Set(tried)].join('、');
    return {
        kind: 'error',
        text: `无法打开 ${target}（已尝试 ${attempted}，均失败；${launcherHint(platform)}）`,
    };
}

function labelFor(entry: ScannedEntry): string {
    return entry.isDir ? `📁 ${entry.basename}` : entry.basename;
}

/** http/https URL detection (case-insensitive; the only allowed schemes). */
const HTTP_URL = /^https?:\/\//iu;

export function isHttpUrl(value: string): boolean {
    return HTTP_URL.test(value);
}

/**
 * File-name tails that must NEVER be treated as a bare (protocol-less) URL.
 * `/open readme.md` means the workspace file, not a .md domain.
 */
const FILE_TAILS = new Set([
    'md', 'markdown', 'txt', 'text', 'rst', 'log', 'csv', 'tsv',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'jsonl',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'properties',
    'css', 'scss', 'less', 'sass', 'html', 'htm', 'vue', 'svelte', 'astro',
    'py', 'pyc', 'rb', 'go', 'rs', 'zig', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
    'java', 'kt', 'kts', 'swift', 'scala', 'sh', 'bash', 'zsh', 'bat', 'cmd',
    'ps1', 'psm1', 'fish', 'npmrc', 'nix', 'dockerfile',
    'exe', 'dll', 'msi', 'app', 'dmg', 'apk', 'deb', 'rpm',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'bin',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff',
    'avif', 'heic', 'psd', 'ai', 'eps', 'raw', 'exr',
    'wav', 'mp3', 'mp4', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'mkv', 'avi',
    'mov', 'webm', 'flv', 'm4v', '3gp',
    'sql', 'db', 'sqlite', 'dump', 'bak', 'wasm', 'map', 'd.ts',
    'gitignore', 'gitattributes', 'editorconfig', 'prettierrc', 'eslintrc',
    'patch', 'diff', 'desktop',
]);

/** Is this an IPv4 literal (optionally with port and path)? */
function isIpv4Literal(value: string): boolean {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:\/.*)?$/u.exec(value);
    if (match === null) return false;
    return match.slice(1, 5).every((segment) => Number(segment) <= 255);
}

/**
 * Guess a protocol-less URL the user clearly meant as a web address:
 *  - `github.com`, `www.example.com/path` → https://…  (domain TLD)
 *  - `localhost:5173`, `127.0.0.1:8080`  → http://…   (local dev)
 *
 * Returns null when the input does not look like a web address, so paths and
 * file names (incl. almost every common file extension) keep flowing into the
 * stat / fuzzy branches untouched.
 */
export function guessBareUrl(value: string): string | null {
    if (/^localhost(?::\d+)?(?:\/.*)?$/iu.test(value) || isIpv4Literal(value)) {
        return `http://${value}`;
    }
    // host(.tld)+ with optional :port and /path — letters/digits/hyphens only.
    const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/.*)?$/iu.exec(value);
    if (match === null) return null;
    const host = match[1].toLowerCase();
    const tld = host.slice(host.lastIndexOf('.') + 1);
    if (tld.length < 2 || !/^[a-z]+$/u.test(tld)) return null;
    if (FILE_TAILS.has(tld)) return null;
    return `https://${value}`;
}

/**
 * Expand a leading `~` (bare, `~/…` or `~\…`) to the user's home directory.
 * `~user` is deliberately left untouched: no passwd lookup, no shell parsing.
 * POSIX shells expand this before a command ever sees it, so users type it by
 * reflex on Linux/macOS — without this, `~/docs` was treated as a relative
 * path called `~`.
 */
export function expandTilde(value: string, home: string): string {
    if (!value.startsWith('~')) return value;
    const isBare = value.length === 1;
    const lead = isBare ? '' : value[1];
    if (!isBare && lead !== '/' && lead !== '\\') return value; // ~user — untouched
    const rest = isBare ? '' : value.slice(2);
    if (rest === '') return home;
    // `join` both normalises the separator the user typed to this platform's
    // and keeps a root home directory ("/" or "C:\") single-separated.
    return join(home, rest);
}

/** Home directory for `~` expansion, degrading to the workspace root. */
function homeDir(runtime: OpenRuntime): string {
    if (runtime.home !== undefined && runtime.home !== '') return runtime.home;
    try {
        return homedir();
    }
    catch {
        return runtime.cwd;
    }
}

/** Run the full /open decision tree and settle with a command result. */
export async function runOpenCommand(
    rawInput: string,
    runtime: OpenRuntime,
    options: OpenCommandOptions,
): Promise<CommandResultLike> {
    const trimmed = rawInput.trim();
    const query = trimmed.startsWith('~') ? expandTilde(trimmed, homeDir(runtime)) : trimmed;

    // 1) Bare /open → the session working directory.
    if (query === '') {
        return openTarget(runtime, runtime.cwd, true);
    }

    // 2) http/https URL → open with the platform default handler (browser).
    //    Deliberately BEFORE path detection: an https://… input is also
    //    path-shaped and would otherwise fall into a stat/fuzzy detour.
    //    Only http(s) is allowed — any other scheme (file:, javascript:,
    //    ftp:, …) is rejected instead of handed to the OS iframe of trust.
    if (isHttpUrl(query)) {
        return openTarget(runtime, query, false);
    }
    // 2b) Protocol-less web address: `github.com`, `example.com/path`,
    //     `localhost:5173`, `127.0.0.1:8080`… BEFORE the scheme check, so a
    //     host:port form is never mistaken for a protocol. A workspace file
    //     with the same name always wins (a real file on disk beats a guessed
    //     URL). File extensions are excluded from guessing, so `readme.md`
    //     still opens the file / fuzzy-matches as today.
    const guessedUrl = guessBareUrl(query);
    if (guessedUrl !== null) {
        try {
            const localTarget = resolve(runtime.cwd, query);
            if (existsSync(localTarget)) {
                return openTarget(runtime, localTarget, statSync(localTarget).isDirectory());
            }
        }
        catch {
            // stat race — fall through to the URL guess below.
        }
        return openTarget(runtime, guessedUrl, false);
    }

    // 2c) Other scheme-like input (mailto:, ftp:, javascript:, ws:, …) is
    //     rejected with a clear error — never silently routed into the path
    //     or fuzzy branches. A bare drive letter ("C:\…") needs ≥2 scheme
    //     characters to match, so Windows paths stay untouched.
    const schemeMatch = /^([a-z][a-z0-9+.-]{1,}):/iu.exec(query);
    if (schemeMatch !== null) {
        return {
            kind: 'error',
            text: `仅支持 http/https 链接（检测到 ${schemeMatch[1].toLowerCase()}: 协议）`,
        };
    }

    // 3) Path-shaped input: absolute, ./, ../, or containing a separator.
    //    Both separators count on every platform, so a Windows-style path typed
    //    on Linux (and vice versa) still reaches the fuzzy fallback below.
    const pathShaped = isAbsolute(query) || query.startsWith('.') || /[\\/]/.test(query);
    if (pathShaped) {
        const target = isAbsolute(query) ? query : resolve(runtime.cwd, query);
        try {
            if (existsSync(target)) {
                return openTarget(runtime, target, statSync(target).isDirectory());
            }
            // Missing path: fall through to fuzzy search (typo recovery).
        }
        catch {
            // stat race (EACCES / vanished): fall through to fuzzy search.
        }
    }

    // 4) Fuzzy search of the workspace index. For a missing path-shaped
    //    query, search by the LAST segment (what the user actually named),
    //    so "src/readme.md" with a typo'd directory still finds readme.md.
    const segments = query.split(/[\\/]/).filter((segment) => segment !== '');
    const fuzzyQuery = segments.length > 0 ? segments[segments.length - 1] : query;
    const scan = runtime.scan ?? scanWorkspace;
    const limits: ScanLimitsLike = { ...DEFAULT_LIMITS, includeHidden: options.includeHidden };
    const entries = await scan(runtime.cwd, limits, runtime.signal);
    const ranked = rankEntries(fuzzyQuery, entries, options.maxCandidates);

    if (ranked.length === 0) {
        return { kind: 'error', text: `工作区中找不到与 “${query}” 相关的文件或文件夹` };
    }

    if (ranked.length === 1) {
        const only = ranked[0];
        return openTarget(runtime, only.absPath, only.isDir);
    }

    // 5) Multiple candidates: ask, open the pick, or degrade.
    const dialog = runtime.dialogs;
    if (dialog === undefined) {
        const preview = ranked
            .slice(0, 5)
            .map((entry) => (entry.isDir ? `[目录] ${entry.relPath}` : entry.relPath))
            .join('；');
        const more = ranked.length > 5 ? ` 等 ${ranked.length} 项` : '';
        return {
            kind: 'error',
            text: `找到 ${ranked.length} 个匹配，但当前环境没有对话框选择，请键入更精确的路径。候选：${preview}${more}`,
        };
    }

    const picked = await dialog.select({
        title: `打开哪个？（${query}）`,
        options: ranked.map((entry) => ({
            id: entry.relPath,
            label: labelFor(entry),
            description: entry.relPath,
        })),
    });
    if (picked === undefined) {
        return { kind: 'success' }; // Esc / cancelled — stay quiet.
    }
    const target = resolve(runtime.cwd, picked);
    try {
        const isDir = existsSync(target) && statSync(target).isDirectory();
        return openTarget(runtime, target, isDir);
    }
    catch {
        return { kind: 'error', text: `无法打开 ${target}（目标已失效）` };
    }
}

/** Small helper for tests: the human-facing label of a path. */
export function basenameOf(path: string): string {
    return basename(path);
}
