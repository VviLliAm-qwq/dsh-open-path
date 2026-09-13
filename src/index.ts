/**
 * dsh-open-path — a `/open` slash command for dsh-TUI.
 *
 * Opens files, folders and http(s) URLs with the platform default handler:
 *  - `/open`                  → opens the session working directory
 *  - `/open <path>`           → absolute / relative path (must exist)
 *  - `/open <http(s)-url>`    → opens with the default browser/handler
 *  - `/open github.com`       → protocol-less domain: https:// is prepended
 *                               (localhost/IPv4 get http://); a same-named
 *                               workspace file always wins the guess
 *  - `/open ~/docs`           → `~` expands to the home directory
 *  - `/open <fragment>`       → fuzzy search of the workspace; one match opens
 *                               directly, several matches show a managed
 *                               scrollable select dialog (TUI seam 十, every
 *                               match up to the host's own option ceiling),
 *                               none = clear error
 *
 * URL trust boundary: only http/https is handed to the OS handler; other
 * schemes (file:, javascript:, ftp:, …) are rejected with a clear error
 * (mirrors the TUI's own openExternal classification). Bare-domain guessing
 * excludes common file extensions, so `readme.md` still means the file.
 *
 * Platform support: Windows / macOS / Linux (incl. WSL), each with an ordered
 * launcher chain — see `./win32.js`.
 *
 * Compatibility contract:
 *  - Manifest: Community v0.15 (`dsh-plugin.json`, commands.dsh/v1alpha1#Command
 *    required, `commands.invoke` granted for the declared contribution id).
 *  - Command registration: the MEDIATED surface `ctx.tuiPluginHost`
 *    (C-041 attribution + invoke checkpoint) when the host provides it;
 *    otherwise the direct `commands` service (C-070 boundary, still functional).
 *  - Managed dialog seam is soft-probed (`ctx.get('tuiDialogs', false)`); when
 *    absent the command degrades to a clear error listing — never a crash
 *    (#183 discipline). No host service, no boot impact.
 *  - No session events are appended; no files are ever written by this plugin,
 *    except its own bounded diagnostic log (`~/.dsh-tui/dsh-open-path.log`).
 *
 * @module @dsh-tui-ecosystem/dsh-open-path
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { runOpenCommand, type CommandResultLike, type OpenDialogLike, type OpenCommandOptions } from './open.js';
import { resolveLang, t } from './i18n.js';

/** Cordis row id used for the plugin. */
export const name = 'dsh-open-path';

/**
 * Plugin configuration (all keys have defaults; a missing config degrades
 * to the defaults — it must never fail the TUI boot).
 */
export type Config = {
    /** Max candidates offered in the select dialog; `0` = every match (unlimited). */
    maxCandidates?: number;
    /** Include hidden (dot) files and directories in the fuzzy index. */
    includeHidden?: boolean;
};

export const Config: Schemastery<Config> = z.object({
    // schemastery has no .integer(); slice() truncates decimals anyway.
    // `0` is the default and means "no plugin-side cap": the managed dialog is
    // windowed and scrolls (↑/↓), so hiding matches buys nothing. Values ≤ 0
    // are treated as unlimited by the ranker as well, so a stray -1 can never
    // produce an empty picker.
    maxCandidates: z.number().min(0).default(0),
    includeHidden: z.boolean().default(false),
});

/**
 * Structural subset of `@deepseek-ai/dsh-commands` `CommandDefinition` —
 * intentionally NOT imported so the plugin stays decoupled from the upstream
 * package version (a drift in dsh-commands must never break this plugin).
 */
export interface CommandDefinitionLike {
    readonly name: string;
    readonly description: string;
    /** Localized descriptions the host renders itself (English is the fallback). */
    readonly descriptions?: { readonly zh?: string; readonly en?: string };
    readonly input?: { readonly hint: string };
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>;
}

/**
 * Structural subset of `@deepseek-ai/dsh-session` `SessionHeader` — the live
 * session's storage metadata. `meta` is only a construction-time input
 * (`CreateSessionOptions.meta`); the runtime `Session` exposes the folded
 * result as `header`, so `session.meta` is always undefined at invocation time.
 */
export interface SessionHeaderLike {
    /** Absolute working directory the session was created in, when known. */
    readonly cwd?: string;
}

/** Structural subset of `CommandInvocation`. */
export interface CommandInvocationLike {
    readonly rawInput: string;
    readonly signal: AbortSignal;
    readonly agent?: {
        readonly session?: {
            /** Live session storage metadata — the authoritative per-session cwd. */
            readonly header?: SessionHeaderLike;
            /** Legacy host alias for the same metadata (older dsh lines). */
            readonly meta?: SessionHeaderLike;
        };
    };
}

/** Structural subset of `ctx.tuiPluginHost` (C-041 mediated registration). */
export interface PluginHostLike {
    registerCommand(pluginCtx: unknown, definition: CommandDefinitionLike): () => void;
}

/** Structural subset of the direct `commands` service (C-070 boundary). */
export interface CommandsLike {
    register(definition: CommandDefinitionLike): () => void;
}

/**
 * Resolve the working directory `/open` operates on: the invoking session's
 * live cwd, read from the session header. A TUI `/workspace` switch starts a
 * NEW session whose header carries the new cwd, so this always follows the
 * current workspace. `process.cwd()` — the host process's launch directory,
 * which never changes for the life of the process — is only a last resort for
 * invocations that carry no session metadata at all.
 */
export function resolveSessionCwd(agent: CommandInvocationLike['agent']): string {
    return agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? process.cwd();
}

function effectiveOptions(config: Config): OpenCommandOptions {
    return {
        // Absent or `0` = unlimited (see Config); the ranker treats any value
        // ≤ 0 the same way, so a stray negative can never empty the picker.
        maxCandidates: config.maxCandidates ?? 0,
        includeHidden: config.includeHidden ?? false,
    };
}

/**
 * Diagnostic log file (ecosystem convention `~/.dsh-tui/<plugin>.log`).
 * Resolved lazily: a module-level `homedir()` throw would take the whole entry
 * down, and diagnostics are never worth a boot failure.
 */
function diagLogPath(): string {
    return join(homedir(), '.dsh-tui', 'dsh-open-path.log');
}

/** Above this size the log is trimmed to its newest half. */
const MAX_LOG_BYTES = 128 * 1024;

/**
 * Test runners must never write into a user's `~/.dsh-tui`. The SOP names
 * `node --test`; vitest is treated identically, since this suite calls
 * `apply()` on every run and would otherwise litter the log.
 */
function diagnosticsEnabled(): boolean {
    return typeof process.env?.NODE_TEST_CONTEXT !== 'string' && process.env?.VITEST === undefined;
}

/**
 * Append one diagnostic line, keeping the file bounded: past `MAX_LOG_BYTES`
 * the older half is dropped, so a long-lived session cannot grow the log
 * without bound.
 */
function appendLogLine(path: string, line: string): void {
    try {
        if (statSync(path).size > MAX_LOG_BYTES) {
            const keep = readFileSync(path, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2));
            writeFileSync(path, keep);
        }
    }
    catch {
        // Missing or unreadable file: the append below recreates it.
    }
    appendFileSync(path, line);
}

try {
    if (diagnosticsEnabled()) {
        appendLogLine(
            diagLogPath(),
            `${new Date().toISOString()} info module imported pid=${process.pid} node=${process.version} entry=${import.meta.url}\n`,
        );
    }
}
catch {
    // Diagnostics must never be the reason a module fails to load.
}

/** The host logger surface this plugin uses (structurally, never imported). */
interface HostLoggerLike {
    info?(message: string): void;
    warn?(message: string): void;
}

/**
 * Lifecycle logger (SOP §2.2): host logger plus this plugin's own bounded file
 * log, so "host never loaded the file" / "loaded but the seam refused the
 * registration" / "registered but nothing shows up" are distinguishable from a
 * single log. Warnings are de-duplicated — the host may re-apply the plugin.
 */
function createLogger(ctx: Context, seen: Set<string>): { info(message: string): void; warn(message: string): void } {
    const host = ctx.logger as unknown as HostLoggerLike | undefined;
    const write = (level: 'info' | 'warn', message: string): void => {
        if (level === 'warn') {
            if (seen.has(message)) return;
            seen.add(message);
        }
        try {
            host?.[level]?.(`${name}: ${message}`);
        }
        catch {
            // Observability only; never let logging break the plugin.
        }
        if (!diagnosticsEnabled()) return;
        try {
            appendLogLine(diagLogPath(), `${new Date().toISOString()} ${level} ${message}\n`);
        }
        catch {
            // An unwritable log path is not an error worth surfacing.
        }
    };
    return {
        info: (message) => write('info', message),
        warn: (message) => write('warn', message),
    };
}

/** `0` = absent, `1` = present (the SOP's seam-probe notation). */
function seamState(value: unknown): number {
    return value === undefined || value === null ? 0 : 1;
}

/**
 * Wire the plugin: register `/open` through the host-mediated command surface
 * (C-041) with a direct-services fallback (C-070). Failures log and degrade —
 * a registration problem must never take the TUI down.
 */
export function apply(ctx: Context, config: Config = {}): void {
    const options = effectiveOptions(config);
    const log = createLogger(ctx, new Set<string>());
    /**
     * The host's live language preference (`dsh-tui.lang`), or undefined.
     *
     * Read through the public `settings.get(ns)` seam — never by importing host
     * internals — and defensively, because a host without that namespace (or one
     * that answers oddly) must still render in the historical default.
     */
    const settingsLang = (): unknown => {
        try {
            const settings = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.('settings', false) as { get?: (ns: string) => unknown } | undefined;
            const section = settings?.get?.('dsh-tui') as { lang?: unknown } | undefined;
            return section?.lang;
        }
        catch {
            return undefined;
        }
    };
    log.info(`apply start pid=${process.pid} entry=${import.meta.url}`);
    log.info(`config maxCandidates=${options.maxCandidates} includeHidden=${options.includeHidden}`);

    const definition: CommandDefinitionLike = {
        name: 'open',
        // The host localizes `descriptions` itself, so both languages ride along;
        // `description` stays the English fallback for a host that does not.
        description: t('en', 'commandDescription'),
        descriptions: {
            zh: t('zh', 'commandDescription'),
            en: t('en', 'commandDescription'),
        },
        input: { hint: t(resolveLang({ settingsLang: settingsLang() }), 'commandHint') },
        handler: async (invocation) => {
            const cwd = resolveSessionCwd(invocation.agent);
            const dialogs = ctx.get('tuiDialogs', false) as OpenDialogLike | undefined;
            return runOpenCommand(
                invocation.rawInput,
                { cwd, dialogs, signal: invocation.signal },
                options,
            );
        },
    };

    let host: PluginHostLike | undefined;
    let commands: CommandsLike | undefined;
    try {
        host = ctx.get('tuiPluginHost', false) as PluginHostLike | undefined;
        // Probed for the log even when the mediated surface wins: a support
        // session needs to see which surfaces the host actually offers.
        commands = ctx.get('commands', false) as CommandsLike | undefined;
        log.info(`seams tuiPluginHost=${seamState(host)} commands=${seamState(commands)} tuiDialogs=${seamState(ctx.get('tuiDialogs', false))}`);
    }
    catch (error) {
        log.warn(`seam probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let dispose: (() => void) | undefined;
    try {
        if (host !== undefined) {
            // Mediated path: stamps verified component identity + invoke checkpoint.
            dispose = host.registerCommand(ctx, definition);
        }
        else {
            const fallback = commands ?? (ctx.get('commands', false) as CommandsLike | undefined);
            dispose = fallback?.register(definition);
        }
    }
    catch (error) {
        // DUPLICATE_CONTRIBUTION_ID or an absent commands service: log, skip.
        log.warn(`command registration failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    if (dispose === undefined) {
        log.warn('no command service available — /open is not registered');
        return;
    }

    log.info(`command registered name=open via=${host !== undefined ? 'tuiPluginHost' : 'commands'} cwd-source=session-header`);
    ctx.effect(() => () => {
        log.info('command disposed — /open is no longer registered');
        (dispose as () => void)();
    }, 'dsh-open-path command');
}
