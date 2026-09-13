/**
 * UI language resolution and strings for `/open`.
 *
 * The plugin follows the same chain dsh-TUI itself uses, so `/lang` is honoured
 * without a restart:
 *
 *   `DSH_TUI_LANG` → the live `dsh-tui` settings namespace (passed in by the
 *   caller, which owns the seam) → `~/.dsh-tui/lang.json` → the OS locale →
 *   `zh`, the language this plugin's replies were originally written in.
 *
 * An unsupported but *present* locale falls back to `en`, matching dsh-TUI's own
 * rule; a missing locale keeps `zh`, which is what keeps a Chinese host that
 * never wrote a preference byte-identical to the pre-i18n releases.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The two languages this plugin can render. */
export type Lang = 'zh' | 'en';

/** Path of the preference file dsh-TUI writes on `/lang`. */
export function langFilePath(env: NodeJS.ProcessEnv = process.env): string {
    // `DSH_OPEN_PATH_LANG_FILE` lets a test or a diagnostic point somewhere else,
    // exactly like the other DSH_* overrides in this ecosystem.
    const override = typeof env.DSH_OPEN_PATH_LANG_FILE === 'string' && env.DSH_OPEN_PATH_LANG_FILE !== ''
        ? env.DSH_OPEN_PATH_LANG_FILE
        : undefined;
    if (override !== undefined) return override;
    const dir = typeof env.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
        ? env.DSH_TUI_STATE_DIR
        : join(homedir(), '.dsh-tui');
    return join(dir, 'lang.json');
}

/** Normalize one raw preference value; `undefined` = "no information". */
export function normalizeLang(value: unknown): Lang | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().toLowerCase();
    if (text === '') return undefined;
    // Languages arrive in every shape the ecosystem produces: `zh`, `zh-CN`,
    // `zh_CN`, `zh_CN.UTF-8`, `en_GB@euro`. The language is the head before the
    // first separator, so all of them normalize without a per-spelling table.
    const head = text.split(/[_.\-@]/u)[0];
    if (head === 'zh') return 'zh';
    if (head === 'en') return 'en';
    return undefined;
}

/**
 * Whether a locale string names a language this plugin supports.
 *
 * A locale that is present but unsupported is not "no information": the user's
 * system says French, so answering in Chinese would be wrong. Only a *missing*
 * locale falls back to the historical default.
 */
function localePrefers(locale: unknown): Lang | undefined {
    if (typeof locale !== 'string' || locale.trim() === '') return undefined;
    return normalizeLang(locale) ?? 'en';
}

/** Read `~/.dsh-tui/lang.json`; any problem reads as "no information". */
function langFromFile(env: NodeJS.ProcessEnv): Lang | undefined {
    try {
        const raw = readFileSync(langFilePath(env), 'utf8');
        const parsed = JSON.parse(raw) as { lang?: unknown };
        return normalizeLang(parsed?.lang);
    }
    catch {
        return undefined;
    }
}

/** Everything {@link resolveLang} needs, all injectable for tests. */
export interface LangSources {
    /** Live value from the host's `dsh-tui` settings namespace. */
    settingsLang?: unknown;
    env?: NodeJS.ProcessEnv;
    /** Process locale, e.g. `process.env.LANG` or `Intl` output. */
    locale?: unknown;
    /** File reader override (tests). */
    readLangFile?: (env: NodeJS.ProcessEnv) => Lang | undefined;
}

/**
 * Resolve the language to render with.
 *
 * Order and fallbacks are documented on the module; every step is optional, and
 * the function never throws.
 */
export function resolveLang(sources: LangSources = {}): Lang {
    const env = sources.env ?? process.env;
    const fromEnv = normalizeLang(env.DSH_TUI_LANG);
    if (fromEnv !== undefined) return fromEnv;
    const fromSettings = normalizeLang(sources.settingsLang);
    if (fromSettings !== undefined) return fromSettings;
    const reader = sources.readLangFile ?? langFromFile;
    let fromFile: Lang | undefined;
    try {
        fromFile = reader(env);
    }
    catch {
        fromFile = undefined;
    }
    if (fromFile !== undefined) return fromFile;
    return localePrefers(sources.locale ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG) ?? 'zh';
}

/**
 * Every string this plugin renders.
 *
 * `{name}` placeholders are substituted by {@link t}. Both dictionaries carry
 * the same key set; `test/i18n.test.ts` pins that.
 */
const STRINGS: Record<Lang, Record<string, string>> = {
    zh: {
        commandDescription: '打开路径、http(s) 链接或裸域名（github.com），或在工作区里模糊查找文件/文件夹（留空 = 打开工作目录）',
        commandHint: '<路径 / 文件名 / 链接或域名>（留空 = 打开工作目录）',
        hintWindows: '请检查系统默认程序关联',
        hintMac: '请确认 /usr/bin/open 可用',
        hintLinux: '多数精简发行版需要先安装 xdg-utils（或 gio / kde-open）',
        targetMissing: '目标不存在：{target}',
        noGraphicalSession: '当前环境没有图形会话，无法打开文件管理器',
        opened: '已打开 {target}',
        openFailed: '无法打开 {target}（已尝试 {attempted}，均失败；{hint}）',
        schemeRejected: '仅支持 http/https 链接（检测到 {scheme}: 协议）',
        noMatch: '工作区中找不到与 “{query}” 相关的文件或文件夹',
        dirTag: '[目录] {path}',
        listSeparator: '、',
        moreItems: ' 等 {count} 项',
        noDialogCandidates: '找到 {count} 个匹配，但当前环境没有对话框选择，请键入更精确的路径。候选：{preview}{more}',
        dialogTitleTruncated: '打开哪个？（{query} · 共 {count} 个匹配，仅显示前 {shown} 个）',
        dialogTitle: '打开哪个？（{query} · {count} 个匹配）',
        targetStale: '无法打开 {target}（目标已失效）',
    },
    en: {
        commandDescription: 'Open a path, http(s) URL or bare domain (github.com), or fuzzy-find a workspace file/folder (blank = working directory)',
        commandHint: '<path / file name / URL or domain> (blank = the working directory)',
        hintWindows: 'check the system default-handler association',
        hintMac: 'check that /usr/bin/open is available',
        hintLinux: 'most minimal distributions need xdg-utils installed (or gio / kde-open)',
        targetMissing: 'target does not exist: {target}',
        noGraphicalSession: 'no graphical session is available, so no file manager can be opened',
        opened: 'opened {target}',
        openFailed: 'cannot open {target} (tried {attempted}; all failed; {hint})',
        schemeRejected: 'only http/https links are supported (got the {scheme}: scheme)',
        noMatch: 'no workspace file or folder matches “{query}”',
        dirTag: '[dir] {path}',
        listSeparator: ', ',
        moreItems: ' and {count} more',
        noDialogCandidates: 'found {count} matches, but no dialog is available here — type a more specific path. Candidates: {preview}{more}',
        dialogTitleTruncated: 'open which? ({query} · {count} matches, showing the first {shown})',
        dialogTitle: 'open which? ({query} · {count} matches)',
        targetStale: 'cannot open {target} (the target disappeared)',
    },
};

/** Every key either dictionary defines. */
export const STRING_KEYS: readonly string[] = Object.freeze(Object.keys(STRINGS.zh));

/**
 * Render one string.
 *
 * @param lang - resolved language.
 * @param key - a key from {@link STRING_KEYS}.
 * @param vars - `{name}` substitutions; a missing one is left as written, so a
 *   bug shows up as `{name}` on screen instead of `undefined`.
 * @returns The rendered string; an unknown key renders as the key itself, which
 *   is visible in a test and harmless in a log.
 */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
    const table = STRINGS[lang] ?? STRINGS.zh;
    const template = table[key] ?? STRINGS.zh[key] ?? key;
    if (vars === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = vars[name];
        return value === undefined ? match : String(value);
    });
}
