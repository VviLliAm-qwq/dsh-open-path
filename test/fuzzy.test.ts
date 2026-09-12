import { describe, expect, it } from 'vitest';
import { rankEntries, scoreMatch } from '../src/fuzzy.js';

describe('scoreMatch', () => {
    it('scores an exact prefix as the best kind', () => {
        const result = scoreMatch('index', 'index.ts');
        expect(result?.kind).toBe('prefix');
        expect(result !== null && result.score > 900).toBe(true);
    });

    it('recognises a word-boundary start (after a path separator)', () => {
        const result = scoreMatch('index', 'src/index.ts');
        expect(result?.kind).toBe('word');
    });

    it('recognises a plain substring', () => {
        const result = scoreMatch('docs', 'READMEdocs.md');
        expect(result?.kind).toBe('substring');
    });

    it('recognises an ordered subsequence', () => {
        const result = scoreMatch('inx', 'index.ts');
        expect(result?.kind).toBe('subsequence');
    });

    it('handles Chinese text without case quirks', () => {
        expect(scoreMatch('文档', '中文文档.md')?.kind).toBe('substring');
        expect(scoreMatch('中文', '中文文档.md')?.kind).toBe('prefix');
    });

    it('is case-insensitive', () => {
        expect(scoreMatch('INDEX', 'index.ts')?.kind).toBe('prefix');
    });

    it('matches NFD-on-disk names against an NFC query (macOS APFS/HFS+)', () => {
        const onDisk = 'cafe\u0301-notes.md'; // NFD, as the filesystem reports it
        const typed = 'caf\u00e9'; // NFC, as a user types it
        expect(scoreMatch(typed, onDisk)?.kind).toBe('prefix');
        // …and the other way round: an NFD query still hits an NFC candidate.
        expect(scoreMatch('cafe\u0301-notes', 'caf\u00e9-notes.md')?.kind).toBe('prefix');
    });

    it('matches decomposed Hangul against the composed form', () => {
        const composed = '\ud55c\uad6d.md'; // 한국.md
        const decomposed = '\u1112\u1161\u11ab\u1100\u116e\u11a8.md'; // jamo form
        expect(scoreMatch(composed, decomposed)?.kind).toBe('prefix');
        expect(scoreMatch(decomposed, composed)?.kind).toBe('prefix');
    });

    it('returns null when the query is not present in order', () => {
        expect(scoreMatch('zzz', 'abc.txt')).toBeNull();
    });

    it('ranks prefix above substring above subsequence', () => {
        const prefix = scoreMatch('src', 'src/index.ts')!.score;
        const substring = scoreMatch('in', 'src/index.ts')!.score;
        const subsequence = scoreMatch('sx', 'src/index.ts')!.score;
        expect(prefix).toBeGreaterThan(substring);
        expect(substring).toBeGreaterThan(subsequence);
    });
});

describe('rankEntries', () => {
    const entries = [
        { relPath: 'docs/readme.md', basename: 'readme.md', isDir: false },
        { relPath: 'src/utils/reader.ts', basename: 'reader.ts', isDir: false },
        { relPath: 'src/index.ts', basename: 'index.ts', isDir: false },
        { relPath: 'docs/index-notes.md', basename: 'index-notes.md', isDir: true },
    ];

    it('prefers a basename prefix over a deep path match', () => {
        const ranked = rankEntries('read', entries, 10);
        expect(ranked[0].relPath).toBe('docs/readme.md');
    });

    it('finds nothing for an unrelated query', () => {
        expect(rankEntries('不存在', entries, 10)).toEqual([]);
    });

    it('returns at most `limit` candidates', () => {
        const ranked = rankEntries('index', entries, 1);
        expect(ranked.length).toBe(1);
        expect(ranked[0].relPath).toBe('src/index.ts');
    });

    it('keeps every match when the limit is 0 or negative (unlimited)', () => {
        const many = Array.from({ length: 40 }, (_, index) => ({
            relPath: `src/file-${index}.ts`,
            basename: `file-${index}.ts`,
            isDir: false,
        }));
        expect(rankEntries('file', many, 0)).toHaveLength(40);
        expect(rankEntries('file', many, -1)).toHaveLength(40);
        // …and the previous behaviour is untouched for a positive limit.
        expect(rankEntries('file', many, 10)).toHaveLength(10);
    });

    it('keeps entries matched by path alone when basename misses', () => {
        const only = [
            { relPath: 'docs/index-archived.md', basename: 'archived.md', isDir: false },
        ];
        const ranked = rankEntries('index', only, 10);
        expect(ranked).toHaveLength(1);
    });
});
