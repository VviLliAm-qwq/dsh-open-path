import { describe, expect, it } from 'vitest';

import { STRING_KEYS, langFilePath, normalizeLang, resolveLang, t } from '../src/i18n.js';

describe('language resolution', () => {
    it('normalizes the values dsh-TUI actually writes', () => {
        expect(normalizeLang('zh')).toBe('zh');
        expect(normalizeLang(' zh-CN ')).toBe('zh');
        expect(normalizeLang('en')).toBe('en');
        expect(normalizeLang('en_US')).toBe('en');
        expect(normalizeLang('')).toBeUndefined();
        expect(normalizeLang('fr')).toBeUndefined();
        expect(normalizeLang(42)).toBeUndefined();
    });

    it('prefers the environment pin, then the live host setting, then the file', () => {
        const readLangFile = () => 'en' as const;
        expect(resolveLang({ env: { DSH_TUI_LANG: 'en' }, settingsLang: 'zh', readLangFile })).toBe('en');
        expect(resolveLang({ env: {}, settingsLang: 'zh', readLangFile })).toBe('zh');
        expect(resolveLang({ env: {}, readLangFile })).toBe('en');
    });

    it('a locale that exists but is unsupported reads as English, not as “no information”', () => {
        expect(resolveLang({ env: { LANG: 'fr_FR.UTF-8' }, readLangFile: () => undefined })).toBe('en');
        expect(resolveLang({ env: { LANG: 'en_GB.UTF-8' }, readLangFile: () => undefined })).toBe('en');
        expect(resolveLang({ env: { LANG: 'zh_CN.UTF-8' }, readLangFile: () => undefined })).toBe('zh');
    });

    it('keeps the historical default when nothing anywhere says anything', () => {
        // A Chinese host that never wrote a preference must render exactly as the
        // pre-i18n releases did.
        expect(resolveLang({ env: {}, readLangFile: () => undefined })).toBe('zh');
    });

    it('a throwing file reader never takes the plugin down', () => {
        const readLangFile = () => {
            throw new Error('boom');
        };
        expect(resolveLang({ env: {}, readLangFile })).toBe('zh');
    });

    it('the preference file lives in the TUI state directory, with an override', () => {
        expect(langFilePath({ DSH_TUI_STATE_DIR: '/tmp/state' }).replace(/\\/g, '/')).toBe('/tmp/state/lang.json');
        expect(langFilePath({ DSH_OPEN_PATH_LANG_FILE: '/tmp/custom.json' })).toBe('/tmp/custom.json');
        expect(langFilePath({})).toMatch(/lang\.json$/);
    });
});

describe('strings', () => {
    it('both dictionaries define every key', () => {
        for (const key of STRING_KEYS) {
            expect(t('zh', key), `zh.${key}`).not.toBe(key);
            expect(t('en', key), `en.${key}`).not.toBe(key);
        }
    });

    it('substitutes placeholders and leaves an unknown one visible', () => {
        expect(t('zh', 'targetMissing', { target: '/tmp/x' })).toBe('目标不存在：/tmp/x');
        expect(t('en', 'targetMissing', { target: '/tmp/x' })).toBe('target does not exist: /tmp/x');
        expect(t('en', 'openFailed', { target: 'x', attempted: 'a, b', hint: 'h' })).toContain('tried a, b');
        // A missing variable renders as its placeholder — a visible bug beats an
        // `undefined` printed at the user.
        expect(t('en', 'opened', {})).toBe('opened {target}');
    });

    it('an unknown key renders as the key itself', () => {
        expect(t('zh', 'no-such-key')).toBe('no-such-key');
        expect(t('zh', 'no-such-key', { a: 1 })).toBe('no-such-key');
    });

    it('an unsupported language falls back to the source dictionary', () => {
        expect(t('fr' as 'zh', 'opened', { target: 'x' })).toBe('已打开 x');
    });

    it('the two dictionaries differ where it matters', () => {
        expect(t('zh', 'commandHint')).toContain('工作目录');
        expect(t('en', 'commandHint')).toContain('working directory');
        expect(t('zh', 'listSeparator')).toBe('、');
        expect(t('en', 'listSeparator')).toBe(', ');
    });
});
