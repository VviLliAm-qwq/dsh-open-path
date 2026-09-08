import { describe, expect, it } from 'vitest';
import { apply, resolveSessionCwd, type CommandDefinitionLike } from '../src/index.js';

describe('resolveSessionCwd', () => {
    it('reads the live session header cwd — the TUI workspace', () => {
        expect(resolveSessionCwd({ session: { header: { cwd: 'D:\\ws-alpha' } } })).toBe('D:\\ws-alpha');
    });

    it('follows a /workspace switch: every invocation resolves its own session', () => {
        // A switch starts a new session, so the next invocation carries the new
        // header cwd instead of the host process's fixed launch directory.
        expect(resolveSessionCwd({ session: { header: { cwd: 'D:\\ws-alpha' } } })).toBe('D:\\ws-alpha');
        expect(resolveSessionCwd({ session: { header: { cwd: 'D:\\ws-beta' } } })).toBe('D:\\ws-beta');
    });

    it('prefers the session header over the legacy meta alias', () => {
        expect(
            resolveSessionCwd({ session: { header: { cwd: 'D:\\live' }, meta: { cwd: 'D:\\stale' } } }),
        ).toBe('D:\\live');
    });

    it('falls back to the legacy meta alias when the header carries no cwd', () => {
        expect(resolveSessionCwd({ session: { meta: { cwd: 'D:\\legacy' } } })).toBe('D:\\legacy');
    });

    it('falls back to the host process cwd when no session metadata exists', () => {
        expect(resolveSessionCwd(undefined)).toBe(process.cwd());
        expect(resolveSessionCwd({})).toBe(process.cwd());
        expect(resolveSessionCwd({ session: { header: {} } })).toBe(process.cwd());
    });
});

describe('apply', () => {
    it('registers /open through the commands-service fallback', () => {
        const registered: CommandDefinitionLike[] = [];
        const ctx = {
            get: (key: string) =>
                key === 'commands'
                    ? {
                        register: (definition: CommandDefinitionLike) => {
                            registered.push(definition);
                            return () => {};
                        },
                    }
                    : undefined,
            effect: (setup: () => () => void) => setup(),
            logger: { warn: () => {} },
        };
        apply(ctx as never, {});
        expect(registered.map((definition) => definition.name)).toEqual(['open']);
        expect(registered[0]?.input?.hint).toContain('工作目录');
    });
});
