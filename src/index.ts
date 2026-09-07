/**
 * dsh-open-path — a `/open` slash command for dsh-TUI.
 *
 * Opens files, folders and http(s) URLs with the platform default handler:
 *  - `/open`                  → opens the session working directory
 *  - `/open <path>`           → absolute / relative path (must exist)
 *  - `/open <http(s)-url>`    → opens with the default browser/handler
 *  - `/open <fragment>`       → fuzzy search of the workspace; one match opens
 *                               directly, several matches show a managed
 *                               select dialog (TUI seam 十), none = clear error
 *
 * URL trust boundary: only http/https is handed to the OS handler; other
 * schemes (file:, javascript:, ftp:, …) are rejected with a clear error
 * (mirrors the TUI's own openExternal classification).
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
 *  - No session events are appended; no files are ever written by this plugin.
 *
 * @module @dsh-tui-ecosystem/dsh-open-path
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { runOpenCommand, type CommandResultLike, type OpenDialogLike, type OpenCommandOptions } from './open.js';

/** Cordis row id used for the plugin. */
export const name = 'dsh-open-path';

/**
 * Plugin configuration (all keys have defaults; a missing config degrades
 * to the defaults — it must never fail the TUI boot).
 */
export type Config = {
    /** Max candidates shown in the select dialog (1–50, default 10). */
    maxCandidates?: number;
    /** Include hidden (dot) files and directories in the fuzzy index. */
    includeHidden?: boolean;
};

export const Config: Schemastery<Config> = z.object({
    // schemastery has no .integer(); slice() truncates decimals anyway.
    maxCandidates: z.number().min(1).max(50).default(10),
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
    readonly input?: { readonly hint: string };
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>;
}

/** Structural subset of `CommandInvocation`. */
export interface CommandInvocationLike {
    readonly rawInput: string;
    readonly signal: AbortSignal;
    readonly agent?: {
        readonly session?: { readonly meta?: { readonly cwd?: string } };
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

function effectiveOptions(config: Config): OpenCommandOptions {
    return {
        maxCandidates: config.maxCandidates ?? 10,
        includeHidden: config.includeHidden ?? false,
    };
}

/**
 * Wire the plugin: register `/open` through the host-mediated command surface
 * (C-041) with a direct-services fallback (C-070). Failures log and degrade —
 * a registration problem must never take the TUI down.
 */
export function apply(ctx: Context, config: Config = {}): void {
    const options = effectiveOptions(config);

    const definition: CommandDefinitionLike = {
        name: 'open',
        description: 'Open a path, http(s) URL, or fuzzy-find a workspace file/folder (blank = working directory)',
        input: { hint: '<路径 / 文件名 / http(s) 链接>（留空 = 打开工作目录）' },
        handler: async (invocation) => {
            const cwd = invocation.agent?.session?.meta?.cwd ?? process.cwd();
            const dialogs = ctx.get('tuiDialogs', false) as OpenDialogLike | undefined;
            return runOpenCommand(
                invocation.rawInput,
                { cwd, dialogs, signal: invocation.signal },
                options,
            );
        },
    };

    let dispose: (() => void) | undefined;
    try {
        const host = ctx.get('tuiPluginHost', false) as PluginHostLike | undefined;
        if (host !== undefined) {
            // Mediated path: stamps verified component identity + invoke checkpoint.
            dispose = host.registerCommand(ctx, definition);
        }
        else {
            const commands = ctx.get('commands', false) as CommandsLike | undefined;
            dispose = commands?.register(definition);
        }
    }
    catch (error) {
        // DUPLICATE_CONTRIBUTION_ID or an absent commands service: log, skip.
        ctx.logger?.warn?.(`dsh-open-path: command registration failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    if (dispose === undefined) {
        ctx.logger?.warn?.('dsh-open-path: no command service available — /open is not registered');
        return;
    }

    ctx.effect(() => dispose as () => void, 'dsh-open-path command');
}
