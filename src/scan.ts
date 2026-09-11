/**
 * Workspace file/folder index for @dsh-tui-ecosystem/dsh-open-path.
 *
 * Async recursive walk with hard caps so a huge repository cannot hang the
 * command: depth limit, total-entry limit, ignored-directory allowlist,
 * hidden-file skip, and cooperative AbortSignal checks. Best effort only —
 * unreadable directories are skipped silently, never fatal.
 *
 * @module dsh-open-path/scan
 */
import { statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

/** One indexed workspace entry (file or directory). */
export interface ScannedEntry {
    readonly relPath: string;
    readonly absPath: string;
    readonly isDir: boolean;
    readonly basename: string;
}

/** Scan hard limits and filters. */
export interface ScanLimits {
    /** Maximum directory depth walked (root = 0). */
    readonly maxDepth: number;
    /** Maximum number of entries collected. */
    readonly maxEntries: number;
    /** Include dot-files and dot-directories. */
    readonly includeHidden: boolean;
}

export const DEFAULT_LIMITS: ScanLimits = {
    maxDepth: 6,
    maxEntries: 20000,
    includeHidden: false,
};

/**
 * Directories that are never walked. Everything here is either generated,
 * vendored, or tool-state: a fuzzy /open should not suggest them.
 */
export const IGNORED_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    '.dsh',
    '.dsh-tui',
    '.dsh-memory',
    'node_modules',
    'bower_components',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    '.nyc_output',
    '.turbo',
    '.cache',
    '.pnpm-store',
    '.venv',
    'venv',
    '__pycache__',
    '.mypy_cache',
    '.idea',
    '.vscode',
    '.vs',
]);

/**
 * Walk `root` and collect candidate files and directories.
 *
 * @returns entries sorted by relative path (stable ordering for tests).
 */
export async function scanWorkspace(
    root: string,
    limits: ScanLimits = DEFAULT_LIMITS,
    signal?: AbortSignal,
): Promise<ScannedEntry[]> {
    const entries: ScannedEntry[] = [];
    let count = 0;
    let stopped = false;

    const walk = async (dirPath: string, depth: number): Promise<void> => {
        if (stopped || (signal?.aborted ?? false)) {
            stopped = true;
            return;
        }
        if (depth > limits.maxDepth) return;
        let dir;
        try {
            dir = await opendir(dirPath);
        }
        catch {
            return; // unreadable / vanished — skip silently
        }
        try {
            for await (const entry of dir) {
                if (stopped || (signal?.aborted ?? false)) {
                    stopped = true;
                    return;
                }
                if (!limits.includeHidden && entry.name.startsWith('.')) continue;
                const absPath = join(dirPath, entry.name);
                // A symlink to a directory reports isDirectory() === false on
                // every platform, which used to index it as a FILE (opened with
                // a text editor instead of the file manager). One stat resolves
                // the real kind; symlinked directories are indexed but NOT
                // descended into, which keeps the walk cycle-free and inside the
                // workspace.
                const isSymlink = entry.isSymbolicLink();
                let isDir = entry.isDirectory();
                if (!isDir && isSymlink) {
                    try {
                        isDir = statSync(absPath).isDirectory();
                    }
                    catch {
                        isDir = false; // dangling link — keep it as a file
                    }
                }
                if (isDir && IGNORED_DIRS.has(entry.name)) continue;

                const relPath = relative(root, absPath).split(sep).join('/');
                entries.push({ relPath, absPath, isDir, basename: basename(absPath) });
                count += 1;
                if (count >= limits.maxEntries) {
                    stopped = true;
                    return;
                }
                // Cooperative yield every few hundred entries so the event
                // loop (and the TUI) stays responsive on huge trees.
                if ((count & 255) === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                if (isDir && !isSymlink) {
                    await walk(absPath, depth + 1);
                }
            }
        }
        catch {
            // aborted mid-iteration or read error — keep what we have
        }
    };

    await walk(root, 0);
    entries.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));
    return entries;
}
