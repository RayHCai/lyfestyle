import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSoul } from '../src/soul.js';

describe('readSoul', () => {
    it('reads the doc trimmed, and gives nothing when it is missing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lyfestyle-soul-'));
        const file = join(dir, 'SOUL.md');
        expect(await readSoul(file)).toBe('');
        await writeFile(file, '\n# Me\n\nBe terse.\n\n');
        expect(await readSoul(file)).toBe('# Me\n\nBe terse.');
        await rm(dir, { recursive: true, force: true });
    });
});
